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

Organizer import of results also closes the meet cycle: resets current meet (both admin and organizer paths), regenerates club PINs, clears organizer role. Empty meet state is supported — self-invite shows "no meet planned". See `packages/team-app/CLAUDE.md` for details.

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
  age-group-rules.json         — Shared age-group reference dates (both apps, see config/CLAUDE.md)
  combined-events-config.json  — Shared category/points config (both apps)
  template_pool.lxf            — Pool meet template (swimstyleids 500-531)
  template_beach.lxf           — Beach meet template (swimstyleids 601-624)

packages/
  shared-ui/src/
    pages/EventsPage.tsx    — THE shared component (sessions tree + meet editor)
    pages/IndividualEntryPage.tsx — Individual event entry (relaycount=1), toolbar with Add/Delete buttons
    pages/RelayEntryPage.tsx — Relay team management (team CRUD, member dropdowns, age groups in headers)
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

scripts/
  generate_dsq_xml.py     — Generates Splash DSQ XML from config/dsq-codes.json.
                             Usage: python scripts/generate_dsq_xml.py [--lang fr|en] [--type pool|beach] [--output FILE]
                             Default: French, pool → config/dsq.xml (Windows-1252 encoding)
  normalize_lxf.py         — Standalone tool: normalizes historic .lxf files against a current
                             template (remaps swimstyle IDs, fuzzy-matches clubs/athletes, copies
                             HANDICAP exception codes). Usage:
                             python scripts/normalize_lxf.py TEMPLATE.lxf ENTRIES.lxf HISTORIC.lxf
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
- `swimevent.round` — `11` in MDB encoding means Break/Pause → converted to `internalevent='T'` on import
- Gender: `0`=All (individual events only), `1`=M, `2`=F, `3`=Mixed (relay events only). An age group's gender always mirrors its parent event's — never independently set (cascades on event gender update, both apps). Individual events: All/M/F. Relay events: Mixed/M/F, no All. LENEX's real `GENDER` attribute enum is `ALL|M|F|MIXED` — our own exporter used to non-conformantly write `X` for Mixed; still accepted on import for backward compatibility. See `docs/AGE_GROUP_GENDER_MODEL.md` for the full design rationale (what Splash/LENEX's data model still supports vs. what our UI enforces).
- Times: INTEGER milliseconds (`0` = no time, same as NULL)
- Boolean: CHAR(1) `'T'`/`'F'`
- `agegroup.agemax` — `99` or `-1` both mean "Open" (no upper limit)

### MEETVALUES format
Meet-level config in `bsglobal` uses Splash's format: `KEY=TYPE;VALUE\r\n`
Types: `I`=integer, `S`=string, `B`=boolean(T/F), `D`=date(YYYYMMDDHHMMSSMMM), `F`=float

## Relay Entry

Relay team management across both apps. Relay events have `relaycount > 1` (typically 4).

### SERC (Simulated Emergency Response Competition)

SERC is a judged technical relay event (swimstyle ID 530). Teams of 4 respond to a staged water emergency with multiple victims.

**Key differences from normal relays:**
- **No gender/age restrictions** — any mix of men/women, any age group
- **No age group labels** displayed on teams
- **Scoring** instead of timing — judges rate criteria 0-10 (×0.5 increments), weighted by factors
- **Separate SERC tab** in organizer view with setup, scoring grid, results, and print

**SERC components:**
| Component | What |
|-----------|------|
| `backend/app/models_serc.py` | SQLAlchemy models (serc_config, serc_draw_order, serc_score) |
| `backend/app/routers/serc.py` | CRUD API (config, teams, scores, results, draw order) |
| `backend/app/routers/serc_print.py` | Printable judge sheets (one page per team per section, bilingual) |
| `frontend/src/pages/Serc.jsx` | Organizer page (setup, scoring grid, results, QR codes) |
| `frontend/src/pages/SercJudge.jsx` | Judge tablet form (public, no login, FR/EN toggle) |

**SERC API endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `GET/POST /api/serc/config` | Get/save SERC configuration (victims, factors) |
| `GET /api/serc/teams` | List relay teams for swimstyle 530 |
| `GET/POST /api/serc/draw-order/1/randomize` | Randomize team order |
| `PUT /api/serc/score` | Save a single score (draw, team, section, field, value) |
| `GET /api/serc/scores/1` | Get all scores grouped by team |
| `GET /api/serc/results` | Compute ranked results |
| `GET /api/serc/print/sheets?lang=fr` | Print judge sheets (fr/en/bilingual) |

**Judge tablet form:** `/serc/judge/overall`, `/serc/judge/bystander`, `/serc/judge/victim/1` — public URLs, no login needed. QR codes generated from the scoring page.

### Shared UI Pages
- `shared-ui/src/pages/RelayEntryPage.tsx` — relay team management (flat event list with age groups shown after event name, team CRUD, member dropdowns)
- `shared-ui/src/pages/IndividualEntryPage.tsx` — individual entry (toolbar with search, "Add Athlete" / "Delete" buttons, shows only events with `relaycount=1`)

### Navigation Tabs
Both apps show two entry tabs:
- "Individual Entries" / "Inscriptions individuelles" → `IndividualEntryPage`
- "Relay Entries" / "Inscriptions relais" → `RelayEntryPage`

