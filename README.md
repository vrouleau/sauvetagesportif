# Sauvetage Sportif — Monorepo

Competition management software for lifesaving sport (sauvetage sportif). Replaces Splash Meet Manager (Delphi) with modern cross-platform tools while maintaining full schema compatibility with the original.

## Structure

```
config/                 — Shared configuration files (used by both apps)
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
npm test
```

> Note: `npm test` automatically rebuilds `better-sqlite3` for system Node before running vitest. If you then want to run the Electron app, use `npm run rebuild` to recompile for Electron's ABI.

### Clean build (meet-app)

```bash
cd packages/meet-app
npm run clean   # wipes out/, rebuilds native modules for Electron, runs full Vite build
```

### Fixture data (meet-app)

Generate sample `.smb` files for testing or documentation screenshots:

```bash
cd packages/meet-app
npx tsx scripts/generate-fixture-smb.ts
```

This produces two files in `scripts/`:
- `fixture_pool.smb` — Pool meet (11 events, 2 sessions, 10 clubs, 150 athletes, ~450 registrations with entry times)
- `fixture_beach.smb` — Beach meet (5 events, 2 sessions, 10 clubs, 150 athletes, ~450 registrations without times)

To load: File → *Restaurer un meet (.smb)…* and select the desired fixture. Heats are not pre-generated — use *Générer séries* in the app to create them.

### Releasing

All packages share a single version. To create a release:

```bash
npm run release minor    # 0.1.0 → 0.2.0
npm run release patch    # 0.1.0 → 0.1.1
npm run release 1.0.0    # explicit version
```

This bumps the version in all `package.json` files, commits, and creates a git tag. Then push:

```bash
git push && git push --tags
```

Pushing the tag triggers the [Release CI](.github/workflows/release.yml) which builds:
- Windows installer (`.exe`) via electron-builder
- macOS DMG
- Docker images pushed to `ghcr.io`

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
- **Heat generation** — FINA/World Aquatics-compliant seeding (circle, pyramid, straight) with qualification period, entry priority, and configurable lane order
- **Timing sheet OCR** — camera barcode scanning + Gemini vision for handwritten time recognition
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

## Timing Sheet OCR Scanning

Replaces manual time entry from handwritten timing sheets with a camera-based workflow.

### How it works
1. **Print** timing sheets from HeatsPage — portrait, 3 strips/page, full-width Code128 barcode per lane
2. **Scan** sheets in batch (Scanner tab) — camera reads barcode, captures image, hands-free
3. **Process** (Traitement tab) — Gemini 2.5 Flash Lite reads handwritten times (~1.4s/scan), operator validates
4. **Accept** → writes `backuptime1`, `backuptime2`, averaged `swimtime` to `swimresult`

### Gemini API key management
- Two keys: free tier (15 req/min, 1500/day) + paid tier (fallback on rate limit)
- Keys stored in `bsglobal` as `GEMINI_KEY_FREE` / `GEMINI_KEY_PAID`
- Admin sets keys in team-app (Admin page → "Clés API Gemini")
- Keys travel with `.smb` export/import — transparent to meet-app users
- Auto-fallback: free → paid on 429 → back to free after 60s
- Background processing runs in main process (works on any page)
- Toggle ON/OFF in Traitement page header

### Sheet format
- Barcode: `E{eventNumber}-H{heatNumber}-L{lane}` (Code128, full-width SVG)
- Two time rows: "Chrono 1" / "Chrono 2" (5 digit boxes each: M:SS.HH)
- Athlete name + club code for timer reference

### Timing scan storage
Separate SQLite file (`%APPDATA%/@meetmgr/meet-app/timing_scans.sqlite`) stores scanned images and processing state. Cleared via "Vider les scans" button or `npm run clean`.

### Dependencies (timing/OCR)
```bash
cd packages/meet-app
npm install sharp tesseract.js onnxruntime-node @ericblade/quagga2
```

## Combined Events (Cumulative Point Standings)

The `COMBINEDEVENTS` row in `bsglobal` stores an XML definition that tells Splash how to compute cumulative point standings across multiple events per age group/gender category. This is auto-generated by both apps whenever events or age groups change.

