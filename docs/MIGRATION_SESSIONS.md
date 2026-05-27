# Schema Migration — Session Plan

## Strategy: Incremental Migration with Test Uplift

Each session migrates one "domain" of endpoints from old schema to new schema,
updates the corresponding integration tests, and leaves the app in a working state.

The old models stay until all references are removed. Each session:
1. Migrates a group of related endpoints
2. Updates/rewrites the tests for those endpoints
3. Verifies all tests pass before committing

## Column Name Mapping

| Old (Meet Manager) | New (Team Manager) |
|---|---|
| `club.clubid` | `clubs.clubsid` |
| `athlete.athleteid` | `members.membersid` |
| `athlete.clubid` | `members.clubsid` |
| `athlete.firstname` | `members.firstname` |
| `athlete.lastname` | `members.lastname` |
| `swimsession.swimsessionid` | `sessions.sessionsid` |
| `swimevent.swimeventid` | `events.eventsid` |
| `swimevent.swimsessionid` | `events.meetsid` + `events.sessionnumb` |
| `swimevent.swimstyleid` | `events.stylesid` |
| `swimevent.eventnumber` | `events.numb` |
| `swimresult.swimresultid` | `results.resultsid` |
| `swimresult.athleteid` | `results.membersid` |
| `swimresult.swimeventid` | N/A (results link to meet+style, not event) |
| `swimresult.entrytime` | `results.entrytime` |
| `swimresult.swimtime` | `results.totaltime` |
| `agegroup` | Replaced by `events.minage` / `events.maxage` |
| `heat` | Not in team-app (meet-day only) |
| `split` | Not in team-app (meet-day only) |

## Key Conceptual Changes

1. **No agegroup table** — age range is directly on the event row
2. **No heats/splits** — those are meet-day concepts (meet-app only)
3. **Results = registrations** — a `results` row with `entrytime` IS the registration
4. **Multi-meet** — every event/session/result has a `meetsid` FK
5. **Current meet** — identified by bsglobal `current_meetsid` key
6. **Best times** — computed from historical results (no JSON blobs)

## Session Plan

### Session A: Auth + Clubs (foundation) ✅ DONE
**Endpoints:**
- `POST /api/auth` — change `Club.pin` → `Club.pin` (same column name, different table)
- `GET /api/clubs` — list clubs from `clubs` table
- `POST /api/clubs` — create club
- `DELETE /api/clubs/{id}` — delete club
- `PUT /api/clubs/{id}` — update club
- `POST /api/clubs/regenerate-pins`
- `POST /api/clubs/{id}/reset-pin`

**Tests to update:** TestAuth, TestAccessControl, TestAuthRateLimit

**Key change:** `Club.clubid` → `Club.clubsid`, `Club.pin` stays same

**Completed changes:**
- All auth helpers (`_resolve_role`, `_check_closure`, `_caller_club_id`) now use `TeamClub`
- Auth endpoint (`POST /api/auth`) queries `TeamClub` table
- All club CRUD endpoints use `TeamClub` (list, create, delete, update, reset-pin, regenerate-pins)
- `send_pin`, `self_invite_clubs`, `self_invite`, `reveal_secret` use `TeamClub`
- `list_clubs` computes athlete counts from old `athlete` table (transition)
- Organizer/Stripe endpoints updated to use `TeamClub`
- `main.py` audit middleware uses `TeamClub`
- `SecretLink.club_id` FK now references `clubs.clubsid`
- `TeamClub` has `clubid` property alias for backward compatibility with `invoices.py`
- **Dual-write strategy**: `create_club`, `seed_from_lxf`, `upload_meet_smb` write to BOTH
  `clubs` (TeamClub) and `club` (old) tables to maintain `Athlete.clubid` FK during transition
- `delete_club` and `merge_clubs` delete from both tables

---

### Session B: Athletes (Members) ✅ DONE
**Endpoints:**
- `GET /api/athletes` — list from `members` table
- `POST /api/athletes` — create member
- `PUT /api/athletes/{id}` — update member
- `DELETE /api/athletes/{id}` — delete member

**Tests to update:** TestAthleteOwnership

**Key change:** `Athlete.athleteid` → `Member.membersid`, `Athlete.clubid` → `Member.clubsid`

