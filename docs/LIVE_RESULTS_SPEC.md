# Live Results — Feature Specification

## Overview

Enable real-time competition results to flow from the venue (meet-app) to spectators
via the team-app web interface. Eliminates the manual LXF file transfer step for
results and provides a live spectator experience similar to swimrankings.net / Meet Mobile.

## Goals

1. Spectators (parents, coaches not at venue) can follow results heat-by-heat on their phone
2. Eliminate the manual "export results LXF → import in team-app" step
3. Organizer finalizes the meet in team-app with a single button once competition ends
4. Maintain the existing LXF import path as fallback (no internet at venue, or Splash used instead)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Venue (local network)                                       │
│                                                              │
│  Swiss Timing ──► Quantum Bridge ──► meet-app DB (SQLite/PG)│
│                                           │                  │
│                                           │ HTTP POST        │
│                                           ▼                  │
└───────────────────────────────────────────┼──────────────────┘
                                            │ Internet
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│  team-app (public server)                                    │
│                                                              │
│  FastAPI backend                                             │
│    ├── POST /api/live/push-results  (from meet-app)          │
│    ├── POST /api/live/push-startlist (from meet-app)         │
│    ├── GET  /api/live/events        (spectator polling)      │
│    ├── GET  /api/live/results/:id   (spectator polling)      │
│    └── WS   /api/live/ws            (spectator real-time)    │
│                                                              │
│  React frontend                                              │
│    └── /live  — public results page (no auth required)       │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### During competition

1. A time is recorded in meet-app (via Quantum, manual entry, or Gemini OCR scan)
2. meet-app writes to local `swimresult` table
3. Live push module detects the write → serializes the result (event, heat, lane, time, status)
4. meet-app POSTs to `team-app /api/live/push-results` (authenticated via live secret)
5. team-app stores in `live_results` table, broadcasts via WebSocket to connected clients
6. Spectators see the result appear within seconds
7. When heat is marked official → push status update → spectator UI updates accordingly

### Start lists

1. After heat generation (or when a session starts), meet-app pushes start lists
2. Spectators can see upcoming heats and who swims in which lane

### Meet finalization

1. Competition ends — all results are already in team-app's `live_results` table
2. Organizer clicks "Finaliser le meet" in team-app
3. team-app promotes `live_results` → `results` (historical/Team Manager schema)
4. Best times recomputed, meet archived, PINs regenerated, current meet reset
5. Live results table cleared

### Fallback (no internet / Splash used)

- Existing LXF import path remains functional
- If live results were partially pushed, finalization merges/overwrites as needed

## Data Model (team-app PostgreSQL)

### New tables

```sql
-- Live heat results (ephemeral — cleared on meet finalization)
CREATE TABLE live_results (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL,          -- references swimevent
    heat_number INTEGER NOT NULL,
    lane INTEGER NOT NULL,
    athlete_id INTEGER,                 -- references members.membersid
    athlete_name TEXT,                  -- denormalized for display
    club_name TEXT,                     -- denormalized for display
    swimtime_ms INTEGER,               -- NULL = not yet finished
    reaction_time_ms INTEGER,
    status TEXT DEFAULT '',             -- DSQ, DNS, DNF, etc.
    is_official BOOLEAN DEFAULT FALSE,  -- TRUE once heat is marked official
    pushed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(event_id, heat_number, lane)
);

-- Live splits (optional, for detailed display)
CREATE TABLE live_splits (
    id SERIAL PRIMARY KEY,
    live_result_id INTEGER REFERENCES live_results(id) ON DELETE CASCADE,
    distance INTEGER NOT NULL,
    swimtime_ms INTEGER NOT NULL
);

-- Live start lists (upcoming heats)
CREATE TABLE live_startlist (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL,
    heat_number INTEGER NOT NULL,
    lane INTEGER NOT NULL,
    athlete_id INTEGER,
    athlete_name TEXT,
    club_name TEXT,
    entry_time_ms INTEGER,
    UNIQUE(event_id, heat_number, lane)
);

-- Live session/event metadata (pushed once at start of meet/session)
CREATE TABLE live_events (
    event_id INTEGER PRIMARY KEY,
    session_number INTEGER,
    session_name TEXT,
    event_number INTEGER,
    event_name TEXT,
    gender TEXT,                         -- M/F/X
    distance INTEGER,
    round TEXT,                          -- PRE/FIN/TIM
    scheduled_time TEXT,                 -- HH:MM
    total_heats INTEGER DEFAULT 0,
    completed_heats INTEGER DEFAULT 0
);
```

### Authentication for push