## Heat Generation

The meet-app implements FINA/World Aquatics SW 3.1-compliant heat seeding. Full documentation: [`packages/meet-app/docs/HEAT_GENERATION_RULES.md`](packages/meet-app/docs/HEAT_GENERATION_RULES.md).

### Pool meets (timed events)

### Seeding methods
- **Circle seeding** (default) — round-robin distribution for balanced prelim heats
- **Pyramid seeding** — fastest swimmers in last heat (timed finals)
- **Straight seeding** — fastest in heat 1, sequential fill

### Key features
- FINA "last N heats" rule (`fastheatcount`)
- Qualification period filtering (date range + course type)
- Entry priority ordering (bonus/exhibition/late entries seeded last)
- Combine age groups option
- Minimum swimmers per heat enforcement
- Center-out lane assignment with custom override (`lanesbyplace`)

### Configuration
Meet-level seeding config is stored in `MEETVALUES` (bsglobal):
- `SEEDMETHOD`, `FASTHEATCOUNT`, `MINPERHEAT`
- `SEEDBONUSLAST`, `SEEDEXHLAST`, `SEEDLATELAST`, `COMBINEAGEGROUPS`
- `QUALIFROM`, `QUALITO`, `QUALICOURSE`

Per-age-group overrides: `agegroup.finalseedtype`, `agegroup.fastheatcount`

### Beach meets (ranked events)

Beach events use positions (1st, 2nd, 3rd) instead of times. Heat generation works differently:
- **No lanes** — athletes are assigned sequentially, not center-out
- **Random seeding** — athletes shuffled randomly into heats
- **Max participants** from `swimevent.maxentries` (override) or `swimstyle.distance` (template default)
- **Finals** qualify by best position from prelims (lowest value = best)

Meet type is stored in `bsglobal` as `MEET_TYPE` (`POOL` or `BEACH`). Templates:
- `config/template_pool.lxf` — swimstyleids 501-540
- `config/template_beach.lxf` — swimstyleids 601-605

### Configuration

`config/combined-events-config.json` — single source of truth shared by both apps. Defines:
- **Categories**: one per age group/gender combination (10 for Canadian lifesaving: 10-, 11-12, 13-14, 15-18, 19+ × M/F/mixed)
- **Points scales**: comma-separated points per rank (e.g. `"20,18,16,14,13,12,11,10,8,7,6,5,4,3,2,1"`)
- **Flags**: `sortbyresfirst`, `finalusetype`, `isSpecialNoEvents`

This file is editable at runtime (meet-app copies it to userData on first launch; team-app mounts it in the Docker container). Modify it to adjust points scales or categories for a specific meet without rebuilding.

### How it works

1. Query all individual pool events (relaycount=1, distance≥25m, no finals linked to prelims, no admin events)
2. For each category in the config, find events whose age groups match the category's age range and gender
3. Build the XML with event IDs sorted ascending, points scale from config
4. Upsert into `bsglobal` row `name='COMBINEDEVENTS'`

### When it regenerates

| App | Trigger |
|-----|---------|
| meet-app | `createEvent`, `deleteEvent`, `updateEvent` (gender/style), `createAgeGroup`, `deleteAgeGroup`, `updateAgeGroup` (age/gender) |
| team-app | `upload_meet` (LXF upload that loads event structure) |

### XML format (produced)

```xml
<?xml version="1.0" encoding="UTF-16"?>
<COMBINEDEVENTDEFINITION>
  <COMBINEDEVENTS>
    <COMBINEDEVENT combinedeventid="1077" name="Cumulatif 10 ans et moins - filles et garçons"
      titleforprints="..." sumtype="2" pointsforplaces="20,18,16,..." maxresults="100"
      sortbyresfirst="F" penalty="10" inpercent="T" completedsq="F" finalusetype="2"
      agegroupeventid="1077">
      <EVENTS>
        <EVENT eventid="1077" mandatory="F" />
        <EVENT eventid="1095" mandatory="F" />
      </EVENTS>
    </COMBINEDEVENT>
  </COMBINEDEVENTS>
</COMBINEDEVENTDEFINITION>
```
