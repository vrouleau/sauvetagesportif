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

## How Splash models records (verified against `splash-schema.csv`)

| Table | Purpose |
|---|---|
| `recordlist` | One row per named list: "Meet Record", "Quebec Record", "National Record". `lenexcode` maps to Lenex's `RECORDLIST TYPE` enum (`MEET`, `MEET_AND_OPEN`, `REGIONAL`, `NATIONAL`, `CONTINENTAL`, `WORLD`). `agecacltype` = age-as-of rule (same idea as our `config/age-group-rules.json`). `updatemode` = whether the list auto-updates when broken or needs manual confirmation. |
| `recordagegroup` / `recordlistagegroup` | Age brackets *specific to records* — independent of a given meet's own `agegroup` rows, so standings stay comparable across meets/years that used different brackets. |
| `record` | The record itself: `recordlistid` + `recordagegroupid` + `swimeventid`/`swimstyleid` + `gender` + `course` + `handicap` → `swimtime`, plus who set it (name/birthdate/club) and where/when (meet name/city/date/nation), plus `resultid` linking back to the result that set it. |
| `recordposition` / `recordsplit` | Relay-leg swimmers and split times for the record swim — same shape as `relayposition`/`split`. |
| `eventrecord` | Links a `swimevent` **in the current meet** to a `recordlist` (`listid`), with `marker` (e.g. "MR"/"NR", printed next to the result), `fine`, and `onstartlist`/`onresultlist` display flags. |

**Inferred live mechanism**: when a result is entered, Splash looks up
`eventrecord` for that event, resolves the matching `record` row
(`recordlistid` + bucketed age → `recordagegroupid` + gender/course/handicap),
and compares the new time. Faster → flag with `eventrecord.marker`; if
`updatemode` allows it, overwrite `record` and insert fresh
`recordsplit`/`recordposition` rows.

This maps directly onto the standard Lenex `RECORDLIST`/`RECORD` elements
— the same pattern our `RELAY`/`RELAYPOSITION` import/export already uses
(`lenex.ts:723-770` import, `lenex.ts:1262-1311` export), and the same
table-list pattern used for SMB round-trip of relays
(`smb.ts:488-495`, `smb.ts:1018`).

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
- Exact UI for the live "new record" flag in meet-app (badge on the
  results grid? toast? both start-list and result-list markers like
  Splash?).
- What "records broken this meet" surfaces as for provincial/national —
  a printed report, an export flag, both?
- Whether `fine` (Splash's per-broken-record monetary field) is worth
  carrying at all, or a Splash-only quirk we can drop.
