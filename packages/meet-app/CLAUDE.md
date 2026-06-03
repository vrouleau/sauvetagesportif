# Meet App (SauvetageMeet) — Electron Desktop

## How to run

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

## Unit tests

```bash
npm rebuild better-sqlite3   # ensure compiled for system Node
npm test
```

Test files in `tests/`:
- `heat-generation.test.ts` — 28 tests
- `gbin.test.ts`, `lenex.test.ts`, `schema.test.ts`, `smb.test.ts`, `meetvalues.test.ts`, `timing-scan.test.ts`

### Key utility: `msToDisplay(ms)`
Converts integer milliseconds to display format (`M:SS.cc` or `SS.cc`). Returns `undefined` for `null`, `0`, negative values, and max-int sentinel (2147483647) — all treated as "no time" (NT).

## Critical rule: IPC listener cleanup

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

## Source layout

```
src/main/
  index.ts              — Electron main process, IPC handlers, native menu
  db.ts                 — SQLite (better-sqlite3), all queries, heat generation
  combinedEvents.ts     — COMBINEDEVENTS XML generator (auto-regen on event/agegroup changes)
  lenex.ts              — LENEX .lxf import + export (importLenex, exportMeetLenex, exportResultsLenex)
  quantum.ts            — Swiss Timing Quantum protocol bridge
  smb.ts                — SMB save/restore (Splash Meet Backup format)
  timingBarcode.ts      — Barcode encode/decode (E{n}-H{n}-L{n} format)
  timingSheets.ts       — Timing sheet PDF generator (HTML + Code128 SVG)
  timingScanDb.ts       — Local SQLite for scanned images + processing state
  timingImageProcess.ts — Image crop/preprocessing for OCR
  ocrEngine.ts          — OCR engine interface + time parsing utilities
  ocrGemini.ts          — Gemini 2.5 Flash Lite vision OCR (primary)
  ocrOllama.ts          — Ollama local vision model (fallback)
  geminiBackground.ts   — Background Gemini processing loop (main process)
src/preload/index.ts    — contextBridge API
src/renderer/src/
  App.tsx               — App shell (title bar, tabs, modals)
  meetApiElectron.ts    — MeetAPI adapter (IPC → SQLite)
  registrationApiElectron.ts — RegistrationAPI adapter (IPC → SQLite)
  pages/EventsPage.tsx  — Thin wrapper: ApiProvider + shared EventsPage
  pages/HeatsPage.tsx   — Heat runner + Quantum toolbar + Print timing sheets
  pages/AthletesPage.tsx— Athlete list + editor
  pages/TimingScanPage.tsx — Camera barcode scanner (batch mode)
  pages/TimingProcessPage.tsx — OCR processing queue + manual time entry
```

## IPC channels

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
| `file:save-smb` | Save meet as .smb |
| `file:restore-smb` | Restore meet from .smb |
| `file:import-lenex` | Import .lxf (meet structure + entries + best times) |
| `file:export-meet-lenex` | Export meet structure as .lxf (sessions/events/agegroups, no athletes) — for team-app invitation setup |
| `file:export-lenex-results` | Export results as .lxf (full athletes + times) — for team-app historical import |

### LXF round-trip details

**Import (`importLenex`):**
- Remaps `swimstyleid` via `uniqueid` attribute (Splash uses internal auto-increment IDs in MDB but canonical 5xx UIDs in Lenex)
- Events with `round=11` (MDB encoding for Break/Pause) are marked `internalevent='T'`
- Extracts MEETVALUES metadata from meet attributes (name, course, agedate, deadline, etc.)

**Export (`exportMeetLenex`, `exportResultsLenex`):**
- Includes pause event names in the output
- Uses correct swimstyleids (canonical UIDs)
- Writes meet-level attributes (course, agedate, organizer, etc.) from MEETVALUES
| `timing:save-scan` | Store scanned image + barcode metadata |
| `timing:get-scans-for-processing` | List scans by status filter |
| `timing:run-ocr` | Run OCR engine on a scan (Gemini/Ollama/etc) |
| `timing:validate-scan` | Accept times → write to swimresult |
| `timing:generate-sheets` | Generate timing sheet HTML for a session |
| `timing:set-gemini-background` | Enable/disable background Gemini processing |
| `timing:get-gemini-key` | Get masked API keys |
| `timing:set-gemini-key` | Set free/paid API keys |
| `timing:clear-all-scans` | Delete all scan records |
| `db:get-clubs` | Get real database club IDs |
| `db:get-relay-page-data` | Relay events, teams, eligible athletes |
| `db:create-relay-team` | Create relay team |
| `db:delete-relay-team` | Delete relay team |
| `db:set-relay-team-member` | Assign/remove member at position |
| `db:set-relay-team-name` | Set custom team name |
| `db:get-meet-type` | Get meet type (POOL/BEACH) from BSGLOBAL |
| `menu:open-guide` | Open in-app workflow guide (pool/beach) |
| `db:register` | Register athlete for event (create swimresult) |
| `db:unregister` | Unregister athlete from event (delete unseeded swimresult) |
| `db:get-relay-members` | Get relay position members by relay ID |
| `db:get-relay-members-by-event` | Get relay members for event+club |
| `db:set-relay-member` | Set/clear a relay position member |

