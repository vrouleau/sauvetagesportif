# Changelog

## [0.3.35] - 2026-07-10

### 🔧 Chores

- remove invalid files (`482610c`)

### Other

- Fix pause/event mixups and decouple swimstyle catalog from meet templates (`fa2e875`)

# Changelog

## [0.3.34] - 2026-07-09

### Other

- Fix event ordering and name-persistence bugs across meet-app/team-app (`a0ab4e0`)

## [0.3.33] - 2026-07-03

### Other

- Fix meet-app: wipe clubs/athletes on new meet/import, sync MEET_TYPE to UI after LXF import (`7816c96`)

# Changelog

## [0.3.32] - 2026-06-19

### Other

- Fix SQLite backup/restore: use backup API for live DB replacement (`1bd75e7`)

## [0.3.31] - 2026-06-19

### Other

- Fix historical import: use actual gender from LXF instead of hardcoded male (`991f63e`)
- Remove redundant category subtitle from Resultat Combine report (`b44c5b8`)

## [0.3.30] - 2026-06-19

### 🐛 Bug Fixes

- resolve all TS2305, TS2307, TS2339, TS2353 compilation errors (`e6aac9e`)
- combined results & point standings reports not generating (`d720287`)

### 🔧 Chores

- upgrade Vite 5 → 7 + electron-vite 5 + plugin-react 5.2 (`ab4de6f`)
- upgrade Electron 33 → 42 + electron-toolkit packages (`48bcdab`)
- bump safe dependencies (`5b90794`)
- migrate to TypeScript 6.0 (`59222a5`)

## [0.3.29] - 2026-06-19

### 🐛 Bug Fixes

- remove distance prefix from event names in beach meets (`89a763b`)
- use swimstyle.distance for heat capacity in HeatsPage (`099bd28`)

### 📝 Documentation

- add beach number feature to README and CLAUDE.md (`b03e88e`)

## [0.3.28] - 2026-06-19

### ✨ Features

- add select-all checkbox to individual events header (`26c0c96`)
- add 'Liste des inscriptions par épreuves' and 'Classement au points' reports (`e66771f`)
- expand beach athlete number from 3 to 4 characters (L-DDD) (`8bb0f12`)

### 🐛 Bug Fixes

- beach numbers use category-based hundreds (100=cat1, 200=cat2, etc.) (`b3da198`)

### 🔧 Chores

- fix all TS6133/TS6196 unused variable and import errors (`852f112`)

## [0.3.27] - 2026-06-18

### 🐛 Bug Fixes

- session properties panel section collapse arrows now work correctly (`9505e90`)
- move Field component to module level to prevent focus loss on keystroke (`0743140`)

## [0.3.26] - 2026-06-18

### 🐛 Bug Fixes

- remove stray BOM character from test_integration.py (`22650d5`)

### ⚡ Performance

- bulk athletes endpoint + client cache to fix slow page nav (`29053f2`)

### 🔧 Chores

- remove dead code and consolidate best_times module (`aef61b6`)

### Other

- Add AGPL-3.0 license and source file headers (`d418a69`)

## [0.3.25] - 2026-06-17

### ✨ Features

- searchable DSQ dropdown, draggable splitters, remove splits panel (`3373ebe`)
- require YAML input and add ALL option to DSQ items (`670964c`)

### 🐛 Bug Fixes

- auto-assign beach numbers when generating heats (`86a9041`)

### Other

- Add generate_dsq_xml.py script for Splash DSQ import (`ad94e53`)

## [0.3.24] - 2026-06-17

### 🐛 Bug Fixes

- auto-backup loop not running + isolate dev appdata (`4ccfc9a`)

## [0.3.23] - 2026-06-17

### 🐛 Bug Fixes

- clear existing meet before LXF import (`ec1c8bd`)
- add missing extraResources and remove obsolete meet.lxf (`b0c6859`)

## [0.3.22] - 2026-06-16

### ✨ Features

- duplicate event with age groups on Add Event when event selected (`1913080`)
- wire up dsqitem seeding, language-aware names, options filtering, and remove dummy panel (`906f76f`)
- add beach athlete number generation and display (`6520363`)

### 🐛 Bug Fixes

- duplicateEvent INSERT placeholder count (28→29) (`541789f`)
- clear MEETVALUES DEADLINE on meet re-import (`bd82e62`)

## [0.3.21] - 2026-06-15

### 🐛 Bug Fixes

- detect meet_type on LXF/SMB upload, check both key names (`de58409`)

## [0.3.20] - 2026-06-15

### ✨ Features

- generate SMB export from live database in team-app (`491b0e5`)

### 🐛 Bug Fixes

- show 'plage/beach' instead of '?' for BEACH meet type (`aed9ebd`)
- ensure shell scripts use LF line endings (`512b760`)

## [0.3.19] - 2026-06-15

### ✨ Features

- add --wipe flag to podman_restartmeet.sh to delete appdata volume (`712d9da`)
- show age groups next to relay event name in relay page (`b04953a`)
- auto-detect MEET_TYPE (pool/beach) from swim style IDs on LXF import (`8e332fd`)

### 🐛 Bug Fixes

