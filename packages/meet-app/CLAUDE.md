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
- `concurrency.test.ts` — multi-station PG concurrency (see below)
- `splash-schema-contract.test.ts` — diffs our schema against a real captured Splash-on-Postgres schema (see below)

### PostgreSQL backend testing (schema/data cross-compatibility)

The app has two DB backends (`connectionManager.ts` → `SqliteBackend` / `PgBackend`, both implementing `DbBackend`). The **hard requirement** is that a shared PostgreSQL server can be hit concurrently by multiple SauvetageMeet stations, and by real Splash Meet Manager, without behavior drift or corruption. Two test layers cover this:

**Backend parity** — `schema.test.ts`, `heat-generation.test.ts`, and `combined-events.test.ts` run every test against *both* backends via `describe.each(['sqlite','pg'])`. This catches anything that behaves differently on PG (e.g. `inClause()`'s PG-vs-SQLite branch in `db.ts`, `pgBackend.ts`'s placeholder rewriting/row normalization — running this suite is what caught that Postgres returns `COUNT(*)` as a string, not a number, now fixed in `pgWorker.js`'s type parsers).

**Multi-station concurrency** — `concurrency.test.ts` runs two independent connections against one real Postgres database to reproduce races two real stations would hit. **Confirmed concurrency model: only one station ever changes event structure** (heat generation, event/agegroup edits, beach-number assignment) during a meet; multiple stations *do* concurrently enter results (timing) and read/generate reports. So this suite only covers concurrent results-entry and report reads — it deliberately does not test concurrent heat generation or beach-number assignment, since those never run from more than one station. It uses raw `pg` `Client`s rather than two `PgBackend` instances — see the file's top comment for why (`PgBackend` blocks synchronously per call, so two instances driven from the same test process can never truly overlap).

Note: an earlier version of this suite *did* test concurrent heat-id allocation (`db.ts:1902`/`:2140`, `SELECT MAX(heatid)+1` then INSERT, no locking) and concurrent late beach-number assignment (`beachNumber.ts:347-356`, same MAX+1 pattern) — both reproduced real duplicate-id races against a live Postgres container. Those tests were removed as out of scope once the single-station-for-event-structure model was confirmed, but the underlying MAX+1-without-locking pattern in both functions is still there; it would need a locking strategy (`SELECT ... FOR UPDATE`, an advisory lock, or a real sequence) if that assumption ever changes.

**Running the PG-backed tests locally:**
```bash
# WSL terminal, once:
cd packages/meet-app
docker compose -f docker-compose.postgres.yml up -d
```
Then `npm test` from Windows or WSL — `tests/helpers.ts`'s `isPgTestAvailable()` probes `localhost:5432` (override via `TEST_PG_HOST`/`TEST_PG_PORT`/`TEST_PG_USER`/`TEST_PG_PASSWORD`) and the PG-backed suites **skip themselves with a console warning** if no server is reachable, so `npm test` still passes with no Docker running. CI always has a Postgres service (see `.github/workflows/ci.yml`), so these run on every PR.

**Alternative: native Windows Postgres (no WSL, for testing against real Splash Meet Manager)**

Real Splash runs on Windows and needs to reach the DB directly — if WSL2→Windows port forwarding isn't working (seen 2026-07-31: Windows' Host Network Service held a phantom reservation on port 5432, invisible to `netstat` but blocking real binds — a `netstat`/`Test-NetConnection` mismatch and a stuck `SYN_SENT` on an unrelated, previously-working WSL-forwarded port were the tells; a real Windows reboot would likely clear it, `wsl --shutdown` alone did not), a portable (no installer, no admin rights, no Windows service) Postgres works around it entirely:

