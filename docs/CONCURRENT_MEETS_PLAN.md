# Concurrent Meets — Implementation Plan

## Phase 1: Data Model Uplift

## Problem

Beach meets run frequently within the summer season and their
registration windows can legitimately overlap (e.g. two regional beach
meets registering simultaneously). Pool meets were originally assumed to
never overlap — but that's not actually guaranteed either: there's a
2-week gap between pool meets in January–February 2027, tight enough that
their registration windows can overlap too. Today the app can't represent
either case: the operational schema behind live registration holds
exactly one meet's data at a time, so running a second concurrent meet —
pool or beach — requires either a second app instance or artificially
staggering registration windows so they never truly overlap.

Registration is the only part of this that actually needs to support
concurrency. The real-time live-results feed meet-app pushes to during a
competition (`models_live.py`) does not: sessions each pin to one calendar
date and two meets never schedule a session on the same day, so at most
one meet is ever genuinely "live" at a time — see the dedicated
subsection below for why that stays a deliberate singleton, with just one
new invariant to enforce (no two meets' sessions on the same date) now
that overlapping registration periods are becoming normal.

Phase 1 is the data model change needed to make "more than one meet
registering at once" representable at all, plus that one small scheduling
guard for the live side. Phase 2 (below) is exposing the registration
side through the UI (persistent meet-switcher, etc.) — live results needs
no new UI at all. **Phase 1 does not change any user-visible behavior**
— it only removes the schema-level blocker so Phase 2 has something to
build on.

## Current state (verified against the code and against a real Splash
Team Manager `.mdb` file)

The backend has two schemas sharing one `Base`/database:

| Schema | Tables | Shape | Used for |
|---|---|---|---|
| **Team Manager** (`models_team.py`) | `meets`, `sessions`, `events`, `results`, `membersmeets`, `relays`, `relayspos` | Real `meetsid` FK on every row — already multi-meet, matches Splash's actual Team Manager `.mdb` format field-for-field (confirmed by schema-dumping an uploaded Team.mdb) | Historical archive only, populated once at results-import time; **never read or written during live registration** |
| **Meet Manager** (`models.py`) | `swimstyle`, `swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`, `bsglobal` | **No `meetsid` column at all** — one physical row-set represents "the current meet," full stop | Everything live: `GET /api/sessions` (every registration screen), individual/relay entry, export/import, heat status |

`swimstyle` is the one table genuinely shared between both — no `meetsid`,
by design, on both the Splash original and ours (confirmed directly from
the uploaded `.mdb`). It's a global stroke/distance catalog, not per-meet
data, and should stay that way.

The singleton is enforced by two mechanisms today, both in
`routers/api.py`:

1. **No FK to scope by** — `SwimSession`/`SwimEvent`/`AgeGroup`/`SwimResult`/`Heat` rows aren't tagged with which meet they belong to.
2. **`bsglobal` flat key-value config**, one row per key, no meet dimension. `_reset_for_next_meet` (`api.py:2507`) and `flush_meet` (`api.py:2446`) enumerate exactly which keys are meet-scoped by deleting them wholesale on every reset:

   ```
   meet_filename, meet_uploaded_at, meet_name, meet_course, meet_masters,
   meet_currency, meet_fees_json, closure_date, organizer_club_id,
   current_meetsid, MEETVALUES, meet_nation, meet_city
   ```

   Everything **not** in that list (`admin_pin`, `backup_interval_days`,
   `backup_max_count`, Gemini keys, `bt_*` best-time cache) is genuinely
   app-level config, not meet-scoped, and stays in `bsglobal` untouched.

Both reset paths currently do **blanket deletes** (`db.query(SwimResult).delete()`, etc.) — there's no way today to clear one meet's registrations without clearing all of them.

No migration framework exists (no Alembic). Schema changes ship via
`Base.metadata.create_all(bind=engine)` at startup (`main.py:124`), which
only creates *missing tables* — it does not add columns to existing
tables. The one precedent for a real schema change (`main.py:110-122`,
the SERC migration) drops and lets `create_all` rebuild, which is fine for
throwaway SERC data but not acceptable here — the columns we're adding
must be added in place, preserving existing registrations.

## Target data model

### 1. `meets` becomes the identity anchor for both schemas

No new "meet registry" table. `meets` (Team Manager schema) already models
a meet: `name`, `course`, `deadline`, `feeclub`/`feeperson`/`feerelay`,
`meetstate`, `mindate`/`maxdate`. It's already created on every
`new-meet` call and pointed to by `current_meetsid` — it's just under-used.
Phase 1 promotes it to be the FK target for the Meet Manager tables too.

Two additions to `meets` itself:

| New column | Purpose |
|---|---|
| `meet_type` (`POOL`/`BEACH`) | First-class instead of a `bsglobal` scalar — this is the one field concurrency rules actually key off. |
| `registration_open` (boolean) | `meetstate` already distinguishes planned(0)/completed(3); this adds "is this meet currently accepting entries," independent of archival state. Any number of meets — pool, beach, or a mix — can have `registration_open = true` at once; there's no type-based cap (see Phase 2). |

### 2. Add `meetsid` FK to the Meet Manager tables

