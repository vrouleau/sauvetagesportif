# Sauvetage Sportif — Monorepo

Competition management software for lifesaving sport (sauvetage sportif). Replaces Splash Meet Manager (Delphi) with modern cross-platform tools while maintaining full schema compatibility with the original.

## Structure

```
packages/
  shared-ui/      — Shared React components (EventsPage, i18n, contexts)
  meet-app/       — Electron desktop app (SplashMeet replacement)
  team-app/       — Web app (team registration, entries, invoices)
```

## Quick Start

### Electron app (meet-app)

```bash
cd packages/meet-app
npm install
npx electron-rebuild -f -w better-sqlite3
npm run dev
```

### Web app (team-app)

```bash
cd packages/team-app
cp .env_template .env   # edit SECRET_KEY
docker compose up -d    # runs on http://localhost:8001
```

### Integration tests (team-app)

```bash
# Requires WSL with Docker
wsl -- bash -c "cd /mnt/c/.../packages/team-app && python3 -m pytest tests/ -v"
```

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