- Binaries: `%UserProfile%\pgsql-portable\pgsql` (extracted from EDB's official Windows "binaries" zip, not the installer)
- Data dir: `%UserProfile%\pgsql-portable\data`, port **5433** (5432 was avoided — that's the port with the phantom reservation above)
- Role/database: `meetmgr` / `meetmgr` / db `meetmgr` (superuser), matching the project's usual convention
- Start: `& "$env:UserProfile\pgsql-portable\pgsql\bin\pg_ctl.exe" -D "$env:UserProfile\pgsql-portable\data" -l "$env:UserProfile\pgsql-portable\server.log" -o "-p 5433" start`
- Stop: same command with `stop` instead of `start`
- Point meet-app tests at it: `TEST_PG_PORT=5433 npm test` (rest of the env vars default to matching `meetmgr`/`meetmgr`)
- Point Splash or meet-app's "Connect to PostgreSQL" dialog at `127.0.0.1:5433`, user `meetmgr`, password `meetmgr`

Each test run creates and drops its own throwaway database (`meetapp_test_<random>`) against that server — never a fixed shared one — so parallel test files/CI runs don't collide.

**Fixture generator bug found and fixed via this setup (2026-07-31):** `scripts/generate-fixture-smb.ts` was passing `swimstyle.uniqueid: 0` (literal zero) instead of `null`. Splash treats a real `0` as "maps to catalog slot 0" in its own compiled-in base style table (slot 0 there is an unrelated yards-based IM event) rather than "no catalog mapping" — every custom lifesaving style got silently blended with that wrong entry, crashing Splash's Results tree (`TFModulResult.HeatNode`, null pointer) when clicked. Fixed by emitting `null` there so GBIN's null-disambiguation-flag encoding marks it correctly. General lesson for anything touching `.smb`/GBIN encoding: `0` and `null` are not interchangeable for optional integer fields once Splash's own null-handling is involved — check `smb.ts`'s null-sentinel logic (`docs/GBIN_FORMAT.md`) before defaulting an optional field to `0`.

Also confirmed clean (same session): a three-stage LENEX import (meet structure, then entries, then results, via `packages/team-app/tests/fixtures/{meet_template,test_results}.lxf`) into the same Splash-Postgres setup — a second, independent Splash code path from the `.smb` restore — worked with no crashes and correct Results view rendering.

**Two more real bugs found and fixed, testing meet-app's own `exportLenexResults` output (not the team-app fixture) against Splash:**
1. `<ATHLETE birthdate="...">` was writing the raw internal value (an OLE-Automation-date string like `"42883.166666666664"`) instead of an ISO date — Splash showed nonsense (or, once partially masked, wildly wrong ages). Fixed by routing it through `parseOleDate()` (now exported from `db.ts`) before writing the attribute.
2. `exportLenexResults` never wrote a `<AGEDATE>` element at all (unlike `exportMeetLenex`, which did) — LENEX's age-category calculations need it, and its total absence made Splash compute ages against some internal sentinel reference date (observed: exactly `1000 − birthYear`, i.e. Splash's fallback reference year is `1000`). Fixed by factoring the date-computation logic both functions need into a shared `computeAgeDate(mv)` helper and calling it from both — the duplication between the two functions is exactly how the gap happened in the first place (one got fixed/written correctly, the other didn't).

**Not a bug — confirmed expected behavior:** after both fixes, Splash imported the results correctly (times, status, athlete/club data all landed), but with no heat/lane placement — confirmed via Postgres statement logging that Splash's own `INSERT INTO SWIMRESULT` never includes `HEATID`/`LANE` columns at all when importing via its results-import action, regardless of what `heatid`/`lane` attributes our exported `<RESULT>` elements carry. This is intentional on Splash's side: **`exportLenexResults` produces a historical per-athlete-per-event results record (time + status), not a heat/lane seeding file** — Splash (correctly) doesn't try to graft an external system's internal heat numbering onto its own. Heat/lane placement is regenerated wherever the data currently lives, not carried through LENEX.

**Not a bug either:** the fixture's small name pool (~13 first/last names cycled across 150 athletes over 10 clubs) produces athletes that coincidentally share a full name far more often than a real competition would — each is still a distinct `athleteid` with its own birthdate/club/license, and Splash (like our own code) distinguishes athletes by ID, never by name. Looks like duplication in a quick visual scan; isn't one.

**Regression coverage added for the four bugs above** (`tests/lenex.test.ts`, "LENEX exporter" describe block) — these don't need Splash or Postgres to run, they're deterministic output-format checks: `exportLenexResults` writes an ISO birthdate not a raw OLE double, writes `<AGEDATE>` (both from `MEETVALUES.AGEDATE` and the current-year fallback), `exportMeetLenex` does too (regression guard for `computeAgeDate` staying shared), and a full export→import round-trip confirms `swimtime`/`resultstatus`/`heatid`/`lane` survive. Verified each one actually catches its bug by temporarily reverting the fix and confirming the test fails.

**Update (2026-08-11):** `computeAgeDate(mv)` above is now `computeAgeDate(db)` — it no longer reads `MEETVALUES.AGEDATE` at all. It reads this database's own `bsglobal.AGEDATE` (the same key `flushMeet()` sets from `new Date()` at meet creation/reset — see `ageGroupRules.ts`'s `getSeasonYear()`), computing Dec 31 of *that* season year instead of always defaulting to today's calendar year. This matters for a meet held early in the year for a season that started the previous fall (e.g. a pool competition in Feb 2026 for the 2025-2026 season) — the old fallback would emit `2026-12-31`, the wrong season anchor; it now correctly emits `2025-12-31`. MEETVALUES.AGEDATE was never actually wired to anything on the import side regardless (nothing set it from an incoming LXF's `<AGEDATE>`), so this was silently always hitting the "not set" fallback in practice — see `config/CLAUDE.md`'s "Age Group Rules" section for the full age-determination fix this is part of.

