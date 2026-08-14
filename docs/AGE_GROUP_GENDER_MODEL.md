# Event/Age Group Gender Model

Splash Meet Manager (and the LENEX format it speaks) was built for swim meets, where
a meet director sometimes genuinely needs per-age-group control that a lifesaving
meet never uses. This document describes what the underlying data model still
supports (because we didn't change it), and what our UI now enforces on top of it
so lifesaving directors never have to deal with that flexibility.

## What Splash/LENEX actually supports

In Splash's schema (and ours, which mirrors it — `swimevent`, `agegroup` in
`schema.ts` / `models.py`), **an event's gender and each of its age groups' genders
are independent columns**. Nothing in the schema ties them together:

- `swimevent.gender` — the event's own gender
- `agegroup.gender` — each age group under that event has its *own*, separately
  stored gender

A swim meet director can legitimately want this: e.g. one "200 IM" event hosting a
15-18 age group restricted to boys and a separate 15-18 age group restricted to
girls, scored as two categories under one event listing. LENEX's `GENDER` attribute
reflects this flexibility — it's a real enum, `ALL | M | F | MIXED`, that can appear
on both `<EVENT>` and `<AGEGROUP>` elements independently, and age ranges on each
`<AGEGROUP>` are completely freeform (any `agemin`/`agemax` pair).

Splash's own UI exposes exactly this: an age-group detail panel where age range and
gender are edited per age group, independent of the parent event.

## Why lifesaving doesn't need it

Lifesaving competitions run against a fixed, federation-defined set of age brackets
(10-, 11-12, 13-14, 15-18, Open, Masters) and a fixed set of gender categories.
Nobody is inventing a novel age-group/gender combination inside a single event —
the age group's category *is* the event's category. Carrying Splash's full
per-age-group flexibility into our own UI just gave coaches and meet directors a
way to create data that's internally inconsistent (an event labeled "Men" hosting
an age group quietly switched to "Women") with no operational upside.

## What our UI enforces instead

**The invariant:** an age group's gender always mirrors its parent event's gender.
It is never set independently, in any UI, in either app.

**The value set** (`0=All, 1=M, 2=F, 3=Mixed` — see root `CLAUDE.md`):
- **Individual events** (`relaycount=1`): **All / M / F**. Mixed is not offered —
  an individual swimmer doesn't have a "mixed" sex.
- **Relay events** (`relaycount>1`): **Mixed / M / F**. All is not offered — there
  is no lifesaving use case for a relay event where man-only and mixed teams both
  compete under one open category (see the discussion that led to this design;
  the complexity wasn't worth it for a case nobody needed).

**Age ranges** are fixed at creation, via the named presets only (10-, 11-12,
13-14, 15-18, 15-18+Open, Open, Masters). There's no arbitrary/custom range option
and no way to edit a range after creation — once an event has its 15-18 age group,
that's what it is.

### Where the invariant is enforced

| Layer | File | Mechanism |
|---|---|---|
| Age group creation | `EventsPage.tsx` (`handleAddCategoryPresets`) | New age groups are created with `targetEvent.gender` — never a separately chosen value |
| Event gender edit (meet-app) | `db.ts` `updateEvent()` | Cascades: `UPDATE agegroup SET gender=? WHERE swimeventid=?` |
| Event gender edit (team-app) | `routers/api.py` `update_event()` | Same cascade, via SQLAlchemy `.update()` |
| LXF import (meet-app) | `lenex.ts` `importLenex()` | Every `<AGEGROUP>` under an event is written with that event's own decoded gender — the source XML's own per-agegroup `gender` attribute is never read |
| LXF import (team-app) | `meet_parser.py` / `events.py` `_load_from_parsed()` | `MeetAgeGroup` doesn't even carry a gender field — age groups are always created with the parent `MeetEvent.gender_int` |
| Age-group detail panel | `EventsPage.tsx` (`AgeGroupPropertiesPanel`) | No age-range inputs, no gender selector — only move-to-event, heat-count override, and final-seed-type remain editable there |

### Where the underlying flexibility can still leak in

The enforcement above is UI- and import-normalization-level, not a database
constraint — the `agegroup.gender` column itself is still a plain, independently
writable integer. Two paths can still produce a divergent state:

- **`.smb` restore** (`smb.ts`) round-trips the `AGEGROUP` table's raw columns
  verbatim, with no re-derivation from the paired event. A `.smb` backup captured
  from a real Splash meet that used per-age-group gender overrides would restore
  that divergence as-is into our database.
- **Direct DB writes** (`updateAgeGroup`/`update_age_group` endpoints) still accept
  a `gender` field if called directly — the UI simply never sends one anymore.

Neither path is expected to occur in normal lifesaving operation (nobody hand-edits
`.smb` files or calls the age-group API directly), so this was accepted as a known,
low-probability gap rather than adding a DB-level check constraint for a case that
shouldn't arise. If it ever does, the next event-gender edit on that event will
silently correct it, since the cascade always re-derives every age group from the
event.

## LENEX gender string encoding

Our own exporters previously wrote `"X"` for Mixed, which isn't in the real LENEX
`GENDER` enum (`ALL|M|F|MIXED`) — a genuine interop bug against real Splash.
`encodeGender`/`decodeGender` (`lenex.ts`) and their Python equivalents
(`meet_parser.py`, `export.py`, `lxf_to_team.py`, `models_team.py`) now:
- **decode/export** `0→"ALL"`, `1→"M"`, `2→"F"`, `3→"MIXED"`
- **encode/import** accept `"ALL"`, `"M"`, `"F"`, `"MIXED"`, and legacy `"X"`
  (for backward compatibility with files this app already exported before this
  fix)

See `CLAUDE.md` (root) for the canonical encoding reference, and
`docs/RELAY_TEAM_RULES.md` for the relay-specific 2M+2F composition rules that
apply once an event's gender is Mixed.
