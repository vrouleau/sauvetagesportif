# Sauvetage Sportif — AI Context

## What this is
Monorepo for lifesaving competition management. Two apps sharing UI components:
- **meet-app**: Electron desktop app (replaces Splash Meet Manager)
- **team-app**: Web app (team registration before competition)

## How to run

### Meet app (Electron)
```bash
cd packages/meet-app
npm run dev
```
F12 opens DevTools. **Do NOT run from Claude Code terminal** (ELECTRON_RUN_AS_NODE=1 crashes it).

### Team app (Docker)
```bash
cd packages/team-app
cp .env_template .env  # set SECRET_KEY
docker compose up -d   # http://localhost:8001
```

### Integration tests
```bash
wsl -- bash -c "cd .../packages/team-app && python3 -m pytest tests/ -v"
```

## Project structure
```
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
      db.ts                 — SQLite (better-sqlite3), all queries
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
    electron.vite.config.ts — @shared alias → ../shared-ui/src

  team-app/
    backend/app/
      main.py               — FastAPI app, startup, audit logging
      models.py             — SQLAlchemy models (Splash schema + extra columns)
      routers/api.py        — All API endpoints
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