### Meet-app IPC Channels (relay)
| Channel | Purpose |
|---|---|
| `db:get-clubs` | Get real database club IDs |
| `db:get-relay-page-data` | Relay events, teams, eligible athletes |
| `db:create-relay-team` | Create relay team |
| `db:delete-relay-team` | Delete relay team |
| `db:set-relay-team-member` | Assign/remove member at position |
| `db:set-relay-team-name` | Set custom team name |

### Team-app API Endpoints (relay)
| Endpoint | Purpose |
|---|---|
| `GET /api/relay-teams?club_id=X` | Relay page data (events, teams, eligible athletes) |
| `POST /api/relay-teams` | Create relay team |
| `DELETE /api/relay-teams/{id}` | Delete relay team |
| `PUT /api/relay-teams/{id}/members/{pos}` | Assign member at position |
| `PUT /api/relay-teams/{id}/name` | Set custom team name |

### Team Composition Rules (see `docs/RELAY_TEAM_RULES.md`)
- **Age group**: a team's category = the event it was created under (not computed from members). Members must be that exact category or the single adjacent-younger one (swim-up, never the reverse). At least 2 members must match the exact category — 1-3 and 0-4 splits are invalid. Beyond that, any split is valid (4-0, 3-1, 2-2) — no majority requirement. No per-team age label is shown in the UI; the event card's own category applies.
- **Mixed events (gender=X)**: exactly 2M + 2F required (for 4-person relay)
- **SERC events (swimstyle 530)**: NO gender or age restrictions — any composition allowed
- **Eligibility**: same club, registered for individual events, no duplicate across teams for same event
- **Team naming**: concatenated last names ("Tremblay/Gagnon/Roy/Boucher") or custom name

### Data Flow
```
RelayEntryPage.tsx
    ↓ useApi()
    ├── meet-app: registrationApiElectron.ts → Electron IPC → SQLite (relay/relayposition tables)
    └── team-app: meetApi.js → HTTP fetch → FastAPI → PostgreSQL (relays/relayspos tables)
```

### LXF Import (relay)
- **meet-app**: `importLenex` now processes `RELAY` and `RELAYPOSITION` elements from .lxf files
- **team-app**: `upload_entries` also imports relay teams from LXF

### SMB Import/Export (relay)
meet-app handles `relay`, `relayposition`, and `relaysplit` tables in its own SMB backup/restore (Splash interop). team-app has no `.smb` support (removed — superseded by LXF).

## Beach Meets

Beach events are **ranked** (positions 1st, 2nd, 3rd) instead of **timed**. Positions stored as integer milliseconds (position 1 = 1000ms, position 2 = 2000ms).

### Beach Numbers

Athletes in beach meets get a unique jersey/bib number stored in `athlete.nameprefix`. Format: `Letter + 3 chars` (e.g., `C201`, or `C A01` for Masters — no space, 4 chars total).

**Encoding:**
- Letter (A-Z) = club identifier (from club code characters, fallback to first unused letter)
- Category char = **fixed global code** per (age bracket, sex) — the same code everywhere, not assigned dynamically per club. Age brackets follow the canonical order (`AGE_CODE_ORDER` in `shared-ui/src/logic/ageGroupCode.ts`): 10-, 11-12, 13-14, 15-18, Open, Masters. Each bracket has a female slot then a male slot:
  `10-F=0, 10-M=1, 11-12F=2, 11-12M=3, 13-14F=4, 13-14M=5, 15-18F=6, 15-18M=7, OpenF=8, OpenM=9, MastersF=A, MastersM=B`
  (digits 0-9 cover the first 5 brackets; Masters overflows into letters once digits run out). The bracket comes from the athlete's age group (`agemin`/`agemax`/`name`); the sex comes from the athlete's own `gender` (not the age group's, which can be mixed for X relay events).
- Last 2 chars (01-99) = athlete sequence within category, alphabetical by lastname/firstname

**Generation triggers:**
- `importLenex` → calls `generateBeachNumbers(db)` when `MEET_TYPE='BEACH'`
- `registerForEvent` (late entry) → calls `assignLateBeachNumber(db, athleteId)`
- `generateHeats` → calls `assignLateBeachNumber` for any athletes missing a number

**Key source:** `packages/meet-app/src/main/beachNumber.ts`
- `generateBeachNumbers(db)` — full idempotent regeneration (clears all, recomputes)
- `assignLateBeachNumber(db, athleteId)` — assigns next available number for one athlete

**Constraints:** 26 clubs max, 12 fixed categories (6 age brackets × 2 sexes), 99 athletes per category per club.

**Properties:** deterministic, unique, idempotent, stable (late arrivals don't change existing numbers).

**Display:** HeatsPage, AthletesPage (read-only), "Identifiants plage" PDF report.

### Meet type flag
- Stored in `bsglobal` as `MEET_TYPE` (`POOL` or `BEACH`, default `POOL` if missing)
- Set at meet creation via "Create Pool" / "Create Beach" buttons
- Auto-detected on LXF import: if any `swimstyleid >= 600` exists → `BEACH`, otherwise `POOL` (only when `MEET_TYPE` not already set)
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
| swimstyleid | 500-531 | 601-624 |
| eventid | 1065-1234 | 6001-6105 |
| agegroupid | 1066-1236 | 6002-6106 |
