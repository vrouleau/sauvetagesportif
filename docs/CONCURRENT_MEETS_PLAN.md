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

## Decisions

1. **Meet switching: persistent title-bar dropdown, not logout/re-pick.**
   Settled — an organizer's club is routinely also a participant in a
   concurrent meet, and admin manages all open meets at once, so switching
   is routine behavior, not a rare edge case. A dropdown in `AuthLayout`
   that recomputes `meetId` and the derived `canOrganizer`/`canAdmin` flags
   is the right shape; logout/login would punish the exact users who need
   this most.
2. **Admin meets-dashboard scope** — still open: should recently-closed
   beach meets stay visible/undoable for a grace period, or does "close
   registration" delete immediately with no recovery window (matches "no
   results, throw it away" today, but worth confirming that's still fine
   now that it's a more visible, deliberate admin action rather than an
   end-of-cycle default)?