**Follow-up audit (2026-07-31): does the birthdate bug affect team-app too, and are there other OLE/ISO gaps?** `exportLenexResults` is the actual production path for step 5 of the meet lifecycle (meet-app → team-app, see "Meet lifecycle" in `packages/team-app/CLAUDE.md`), not just a Splash-testing artifact, so this mattered beyond Splash compatibility:
- **team-app's import doesn't crash on a malformed birthdate — it silently drops it.** `lxf_to_team.py`'s `_parse_date` (and `historical_import.py`'s equivalent) wrap the parse in `try/except ValueError: return None`. A raw OLE-double string never raises; it just becomes `None` — new members get no birthdate (breaks next season's age category), existing members (matched by license) never get birthdate updated at all, and nothing surfaces an error anywhere. Our fix stops this going forward; any *already-archived* historical meets from before the fix may have null birthdates worth a spot-check if that matters.
- **Found and fixed a second, identical-class bug**: `exportMeetLenex`'s session date (`lenex.ts` ~line 1248) was `sess.startdate ? sess.startdate.slice(0, 10) : ageDate` — `swimsession.startdate` is the same dual-format (ISO or raw-OLE-double) column as `athlete.birthdate`, and `.slice(0,10)` silently produces garbage whenever the DB came from an `.smb` restore (which never converts it — confirmed in `smb.ts`). Fixed to `parseOleDate(sess.startdate) ?? ageDate`, matching the same pattern already used correctly for the same column in `db.ts:765`. Regression test added (`tests/lenex.test.ts`, "writes an ISO-formatted session date").
- **team-app's own LENEX export is correct** — `export.py`/`export_entries.py` use proper `.date()`/`.strftime()` calls, no reverse-direction bug.
- **`importLenex`'s read path and `smb.ts`'s GBIN encode/decode are correct** — the dual-format column is handled consistently by every other reader (`parseOleDate`/`parseBirthYear`/`parseBirthDate` in `db.ts` all branch on `/^\d{4}-/` first, OLE-double fallback second).
- **Not fixed, lower confidence, team-app-side, separate from this bug:** `exportLenexResults` never writes a `startdate`/session `date` at all (unlike `exportMeetLenex`, which does since the fix above) — `lxf_to_team.py` looks for exactly those attributes to set `meets.mindate`/`maxdate`/`results.eventdate`, so they end up NULL for results imports specifically. Whether this actually matters is unclear: `best_times_v2.py` computes an 18-month cutoff that (per the audit) may not actually be applied in the query that uses it — unconfirmed, would need a closer look at `best_times_v2.py` if this turns out to matter in practice.

**Splash schema contract (Layer 3)** — `splash-schema-contract.test.ts` diffs `schema.ts`'s `SCHEMA_DDL` against `tests/fixtures/splash-schema.csv`, a real `information_schema.columns` dump captured 2026-07-31 from an actual Splash Meet Manager instance connected via ODBC DSN to a fresh Postgres database (not our own reverse-engineering of the format — the genuine article). It fails on any column Splash has that we don't (silent data loss / crash reading a real Splash-created DB), and on any column we have that Splash doesn't unless it's on the `KNOWN_EXTRA_COLUMNS` allowlist in the test file (currently just `dsqitem.name_en` — our own bilingual-DSQ addition, intentionally backfilled onto pre-existing Splash tables via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `connectionManager.ts`). This is what caught `agegroup.afinal8lanes` (a real Splash column we were missing, now added) in the same session the fixture was captured.

Regenerating the fixture (only needed if Splash's own schema changes): connect real Splash to a fresh empty Postgres via its ODBC DSN — just opening the connection makes Splash create its full ~34-table schema — then dump with the `psql` command in the test file's header comment.

**Operational finding, not a bug**: restoring an `.smb` backup directly into a Splash-Postgres connection that has never been opened (i.e. an empty database with zero tables) crashes Splash with a generic "database contains wrong data" error. The fix is procedural, not code: let Splash connect to the target Postgres database first (which makes it auto-create its schema), *then* restore the `.smb` into it. Confirmed 2026-07-31 — same `fixture_pool.smb`, same DSN, crashed against a schema-less database and restored cleanly once Splash had initialized its own tables first.

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

### Prelim/Final event numbering

`handleConvertToFinal` (shared-ui `EventsPage.tsx`) splits a Timed Final into a
Prelim + Final pair. The Final reuses the prelim's `eventnumber` (Splash
convention — confirmed against a real Splash `.mdb`: prelim and final share
`EventNumber` but have distinct `SwimEventID`s, differentiated by `round`).
Do NOT mint a new event number for the final — that's what causes "Event 5"'s
final to show up as an unrelated "Event 83". Because `eventnumber` can now be
shared, timing-scan barcode matching keys on `swimeventid` instead — see
"Barcode format" below.

### LXF round-trip details

**Import (`importLenex`):**
- Remaps `swimstyleid` via `uniqueid` attribute (Splash uses internal auto-increment IDs in MDB but canonical 5xx UIDs in Lenex)
- Events with `round=11` (MDB encoding for Break/Pause) are marked `internalevent='T'`
- Extracts MEETVALUES metadata from meet attributes (name, course, agedate, deadline, etc.)
- Auto-detects `MEET_TYPE` from swim style IDs: if any `swimstyleid >= 600` → `BEACH`, else `POOL` (only when not already set)

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
| `db:get-matching-age` | Age to use for age-group matching (season-reference-date rules, see `config/CLAUDE.md`) |
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
Age group: a team's category = the event it was created under. Members must be that exact category or the single adjacent-younger one (swim-up); ≥2 members must match exactly (1-3/0-4 invalid). No per-team age label shown in UI. See `docs/RELAY_TEAM_RULES.md` for full rules (any split valid beyond the anchor — 4-0/3-1/2-2 — 2M+2F for mixed).

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
- Auto-assigns beach numbers to athletes missing one before generating heats
- `swimevent.maxentries = 0` → no heat distribution: events like beach flags/sprint that only run a final (results entered manually on the beach) get a single empty heat shell instead of entries being split across heats

## Beach Numbers

Athletes in beach meets get a unique jersey/bib identifier stored in `athlete.nameprefix`.

### Format: `Letter + 3 chars` (e.g., `C201`; `CA01` for Masters)
- **Letter (A-Z):** Club letter (from club code chars, fallback first unused A-Z)
- **Category char:** **Fixed global code** per (age bracket, sex) — same code for every club, not
  assigned dynamically. Brackets follow `AGE_CODE_ORDER` (`shared-ui/src/logic/ageGroupCode.ts`):
  10-, 11-12, 13-14, 15-18, Open, Masters, each with an F slot then an M slot:
  `10-F=0 10-M=1 11-12F=2 11-12M=3 13-14F=4 13-14M=5 15-18F=6 15-18M=7 OpenF=8 OpenM=9 MastersF=A MastersM=B`.
  Bracket comes from the athlete's age group (`agemin`/`agemax`/`name` via `ageGroupCodeFor`); sex
  comes from the athlete's own `athlete.gender` (not the age group's — a relay's age group can be
  mixed/X, but each teammate keeps their own individual-sex category).
