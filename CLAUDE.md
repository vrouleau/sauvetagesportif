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

  meet-app/
    src/main/
      index.ts              — Electron main process, IPC handlers, native menu
      db.ts                 — SQLite (better-sqlite3), all queries, heat generation
      combinedEvents.ts     — COMBINEDEVENTS XML generator (auto-regen on event/agegroup changes)
      lenex.ts              — LENEX .lxf importer
      quantum.ts            — Swiss Timing Quantum protocol bridge
      smb.ts                — SMB save/restore (Splash Meet Backup format)
      timingBarcode.ts      — Barcode encode/decode (E{n}-H{n}-L{n} format)
      timingSheets.ts       — Timing sheet PDF generator (HTML + Code128 SVG)
      timingScanDb.ts       — Local SQLite for scanned images + processing state
      timingImageProcess.ts — Image crop/preprocessing for OCR
      ocrEngine.ts          — OCR engine interface + time parsing utilities
      ocrGemini.ts          — Gemini 2.5 Flash Lite vision OCR (primary)
      ocrOllama.ts          — Ollama local vision model (fallback)
      ocrTesseract.ts       — Tesseract.js (prototype)
      ocrOnnx.ts            — ONNX digit model (prototype)
      ocrPaddle.ts          — PaddleOCR subprocess (prototype)
      geminiBackground.ts   — Background Gemini processing loop (main process)
    src/preload/index.ts    — contextBridge API
    src/renderer/src/
      App.tsx               — App shell (title bar, tabs, modals)
      meetApiElectron.ts    — MeetAPI adapter (IPC → SQLite)
      registrationApiElectron.ts — RegistrationAPI adapter (IPC → SQLite, register/unregister/relay members)
      pages/EventsPage.tsx  — Thin wrapper: ApiProvider + shared EventsPage
      pages/HeatsPage.tsx   — Heat runner + Quantum toolbar + Print timing sheets
      pages/AthletesPage.tsx— Athlete list + editor
      pages/TimingScanPage.tsx — Camera barcode scanner (batch mode)
      pages/TimingProcessPage.tsx — OCR processing queue + manual time entry
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
      timing-scan.test.ts   — Barcode, time parsing, Gemini key roundtrip tests
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
| `timing:save-scan` | Store scanned image + barcode metadata |
| `timing:get-scans-for-processing` | List scans by status filter |
| `timing:run-ocr` | Run OCR engine on a scan (Gemini/Ollama/etc) |
| `timing:validate-scan` | Accept times → write to swimresult |
| `timing:generate-sheets` | Generate timing sheet HTML for a session |
| `timing:set-gemini-background` | Enable/disable background Gemini processing |
| `timing:get-gemini-key` | Get masked API keys |
| `timing:set-gemini-key` | Set free/paid API keys |
| `timing:clear-all-scans` | Delete all scan records |
| `db:get-meet-type` | Get meet type (POOL/BEACH) from BSGLOBAL |
| `menu:open-guide` | Open in-app workflow guide (pool/beach) |
| `db:register` | Register athlete for event (create swimresult) |
| `db:unregister` | Unregister athlete from event (delete unseeded swimresult) |
| `db:get-relay-members` | Get relay position members by relay ID |
| `db:get-relay-members-by-event` | Get relay members for event+club |
| `db:set-relay-member` | Set/clear a relay position member |

