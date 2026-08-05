# Concurrent Meets — Implementation Plan

## Phase 1: Data Model Uplift

## Problem

Pool meets run one at a time, months apart — the current "one active meet"
model never causes friction there. Beach meets are the exception: they run
frequently within the summer season and their registration windows can
legitimately overlap (e.g. two regional beach meets registering
simultaneously). Today the app cannot represent that: the operational
schema behind live registration holds exactly one meet's data at a time, so
running a second concurrent beach meet requires either a second app
instance or artificially shortening/staggering registration windows so they
never truly overlap.

Phase 1 is the data model change needed to make "more than one meet
registering at once" representable at all. Phase 2 (separate plan) is
exposing that capability through the UI (organizer meet-switcher, coach
picker when a club has more than one open meet, etc.). **Phase 1 does not
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
| `registration_open` (boolean) | `meetstate` already distinguishes planned(0)/completed(3); this adds "is this meet currently accepting entries," independent of archival state. A pool meet and a beach meet can both have `registration_open = true` at once; two pool meets should not (business rule enforced at the application layer, not the DB — see Non-Goals). |

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

## Migration mechanics

This is the project's first true in-place ALTER migration (every prior
schema change was either a new table or, for SERC, an acceptable
drop/rebuild). Concretely, at startup, before `create_all`:

1. Detect existing installs (the `swimevent` table exists and has no
   `meetsid` column).
2. `ALTER TABLE ... ADD COLUMN meetsid INTEGER` (nullable) on the five
   tables above, plus `secret_links`.
3. Backfill: every existing row gets the value currently in
   `bsglobal.current_meetsid` (there is, by construction, only one meet
   today — this is a safe 1:1 backfill, not a guess).
4. Add the FK constraint and flip to `NOT NULL` once backfilled.
5. Create `meet_config`, copy the 13 keys out of `bsglobal` for the
   current `meetsid`, delete them from `bsglobal`.
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
file, not all are call sites — real audit happens during implementation):

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

The payoff: `flush_meet`/`_reset_for_next_meet`/`create_new_meet` change
from blanket `db.query(X).delete()` to `.filter(meetsid == target).delete()`
— which is what actually unlocks closing one beach meet without touching
a concurrently-open second one.

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
set it. Phase 2 owns that rule:

- **Pool**: at most one `meetsid` with `registration_open = true` at a
  time (unchanged from today). Starting a new pool meet while one is open
  is blocked with a clear message, same spirit as today's implicit
  single-meet behavior — just explicit now instead of accidental.
- **Beach**: no such limit. Multiple `registration_open = true` beach
  meets can coexist.

This check lives in `create_new_meet` (`api.py:578`) and needs one new
guard clause per type before allocating the new `meets` row.

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

## Organizer: mostly unchanged, now meet-scoped instead of app-scoped

An organizer session is already tied to one club (`organizer_club_id`). In
Phase 1 that key moved into meet-scoped `meet_config`, which means it was
already implicitly one-club-per-meet — Phase 2 just makes that explicit:
assigning an organizer is a per-meet action (done from the Admin meets
dashboard above), and once assigned, `Organizer.jsx` and `EventsPage`
operate on that one `meetId` for the rest of that organizer's session. An
organizer never juggles multiple meets in one sitting in this design —
Admin assigns one organizer club per meet, same mental model as today,
just no longer assuming there's only one meet in the whole system.

Practical effect: **`Organizer.jsx` and `EventsPage.tsx` barely change.**
They gain a `meetId` they read from context instead of assuming "the
current meet," but the screens themselves don't need new UI.

LXF export/import (`/api/export/registrations-lxf`, `/api/upload/meet`,
etc.) start taking the organizer's bound `meetId` — since it's already
resolved from their session, no new picker needed here either.

## Coach flow — the one place a picker can appear

This is the only surface where genuine ambiguity exists: a club could
have open registrations in two concurrent beach meets. Design:

1. `POST /api/auth` gains a resolved list of open meets that club is
   eligible for (today: always exactly 1; during beach season: possibly
   more, per club).
2. **Exactly 1 open meet** (pool always, beach usually): auth response
   includes that `meetId`, `main.jsx` stores it in `localStorage` next to
   `role`/`club_id`, and every route behaves exactly as it does today —
   zero visible change, same PIN, same click path.
3. **More than 1 open meet for that club**: after PIN entry, insert one
   lightweight screen — a list of the open meets ("Beach Meet A — May
   10–12" / "Beach Meet B — May 24–26"), reusing the meet-info fields
   already returned by `/api/meet-info` per meet. Coach picks one, lands
   on the exact same `IndividualEntryPage`/`RelayEntryPage` they already
   know, now scoped to that `meetId`. A "switch meet" link stays available
   from within the app (small addition to `AuthLayout`'s title bar,
   `main.jsx:197`) rather than forcing logout/login to change meets.
4. **Self-invite / secret links** (`Secret.jsx`, `SelfInvite.jsx`): these
   already carry a token that Phase 1 ties to one `meetsid`. A coach
   arriving via a meet-specific invite link skips the picker entirely —
   the token already answers "which meet." The picker in step 3 is only
   needed for the generic PIN-login path when a club is eligible for more
   than one open meet and arrives without a meet-specific link.

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
  `X-Club-Pin`, defaulting to "the club's one open meet" when the header
  is absent (keeps old clients/tests working during rollout).

## Non-goals for Phase 2

- No change to `shared-ui` components' public API/props — the meet
  dimension is carried at the HTTP-adapter layer, not the shared
  component layer, specifically so meet-app's Electron IPC adapter (which
  has no concurrency problem) needs zero changes.
- No support for an organizer or coach actively working inside two meets
  in the same browser tab at once — switching meets is an explicit action
  (picker or "switch meet" link), not simultaneous split-screen use.

## Testing

- Coach-flow integration test: one club registered in two concurrent beach
  meets sees the picker and lands in the right one; a club in exactly one
  meet (pool, or solo beach) sees no picker at all — regression check for
  the "invisible in the common case" requirement.
- Admin rule test: attempting to open a second pool meet while one is
  `registration_open` is rejected; attempting the same for beach succeeds.
- Self-invite test: a meet-specific invite link bypasses the picker even
  when the invited club has other open meets.

## Open decisions for you

1. **"Switch meet" link placement/frequency** — is switching meets rare
   enough that a logout-and-pick-again flow is fine, or does it need the
   persistent title-bar link described above?
2. **Admin meets-dashboard scope** — should recently-closed beach meets
   stay visible/undoable for a grace period, or does "close registration"
   delete immediately with no recovery window (matches "no results, throw
   it away" today, but worth confirming that's still fine now that it's a
   more visible, deliberate admin action rather than an end-of-cycle
   default)?