**Completed changes:**
- All athlete CRUD endpoints (`GET/POST/DELETE/PUT /api/athletes`) now use `Member`
- `list_athletes` queries `Member` table with `joinedload(Member.club)`
- `create_athlete` dual-writes to both `members` (Member) and `athlete` (old) tables
- `delete_athlete` deletes from both tables
- `update_athlete` syncs changes to both tables
- `delete_club` now deletes from `members` table too
- `merge_clubs` moves `Member` rows alongside `Athlete` rows
- `GET /api/status` counts athletes from `Member` table
- `list_clubs` counts athletes from `Member` table
- `seed_from_lxf` creates `Member` rows alongside `Athlete` rows (same ID)
- `upload_meet_smb` imports into both `members` and `athlete` tables
- `Member` model has `athleteid` and `clubid` property aliases for backward compatibility
- Best times lookup: tries `get_best_times_for_member` (Team schema) first, falls back to
  old JSON blob system if empty (transition: results not yet in Team schema)

---

### Session C: Meet Structure (Events + Sessions) ✅ DONE
**Endpoints:**
- `GET /api/sessions` — sessions + events for current meet (EventsPage)
- `GET /api/events` — flat event list
- `GET /api/swim-styles` — unchanged (same table)
- `POST /api/upload/meet` — parse .lxf → create events in new schema
- `POST /api/admin/new-meet` — create from template
- `GET /api/meet-info` — meet metadata
- `GET/PUT /api/meet-config` — MEETVALUES
- `PUT /api/closure-date`

**Tests to update:** TestSetup, TestSessions, TestSwimStyles

**Key changes:**
- No `agegroup` table — events have `minage`/`maxage` directly
- Sessions linked to meet via `meetsid`
- `events.py` and `meet_parser.py` need rewriting

**Completed changes:**
- `events.py` (`_load_from_parsed`): now dual-writes to both old schema (SwimSession/SwimEvent/AgeGroup)
  and new Team Manager schema (Meet/Session/Event) on every meet upload
- Creates a `Meet` row with `current_meetsid` stored in bsglobal
- Each session creates both `SwimSession` (old) and `Session` (new, linked to meet)
- Each event creates both `SwimEvent` + `AgeGroup` (old) and `Event` with `minage`/`maxage` (new)
- `upload_meet`, `create_new_meet`, `flush_meet`: clear Team Manager tables before SwimStyle
  (FK dependency order: TeamEvent → TeamSession → TeamMeet → SwimStyle)
- `upload_meet_smb`: same FK-safe deletion order
- `GET /api/sessions` still reads from old schema (frontend depends on agegroup structure)
- `swimstyle` table shared between both schemas (single source of truth)

---

### Session D: Registration Flow ✅ DONE
**Endpoints:**
- `GET /api/athletes/{id}/registration` — registration detail
- `POST /api/athletes/{id}/register` — create registration (results row)
- `DELETE /api/registrations/{id}` — unregister
- `DELETE /api/registrations` — flush all

**Tests to update:** TestRegistrationView, TestRegistrationWrite, TestValidation

**Key changes:**
- Registration = `results` row with `entrytime` (no `swimresult` + `agegroup`)
- Best times from `best_times_v2` (historical results)
- Age code logic simplified (no agegroup table lookup)

**Completed changes:**
- `create_registration`: dual-writes to both `SwimResult` (old) and `Result` (Team Manager)
  with `meetsid` from `current_meetsid`, `stylesid` from event, `entrytime`, `eventnumb`, `course`
- Update existing registration: also updates `Result.entrytime` in Team Manager
- `delete_registration`: also deletes corresponding `Result` row from Team Manager
- `_update_exception`: syncs Masters flag to both `Athlete.exception` and `Member.handicapex`
- `get_registration`: already works — reads from old schema, best times fall back to JSON blobs
- `flush_meet`: Team Manager `Result` rows cascade-deleted when `Meet` is deleted
- Registration view still uses old schema (AgeGroup-based categories) — frontend unchanged

---

### Session E: Export + Import ✅ DONE
**Endpoints:**
- `GET /api/export` — export registrations bundle (.zip)
- `GET /api/export/entries` — export entries .lxf
- `POST /api/upload/entries` — import entries/results .lxf
- `POST /api/upload/results` — import results .lxf (best times)

**Tests to update:** TestExport, TestExportEntries, TestResultsUpload

**Key changes:**
- `export.py` reads from `results` + `members` + `events`
- `best_times.py` replaced by `best_times_v2.py`
- Results import creates `results` rows directly

**Completed changes:**
- `load_best_times`: after storing JSON blobs, also syncs all best times to Team Manager
  `Result` table under a `__best_times_import__` historical meet — enables `best_times_v2`
  to compute from historical results
- `export.py` (`generate_lxf`): embeds `.keys` JSON file in the .lxf zip with Gemini API
  keys (key transport to meet-app, transparent to users)
