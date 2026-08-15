# Records Feature — Design Discussion

## Problem

Neither app tracks competition records today. Splash has a records
feature (meet/club/provincial/national record lists, a live "new record"
flag during results entry, printed markers on start/result lists) that
we've never fully understood — this doc starts by reverse-engineering how
Splash actually does it, then designs an equivalent for
meet-app/team-app that round-trips through `.lxf` and `.smb` so a meet
run partly in our tools and partly in real Splash still shows the same
records.

## How Splash models records (verified against `splash-schema.csv`, confirmed against the official *Meet Manager 11 — Records and Time Standards* manual)

| Table | Purpose |
|---|---|
| `recordlist` | One row per named list: "Meet Record", "Quebec Record", "National Record". `lenexcode` maps to Lenex's `RECORDLIST TYPE` enum (`MEET`, `MEET_AND_OPEN`, `REGIONAL`, `NATIONAL`, `CONTINENTAL`, `WORLD`). `agecacltype` = age-as-of rule (same idea as our `config/age-group-rules.json`). `updatemode`/**Auto update** = whether the list updates itself when a record in it is broken, vs. requiring a manual edit. A per-list `Order` sets display/tie-break priority (see below) — never define an "Open" record age group explicitly; leave the age group unselected instead, and age brackets within one list must not overlap. |
| `recordagegroup` / `recordlistagegroup` | Age brackets *specific to records* — independent of a given meet's own `agegroup` rows, so standings stay comparable across meets/years that used different brackets. For relays: **relay single** (age taken per-athlete) vs. **relay total** (summed age of all four). |
| `record` | The record itself: `recordlistid` + `recordagegroupid` + `swimeventid`/`swimstyleid` + `gender` + `course` + `handicap` → `swimtime`, plus who set it (name/birthdate/club) and where/when (meet name/city/date/nation), plus `resultid` and a **meet event reference** linking back to the event where it was set. |
| `recordposition` / `recordsplit` | Relay-leg swimmers and split times for the record swim — same shape as `relayposition`/`split`. |
| `eventrecord` | **A shared junction table for both records *and* time standards** attached to a `swimevent` in the current meet — the manual's own UI panel is literally titled "Records / time standards for event." Per attached list: `marker` (short string printed beside a result that breaks it, e.g. "WR"), `comment` (printed on the line below), `onstartlist`/`onresultlist` (print in that report's event header). **`fine` belongs to the Time Standards half of this table, not records** — Splash's Time Standards is a sibling feature (max/min/default/level qualifying times per event, with a fine for missing one) that happens to reuse the same attach-to-event table; records themselves carry no fine. |

**Confirmed live mechanism** (from the manual, §1.3/1.3.1/1.4/1.6):

1. **The instant a result is entered**, it's compared directly against
   the *currently stored* record time for that event/age-group/gender/
   course. If faster, the result list **immediately** prints a text line
   under the swimmer's name (e.g. "World Record") — but the event's own
   header still shows the *old* record, because nothing has been
   persisted yet.
2. **Only once the heat is set to "official"**, and only if that record
   list has **Auto update** on, does Splash actually write a new `record`
   row (with the meet-event reference). If Auto update is off, a human
   edits the record manually.
3. Because of that ordering, the new record only starts appearing in
   **other events'** start/result-list headers from that point forward
   — not retroactively on the event that broke it.
4. If a single result breaks several attached record lists at once, only
   the **highest-priority one** (lowest `Order`) gets its marker/comment
   printed.
5. Printed reports: `Global → Record Lists` (full lists, optionally with
   history), `Global → Event Structure` (event structure with attached
   records), `Results → Records broken by Event` (a dedicated recap of
   every record broken this meet — populated the same way, gated on
   Auto update + official status).

This maps directly onto the standard Lenex `RECORDLIST`/`RECORD` elements
— the same pattern our `RELAY`/`RELAYPOSITION` import/export already uses
(`lenex.ts:723-770` import, `lenex.ts:1262-1311` export), and the same
table-list pattern used for SMB round-trip of relays
(`smb.ts:488-495`, `smb.ts:1018`). Splash's own import dialog (Transfer →
Import Records) supports four merge modes worth mirroring in our
importer: *replace completely*, *replace all existing* (missing ones
kept), *replace only if faster*, *only add missing*.

## Decisions so far