- meet-app authenticates push requests with a shared secret (stored in bsglobal)
- Header: `X-Live-Secret: <token>` (generated when organizer enables live mode)
- team-app validates the token before accepting pushes

## API Endpoints (team-app)

### Push endpoints (meet-app → team-app, authenticated)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/live/push-events` | Push event/session metadata (once at meet start) |
| POST | `/api/live/push-startlist` | Push start list for a session or event |
| POST | `/api/live/push-results` | Push results for a completed heat |
| POST | `/api/live/push-status` | Update heat status (official, correction) |

### Public endpoints (spectators, no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/live/status` | Is a live meet active? Meet name, session info |
| GET | `/api/live/events` | All events with completion status |
| GET | `/api/live/results/{event_id}` | Results for an event (all heats) |
| GET | `/api/live/startlist/{event_id}` | Start list for an event |
| GET | `/api/results/meets` | List historical meets (archived) |
| GET | `/api/results/meets/{meet_id}` | Results for a historical meet |
| GET | `/api/results/best-times` | Best times per athlete (replaces `/best-times-public`) |
| WS | `/api/live/ws` | WebSocket for real-time updates |

### Organizer endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/live/finalize` | Promote live results → historical, trigger close-meet |

## WebSocket Protocol

```json
// Server → Client: new result
{"type": "result", "event_id": 1065, "heat": 2, "data": [...]}

// Server → Client: heat status change
{"type": "status", "event_id": 1065, "heat": 2, "official": true}

// Server → Client: start list update
{"type": "startlist", "event_id": 1065, "heat": 3, "data": [...]}

// Server → Client: event metadata update
{"type": "event_update", "event_id": 1065, "completed_heats": 3}
```

## meet-app Changes

### New: Live push module

Pushes results to team-app whenever a `swimresult` row is written/updated in the local DB,
regardless of the timing source:

| Source | Trigger |
|--------|---------|
| Swiss Timing Quantum | `quantum:result` event writes times to DB |
| Manual entry | Operator types time in HeatsPage → saves to DB |
| Gemini OCR | Operator accepts scanned time in TimingProcessPage → writes to DB |

**Push granularity: per-result, live**
- Each time a `swimresult.swimtime` is written (INSERT or UPDATE), push that result
- Spectators see times appear one by one as they're entered
- No waiting for "heat official" — results are marked provisional until official status

**Heat official status:**
- Pushed separately when operator marks a heat as official (or Quantum sends STATUS;OFFICIAL)
- Spectator UI shows a visual distinction: provisional (italic/gray) vs official (bold/final)
- Corrections (time edits, DSQ changes) are pushed as updates to existing results

**Implementation approach:**
- Hook into the DB write layer (after `swimresult` INSERT/UPDATE with non-null swimtime)
- Debounce: batch results that arrive within 500ms (e.g., Quantum delivers all lanes at once)
- Queue + retry: if team-app is unreachable, queue and retry on reconnect
- Push on heat official status change (racestatus update)

### Configuration

- `MEETVALUES.LIVE_URL` — team-app base URL (e.g., `https://team.example.com`)
- `MEETVALUES.LIVE_PUSH_SECRET` — authentication token (auto-populated via SMB/LXF transport, no manual entry)
- `MEETVALUES.LIVE_ENABLED` — `T`/`F` toggle

The `LIVE_URL` is the only value the user needs to set manually in meet-app (once).
The secret arrives automatically when the organizer exports the meet structure or SMB backup
after enabling live mode in team-app.

### UI

- Status indicator in title bar: 🟢 connected / 🔴 disconnected / 🟡 queued
- Settings: only `LIVE_URL` needs manual entry (secret arrives via SMB/LXF)
- Manual "push all results" button (for catch-up after reconnect)

## team-app Frontend — /results Page

### Public (no auth required)

- **Auto-detects mode**: live meet active → live view; no meet → historical view
- **Live view**:
  - Event list with progress indicators (3/5 heats completed)
  - Click event → see results by heat (times, ranks, statuses)
  - Auto-updates via WebSocket (no manual refresh)
  - Combined events standings (cumulative points) updated live
- **Historical view**:
  - Browse past meets (list of archived meets)
  - Click meet → see all results by event
  - Best times per athlete/club (replaces current `/best-times`)
- Mobile-first responsive design

### Organizer view

- Same as public + "Finaliser le meet" button
- Shows push connection status (last received, queue depth)

## Meet Lifecycle (Updated)