## Relay Entry

Relay team management for events with `relaycount > 1`.

### UI
- `RelayEntryPageWrapper` in renderer wraps the shared `RelayEntryPage` component
- Two entry tabs: "Inscriptions individuelles" (individual) / "Inscriptions relais" (relay)

### Data flow
```
RelayEntryPage (shared-ui)
  → registrationApiElectron.ts
    → IPC: db:get-relay-page-data, db:create-relay-team, db:delete-relay-team,
           db:set-relay-team-member, db:set-relay-team-name
      → SQLite: relay, relayposition tables
```

### Schema
- `relay` table — team records (event, club, letter)
- `relayposition` table — member assignments (position 1-4)
- `relaysplit` table — relay split times
- All three included in SMB save/restore (`SMB_TABLES`)

### LXF import
`importLenex` processes `RELAY` and `RELAYPOSITION` elements, creating relay teams from imported .lxf files.

### Team composition
Age group determined by majority of members' individual registration age groups. See `docs/RELAY_TEAM_RULES.md` for full rules (3-1 valid, 2-2 invalid, 2M+2F for mixed).

## Heat Generation

Full rules: `docs/HEAT_GENERATION_RULES.md`

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

### Beach mode
- Max participants per heat = `swimevent.maxentries` → `swimstyle.distance` → 16 (fallback)
- Athletes shuffled randomly and distributed evenly across heats
- No lane assignment (sequential numbers as placeholders)

## Timing Sheet OCR Scanning

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

### Key management flow
1. Admin sets keys in team-app (Admin page → "Clés API Gemini")
2. Keys stored in PostgreSQL `bsglobal` table
3. Keys travel to meet-app via TWO paths:
   - `.smb` backup: Admin saves `.smb` → restores in meet-app → keys in local SQLite
   - `.lxf` export: embedded as `.keys` JSON dotfile inside the zip archive (transparent)
4. Gemini OCR works automatically in meet-app (transparent to end users)

### Time entry
- Manual: type `14500` → parsed as `1:45.00` (same parser as HeatsPage)
- Gemini: auto-fills fields, operator confirms with Enter
- Both chronos required to accept
- Accept immediately writes to meet DB (`swimresult.backuptime1/2 + swimtime`)

## In-App Documentation

- Location: `src/renderer/public/docs/`
- Files: `meet-pool_{lang}.md`, `meet-beach_{lang}.md`
- Accessed via: Aide menu → "Guide — Compétition piscine/plage" (full-screen overlay)
- Screenshots: `public/docs/assets/meet-*.png`
- Renderer: custom `GuidePage.tsx` with built-in markdown-to-HTML converter (no external dependency)

## Combined Events

Auto-generated XML in `bsglobal` defining cumulative point standings per age/gender category.

- **Implementation**: `src/main/combinedEvents.ts` — called from `db.ts` after event/agegroup CRUD
- **Config**: `../../config/combined-events-config.json` (see `config/CLAUDE.md` at repo root)

## Fixture data

- Generator: `scripts/generate-fixture-smb.ts`
- Output: `fixture_pool.smb`, `fixture_beach.smb` (10 clubs, 150 athletes, events, registrations)
- Usage: File → Restaurer un meet (.smb)

## Simulate Results (test script)

Injects random swim times into all `swimresult` rows that have no time yet. Useful for end-to-end testing of the results export flow without running a real competition.

- **Script**: `scripts/simulate_results.bat` (calls `scripts/simulate_results.py`)
- **Default DB**: `%APPDATA%\SauvetageMeet\meet.db`
- **Logic**: `swimtime = entrytime ± 5%` (random if NT: 30–180s), 5% DSQ
- **Side effect**: marks affected heats as official (`racestatus=5`)
- **Idempotent**: only fills rows where `swimtime` is NULL or 0 — safe to re-run after generating finals

```bash
# Default path
scripts\simulate_results.bat

# Custom path
scripts\simulate_results.bat "C:\path\to\meet.db"
```