- **Last 2 chars (01-99):** Alphabetical sequence within category

### Source: `src/main/beachNumber.ts`
| Function | Purpose |
|----------|---------|
| `generateBeachNumbers(db)` | Full idempotent regen — clears all, recomputes from scratch |
| `assignLateBeachNumber(db, athleteId)` | Late arrival — assigns next available in club/category |

### Triggers
- **LXF import** (`importLenex`): calls `generateBeachNumbers` when `MEET_TYPE='BEACH'`
- **Late entry** (`registerForEvent`): calls `assignLateBeachNumber` for the new athlete
- **Heat generation** (`generateHeats`): calls `assignLateBeachNumber` for any athletes with entries but no beach number

### Constraints & properties
- Max 26 clubs, 12 fixed categories (6 age brackets × 2 sexes), 99 athletes per category per club
- Deterministic, unique, idempotent, stable (late arrivals don't shift existing)
- Club letter assignment: tries each char of `club.code`, fallback first available A-Z
- An athlete with no resolvable sex (`athlete.gender` not 1 or 2) gets no beach number and is
  reported in `BeachNumberResult.errors` — every real athlete has a gender from LXF import, so
  this should only happen with malformed data

### Display
- HeatsPage: shown next to athlete name
- AthletesPage: read-only column
- "Identifiants plage" PDF report

### Tests: `tests/beach-number.test.ts`
- Property-based tests (fast-check): uniqueness, determinism, format validity
- Unit tests: sequence numbering, late arrival, capacity errors

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
`E{eventNumber}-U{swimEventId}-H{heatNumber}-L{lane}` — e.g. `E5-U1496-H2-L3` = Event 5, Heat 2, Lane 3.
`swimEventId` (the internal `swimevent` primary key) is what validate-scan actually
matches on — it's always unique, unlike `eventNumber`, which a prelim and its final
can share (see "Prelim/Final event numbering" below).

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
3. Keys travel to meet-app via `.lxf` export: embedded as `.keys` JSON dotfile
   inside the zip archive (transparent). Team-app's own `.smb` import/export
   was removed (superseded by LXF) — this is now the only path.
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

### Prelim/Final resolution

`queryEventsWithAgeGroups` (and the COMBINEDEVENTS XML it feeds) intentionally references
the **prelim's** event/agegroup ids — that's the stable "event slot" Splash's own export
uses, and what the report UI's event tree lets the user select. But `getCombinedResults`
and `getPointStandings` (`db.ts`) resolve each matched pair through `resolveToFinal()`
before querying `swimresult`, so the actual points come from the **final's** placements
when a final exists. Verified athlete-by-athlete against a real Splash `.mdb` for an
actual competition (CanadienMai2026_S40): Splash's own combined-events totals reflect
final results, not prelim heat times — scoring off the prelim would use stale/slower
times once finals have been swum.

### Finale A/B ordering (§4.4.2.1)

At CQS, when 16 finalists split into Finale A (ranks 1-8) and Finale B (ranks 9-16), a
B-finalist's time is never compared against an A-finalist's for medals/points — A always
outranks B, even if a B swimmer posted the faster raw time (Règlements Québec §4.4.2.1;
Finale B swims first, Finale A last, per `seedFinals`' `finalOrder` handling). `autoQualify`
already writes this grouping to `swimresult.qualcode` / `relay.qualcode` (`'A'`, `'B'`, `'C'`,
… or `'R'` for reserve) when splitting finalists across heats — `getCombinedResults`,
`getPointStandings`, and `getResultsList` all order by `qualcode` before `swimtime`, reusing
that existing column rather than adding a parallel concept. Meets that never call
`autoQualify`/`seedFinals` (the common case — a single final, no A/B split) leave `qualcode`
NULL on every row, so this is a no-op tiebreaker there: pure time ordering, unchanged. Tests:
`tests/combined-events.test.ts` ("Finale A/B qualification ordering") and
`tests/results-list.test.ts` — the latter matters most since `getResultsList` is what the
printed "Liste des résultats" report (medals) reads its rank order from.

## Fixture data

- Generator: `scripts/generate-fixture-smb.ts`
- Output: `fixture_pool.smb`, `fixture_beach.smb` (10 clubs, 150 athletes, events, registrations)
- Usage: File → Restaurer un meet (.smb)

## Simulate Results (test script)

Injects random swim times into all `swimresult` rows that have no time yet. Useful for end-to-end testing of the results export flow without running a real competition.

- **Script**: `scripts/simulate_results.bat` (calls `scripts/simulate_results.py`)
- **Default DB**: auto-detects `%APPDATA%\SauvetageMeet-Dev\meet.db` (unpackaged, i.e. `npm run dev` — matches `app.setName()` in `src/main/index.ts`) vs. `%APPDATA%\SauvetageMeet\meet.db` (packaged build). **If both exist, the script refuses to guess and asks for an explicit path** — silently running against the wrong one used to look identical to a real "0 results, nothing to simulate" run (bit us for real once: `npm run dev` writes to `-Dev`, but the old hardcoded default pointed at the non-`-Dev` path).
- **Logic**: `swimtime = entrytime ± 5%` (random if NT: 30–180s), 5% DSQ
- **Side effect**: marks affected heats as official (`racestatus=5`)
- **Idempotent**: only fills rows where `swimtime` is NULL or 0 — safe to re-run after generating finals

```bash
# Default path (auto-detected)
scripts\simulate_results.bat

# Custom path (required if both packaged and dev databases exist)
scripts\simulate_results.bat "C:\path\to\meet.db"
```
