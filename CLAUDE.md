# Sauvetage Sportif — AI Context

## What this is
Monorepo for lifesaving competition management. Two apps sharing UI components:
- **meet-app**: Electron desktop app — "SauvetageMeet" (replaces Splash Meet Manager)
- **team-app**: Web app — "SauvetageTeam" (team registration before competition)

Per-package context:
- `packages/meet-app/CLAUDE.md` — Electron app, IPC channels, heat generation, OCR scanning, LXF export
- `packages/team-app/CLAUDE.md` — Docker stack, API endpoints, schema, meet lifecycle, integration tests
- `config/CLAUDE.md` — Shared config files, meet templates, combined events

## LXF round-trip (meet-app ↔ team-app)

| Step | Who exports | Who imports | Content |
|---|---|---|---|
| Meet setup | meet-app (File → Exporter structure) | team-app (Organizer → upload) | Sessions, events, agegroups — no athletes |
| Entries | team-app (Organizer → Télécharger LXF) | meet-app (File → Importer LENEX) | Clubs, athletes, registrations, entry times |
| Results | meet-app (File → Exporter résultats) | team-app (Organizer → Importer résultats) | Athletes + final times → archived as historical meet |

Organizer import of results also closes the meet cycle: resets current meet, regenerates club PINs, clears organizer role. See `packages/team-app/CLAUDE.md` for details.

## Branding
- App names: **SauvetageMeet** (desktop) / **SauvetageTeam** (web)
- Logo: Société de sauvetage stylized "S" swimmer symbol (from sauvetage.qc.ca)
- App icon: `packages/meet-app/resources/icon.ico` / `icon.png`
- UI logo: displayed in the title bar of both apps

## How to run

### Meet app (Electron) — see `packages/meet-app/CLAUDE.md`
```bash
cd packages/meet-app && npm install && npm run rebuild && npm run dev
```
Do NOT run from Claude Code terminal (ELECTRON_RUN_AS_NODE=1 crashes it).

### Team app (Docker via WSL) — see `packages/team-app/CLAUDE.md`
```bash
# In WSL terminal
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
docker compose up -d   # http://localhost:8001, admin PIN: 314159
```

### Tests
```bash
# Meet app (PowerShell)
cd packages/meet-app && npm rebuild better-sqlite3 && npm test

# Team app integration (WSL) — see packages/team-app/CLAUDE.md for full options
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
python3 -m pytest tests/ -v
```

## Project structure
```
config/
  combined-events-config.json  — Shared category/points config (both apps)
  template_pool.lxf            — Pool meet template (swimstyleids 501-540)
  template_beach.lxf           — Beach meet template (swimstyleids 601-605)

packages/
  shared-ui/src/
    pages/EventsPage.tsx    — THE shared component (sessions tree + meet editor)
    context/ApiContext.tsx   — MeetAPI provider (DI for data layer)
    context/LangContext.tsx  — FR/EN language context
    data/api.ts             — MeetAPI interface + shared types
    i18n.ts                 — All FR/EN translations
    index.ts                — Barrel export

  meet-app/                 — Electron desktop (see packages/meet-app/CLAUDE.md)
    src/main/               — Main process: db.ts, IPC handlers, OCR, SMB, LENEX
    src/renderer/src/       — React UI: App.tsx, pages/
    tests/                  — Vitest unit tests
    docs/                   — HEAT_GENERATION_RULES.md, GBIN_FORMAT.md

  team-app/                 — Web app (see packages/team-app/CLAUDE.md)
    backend/app/            — FastAPI: models, routers, exporters, importers
    frontend/src/           — React UI: pages/, meetApi.js
    tests/                  — pytest integration tests + unit tests
```

## Shared critical rules

### Shared code pattern
Both apps use the same EventsPage from shared-ui. Changes go in:
- `packages/shared-ui/src/pages/EventsPage.tsx` (single source of truth)
- Meet-app picks it up via `@shared` Vite alias (`electron.vite.config.ts`)
- Team-app picks it up via Docker `COPY packages/shared-ui/src` at build time

### Docker build context
Team-app `docker-compose.yml` uses `context: ../..` (monorepo root). Always run `docker compose` from `packages/team-app/`, never from the root.

### Column encoding (SQLite + PostgreSQL)
- `swimevent.roundname` — event name (NOT `name`)
- `swimevent.internalevent` — `'T'` = pause/admin event
- Gender: `1`=M, `2`=F, `3`=Mixed
- Times: INTEGER milliseconds
- Boolean: CHAR(1) `'T'`/`'F'`

### MEETVALUES format
Meet-level config in `bsglobal` uses Splash's format: `KEY=TYPE;VALUE\r\n`
Types: `I`=integer, `S`=string, `B`=boolean(T/F), `D`=date(YYYYMMDDHHMMSSMMM), `F`=float

## Beach Meets

Beach events are **ranked** (positions 1st, 2nd, 3rd) instead of **timed**. Positions stored as integer milliseconds (position 1 = 1000ms, position 2 = 2000ms).

### Meet type flag
- Stored in `bsglobal` as `MEET_TYPE` (`POOL` or `BEACH`, default `POOL` if missing)
- Set at meet creation via "Create Pool" / "Create Beach" buttons
- One meet type per database at a time

### Key differences from pool
| Aspect | Pool | Beach |
|--------|------|-------|
| Results | Time in ms | Position as integer (×1000ms) |
| Lanes | Center-out assignment | No lanes (sequential numbering) |
| Heat capacity | `session.lanemax - lanemin + 1` | `swimevent.maxentries` or `swimstyle.distance` |
| Heat seeding | By entry time (circle/pyramid/straight) | Random assignment |
| Finals qualification | By fastest prelim time | By best prelim position (lowest) |
| Timing input | `M:SS.cc` format | Integer position (1, 2, 3...) |
| Scanner/OCR tabs | Visible | Hidden |
| Best times | Stored and displayed | Skipped (not applicable) |
| Inscription | Checkbox + best time + entry time | Checkbox only |

### Position entry UX (HeatsPage)
- Click empty cell → pre-fills with next available position, text selected for override
- Duplicate position → **swaps** the two athletes' positions
- Gap prevention: can't enter position > total athletes with positions
- Rank column hidden (redundant — position IS the result)

### ID ranges (no overlap between pool and beach)
| Entity | Pool range | Beach range |
|--------|-----------|-------------|
| swimstyleid | 501-540 | 601-605 |
| eventid | 1065-1234 | 6001-6105 |
| agegroupid | 1066-1236 | 6002-6106 |