## API endpoints (team-app)

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /api/sessions` | Sessions + events + age groups (for EventsPage) | Public |
| `GET /api/swim-styles` | All swimstyles (for dropdown) | Public |
| `GET /api/meet-info` | Meet metadata | Public |
| `GET /api/events` | Flat event list | Public |
| `POST /api/auth` | PIN authentication | Public |
| `POST /api/upload/meet` | Upload meet .lxf (event structure) | Organizer/Admin |
| `POST /api/upload/entries` | Upload entries/results .lxf (clubs + athletes + best times) | Admin |
| `POST /api/upload/meet-smb` | Full database restore from .smb backup | Admin |
| `GET /api/export/meet-smb` | Download full .smb backup | Admin |
| `POST /api/admin/new-meet` | Create new meet from template (pool/beach) | Organizer/Admin |
| `GET /api/export` | Export registrations as .lxf bundle (.zip) | Admin |
| `GET /api/export/entries` | Export entries .lxf (clubs + athletes + best times) | Admin |
| `GET /api/athletes` | Athlete list | Any authenticated |
| `GET /api/admin/gemini-keys` | Get masked Gemini API keys | Admin |
| `POST /api/admin/gemini-keys` | Set free/paid Gemini API keys | Admin |

## In-App Documentation

Both apps serve bilingual (FR/EN) workflow guides bundled as markdown files:

### Team-app
- Location: `packages/team-app/frontend/public/docs/`
- Files: `team-admin_{lang}.md`, `team-organizer_{lang}.md`, `team-coach_{lang}.md`
- Accessed via: `/usage` route (tab navigation between guides)
- Screenshots: `public/docs/assets/team-*.png`

### Meet-app
- Location: `packages/meet-app/src/renderer/public/docs/`
- Files: `meet-pool_{lang}.md`, `meet-beach_{lang}.md`
- Accessed via: Aide menu → "Guide — Compétition piscine/plage" (full-screen overlay)
- Screenshots: `public/docs/assets/meet-*.png`
- Renderer: custom `GuidePage.tsx` with built-in markdown-to-HTML converter (no external dependency)

### Fixture data
- Generator: `packages/meet-app/scripts/generate-fixture-smb.ts`
- Output: `fixture_pool.smb`, `fixture_beach.smb` (10 clubs, 150 athletes, events, registrations)
- Usage: File → Restaurer un meet (.smb) in meet-app, or Admin → Restore SMB in team-app

## Best times storage
Stored in `bsglobal` as `bt_{athlete_id}` keys with JSON: `{style_uid: {course: {time_ms, date, source}}}`. Updated on results upload, expired after 18 months. **Not updated for beach meets** (positions are not times). Pool styles use 5xx IDs, beach styles use 6xx — no collisions.

## Beach Meets

Beach events are **ranked** (positions 1st, 2nd, 3rd) instead of **timed**. The DB model is unchanged — positions are stored as integer milliseconds (position 1 = 1000ms, position 2 = 2000ms).

### Meet type flag
- Stored in `bsglobal` as `MEET_TYPE` (`POOL` or `BEACH`, default `POOL` if missing)
- Set at meet creation via "Create Pool" / "Create Beach" buttons
- One meet type per database at a time (pool = winter, beach = summer)

### Templates
- `config/template_pool.lxf` — Pool meet structure (swimstyleids 501-540)
- `config/template_beach.lxf` — Beach meet structure (swimstyleids 601-605)
- Docker env vars: `MEET_TEMPLATE_POOL`, `MEET_TEMPLATE_BEACH`

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

### Heat generation (beach mode)
- Max participants per heat = `swimevent.maxentries` (override) → `swimstyle.distance` (default) → 16 (fallback)
- Athletes shuffled randomly and distributed evenly across heats
- No lane assignment (uses sequential numbers as placeholders)

### Position entry UX
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


## Timing Sheet OCR Scanning

### Overview
Camera-based workflow to replace manual time entry from handwritten timing sheets. Lane timers write two stopwatch times (Chrono 1 / Chrono 2) on printed strips with barcodes.

### Workflow
1. **Print** timing sheets from HeatsPage ("🖨 Fiches chrono") — portrait, 3 strips/page
2. **Scan** sheets in batch (Scanner tab) — camera reads Code128 barcode, captures image
3. **Process** (Traitement tab) — Gemini reads times in background, operator validates/corrects
4. **Accept** → writes `backuptime1`, `backuptime2`, averaged `swimtime` to `swimresult`

### Sheet layout
- Full-width Code128 barcode SVG (format: `E{eventNumber}-H{heatNumber}-L{lane}`)
- Event name, heat, lane, athlete name + club code
- Two rows of 5 digit boxes (M:SS.HH) labeled "Chrono 1" / "Chrono 2"
- Corner registration marks for future perspective correction

### Barcode format
`E{n}-H{n}-L{n}` — e.g. `E5-H2-L3` = Event 5, Heat 2, Lane 3

### Scan storage
Separate SQLite: `{userData}/timing_scans.sqlite`
- `timing_scan` table: image blob, barcode, event/heat/lane, status, recognized/validated times
- Statuses: `unprocessed` → `recognized` (Gemini filled) → `validated` (operator confirmed)
- Cleared via "Vider les scans" button or `npm run clean`

### Gemini OCR
- Model: `gemini-2.5-flash-lite` (1.4s/scan, no thinking overhead)
- Fallback: `gemini-2.5-flash` if lite unavailable
- Background processing in main process (runs on any page)
- Dual API keys in BSGLOBAL: `GEMINI_KEY_FREE` + `GEMINI_KEY_PAID`
- Auto-fallback: free → paid on 429 → back to free after 60s
- Keys managed in team-app Admin page, travel with .smb export

### Key management flow
1. Admin sets keys in team-app (Admin page → "Clés API Gemini")
2. Keys stored in PostgreSQL `bsglobal` table
3. Admin saves `.smb` backup → keys included
4. Admin restores `.smb` in meet-app → keys in local SQLite
5. Gemini OCR works automatically (transparent to end users)

### Time entry
- Manual: type `14500` → parsed as `1:45.00` (same parser as HeatsPage)
- Gemini: auto-fills fields, operator confirms with Enter
- Both chronos required to accept
- Accept immediately writes to meet DB (`swimresult.backuptime1/2 + swimtime`)
