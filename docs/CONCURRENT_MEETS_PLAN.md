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

The same problem exists one layer further in: the real-time live-results
feed meet-app pushes to during a competition (`models_live.py`) is its own
separate singleton, with no meet dimension at all — see the dedicated
subsection below. It's actually the more urgent of the two, since it risks
silent data collision (not just a UX limitation) the moment two physical
meets are live at once.

Phase 1 is the data model change needed to make "more than one meet
active at once" representable at all, for both registration and live
results. Phase 2 (below) is exposing that capability through the UI
(persistent meet-switcher, per-meet live config, etc.). **Phase 1 does not
change any user-visible behavior** — it only removes the schema-level
blocker so Phase 2 has something to build on.

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

### 5. Live results (`models_live.py`) — a fourth singleton, and the most urgent one

This one isn't covered by anything above and deserves its own call-out:
`routers/live.py` is the real-time feed meet-app pushes to during a live
competition (heat results, DSQs, announcements → WebSocket-broadcast to
spectators on `/results`). I checked `models_live.py` directly — it's
**entirely unscoped**, more so than the registration tables:

- `LiveEvent.event_id` is the primary key **on its own** — not even a
  composite key. `LiveResult`/`LiveStartlist` are unique on
  `(event_id, heat_number, lane)`, no `meetsid` anywhere.
- `PushSubscription` (coach DSQ push notifications) is keyed by `club_id`
  only — "cleared on meet finalization (same lifecycle as other live
  tables)" per its own docstring, i.e. it already assumes a single live
  meet's lifecycle.
- Live mode is gated by exactly **one shared secret**:
  `bsglobal.LIVE_PUSH_SECRET`, checked by `require_live_secret`
  (`live.py:83`). `POST /api/live/enable` (`live.py:524`) *generates a
  new secret and overwrites the old one* every time it's called.
- `ConnectionManager` (`live.py:105`) broadcasts every message to **every
  connected WebSocket**, with no per-meet channel/room concept.
- `finalize_meet` (`live.py:565`) promotes *all* `LiveResult` rows to a
  single new historical `Meet` row — it has no way to know two physical
  meets' results are mixed together in there.

**Why this is more urgent than the registration singleton:** the
registration tables degrade gracefully today — nothing breaks until
someone actually tries to open a second concurrent meet, which is exactly
what this whole plan is gating. Live results is different: `event_id`
values are template-based and get reused meet-to-meet (same numbering
scheme every cycle, per the ID-ranges table earlier in this doc), so two
meet-app instances pushing concurrently would very plausibly collide on
the same `(event_id, heat_number, lane)` key today, silently overwriting
each other's live times — *and* the second organizer to call
`/api/live/enable` invalidates the first meet's push secret, breaking
their feed outright. This isn't a missing nicety, it's latent data
corruption waiting for the first time two competitions run live at once.

Fix, same pattern as the rest of this plan:

- Add `meetsid` to `live_events`, `live_results`, `live_startlist`,
  `push_subscriptions`; widen the unique constraints to
  `(meetsid, event_id, heat_number, lane)` and `LiveEvent`'s PK to
  `(meetsid, event_id)`.
- Move `LIVE_ENABLED`/`LIVE_PUSH_SECRET`/`LIVE_LAST_PUSH` out of
  `bsglobal` into the new meet-scoped `meet_config` table — **this is the
  one that actually matters**: each concurrently-open meet gets its own
  independent secret, so a second meet's organizer enabling live mode can
  no longer invalidate a first meet's in-progress push credential.
- `require_live_secret` resolves which `meetsid` a push belongs to *from
  the secret itself* (look up which meet's `meet_config` row holds that
  secret) — meet-app doesn't need to know or send a `meetsid` explicitly,
  it just keeps using the secret it was configured with.

## Migration mechanics

This is the project's first true in-place ALTER migration (every prior
schema change was either a new table or, for SERC, an acceptable
drop/rebuild). Concretely, at startup, before `create_all`:

1. Detect existing installs (the `swimevent` table exists and has no
   `meetsid` column).
2. `ALTER TABLE ... ADD COLUMN meetsid INTEGER` (nullable) on the five
   registration tables, `secret_links`, and the four live-results tables
   (`live_events`, `live_results`, `live_startlist`, `push_subscriptions`).
3. Backfill: every existing row gets the value currently in
   `bsglobal.current_meetsid` (there is, by construction, only one meet
   today — this is a safe 1:1 backfill, not a guess).
4. Add the FK constraint and flip to `NOT NULL` once backfilled; widen
   `LiveEvent`'s PK and the live unique constraints to include `meetsid`.
5. Create `meet_config`, copy the 13 registration keys **and**
   `LIVE_ENABLED`/`LIVE_PUSH_SECRET`/`LIVE_LAST_PUSH` out of `bsglobal`
   for the current `meetsid`, delete them from `bsglobal`.
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
`PushSubscription`) — smaller, self-contained surface, entirely inside the
live subsystem:

| File | Occurrences |
|---|---|
| `routers/live.py` | 45 |
| `routers/push_notifications.py` | 17 |
| `models_live.py` | 5 |
| `routers/api.py` | 5 |

The live-results fix is contained enough (four files, one of them the
model definitions themselves) that it can land alongside the registration
migration in the same Phase 1 pass rather than needing its own phase.

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

## Live results — per-meet push credentials and public view

Phase 1 makes each meet's live secret independent; Phase 2 is what
surfaces that so two organizers can run live mode at once without
coordinating with each other.

- **Organizer's live-config screen** (today: `POST /api/live/enable`,
  `GET /api/live/config`) becomes per-meet — enabling live mode for meet A
  generates a secret scoped to meet A's `meet_config` row and has no effect
  on meet B's. Each meet-app instance is configured with the secret for
  the one physical competition it's running, same as today, just no
  longer capable of stepping on a concurrent meet's credential.
- **Public `/results` page**: `GET /api/live/status` today answers "is
  *a* live meet active" with one flat boolean. It becomes "list of
  currently-live meets." Same invisibility rule as the registration
  switcher: exactly one live meet → spectators land straight on it, no
  picker; more than one → a lightweight list to choose from before landing
  on `ResultsPage.jsx`.
- **WebSocket broadcast becomes per-meet.** `ConnectionManager`
  (`live.py:105`) currently has no concept of "which meet is this
  spectator watching" — every connected socket gets every broadcast. Fix:
  `/api/live/ws` takes a `meet_id` query param, and `manager.broadcast`
  filters to sockets subscribed to the relevant `meetsid` instead of
  blasting everyone. Without this, a spectator watching meet A's beach
  results would also see meet B's heat updates and DSQ alerts mixed in.
- **`finalize_meet`** (`live.py:565`) takes an explicit `meetsid` and only
  promotes that meet's `LiveResult` rows to history, scoped-deletes only
  that meet's live tables — same pattern as the registration side's
  scoped flush, applied here for the same reason (don't touch a
  concurrently-running second live meet).
- **DSQ/announcement push notifications** (`push_notifications.py`)
  currently notify "ALL subscribed coaches" per its own comment — becomes
  scoped to subscribers of the specific meet the DSQ/announcement belongs
  to, via `PushSubscription.meetsid`.

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
- **Live-results isolation test** (the one directly motivated by real
  collision risk, not just UX): enable live mode on two concurrent meets
  that reuse the same `event_id`/`heat_number`/`lane` combination
  (realistic, since IDs are template-based), push results to both, and
  assert neither meet's secret invalidates the other's, no `LiveResult`
  row is overwritten across meets, a spectator connected to meet A's
  WebSocket never receives meet B's broadcasts, and `finalize_meet` on
  meet A leaves meet B's live data untouched.

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
