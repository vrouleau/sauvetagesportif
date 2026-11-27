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
- `capture-quality.test.ts` — scanner stable-then-capture logic (`captureQuality.ts`)
- `gbin.test.ts`, `lenex.test.ts`, `schema.test.ts`, `smb.test.ts`, `meetvalues.test.ts`, `timing-scan.test.ts`
- `concurrency.test.ts` — multi-station PG concurrency (see `meet-tests` skill)
- `splash-schema-contract.test.ts` — diffs our schema against a real captured Splash-on-Postgres schema (see `splash-interop` skill)

### PostgreSQL backend testing

Every DB test runs against both SQLite and a real-Splash-schema Postgres (skips itself if none is reachable). Setup, concurrency model, native Windows Postgres → **`meet-tests` skill** (`pg-testing.md`). Splash interop findings (shared PG creation, `.smb` crashes, id allocation, schema contract) → **`splash-interop` skill**.

### Key utility: `msToDisplay(ms)`
Converts integer milliseconds to display format (`M:SS.cc` or `SS.cc`). Returns `undefined` for `null`, `0`, negative values, and max-int sentinel (2147483647) — all treated as "no time" (NT).

## Critical rule: alert/confirm go through main (Windows focus bug)

On Windows, a renderer-side `window.alert()`/`confirm()` leaves the page without keyboard focus after it closes (fields ignore input until you switch to another window and back — seen after "Générer séries"). `renderer/src/nativeDialogs.ts` (installed in `main.tsx`) replaces both globals with `dialog.showMessageBox` in main via `sendSync` (`dialog:alert-sync` / `dialog:confirm-sync`), then re-focuses `webContents`. Keep calling `alert()`/`confirm()` normally — never bypass this with a different blocking dialog.

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
  ocrEngine.ts          — OCR engine interface
  ocrGemini.ts          — Gemini 2.5 Flash Lite vision OCR (primary)
  geminiBackground.ts   — Background Gemini processing loop (main process)
src/preload/index.ts    — contextBridge API
src/renderer/src/
  App.tsx               — App shell (title bar, tabs, modals)
  meetApiElectron.ts    — MeetAPI adapter (IPC → SQLite)
  registrationApiElectron.ts — RegistrationAPI adapter (IPC → SQLite)
  pages/EventsPage.tsx  — Thin wrapper: ApiProvider + shared EventsPage
  pages/HeatsPage.tsx   — Heat runner + Quantum toolbar + Print timing sheets
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

| `timing:save-scan` | Store scanned image + barcode metadata |
| `timing:get-scans-for-processing` | List scans by status filter |
| `timing:run-ocr` | Run OCR engine on a scan (Gemini) |
| `timing:validate-scan` | Accept times → write to swimresult |
| `timing:generate-sheets` | Generate timing sheet HTML for a list of event ids (Reports tab) |
| `timing:generate-blank-sheets` | Blank (hand-identified, no barcode) timing sheet HTML |
| `timing:find-blank-targets` | Entries seeded at a blank sheet's event/heat/lane |
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
| `db:set-relay-team-hc` | Set/clear HC — `relay.resultstatus=4` |
| `db:set-relay-team-entry-time` | Set/clear pool relay entry time (ms) — `relay.entrytime`, used for relay heat seeding |
| `db:get-meet-type` | Get meet type (POOL/BEACH) from BSGLOBAL |
| `db:get-matching-age` | Age to use for age-group matching (season-reference-date rules, see `config/CLAUDE.md`) |
| `menu:open-guide` | Open in-app workflow guide (pool/beach) |
| `db:register` | Register athlete for event (create swimresult) |
| `db:unregister` | Unregister athlete from event (delete unseeded swimresult) |


## Domain knowledge (skills, loaded on demand)

| Working on… | Skill |
|---|---|
| Heat generation, seeding, Prelim/Final conversion | `heat-generation` |
| LXF import/export details | `lxf-roundtrip` (`meet-app-details.md`) |
| Relay entry (meet-app side) | `relay-entry` (`meet-app-details.md`) |
| Beach numbers / beach mode | `beach-meet` |
| Timing sheets, barcode, OCR, Gemini | `ocr-scanning` |
| Combined events, finale A/B ordering | `combined-events` |
| Splash columns encoding (rounds, courses, racestatus) | `splash-encoding` |
| Splash crashes, shared Postgres, `.smb`, id allocation | `splash-interop` |
| Generate results / fixtures | `roundtrip-test` (`generate-results.md`) |

## In-App Documentation

- Location: `src/renderer/public/docs/`
- Files: `meet-pool_{lang}.md`, `meet-beach_{lang}.md`
- Accessed via: Aide menu → "Guide — Compétition piscine/plage" (full-screen overlay)
- Screenshots: `public/docs/assets/meet-*.png`
- Renderer: custom `GuidePage.tsx` with built-in markdown-to-HTML converter (no external dependency)
