# Sauvetage Sportif — AI Context

## What this is
Monorepo for lifesaving competition management. Two apps sharing UI components:
- **meet-app**: Electron desktop app — "SauvetageMeet" (replaces Splash Meet Manager)
- **team-app**: Web app — "SauvetageTeam" (team registration before competition)

## Branding
- App names: **SauvetageMeet** (desktop) / **SauvetageTeam** (web)
- Logo: Société de sauvetage stylized "S" swimmer symbol (from sauvetage.qc.ca)
- App icon: `packages/meet-app/resources/icon.ico` / `icon.png`
- UI logo: displayed in the title bar of both apps

## How to run

### Meet app (Electron)

**Prerequisites (one-time):**
- Windows: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
- macOS: `xcode-select --install`

```bash
cd packages/meet-app
npm install
npm run rebuild   # compile native module for Electron
npm run dev
```

F12 opens DevTools. **Do NOT run from Claude Code terminal** (ELECTRON_RUN_AS_NODE=1 crashes it).

**After switching between `npm test` and `npm run dev`:**
- Before `npm run dev`: `npm run rebuild`
- Before `npm test`: `npm rebuild better-sqlite3`

(They compile the native module for different Node ABIs.)

**Clean build (wipes out/, rebuilds native modules, runs Vite build):**
```bash
npm run clean
```

### Team app (Docker)
```bash
cd packages/team-app
cp .env_template .env  # set SECRET_KEY to something other than default
docker compose up -d   # http://localhost:8001, admin PIN: 314159
```

### Tests
```bash
# Meet app unit tests (72 tests, Vitest)
cd packages/meet-app
npm rebuild better-sqlite3   # ensure compiled for system Node
npm test

# Team app integration tests (94 tests, pytest)
cd packages/team-app
pip install pytest requests
MEETMGR_SKIP_STACK=1 MEETMGR_URL=http://127.0.0.1:8001 python -m pytest tests/ -v
```

## Project structure
```
config/
  combined-events-config.json  — Shared category/points config (both apps)

packages/
  shared-ui/src/
    pages/EventsPage.tsx    — THE shared component (sessions tree + meet editor)
    context/ApiContext.tsx   — MeetAPI provider (DI for data layer)
    context/LangContext.tsx  — FR/EN language context
    data/api.ts             — MeetAPI interface + shared types
    i18n.ts                 — All FR/EN translations
    index.ts                — Barrel export

  meet-app/
    src/main/
      index.ts              — Electron main process, IPC handlers, native menu
      db.ts                 — SQLite (better-sqlite3), all queries, heat generation
      combinedEvents.ts     — COMBINEDEVENTS XML generator (auto-regen on event/agegroup changes)
      lenex.ts              — LENEX .lxf importer
      quantum.ts            — Swiss Timing Quantum protocol bridge
      smb.ts                — SMB save/restore (Splash Meet Backup format)
    src/preload/index.ts    — contextBridge API
    src/renderer/src/
      App.tsx               — App shell (title bar, tabs, modals)
      meetApiElectron.ts    — MeetAPI adapter (IPC → SQLite)
      pages/EventsPage.tsx  — Thin wrapper: ApiProvider + shared EventsPage
      pages/HeatsPage.tsx   — Heat runner + Quantum toolbar
      pages/AthletesPage.tsx— Athlete list + editor
    docs/
      HEAT_GENERATION_RULES.md — Full heat seeding rules documentation
      GBIN_FORMAT.md        — SMB binary format documentation
    tests/
      heat-generation.test.ts — Heat generation unit tests (28 tests)
      gbin.test.ts          — SMB binary format tests
      lenex.test.ts         — LENEX import tests
      schema.test.ts        — Schema/query tests
      smb.test.ts           — SMB save/restore tests
      meetvalues.test.ts    — MEETVALUES parser tests
    scripts/
      clean-build.js        — Clean build (wipe out/, rebuild native, vite build)
      rebuild.js            — Rebuild native modules for Electron
    electron.vite.config.ts — @shared alias → ../shared-ui/src

  team-app/
    backend/app/
      main.py               — FastAPI app, startup, audit logging
      models.py             — SQLAlchemy models (Splash schema + extra columns)
      routers/api.py        — All API endpoints
      combined_events.py    — COMBINEDEVENTS XML generator (Python port)
      events.py             — LENEX meet structure parser
      best_times.py         — Best time storage (bsglobal JSON blobs)
      export.py             — LENEX export (registrations)
      invoices.py           — Stripe invoice generation
    frontend/src/
      main.jsx              — React app, routing, EventsPage wrapper
      meetApi.js            — MeetAPI adapter (HTTP → FastAPI)
      i18n.jsx              — Team-app specific translations
      pages/                — Athletes, Organizer, Admin, etc.
    frontend/Dockerfile     — Builds with shared-ui via symlink
    docker-compose.yml      — DB + backend + frontend (context: monorepo root)

## Critical rules

### IPC listener cleanup (meet-app)
Preload `on*` methods return a cleanup function. Always collect them in `useEffect` and call them on unmount:
```tsx
useEffect(() => {
  const cleanups = [
    m.onImportLenex(() => handleImportLenex()),
    m.onSaveSMB(() => handleSaveSMB()),
  ]
  return () => { cleanups.forEach(fn => fn()) }
}, [])
```
Without cleanup, React StrictMode (or HMR) causes duplicate listeners → duplicate dialogs.

### Schema compatibility
The database schema MUST match the real Splash Meet Manager exactly. NO new tables, NO renamed columns. Team-specific data goes in:
- `bsglobal` key-value store (for config, best times, etc.)
- Extra columns appended to existing tables (Splash ignores them)

### MEETVALUES format
Meet-level config in `bsglobal` uses Splash's format: `KEY=TYPE;VALUE\r\n`
Types: I=integer, S=string, B=boolean(T/F), D=date(YYYYMMDDHHMMSSMMM), F=float

### Column encoding
- `swimevent.roundname` — event name (NOT `name`)
- `swimevent.internalevent` — 'T' = pause/admin event
- Gender: 1=M, 2=F, 3=Mixed
- Times: INTEGER milliseconds
- Boolean: CHAR(1) 'T'/'F'

### Shared code pattern
Both apps use the same EventsPage from shared-ui. Changes go in:
- `packages/shared-ui/src/pages/EventsPage.tsx` (single source of truth)
- Meet-app picks it up via `@shared` Vite alias
- Team-app picks it up via Docker symlink (`ln -sf /shared-ui/src src/shared`)

### Docker build context
Team-app frontend Dockerfile uses monorepo root as context (`context: ../..`) to access shared-ui. The `.dockerignore` at root excludes node_modules and meet-app.

## IPC channels (meet-app)

| Channel | Purpose |
|---|---|
| `db:sessions` | Get sessions + events + age groups |
| `db:update-event` | Update event fields |
| `db:update-age-group` | Update age group fields |
| `db:reorder-events` | Reorder events (sortcode) |
| `db:generate-heats` | Generate heats (seeding) for event/session/all |
| `db:get-meet-config` | Read MEETVALUES from bsglobal |
| `db:set-meet-config` | Write MEETVALUES to bsglobal |
| `db:get-swim-styles` | List all swimstyles |
| `db:sync-up` | Push SQLite → remote PG |
| `db:sync-down` | Pull remote PG → SQLite |
| `file:save-smb` | Save meet as .smb |
| `file:restore-smb` | Restore meet from .smb |
| `file:import-lenex` | Import .lxf file |

## API endpoints (team-app)

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions` | Sessions + events + age groups (for EventsPage) |
| `GET /api/swim-styles` | All swimstyles (for dropdown) |
| `GET /api/meet-info` | Meet metadata |
| `GET /api/events` | Flat event list |
| `POST /api/upload/meet` | Upload meet .lxf |
| `POST /api/upload/entries` | Upload entries/results .lxf |
| `GET /api/export` | Export registrations as .lxf bundle |
| `GET /api/athletes` | Athlete list |
| `POST /api/auth` | PIN authentication |

