# Sauvetage Sportif — Monorepo

Competition management software for lifesaving sport (sauvetage sportif). Replaces Splash Meet Manager (Delphi) with modern cross-platform tools while maintaining full schema compatibility with the original.

## Structure

```
packages/
  shared-ui/      — Shared React components (EventsPage, i18n, contexts)
  meet-app/       — Electron desktop app (SauvetageMeet — replaces SplashMeet)
  team-app/       — Web app (SauvetageTeam — team registration, entries, invoices)
```

## Quick Start

### Electron app (meet-app)

**Prerequisites (Windows, one-time):**
```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**Prerequisites (macOS, one-time):**
```bash
xcode-select --install
```

**Setup & run:**
```bash
cd packages/meet-app
npm install
npm run rebuild    # compile better-sqlite3 for Electron (needs VS Build Tools)
npm run dev
```

> Note: `@electron/rebuild` recompiles `better-sqlite3` for Electron's Node ABI. This is required once after `npm install` and after any Electron version change.

### Web app (team-app)

```bash
cd packages/team-app
cp .env_template .env   # edit SECRET_KEY
docker compose up -d    # runs on http://localhost:8001
```

### Integration tests (team-app)

```bash
# Requires Docker (WSL on Windows, or native on Linux/macOS)
cd packages/team-app
cp .env_template .env   # edit SECRET_KEY
# Full suite (starts/stops Docker stack automatically):
python -m pytest tests/ -v
# Against already-running stack:
MEETMGR_SKIP_STACK=1 MEETMGR_URL=http://127.0.0.1:8001 python -m pytest tests/ -v
```

### Unit tests (meet-app)

```bash
cd packages/meet-app
npm install
npm rebuild better-sqlite3   # compile for system Node (not Electron)
npm test
```

> Note: `npm test` uses system Node.js. If you previously ran `@electron/rebuild`, you need `npm rebuild better-sqlite3` to recompile for system Node before tests will pass.

## Architecture

### Shared UI (`packages/shared-ui`)

Contains React components shared between both apps:
- `EventsPage` — sessions/events tree with drag-and-drop reordering, meet properties panel, event/age group editors
- `LangContext` — FR/EN language toggle
- `ApiContext` — dependency injection for the data layer
- `MeetAPI` interface — abstract API that each app implements differently

### Meet App (`packages/meet-app`)

Electron desktop app for running competitions at the venue.

- **Local SQLite** (better-sqlite3) — self-contained, works offline
- **Remote PG sync** — push/pull to venue's Splash Meet Manager database
- **SMB save/restore** — Splash Meet Backup format (cross-platform)
- **LENEX import** — .lxf file import for meet structure + results
- **Swiss Timing Quantum** — file-based protocol bridge for live timing
- **Data adapter**: `meetApiElectron.ts` wraps `window.api.db.*` (Electron IPC → SQLite)

### Team App (`packages/team-app`)

Web app for team registration before the competition.

- **FastAPI backend** (Python) + PostgreSQL (Docker)
- **React frontend** with shared EventsPage from `shared-ui`
- **Features**: athlete registration, relay assignment, best times, invoices (Stripe), email invitations
- **Data adapter**: `meetApi.js` wraps HTTP `fetch('/api/...')` → FastAPI backend

### Code Sharing Pattern

Both apps render the same `EventsPage` component. Each provides its own `MeetAPI` implementation via React Context:

```
shared-ui/EventsPage.tsx
    ↓ useApi()
    ├── meet-app: meetApiElectron.ts → Electron IPC → SQLite
    └── team-app: meetApi.js → HTTP fetch → FastAPI → PostgreSQL
```

## Database Schema

Both apps use the **same Splash Meet Manager schema** — identical table names, column names, and data encoding. The Delphi Splash app can connect to either database without issues.

Key tables: `swimstyle`, `club`, `swimsession`, `athlete`, `swimevent`, `agegroup`, `heat`, `swimresult`, `split`, `bsglobal`

### bsglobal (key-value store)

Meet-level configuration is stored in `bsglobal` using the Splash `MEETVALUES` format (`KEY=TYPE;VALUE\r\n`). Team-app specific data (best times, admin PIN, closure date) also lives here as separate keys.

### Team-app extra columns

Team-specific fields (`pin`, `email`, `invite_send_count`, `stripe_account_id`) are appended to the end of existing tables. Splash ignores columns it doesn't know about.

## Encoding Conventions

| Field | Encoding |
|-------|----------|
| Gender | 1=Male, 2=Female, 3=Mixed |
| Round | 1=Prelims, 2=Semis, 4=Finals, 5=Direct Finals |
| Course | 1=50m LCM, 2=25yd SCY, 3=25m SCM |
| Boolean | CHAR(1): 'T'/'F' |
| Times | INTEGER milliseconds |
| Stroke | 1=Free, 2=Back, 3=Breast, 4=Fly, 5=IM, 6=Relay |