1. **Three levels, all in scope**: meet, club, provincial/national.
2. **Meet-record identity** = `Meet.name` string equality across years
   (team-app's `models_team.Meet`). No separate "meet series" link.
3. **Data source**:
   - Meet record & club record: **computed**, not stored — same query
     shape as `best_times.py`'s `get_public_best_times`
     (`min(totaltime)` grouped by style/course/gender/age-bracket), just
     grouped by club, or filtered to `Meet.name`, instead of grouped by
     athlete. No new source-of-truth table.
   - Provincial/national record: **stored**, admin-editable in team-app,
     and bulk-loadable via Lenex `RECORDLIST` import (Société de
     sauvetage's own record file). Needs real tables mirroring Splash's
     `record`/`recordlist`/`recordagegroup`.
4. **Delivery workflow**: `team-app → .lxf → meet-app → .smb → Splash`.
   Records are **folded into the existing Entries-LXF export/import**
   (no separate "records" file) to keep the workflow simple. meet-app's
   own `.smb` backup/restore also carries the record tables, so a meet
   opened in real Splash from that backup shows the same records.
5. **Write-back to team-app (broken provincial/national records)**:
   **deliberately deferred** — an automatic approval pipeline has too
   many unclear manual/ratification steps to design yet. For now,
   meet-app surfaces "record broken" live (marker) and in exported
   results, but does **not** attempt to write the provincial/national
   record back to team-app's authoritative table. A human updates that
   list manually (admin edit or a future Lenex re-import) once it's
   officially ratified. Club/meet records need no write-back at all —
   they're recomputed automatically from `Result` rows the next time
   team-app imports results (already happens today via
   `historical_import.py`).
6. **Scope**: timed pool events only. Not beach (positions, not times),
   not SERC (judged/scored, not timed).

## Target design

### team-app

- New tables (Team Manager / provincial-national schema only —
  `models.py` or `models_team.py`, TBD): `record_list`,
  `record_age_group`, `record` — admin CRUD for provincial/national
  entries, plus a Lenex `RECORDLIST` importer.
- Club/meet record queries live alongside `best_times.py`, reusing
  `Result`/`Meet`/`Member`/`TeamClub` — no persistence.
- `export.py:generate_lxf` (the Entries-LXF generator) gains a
  `RECORDLIST`/`RECORD` block per applicable event: one synthesized list
  each for meet record and club record (computed), plus the stored
  provincial/national lists, all as standard Lenex `RECORD` elements.

### meet-app

- New local tables mirroring Splash: `recordlist`, `recordagegroup`,
  `record`, `eventrecord`, and (for relay events) `recordposition`/
  `recordsplit` — new ID ranges needed, same pattern as the existing pool
  vs. beach ID-range table in `CLAUDE.md`.
- `lenex.ts` import: parse `RECORDLIST`/`RECORD` on Entries-LXF import
  into the new tables (same shape as the existing `RELAY` import block).
- Results entry (`FinalsPage`/timing pages): compare each new result
  against the matching `record` row, show the marker live.
- `smb.ts`: add the new tables to the backup/restore table list, same
  treatment as `RELAY`/`RELAYPOSITION`/`RELAYSPLIT`.
- Results-LXF export back to team-app: no special record write-back
  logic needed for club/meet (team-app recomputes them from the
  imported `Result` rows). Provincial/national breaks just need to be
  visible to a human (e.g. a "records broken this meet" report) —
  exact mechanism still open, see below.

## Open questions (not yet decided)

- Where do record age brackets come from — a new fixed table
  (`config/record-age-groups.json`?), or reuse the six beach-number
  brackets (`AGE_CODE_ORDER`), or something else? Needs to work for
  events whose meet-specific age groups don't line up with either.
- Do we replicate Splash's two-stage timing exactly (instant per-result
  text flag on entry, but the persisted record/header refresh gated on
  heat-official + auto-update), or simplify to a single "flag and persist
  immediately" step? The two-stage model exists in Splash to avoid a
  record flickering on/off before results are confirmed official — worth
  keeping for the same reason, but adds meet-app state (need to track
  "already reflected in headers" separately from "flagged on this
  result").
- Exact UI for the live "new record" flag in meet-app — Splash's model
  (inline text under the swimmer's name + header on subsequent
  start/result lists + a dedicated "records broken this meet" report) is
  a solid reference; decide how much of that three-part display to match
  for v1.
- What "records broken this meet" surfaces as for provincial/national —
  a printed report (mirroring Splash's `Results → Records broken by
  Event`), an export flag, both?
- `fine` is now understood to be a Time Standards concept, not Records —
  drop it entirely unless Time Standards (qualifying times + fines) also
  becomes an explicit part of scope later.