| Step | Before (LXF flow) | After (Live flow) |
|------|-------------------|-------------------|
| 1. Setup | meet-app exports structure .lxf → team-app imports | Same (unchanged) |
| 2. Registration | Coaches register in team-app | Same (unchanged) |
| 3. Entries | team-app exports .lxf → meet-app imports | Same (unchanged) |
| 4. Competition | meet-app runs heats | meet-app runs heats + pushes live |
| 5. Results | meet-app exports results .lxf → team-app imports → archive | Organizer clicks "Finaliser" → archive |

## Public Results Page (`/results`)

A single unified public page that replaces the current `/best-times` page. It serves
**both** live and historical purposes depending on meet state:

### During a live meet
- Real-time results via WebSocket (heat-by-heat as they come in)
- Start lists for upcoming events
- Combined events standings (updated live)
- Progress indicators (e.g., "Event 5 — Heat 3/5 completed")

### Between meets (no live meet active)
- Historical results browsing (past meets archived in Team Manager schema)
- Best times per athlete/club (computed from `results` table)
- Meet-by-meet result lookup

### UX
- Single URL: `/results`
- Auto-detects whether a live meet is active → shows live view or historical view
- No authentication required (public page)
- Mobile-first responsive design
- Replaces the current `/best-times` page (which only shows static best times)

## LXF Import/Export (Retained)

The existing `file:export-lenex-results` (meet-app) → `POST /api/import-results-lxf` (team-app)
flow is **fully retained** for:

- Venues without internet (no live push possible)
- Meets run with Splash instead of SauvetageMeet
- Disaster recovery (re-import from backup)
- Partial connectivity (some results pushed live, rest imported via LXF after)

When live results exist AND an LXF import is performed for the same meet, the import
merges/overwrites — LXF is treated as authoritative (final corrections, etc.).

## Security Considerations

### Live push authentication (Option 3 — transparent key transport)

The live push uses a dedicated secret token, transported via the same mechanism as
Gemini API keys (already proven in the codebase):

1. **Organizer enables live mode** in team-app (Admin or Organizer page)
2. team-app generates a strong random token (UUID4 or 32-char hex)
3. Token stored in `bsglobal` as `LIVE_PUSH_SECRET`
4. Token travels to meet-app via existing paths:
   - `.smb` backup: admin saves `.smb` → restores in meet-app → key in local SQLite
   - `.lxf` export: embedded as `.keys` JSON dotfile inside the zip archive (same as Gemini keys)
5. meet-app reads `LIVE_PUSH_SECRET` from its local DB — **zero manual configuration**
6. Push requests include header: `X-Live-Secret: <token>`
7. team-app validates the token before accepting any push

**Key lifecycle:**
- Regenerated each time organizer enables live mode (or on demand)
- Cleared on meet finalization (same as other meet-cycle data)
- If token is compromised, organizer regenerates in team-app → re-export SMB/LXF to meet-app

**Why not reuse admin PIN:**
- Admin PIN is a weak 6-digit number
- Live secret is a strong 128-bit token
- Separate concern: compromising the live token doesn't grant admin access

### Other security measures

- Public endpoints are read-only, no PII beyond athlete name + club
- Rate limiting on push endpoints to prevent abuse
- WebSocket connections capped (e.g., 500 concurrent) to prevent resource exhaustion
- Push endpoint rejects payloads when no live meet is active

## Implementation Phases

### Phase 1 — Push infrastructure + basic display
- [ ] `live_results`, `live_events`, `live_startlist` tables
- [ ] Push endpoints (team-app backend)
- [ ] `LIVE_PUSH_SECRET` generation in team-app (organizer enables live mode)
- [ ] Secret transport via `.keys` dotfile in LXF + SMB (same as Gemini keys)
- [ ] Push module in meet-app (triggered after Quantum result write)
- [ ] Basic `/results` page — live view (polling, no WebSocket yet)
- [ ] `LIVE_URL` configuration in meet-app settings

### Phase 2 — Real-time + UX polish
- [ ] WebSocket broadcast on team-app
- [ ] Auto-updating spectator UI
- [ ] Connection status indicator in meet-app
- [ ] Queue + retry logic for intermittent connectivity
- [ ] Mobile-optimized layout

### Phase 3 — Finalization + lifecycle
- [ ] "Finaliser le meet" button (promote live → historical)
- [ ] Merge logic (partial live + LXF fallback coexist)
- [ ] Combined events live standings

### Phase 4 — Historical view + migration
- [ ] `/results` page — historical view (browse past meets, best times)
- [ ] Migrate `/best-times` functionality into `/results`
- [ ] Remove old `BestTimesPublic` page
- [ ] Push start lists from meet-app
- [ ] "Push all" catch-up button
- [ ] Spectator notifications (optional: "Your athlete just swam!")