```
swimsession.meetsid  → meets.meetsid   (nullable → backfilled → NOT NULL)
swimevent.meetsid    → meets.meetsid
agegroup.meetsid     → meets.meetsid
swimresult.meetsid   → meets.meetsid
heat.meetsid         → meets.meetsid
```

`split` needs **no new column** — it cascades from `swimresult`
(`ondelete="CASCADE"` already on `Split.swimresultid`), so scoping a delete
to one `meetsid` on `swimresult` transitively cleans up its splits at the
DB level. Same reasoning could apply to `heat` (cascades from
`swimevent`), but `heat` gets a direct column anyway since it's queried on
its own (`api.py:1780`, `2450`, `2530`) and a direct column avoids an extra
join on every read.

`swimstyle` and `bsglobal`'s app-level keys are unchanged.

### 3. Retire the 13 meet-scoped `bsglobal` keys into a meet-scoped config table

Rather than widen `meets` with team-app-only columns Splash doesn't have
(`meet_fees_json`, `MEETVALUES`, etc.), introduce:

```sql
CREATE TABLE meet_config (
  meetsid INTEGER REFERENCES meets(meetsid) ON DELETE CASCADE,
  name    VARCHAR(50),
  data    TEXT,
  PRIMARY KEY (meetsid, name)
);
```

This is `bsglobal`'s exact shape with `meetsid` folded into the primary
key — the smallest possible diff from what already exists, and it lets
`_get_config`/`_set_config` become thin wrappers that take an extra
`meetsid` argument instead of being redesigned. The 13 keys above move
here; everything else stays in `bsglobal`.

`organizer_club_id` moves into `meet_config` too — organizer assignment is
inherently per-meet (a club could organize a beach meet while a different
club organizes the concurrent pool cycle).

### 4. `secret_links` (self-invite) gets `meetsid`

An invite link must resolve to one specific meet once more than one can be
open. Add `meetsid` (nullable, backfilled to the current meet at migration
time, NOT NULL after).

### 5. Live results (`models_live.py`) — stays a singleton, on purpose

Correction from an earlier draft of this plan: I'd initially treated
`models_live.py` as a fourth table set needing the same `meetsid`
treatment as everything else. That's not right, and it's worth recording
why, since the reasoning is the whole point.

**Registration periods can overlap. Competition days cannot.** Two meets
can both be collecting entries at once (that's the entire premise of this
plan), but a meet's *sessions* each pin to one calendar date, and two
meets never schedule a session on the same day — there's no world where
two physical competitions are both running live on the same weekend. Live
mode is only ever meaningful while a session is actually happening, so at
most one meet is ever genuinely "live" at any moment, by the nature of
the thing, not by a rule the software has to invent. `models_live.py`
being a singleton isn't a gap to close — it's already the correct shape
for a concept that only ever has one active instance. Adding `meetsid`
scoping, per-meet secrets, and WebSocket rooms here would be solving a
collision that can't occur, at real cost to the live subsystem's
simplicity.

**What Phase 1 actually needs here is much smaller: make the "no two
sessions on the same day" assumption an enforced invariant instead of an
unenforced convention**, now that overlapping *registration* periods are
becoming normal. Concretely:

- When a session's date is saved (session create, and `PUT
  /api/sessions/{id}` — `api.py`, see "Session Date" in the team-app
  CLAUDE.md), reject the write if any other meet already has a session on
  that date. This is the one new check — small, and it's what actually
  keeps the live tables' singleton assumption true going forward, rather
  than just hoping nobody schedules a conflict.
- Small defense-in-depth backstop, not the primary safeguard: track which
  `meetsid` currently owns the live tables (`bsglobal.LIVE_ACTIVE_MEETSID`,
  set by `enable_live_mode`, cleared by `finalize_meet`). If
  `enable_live_mode` is called for a *different* meet while a previous
  meet's live data hasn't been finalized or cleared yet, reject with a
  clear message ("Meet X's live results haven't been finalized — finalize
  or clear them first") instead of silently overwriting the secret and
  mixing two meets' heats into one table. This only ever fires if the
  session-date rule above was somehow bypassed or an organizer forgot to
  finalize before their next session — it shouldn't come up in practice.

No `meetsid` column, no widened keys, no per-meet secrets, no WebSocket
room scoping, no changes to `finalize_meet` beyond the guard above. This
is a two-line schema addition (`LIVE_ACTIVE_MEETSID`) plus one validation
check, not a fourth migration surface.

### 6. Bonus fix, folded in here since it's the same subsystem: scope the live page to today's session

Separate from concurrency, but caught while tracing this code: the live
page doesn't currently show "today's session" at all — it shows
**everything ever pushed since live mode was last enabled.**
`GET /api/live/events` (`live.py:441`) has no date filter, `LiveEvent`
rows are only ever cleared by `finalize_meet` at the very end of the whole
meet, and the frontend (`ResultsPage.jsx`'s `LiveView`) just renders
whatever that endpoint returns. So on a multi-day meet, day 1's events sit
in the sidebar right through day 3; if heats are ever generated for the
whole meet in one action, every day's events show from day one.

This is worth fixing here rather than separately, because it directly
reinforces decision #5 above: once the live page only shows *today's*
session, "at most one meet is ever genuinely live" stops being just a
scheduling argument and becomes something the page itself enforces by
construction — there's structurally nothing from a different day (or a
different meet, since two meets never share a session day) for it to
display.

Concrete fix:

- `LiveEvent` gains a `session_date` column.
- meet-app's `_pushStartListsAfterGeneration` (`index.ts:2226`) already
  joins `swimsession` for `sessionnumber`/`name` — it just needs to also
  select `s.startdate` (confirmed present in meet-app's own schema,
  `schema.ts:53`, currently unused by any live-push code) and include it
  as `session_date` in `eventsPayload` (`index.ts:2263`).
- `GET /api/live/events` filters `WHERE session_date = <today>` by
  default. No session scheduled today → empty list, same "waiting for
  events" empty state the page already shows.
- No frontend change needed — `LiveView` already just renders whatever
  the endpoint returns; the filter lives entirely server-side.

## Migration mechanics

This is the project's first true in-place ALTER migration (every prior
schema change was either a new table or, for SERC, an acceptable
drop/rebuild). Concretely, at startup, before `create_all`:

1. Detect existing installs (the `swimevent` table exists and has no
   `meetsid` column).
2. `ALTER TABLE ... ADD COLUMN meetsid INTEGER` (nullable) on the five
   registration tables and `secret_links`. `live_results`, `live_startlist`,
   `push_subscriptions` are **unchanged** — see "Live results" above, they
   intentionally stay a singleton. `live_events` gets one unrelated
   addition: `ADD COLUMN session_date DATE` (nullable — old rows without
   it just won't match the "today" filter, which is fine, they're stale
   anyway and get cleared on the next `finalize_meet`).
3. Backfill: every existing row gets the value currently in
   `bsglobal.current_meetsid` (there is, by construction, only one meet
   today — this is a safe 1:1 backfill, not a guess).
4. Add the FK constraint and flip to `NOT NULL` once backfilled.
5. Create `meet_config`, copy the 13 registration keys out of `bsglobal`
   for the current `meetsid`, delete them from `bsglobal`. `LIVE_ENABLED`/
   `LIVE_PUSH_SECRET`/`LIVE_LAST_PUSH` stay in `bsglobal` as-is; add
   `LIVE_ACTIVE_MEETSID` alongside them.
6. Add `meet_type`/`registration_open` columns to `meets`, backfill
   `meet_type` from the existing `bsglobal.meet_type` value and
   `registration_open = true` for the current meet.

**Decision: stay with hand-rolled startup SQL, not Alembic.** This is the
first migration with real data-preservation stakes, which made Alembic
worth weighing, but adopting a migration framework is a tooling shift
that outlives this feature and isn't needed to ship it. The existing
pattern just needs to be additive (checked `ALTER TABLE ... ADD COLUMN`,
not the SERC precedent's drop/rebuild) rather than redesigned. Revisit
Alembic on its own merits if more migrations like this accumulate.

## Query-layer changes (Phase 1 scope only)

Phase 1's rule: **behavior stays identical to today** — it just becomes
parameterized instead of hardcoded to "the whole table." A single
`get_active_meetsid(db)`-style helper resolves to the one meet with
`registration_open = true` (today, always exactly one — same as
`current_meetsid` now), and every direct query against the five scoped
tables gains a `.filter(meetsid == active)`.

Sizing the blast radius (occurrences of the affected model names per
file, not all are call sites — real audit happens during implementation).
Registration tables (`SwimSession`/`SwimEvent`/`AgeGroup`/`SwimResult`/
`Heat`/`Split`/`BsGlobal`):

| File | Occurrences |
|---|---|
| `routers/api.py` | 210 |
| `export.py` | 23 |
| `invoices.py` | 19 |
| `seed.py` | 10 |
| `events.py` | 9 |
| `routers/live.py` | 9 |
| `main.py` | 6 |
| `routers/push_notifications.py` | 4 |
| `export_entries.py` | 3 |
| `meet_parser.py` | 3 |
| `historical_import.py` | 2 |
| `best_times.py` | 2 |

Live-results tables (`LiveEvent`/`LiveResult`/`LiveSplit`/`LiveStartlist`/
`PushSubscription`) need **no query changes** — they stay unscoped, per
the "stays a singleton, on purpose" reasoning above. The only touch point
is `enable_live_mode` (`live.py:524`), which gains the
`LIVE_ACTIVE_MEETSID` guard, and the session-date-save endpoints, which
gain the same-day-exclusivity check.

The payoff: `flush_meet`/`_reset_for_next_meet`/`create_new_meet` change
from blanket `db.query(X).delete()` to `.filter(meetsid == target).delete()`
— which is what actually unlocks closing one meet (beach's scoped
flush, or pool's results-import archival) without touching whatever else
is concurrently open, pool or beach.

## Non-goals for Phase 1

- No multi-meet picker, organizer meet-switcher, or any new UI (Phase 2).
- No relaxation of "one active meet" at the *application* layer — the
  schema will support several `registration_open = true` rows, but
  Phase 1 doesn't change any endpoint's behavior yet, so only one meet
  will ever be marked open in practice until Phase 2 wires up the logic
  that decides when a second one is allowed to open (and the rule that
  pool stays exclusive with itself while beach doesn't).
- No change to meet-app/LXF import-export contracts — still one physical
  meet exported/imported at a time. A `meetsid` filter on the export
  endpoints is Phase 2 scope, once there's actually more than one open
  meet to choose between.

## Testing

- Full existing integration suite (`tests/`) must pass unchanged —
  regression safety net proving Phase 1 didn't alter single-meet behavior.
- New: migration backfill test — spin up a pre-Phase-1-shaped DB with one
  meet's worth of data, run the migration, assert every row landed on the
  correct `meetsid` and no data was lost.
- New: scoped-delete test — create two `meets` rows with independent
  `swimevent`/`swimresult` data (directly via the DB, no UI/API needed
  yet), run the new scoped flush against one `meetsid`, assert the other
  meet's rows are untouched. This is the actual new capability Phase 1
  delivers and should be verified even before Phase 2 exposes it.

## Decisions

1. **Migration tooling: hand-rolled, not Alembic.** See rationale above —
   this feature doesn't need a framework adoption bundled into it.
2. **`meet_config` side table, not widened `meets` columns.** Smallest
   diff from what exists, keeps `meets` matching Splash's real shape,
   `_get_config`/`_set_config` just gain a `meetsid` parameter.
3. **New `registration_open` boolean, not an overloaded `meetstate`
   value.** Keeps the archival state machine (`meetstate != 3` checks
   throughout `api.py`) untouched and orthogonal to registration-window
   state.

---

# Phase 2: UI Adaptation

## Goal

Phase 1 makes concurrent meets *representable*; nothing about the app's
behavior changes yet — exactly one meet is ever marked
`registration_open` in practice. Phase 2 is what actually lets a second
beach meet open while one is already running, and surfaces that safely to
organizers, admins, and coaches.

**Design constraint carried over from the original ask:** the common case
(pool, or a single beach meet) must look and feel exactly like it does
today. Any new picker/selector UI must be conditional on there genuinely
being more than one open meet — it should be invisible the rest of the
time, and it must never require a second PIN.

## Current state (verified in code)

Routing and auth have no meet dimension at all today:

- `POST /api/auth` (`Login.jsx:43`) returns `{role, club_id, club_name}` —
  no meet identifier.
- `AppInner` (`main.jsx:268`) stores `pin`/`role`/`club_id`/`club_name` in
  `localStorage` and renders one fixed route tree — there's no `meetId`
  anywhere in the routes, state, or `localStorage`.
- Every page (`IndividualEntryPage`, `RelayEntryPage`, `EventsPage`,
  `Organizer.jsx`, `Admin.jsx`) implicitly operates on "the current meet"
  by calling endpoints (`/api/sessions`, `/api/meet-info`, etc.) with no
  meet parameter, because until Phase 1 there was only ever one.

Phase 2 has to thread a `meetId` through all of this — the interesting
design work is making that threading disappear in the single-meet case.

## Application-layer business rule (new in Phase 2 — Phase 1 only stores the flag)

Phase 1 added `meets.registration_open`, but didn't decide who's allowed to
set it. The first draft of this plan assumed pool meets never overlap and
hard-coded a "max 1 open pool meet" cap — that assumption doesn't hold:
there's a 2-week gap between pool meets in January–February 2027 tight
enough that their registration windows can overlap too. So the real rule
isn't about sport type at all:

- **No system-enforced cap, for either type.** Admin can open a new meet
  (pool or beach) regardless of what's already `registration_open` — the
  decision to run two meets concurrently is an organizational call, not
  something the schema or backend should block.
- Type only matters for *what happens when a meet closes* (Phase 1's
  distinction stands: beach closes via the scoped delete/flush, no
  archive, since there's nothing to keep; pool closes via the existing
  results-import → historical-archive path) — not for how many can be
  open at once.

This removes the type-based guard clause from `create_new_meet`
(`api.py:578`) altogether rather than adding one — one less special case,
and it no longer silently breaks the next time meet scheduling gets tight
in either sport.

## Admin: from "the current meet" to a meets list

`Admin.jsx` today assumes one meet's worth of config. It becomes a small
**meets dashboard**:

- List of meets with `registration_open = true` (plus recently-closed ones
  for a beat, for undo/visibility), each row showing type (pool/beach),
  name, dates, organizer club, closure date, registration count.
- "New meet" flow keeps asking pool/beach as it does today
  (`create_new_meet`'s existing `meet_type` body param), but now:
  - Pool: blocked with an explanatory message if a pool meet is already
    open (see rule above).
  - Beach: always allowed, simply adds a row to the list.
- Per-meet actions replace the current global ones: "assign organizer"
  (writes meet-scoped `organizer_club_id` into `meet_config`), "close
  registration" (the Phase-1 scoped delete/flush, targeted at one
  `meetsid` — this is the lightweight "clear it, no results, no archive"
  action for beach), "edit closure date."
- Backup/restore, best-times, Gemini keys, historical meets list: **no
  change** — these already operate across all data or are app-level, not
  meet-scoped.

## Role is per-(club, meet), not per-login

This is a correction from the first draft. An organizer's club doesn't
only organize — while running meet A, the same club is very likely also
*entering athletes as a participant* in a concurrently-open meet B (their
own coach registering swimmers for the other beach meet), and Admin
manages every open meet at once by definition. So `role` can't be resolved
once at login and held fixed — it's a function of **which meet is
currently selected**:

- `admin`: global, same for every meet (unchanged).
- a club's role is **per meet**: e.g. club X is `organizer` for meet A and
  plain `coach` for meet B, simultaneously.

`POST /api/auth` changes to return the club's full list of open meets,
each tagged with that club's role for it, instead of one flat `role`:

```json
{
  "club_id": 12,
  "club_name": "CNSM",
  "meets": [
    { "meet_id": 3, "name": "Beach Meet A", "role": "organizer" },
    { "meet_id": 4, "name": "Beach Meet B", "role": "coach" }
  ]
}
```

## Meet switcher — persistent, not a login-time picker

Given the above, switching meets is routine, not an edge case — it needs
to happen without logout/login, and the visible tabs need to update to
match the role for whichever meet is currently selected (an organizer tab
should appear for meet A and disappear for meet B, in the same session).

Design: a **meet-switcher dropdown in `AuthLayout`'s title bar**
(`main.jsx:197`, next to the existing club-name/language/logout controls),
always shown when the logged-in identity (club or admin) has more than one
open meet:

- Selecting a meet sets the active `meetId` in state + `localStorage`
  (alongside `pin`/`club_id`) and re-derives `canOrganizer`/`canAdmin` from
  that meet's role instead of a fixed login-time value — the tab bar
  (`main.jsx:202-209`) already reads `canOrganizer`/`canAdmin` to decide
  which tabs render, so this is a matter of recomputing those two booleans
  per selection rather than once at login, not a tab-bar redesign.
  `IndividualEntryPage`/`RelayEntryPage`/`EventsPage` keep working exactly
  as they do today once `meetId` changes — no new UI inside those pages.
- **Exactly 1 open meet** (pool always, most of beach season): no dropdown
  rendered at all, `meetId` resolved silently — zero visible change from
  today, same PIN, same click path.
- **More than 1 open meet**: dropdown appears, defaults to picking one
  sensibly (e.g. the meet with the nearest closure date, or an
  organizer-role meet over a coach-role one), and switching is a single
  click, no page reload, no re-auth.
- Admin gets the same dropdown, scoped to all open meets rather than just
  the ones a specific club participates in — reusing the same component
  rather than building a separate admin-only switcher.

**Self-invite / secret links** (`Secret.jsx`, `SelfInvite.jsx`) are
unaffected by this — they already carry a token Phase 1 ties to one
`meetsid`, so a coach arriving via a meet-specific invite link lands
directly on that meet regardless of what else is open; the switcher is
only relevant for the generic PIN-login path.

## Organizer/Admin practical effect

`Organizer.jsx` and `EventsPage.tsx` barely change beyond reading `meetId`
from context instead of assuming "the current meet" — same screens, no new
UI inside them. LXF export/import (`/api/export/registrations-lxf`,
`/api/upload/meet`, etc.) take whatever `meetId` is currently active in the
switcher.

## Live results — no new UI needed

Since at most one meet is ever genuinely live (sessions can't collide on a
calendar day — see Phase 1), the public `/results` page, the organizer
live-config screen, and the WebSocket broadcast are **unchanged in Phase
2**. There's no second live meet to pick between, so there's nothing to
build here beyond what Phase 1 already added:

- If an organizer tries to enable live mode while a previous meet's live
  data hasn't been finalized (the `LIVE_ACTIVE_MEETSID` guard from Phase
  1), they see a clear error telling them to finalize or clear the
  previous meet first — a message, not a new screen.
- If the session-date exclusivity check (Phase 1) rejects a session date
  because another meet already has one that day, the organizer sees that
  at the point they're setting the date, in the same session-properties
  panel they already use — no new UI, just a new validation error path
  that didn't exist before because the conflict wasn't previously
  possible.

**The "today's session only" fix (Phase 1, item 6) also needs no Phase 2
work.** It's a server-side filter on `GET /api/live/events` — `LiveView`
in `ResultsPage.jsx` already just renders whatever that endpoint returns,
so the visible effect (spectators only ever see today's events instead of
the whole meet's history-to-date) falls out automatically once the filter
ships, with no frontend change.

## Frontend plumbing

- `localStorage`: add `meet_id` alongside the existing `pin`/`role`/
  `club_id`/`club_name`.
- Every API call that currently implies "the current meet" (`meetApi.js`,
  `registrationApi.js`, and the shared `ApiContext`/`RegistrationApiContext`
  providers in `shared-ui`) starts sending `meet_id` — as a header
  (consistent with the existing `X-Club-Pin` header pattern) rather than
  threading it through every function signature in `shared-ui`, so
  `EventsPage.tsx`/`IndividualEntryPage.tsx`/`RelayEntryPage.tsx` need
  **no changes at all** — they keep calling the same `MeetAPI` interface,
  and the HTTP adapter layer (team-app-specific, not shared) attaches the
  meet context.
- Backend endpoints read `X-Meet-Id` the same way they already read
  `X-Club-Pin`. If absent (old clients, or a club/admin with only one open
  meet), it resolves to that one open meet; if the identity has more than
  one open meet and no `X-Meet-Id` is sent, the backend returns a 409 with
  the candidate list rather than guessing — the frontend switcher always
  sends it once it knows there's a choice.

## Non-goals for Phase 2

- No change to `shared-ui` components' public API/props — the meet
  dimension is carried at the HTTP-adapter layer, not the shared
  component layer, specifically so meet-app's Electron IPC adapter (which
  has no concurrency problem) needs zero changes.
- No support for viewing/editing two meets side-by-side in the same
  browser tab — switching is a one-click dropdown selection, not
  simultaneous split-screen use. Two tabs/windows already gives a user
  who wants that today (each tab holds its own `meetId` independently).

## Testing

- Meet-switcher integration test: a club that's `organizer` for meet A and
  `coach` for meet B sees the dropdown, the tab bar updates correctly on
  switch (Organizer tab present for A, absent for B), and a club/admin
  with only one open meet never sees the dropdown at all — regression
  check for the "invisible in the common case" requirement.
- Admin flow test: opening a second pool meet while one is already
  `registration_open` succeeds (covers the January–February 2027 case
  directly) and both remain independently manageable — closure dates,
  entries, and closing one doesn't touch the other.
- Self-invite test: a meet-specific invite link lands directly on that
  meet without the switcher appearing, even when the invited club has
  other open meets.
- Session-date exclusivity test: saving a session date that collides with
  another currently-open meet's session date is rejected; non-colliding
  dates across two open meets save fine.
- `LIVE_ACTIVE_MEETSID` guard test: enabling live mode for meet B while
  meet A's live data is still sitting un-finalized is rejected with a
  clear message; enabling live mode for meet A again (or after meet A is
  properly finalized) succeeds.
- Today's-session filter test: `live_events` rows with yesterday's or
  tomorrow's `session_date` don't appear in `GET /api/live/events`; rows
  matching today's date do. Covers the day-boundary edge (a session
  running late into the evening should still count as "today" by its
  `session_date`, not wall-clock time crossing midnight).

## Verified against current code (2026-08-11) — corrections to the plan above

Re-checked every assumption above against the actual Phase-1-merged code before
starting implementation. Most of the plan holds; three things are materially
different from what's described above, and one is a gap worth closing in the
same pass:

1. **The real blocker isn't a "pool-exclusivity guard clause" — it's a
   blanket wipe.** The plan (§"Application-layer business rule") says to
   remove a type-based guard from `create_new_meet`. That guard doesn't
   exist. What actually runs today, in **both** meet-creation paths —
   `create_new_meet` (`POST /admin/new-meet`, `api.py:553`) and
   `_replace_current_meet_structure` (the LXF-structure-upload path used by
   `POST /upload/meet`, `api.py:442` — this is how meets get created in
   practice, via the organizer uploading meet-app's exported structure LXF)
   — is an unconditional delete of **every** non-archived (`meetstate != 3`)
   meet's sessions/events/results/age-groups before building the new one
   (`api.py:457-467`). Today that's a no-op-looking cleanup because there's
   only ever one non-archived meet. Under Phase 2 it would silently destroy
   a second meet's live registrations the moment anyone opens a third. This
   is the highest-risk change in Phase 2, bigger than the doc originally
   implied — it needs its own design pass: stop scoping the wipe to "every
   non-archived meet" and scope it to nothing (a brand-new `meets` row,
   nothing to wipe) except for the genuine re-upload case (organizer
   re-uploading a corrected structure LXF for the *same* still-open meet,
   which legitimately should wipe that one meet's data). Needs a way to
   distinguish "new meet" from "re-upload of the currently-selected meet" —
   likely keyed off the incoming `X-Meet-Id` header once Phase 2 adds it:
   present + matches an open meet → scoped re-upload wipe; absent → create a
   new `meets` row.
2. **`POST /api/auth` today returns exactly `{role, club_id, club_name}`**
   (`api.py:416-435`, three branches: admin PIN / PIN matches
   `organizer_club_id` config → `organizer` / else `coach`) with zero
   meet-awareness — confirms the doc's description is accurate, just noting
   the precise current shape the rework replaces.
3. **`Admin.jsx` has no current-meet UI to convert.** It has no "current
   meet" section at all today — the only meet-list UI in the file is
   `HistoricalMeetsSection` (archived meets, unrelated). `meetApi.js`'s
   `createMeet()` (line 201) is dead code — nothing in the frontend calls
   it; meets are created server-side, either via the LXF-structure-upload
   flow above or manually via `/admin/new-meet` (not yet exposed in any UI).
   So the "meets dashboard" in Admin.jsx isn't a conversion of existing
   markup, it's new UI end to end, and it needs its own "create meet"
   button/form since one doesn't exist anywhere in the frontend today.
4. **Gap to close alongside this:** `PUT /api/sessions/{id}` runs the
   same-day exclusivity check (`_check_session_date_exclusivity`,
   `api.py:1357`) when `startdate` changes, but `POST /api/sessions`
   (session *create*, `api.py:1472`) does not — a brand-new session can be
   created with a colliding date and only gets caught on the next edit.
   Small fix, same helper, worth doing in the same pass as the rest of
   Phase 2's meet-lifecycle work rather than filed separately.

Everything else in the plan above matches current code exactly:
`get_active_meetsid` (`meet_config.py:47`) already resolves off
`registration_open`; `secret_links.meetsid` is already populated
(`api.py:942`); the `LIVE_ACTIVE_MEETSID` guard in `enable_live_mode`
(`live.py:557-566`) and the `PUT /api/sessions/{id}` exclusivity check both
already work exactly as described — Phase 1 delivered the live-results
side in full, Phase 2 needs no further work there beyond the create-endpoint
gap in point 4.

## Phase 2 implementation sequence

Ordered so each stage is independently testable and the app stays in a
working, single-meet-equivalent state after every stage (no big-bang
cutover):

1. **Fix the wipe-all-on-create bug** (finding #1 above). **Done, and
   verified for real in WSL 2026-08-11** — see
   `_replace_current_meet_structure`/`create_new_meet` in `api.py` and
   `_load_from_parsed` in `events.py`. Landed first, as planned — every
   later stage assumes opening meet B is safe while meet A is open, and
   before this it wasn't. Backend only; no visible behavior change in the
   single-meet case. The first real Docker-backed run (the "no Docker
   available in this pass" gap the original note here flagged) surfaced a
   second bug in the same neighborhood — see "Composite PK follow-up"
   below — now fixed and covered by
   `tests/unit/test_meet_creation_wipe_scope.py`,
   `TestNewMeetPreservesHistory`, `TestUploadMeetPreservesHistory`,
   `test_swim_styles_filtered_to_current_meet_type`, and the new
   `TestConcurrentOpenMeetsStayIsolated`. Two implementation decisions the
   plan above didn't spell out:
   - `_replace_current_meet_structure` (`/upload/meet`) now **reuses** its
     target meet's identity (same meetsid) instead of deleting and
     recreating it — `_load_from_parsed` gained a `reuse_meetsid` parameter
     for this. Needed so meet_config/secret_links/organizer_club_id (all
     keyed by meetsid) survive a routine re-upload instead of being
     orphaned. Defaults to `get_active_meetsid(db)` when no explicit target
     is given (no header yet), preserving today's single-meet behavior
     exactly.
   - `create_new_meet` (`/admin/new-meet`) always creates a genuinely new
     meetsid (its whole job), and now **closes** (sets
     `registration_open=False`) rather than deletes whatever meet was
     previously active — deleting would still risk destroying a
     concurrently-open meet's data; leaving it silently open would leave an
     invisible second `registration_open=True` row colliding with the new
     meet's session dates via `session_date_conflict`. This is a stopgap
     until Stage 7's admin dashboard can make "keep it open" an explicit
     choice instead of an implicit close.
2. **`POST /api/auth` returns `meets: [{meet_id, name, role}]`** instead of
   a flat `role` (finding #2). Backend only. Frontend keeps reading
   `role`/`club_id`/`club_name` off the first/only entry for now — no
   frontend change yet, so this stage ships without touching the UI.
3. **`X-Meet-Id` header plumbing**: every endpoint that currently calls
   `get_active_meetsid(db)` reads `X-Meet-Id` when present (validating it
   against the caller's accessible meets) and falls back to today's
   single-open-meet resolution when absent; 409-with-candidates when the
   identity has >1 open meet and no header was sent. Backend only —
   existing single-meet clients (old frontend build, meet-app's LXF
   import/export calls) keep working unchanged since they never send the
   header and there's only ever one open meet until stage 5 lands.
4. **Session create-time exclusivity check** (finding #4) — small, bundle
   into this stage since it touches the same `api.py` neighborhood.
5. **Frontend plumbing**: `meet_id` in `localStorage`, meet context reads
   `meets[]` from the new `/auth` response, sends `X-Meet-Id` on every
   request. Still no visible UI change when there's one open meet.
6. **Meet-switcher dropdown in `AuthLayout`** (`main.jsx:197`), wired to
   recompute `canOrganizer`/`canAdmin` (`main.jsx:314-315`) per selected
   meet instead of once at login. Invisible until stage 7 makes a second
   open meet reachable.
7. **Admin meets dashboard** — genuinely new UI (finding #3): list of open
   meets, a "new meet" pool/beach flow finally exposed in the frontend
   (wired to the now-safe `/admin/new-meet` from stage 1), per-meet
   organizer-assignment and close-registration actions. This is the stage
   that makes a second concurrently-open meet reachable in practice, so
   land it last, once 1-6 have made it safe to.
8. **Tests** per the "Testing" section above, plus regression coverage for
   finding #1 specifically (open meet B via both `/admin/new-meet` and
   `/upload/meet` while meet A has live registrations; assert meet A's
   sessions/events/results are untouched) and finding #4 (colliding
   session-create date rejected, not just colliding session-edit date).

## Decisions

1. **Meet switching: persistent title-bar dropdown, not logout/re-pick.**
   Settled, and reconfirmed by Vincent 2026-08-11 — an organizer's club is
   routinely also a participant in a concurrent meet, and admin manages all
   open meets at once, so switching is routine behavior, not a rare edge
   case. A dropdown in `AuthLayout` that recomputes `meetId` and the
   derived `canOrganizer`/`canAdmin` flags is the right shape; logout/login
   would punish the exact users who need this most.
2. **Admin meets-dashboard scope** — still open: should recently-closed
   beach meets stay visible/undoable for a grace period, or does "close
   registration" delete immediately with no recovery window (matches "no
   results, throw it away" today, but worth confirming that's still fine
   now that it's a more visible, deliberate admin action rather than an
   end-of-cycle default)?
3. **Meet-creation wipe scope (new, from the 2026-08-11 verification pass).**
   Settled by Vincent 2026-08-11 — `X-Meet-Id` present and matching an
   already-open meet means "re-upload the structure for this meet" (scoped
   wipe of just that meet's sessions/events/results/age-groups); `X-Meet-Id`
   absent, or present but not matching any open meet, means "create a new
   meet" (nothing to wipe). Implemented as stage 1 of the sequence above.
4. **`swimeventid`/`agegroupid` collisions: composite primary key, not id
   remapping (new, from the 2026-08-11 WSL test run).** Settled by Vincent
   2026-08-11. See "Composite PK follow-up" below for the full story —
   `(meetsid, swimeventid)`/`(meetsid, agegroupid)` composite keys, not
   remapping ids on load, so the LXF's literal ids stay meaningful per meet.

## Composite PK follow-up (2026-08-11) — closing the "no Docker available" gap

Stage 1 above was merged (`dd5d686`) without a real Docker-backed test run —
the plan doc said so explicitly at the time. Running the full suite in WSL
for the first time surfaced a real regression: `POST /admin/new-meet` and
`POST /upload/meet` both 500'd with
`psycopg2.errors.UniqueViolation: duplicate key value violates unique
constraint "swimevent_pkey"`.

**Root cause:** `swimevent.swimeventid`/`agegroup.agegroupid` are plain
global integer primary keys, populated verbatim from the LXF templates
(`config/template_pool.lxf`/`template_beach.lxf`) by
`events.py::_load_from_parsed` — fixed ranges (1065-1234 / 1066-1236),
identical every time a meet is created from the template. Before Stage 1, a
new meet always wiped the previously active meet's rows first, so reusing
those fixed ids was invisible. Stage 1 deliberately stopped wiping a
still-open meet's data — the whole point of concurrent meets — so meet B's
insert now collides with meet A's still-present rows at the same ids. This
wasn't specific to genuinely *concurrent* meets either: it broke ordinary
sequential meet creation too, the moment an *archived* meet's rows (also
never wiped) occupied the same ids — `TestNewMeetPreservesHistory` is a
direct regression test for that path and was failing before this fix.

**Fix — composite primary key**, decided over remapping ids on load (see
Decision #4 above): `swimevent`/`agegroup`'s primary key became
`(meetsid, swimeventid)`/`(meetsid, agegroupid)` — `meetsid` already existed
on both tables (added by `m0001_concurrent_meets`), so this reuses an
existing column rather than adding one. Migration:
`backend/app/migrations/versions/m0003_swimevent_agegroup_composite_pk.py`
(drops the old single-column PK and dependent FKs, adds the composite PK,
re-adds FKs as composite, widens `uq_swimresult_entry` to include
`meetsid`). `models.py`'s `SwimEvent`/`AgeGroup`/`Heat`/`SwimResult` classes
updated to match (`PrimaryKeyConstraint`/`ForeignKeyConstraint` in
`__table_args__`, explicit `primaryjoin` on the `SwimEvent.agegroups`/
`heats`/`results` relationships so SQLAlchemy joins on both columns, not
just the numeric id).

A full blast-radius audit turned up something bigger than the crash: most
read paths that touch `SwimEvent`/`AgeGroup` had no `meetsid` filter at
all, because until Stage 1 there was only ever one meet so it didn't
matter. A composite PK alone stops the crash, but unscoped reads would
still silently mix two concurrently-open meets' sessions, events,
registrations, invoices, and exports — worse than the crash, since it
wouldn't error. Fixed in the same pass: ~15 `db.get()`/`Query.get()`
bare-id lookups (now `(meetsid, id)` tuples) and ~30 unscoped
filter/join sites, across `routers/api.py`, `seed.py`, `routers/live.py`,
`invoices.py`, and `export.py`.

**New test**: `TestConcurrentOpenMeetsStayIsolated` in `tests/test_integration.py`
— forces two `registration_open=True` meets at once (the real precondition;
no endpoint exposes this yet — Stage 7's admin dashboard is what will),
asserts meet A's own rows are byte-for-byte unchanged after meet B is
created reusing the same numeric ids, and that `GET /api/events`/
`/api/sessions` never leak meet A's rows into meet B's (empty) listing.

**Known gap, not closed in this pass:** the migration's ALTER-heavy path
(dropping/re-adding constraints on an existing install) is Postgres-specific
syntax that can't be exercised by the SQLite-based unit tests the way
`m0001`/`m0002`'s simpler `ADD COLUMN` migrations are — it's only verified
by the Docker suite's fresh-install path (where `create_all` builds the
composite-PK shape directly and the migration no-ops) and by code review.
If Vincent has a real pre-Stage-1 production database to upgrade, run the
migration against a copy of it first rather than trusting this blind.