- infer relay agegroupid from event when ENTRY lacks it (`e3e479f`)
- report relay import errors instead of silently ignoring (`dab249e`)
- relay import test must write a ZIP (.lxf), not plain XML (`24ce209`)
- relay LXF export — add team name, positions inside ENTRY, relay-only athletes (`88ba939`)
- always emit ENTRY with eventid for relay teams in LXF export (`4fa8b32`)
- refresh title bar meet name after template/SMB upload (`b1e748d`)
- sync meet name into MEETVALUES on LXF upload and new meet creation (`d7bee77`)
- refresh meet name in tree and detail panel after import/new meet (`cf60384`)

### 📝 Documentation

- update CLAUDE.md with toolbar buttons, meet type auto-detection, relay age groups (`e664767`)

### ♻️ Refactoring

- individual bsglobal keys are canonical source for meet identity (`2765acd`)

### 🔧 Chores

- remove duplicate restart_meet.sh (superseded by podman_restartmeet.sh) (`cad3d4f`)

### ✅ Tests

- add relay import tests for meet-app LENEX importer (`37eb6ba`)

## [0.3.18] - 2026-06-15

### ✨ Features

- add Add Athlete and Delete buttons to individual entries toolbar (`d8a4cf8`)
- lastest beach template (`afc2c24`)

### 🐛 Bug Fixes

- update beach template (`b4fa074`)

## [0.3.17] - 2026-06-12

### ✨ Features

- self-invite shows all clubs, saves email if none configured, add Get Help link to login (`f8d3001`)

## [0.3.16] - 2026-06-11

### ✨ Features

- add fr/en i18n support to SERC pages (`3c21042`)

### 🐛 Bug Fixes

- auto-save config when navigating away from setup page (`934df27`)
- translate overall category labels and fix French apostrophe syntax (`5253590`)

### 📝 Documentation

- update all guides to match current app structure (`dfcd2d8`)
- Oracle Cloud deployment guide (Podman + systemd + Cloudflare) (`2cacb53`)

### 🔧 Chores

- remove config/historic from source control (`5ea599c`)

## [0.3.15] - 2026-06-08

### 🐛 Bug Fixes

- organizer and coach role access for individual/relay entry pages (`42f3c1a`)

### Other

- Add meet history files and oracle cloud podman restart script (`de9a7d1`)

# Changelog

## [0.3.14] - 2026-06-07

### ✨ Features

- HANDICAP exception codes, normalize_lxf tool, WSL2 mirrored networking (`a060d6b`)

### 🐛 Bug Fixes

- remove TestDataManagement integration tests for deleted endpoints (`613ddf3`)

# Changelog

## [0.3.12] - 2026-06-05

### ✨ Features

- SERC integration — scoring, judge tablet form, bilingual print sheets, 12 integration tests (`30f4efa`)
- fees UI — meet-level fees section + per-event fee field (`b71dbcf`)
- convert TIM to Prelim+Final pair, colored phase dots (`a38b66b`)
- event/session/agegroup CRUD in team-app + swimstyle dropdown fix (`0b44fd6`)
- historical meet import with full results storage (`f6dce75`)

### 🐛 Bug Fixes

- fees stored in MEETVALUES (Splash-compatible), invoice reads from MEETVALUES (`229b9c7`)
- hide 'Max participants / vague' field for pool events (beach-only) (`cc96530`)
- remove redundant distance prefix from event names in UI (`7aef8ce`)

### 📝 Documentation

- update CLAUDE.md and team-app CLAUDE.md with SERC documentation (`d22b81e`)

### 🔧 Chores

- remove serc_claude prototype (no longer needed) (`ccaa170`)

# Changelog

## [0.3.10] - 2026-06-04

# Changelog

## [0.3.8] - 2026-06-01

### ✨ Features

- move Create Pool/Beach Meet to shared EventsPage toolbar (`3736ed8`)
- live results — meet-app → team-app real-time push (`247717d`)
- DSQ catalog + LXF/SMB/PG fixes (`3615e65`)
- add SERC prototype (`c733274`)

### 🐛 Bug Fixes

- stale club PINs in TestLiveNotifications + SMB email upsert (`907637a`)
- deprecation + SQLite compat in models_live and seed (`3716e89`)
- closeLocalDb require + LXF idempotent test + TODO testing notes (`d3dfe95`)
- integer time input < 100 interpreted as seconds (35 → 35.00, not 0.35) (`7866fff`)
- use inClause() helper for all IN queries (PG can't infer param types in IN) (`9e32a39`)
- cast agemin/agemax to TEXT in SQL concatenation (PG strict typing) (`acb28f4`)

# Changelog

## [0.3.7] - 2026-05-27

### ✨ Features

- PostgreSQL direct connect — shared DB with Splash Meet Manager + auto-refresh (`97b811e`)

## [0.3.6] - 2026-05-27

### 🏗️ CI

- auto-generate release notes on GitHub Releases page (`e5fe266`)

## [0.3.5] - 2026-05-27

### ✨ Features

- auto-generate CHANGELOG.md on npm run release (`dc435cd`)
- PG backup/restore with auto-backup scheduler + docs refresh (`8b01ae3`)
- unify closure date with MEETVALUES DEADLINE + read-only in Organizer (`8625da0`)
- session date input field + team-app updateSession endpoint (`3ca21f8`)
- historical meets, LXF round-trip, remove dual-schema (`0963329`)

### 🐛 Bug Fixes

- install sqlalchemy + hypothesis for unit tests (`e8b0ee8`)
- meet name single source of truth (MEETVALUES) + i18n title bars (`a01cdf6`)

### 🔧 Chores

- remove .kiro from source control (`7bb25e7`)