## Best times storage
Stored in `bsglobal` as `bt_{athlete_id}` keys with JSON: `{style_uid: {course: {time_ms, date, source}}}`. Updated on results upload, expired after 18 months.

## Combined Events (COMBINEDEVENTS)

Auto-generated XML in `bsglobal` that defines cumulative point standings per age/gender category. Both apps regenerate it when events or age groups change.

### Config file: `config/combined-events-config.json`
Single source of truth — shared by meet-app (TypeScript) and team-app (Python). Defines 10 categories for Canadian lifesaving with points scales and age/gender matching rules. Editable at runtime without rebuild.

### Implementation
- **meet-app**: `src/main/combinedEvents.ts` — called from `db.ts` after event/agegroup CRUD
- **team-app**: `backend/app/combined_events.py` — called from `api.py` after `upload_meet`

### Event filtering (what gets included)
- Individual events only (`relaycount = 1`)
- Pool events only (`distance >= 25` — excludes throwing events like "Lancer de précision")
- No admin/internal events (`internalevent != 'T'`)
- No finals linked to prelims (`preveventid < 1` — excludes separate final rounds)
- Must have an event number (`eventnumber IS NOT NULL`)

### Category matching
An event matches a category when its age group has:
- Same `agemin` as the category
- Same `agemax` (with -1 meaning no upper limit)
- Same gender (or event gender=0/3 for mixed categories)

## Heat Generation

Full rules documentation: `packages/meet-app/docs/HEAT_GENERATION_RULES.md`

### Implementation
- **Backend**: `src/main/db.ts` → `generateHeats(eventId?, sessionId?, db?)`
- **IPC**: `db:generate-heats` channel
- **Preload**: `window.api.db.generateHeats(eventId?, sessionId?)`
- **UI**: "Générer séries" button in EventsPage toolbar
- **Tests**: `tests/heat-generation.test.ts` (28 tests)

### Seeding methods (`agegroup.finalseedtype` or `MEETVALUES.SEEDMETHOD`)
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
- `finalseedtype` — overrides SEEDMETHOD
- `fastheatcount` — overrides FASTHEATCOUNT
- `heatcount` — minimum number of heats

### Lane assignment
Default: center-out (e.g., 5,6,4,7,3,8,2,1 for 8 lanes starting at 1).
Custom: `swimsession.lanesbyplace` (comma-separated lane numbers).

### Entry priority (when seed*last flags are set)
1. Regular timed entries
2. Late entries (`swimresult.lateentry='T'`)
3. Bonus entries (`swimresult.bonusentry='T'`)
4. Exhibition entries (`swimresult.infocode` contains 'EXH')
5. No-time entries (NT)