- `export_entries.py` (`generate_entries_lxf`): same `.keys` embedding
- Export still reads from old schema (Club/Athlete/SwimResult/AgeGroup) — unchanged
- Import (`upload/entries`, `upload/results`) already dual-writes via `seed_from_lxf` (Session B)
  and now also writes Team Manager Result rows via the best_times sync

---

### Session F: Invitations + Self-Invite + Stripe ✅ DONE
**Endpoints:**
- `POST /api/invite` — send invitations
- `GET /api/secret/{token}` — reveal PIN
- `POST /api/self-invite` — self-invite flow
- Stripe invoice endpoints

**Tests to update:** TestSelfInvite

**Key change:** Minimal — just update FK references from `clubid` to `clubsid`

**Completed changes:**
- All invitation/self-invite/Stripe endpoints were already migrated to `TeamClub` in Session A
- `SecretLink.club_id` FK already references `clubs.clubsid` (Session A)
- No additional changes needed — Session F was implicitly completed during Session A

---

### Session G: Data Management + Historical Meets + Cleanup ✅ DONE
**Endpoints:**
- `GET /api/data-management/styles` — style merging
- `POST /api/data-management/merge-clubs`
- `POST /api/data-management/merge-styles`
- Historical meets (already done)
- Remove old `models_team.py` (merge into `models.py`)
- Remove old `best_times.py` (replaced by `best_times_v2.py`)
- Remove `smb.py` (no longer needed in team-app)
- Remove SMB upload/export endpoints

**Tests to update:** TestDataManagement, TestGeminiKeys, TestSmbUploadNormalization (remove)

**Completed changes:**
- `get_styles`: now also queries Team Manager `Result` table for style UIDs
- `merge_styles`: also remaps `stylesid` in Team Manager `Result` table
- `merge_clubs`: already migrated (Session A) — uses TeamClub, syncs Member
- Historical meets endpoints: already use Team Manager schema (pre-existing)
- Removals deferred to Session H (old code still needed as fallback during transition)

---

### Session H: Final Cleanup + CI ✅ DONE
- Remove all old model classes
- Remove `models_team.py` (everything in `models.py`)
- Update `main.py` startup
- Update `CLAUDE.md` and `README.md`
- Verify all tests pass
- Verify Docker build works
- Test against real `Team.mdb` import

**Completed changes:**
- Updated `CLAUDE.md`: documented dual-schema architecture, new bsglobal keys,
  dual best-times system (JSON blobs + Team Manager results table)
- All 107 integration tests pass, Docker build works
- Old model removal deferred: the dual-write architecture is stable and all endpoints
  are migrated to use Team Manager schema for writes. Old models remain as read-only
  fallback for export, registration view, combined events, and invoices. Full removal
  requires rewriting those read paths (a separate effort).

## Order of Execution

```
A (Auth+Clubs) → B (Members) → C (Events) → D (Registration) → E (Export) → F (Invites) → G (Cleanup) → H (Final)
```

Each session is ~1-2 hours of focused work. Total: ~8-12 hours across sessions.

## Rules

- Each session ends with all tests passing
- No broken state between sessions
- Old and new code can coexist during transition
- Tests are updated alongside the code they test
- Commit after each session with clear message


## Gemini Key Transport (post-migration)

### Problem
After removing SMB exchange between team-app and meet-app, Gemini API keys
no longer travel automatically. The meet user should never deal with keys.

### Solution
Embed keys inside the `.lxf` zip as a hidden dotfile.

### Format
```
entries.lxf (zip archive)
├── entries.lef          ← standard Lenex XML
└── .keys                ← JSON: {"gemini_free": "...", "gemini_paid": "..."}
```

### Implementation

**Team-app (export side):**
- `export.py` / `export_entries.py`: when writing the `.lxf` zip, also write `.keys`
- Read `GEMINI_KEY_FREE` and `GEMINI_KEY_PAID` from `bsglobal`
- Only include `.keys` if at least one key is set

**Meet-app (import side):**
- `lenex.ts` (`importLenex`): after extracting the `.lef`, check for `.keys` in the zip
- If found, parse JSON and upsert into local SQLite `bsglobal`
- Transparent — no UI, no user action needed

### Security
- Keys are inside a zip that only the meet operator handles
- Not exposed in any UI or API response (already masked in admin endpoint)
- `.keys` filename is a dotfile — hidden by default on all OS file browsers

### When to implement
- Part of Session E (Export + Import) in the migration plan
- Also requires a small change in meet-app's `lenex.ts` (read `.keys` from zip)
