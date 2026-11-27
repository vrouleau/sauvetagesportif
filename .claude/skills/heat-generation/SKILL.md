---
name: heat-generation
description: How meet-app generates heats and manages Prelim/Final events — seeding methods (circle/pyramid/straight), MEETVALUES seeding keys, lane assignment, entry priority, finals qualification, Convert to Final, preveventid, event numbering. Use when touching generateHeats, seedFinals/autoQualify, EventsPage convert-to-final, or heat/lane seeding.
---

# Heat generation & Prelim/Final (meet-app)

## Heat Generation

Full rules: `docs/HEAT_GENERATION_RULES.md`

### Implementation
- **Backend**: `src/main/db.ts` → `generateHeats(eventId?, sessionId?, db?)`
- **IPC**: `db:generate-heats` channel
- **Preload**: `window.api.db.generateHeats(eventId?, sessionId?)`
- **UI**: "Générer séries" button in EventsPage toolbar
- **Tests**: `tests/heat-generation.test.ts` (28 tests)

### Seeding methods (`MEETVALUES.SEEDMETHOD`, meet-level only)
- `0` = Circle seeding (FINA prelims — round-robin across heats)
- `1` = Pyramid seeding (fastest in last heat — timed finals)
- `2` = Straight seeding (fastest in heat 1)

### Meet-level config keys (MEETVALUES in bsglobal)
| Key | Type | Description |
|-----|------|-------------|
| `SEEDMETHOD` | I | Default seeding method (0/1/2) |
| `FASTHEATCOUNT` | I | FINA "last N heats" circle-seed rule |
| `MINPERHEAT` | I | Minimum swimmers per heat (default 3) |
| `SEEDBONUSLAST` | B | Seed bonus entries after regular |
| `SEEDEXHLAST` | B | Seed exhibition entries after regular |
| `SEEDLATELAST` | B | Seed late entries after regular |
| `COMBINEAGEGROUPS` | B | Pool all age groups into one seeding |
| `QUALIFROM` | S | Qualification period start (YYYY-MM-DD) |
| `QUALITO` | S | Qualification period end (YYYY-MM-DD) |
| `QUALICOURSE` | I | 0=all courses, 1=same course only |

### Per-age-group overrides (agegroup table)
- `fastheatcount` — overrides FASTHEATCOUNT
- `heatcount` — **number of finals (A, B, C…) on a FIN event only** (Splash hides it elsewhere; per age group; shown only on Finals in the UI; reset to 1 when an event stops being a FIN). Not a heat floor — `generateHeats` ignores it
- `finalseedtype` — **Splash's "Sort order lanes in finals"** (confirmed against a Splash `.mdb`: 1 = by swum time, 3 = paranatation points; empty = default). NOT a heat seeding method — `generateHeats` ignores it, the UI has no control for it; we just carry the value through.

### Lane assignment
Default: center-out (e.g., 5,6,4,7,3,8,2,1 for 8 lanes starting at 1).
Custom: `swimsession.lanesbyplace` (comma-separated lane numbers).

### Entry priority (when seed*last flags are set)
1. Regular timed entries
2. Late entries (`swimresult.lateentry='T'`)
3. Bonus entries (`swimresult.bonusentry='T'`)
4. Exhibition entries — HC (`resultstatus=4` on `swimresult`/`relay`, from the HC checkbox or an LXF `ENTRY status="EXH"`) or Splash's `infocode` containing 'EXH'
5. No-time entries (NT)

### Beach mode
- Max participants per heat = `swimevent.maxentries` → `swimstyle.distance` → 16 (fallback)
- Athletes shuffled randomly and distributed evenly across heats
- No lane assignment (sequential numbers as placeholders)
- Auto-assigns beach numbers to athletes missing one before generating heats
- `swimevent.maxentries = 0` → no heat distribution: events like beach flags/sprint that only run a final (results entered manually on the beach) get a single empty heat shell instead of entries being split across heats

## Prelim/Final event numbering

`handleConvertToFinal` (shared-ui `EventsPage.tsx`) splits a Timed Final into a
Prelim + Final pair. The Final reuses the prelim's `eventnumber` (Splash
convention — confirmed against a real Splash `.mdb`: prelim and final share
`EventNumber` but have distinct `SwimEventID`s, differentiated by `round`).
Do NOT mint a new event number for the final — that's what causes "Event 5"'s
final to show up as an unrelated "Event 83". Because `eventnumber` can now be
shared, timing-scan barcode matching keys on `swimeventid` instead — see
"Barcode format" below.

The Final is created in the *same* session as the prelim, placed directly
after it (no separate "Finales" session is created). The link is `preveventid`
on the Final row, pointing back at the prelim — exposed to the frontend as
`CompetitionEvent.prevEventId`. Deleting a Final reverses the split: the
paired prelim's `round` is set back to TIM (`1`, Splash's code — the shared editor sends `'TIM'`), as if it had
never been converted.

**Prelim's age groups stop counting for medals/scoring once split (found 2026-08-14).**
The user noticed real Splash shows a "star" marker on an event's tree icon that's
missing from the prelim (but present on the final) after converting to Final —
either natively in Splash or via our LXF import — but present on *both* after an
`.smb` round-trip through our own app. Root-caused by directly sampling a live
Splash-native `.mdb` (`Microsoft.ACE.OLEDB.12.0`, same technique used for the ID
crash investigation above): a freshly-split PRE/FIN pair has
`AGEGROUP.UseForMedals`/`UseForScoring` = `'F'`/`'F'` on the **prelim's** age
group(s) and `'T'`/`'T'` on the final's — real Splash's own convention once a
final exists, the final's placement is what counts, not the prelim's. Our own
`createAgeGroup` and `importLenex`'s `upsertAgeGroup` always hardcode `'T'`/`'T'`
regardless of round, so nothing ever flipped the prelim's flags — explaining why
`.smb` (a raw column copy of our own always-`'T'` data) shows both events
matching, while native Splash and our LXF import (which encodes an already-split
PRE/FIN pair) diverge from what our app itself produces.

Fixed with a cascade in two places, both reusing the same
`UPDATE agegroup SET useformedals='F', useforscoring='F' WHERE swimeventid=<prelim>`
pattern:
- `updateEvent` (`db.ts`): whenever `preveventid` is set to a real (`>0`) id,
  flip that prelim's age groups to `'F'`/`'F'` — covers `handleConvertToFinal`'s
  step 3 (linking the new Final to its prelim). The reverse also lives here:
  whenever `round` is set to `5` (TIM), flip that event's own age groups back to
  `'T'`/`'T'` — covers deleting a Final (which reverts the prelim's round to TIM,
  see above).
- `importLenex` (`lenex.ts`): a post-pass after every session/event/agegroup in
  the file is inserted — for every `swimevent` row with a real `preveventid`,
  flip its linked prelim's age groups. Needed because an incoming LXF can already
  encode a PRE/FIN split (from our own export, or a real Splash export) with no
  `updateEvent` call involved.

Regression tests: `tests/event-fields.test.ts` (`updateEvent` cascade, both
directions) and `tests/lenex.test.ts` ("flips a prelim's age groups off for
medals/scoring when the imported FIN links to it via preveventid").
`smb.ts` needed no change — it always copies whatever `useformedals`/`useforscoring`
already sit in our own table, so once they're set correctly at creation/import
time, `.smb` export carries them through correctly too.

Splash column encoding for heats/rounds: see the `splash-encoding` skill. Full rules: `docs/HEAT_GENERATION_RULES.md`. Beach seeding differences: `beach-meet` skill.
