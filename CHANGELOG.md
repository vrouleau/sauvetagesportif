# Changelog

## [0.5.1] - 2026-08-16

### Other

- Gender-split individual events in the synthetic entries generator, fix 10-and-under ageMin, drop SERC from the catalog (`f84b793`)
- Include short-distance individual/relay events in club point standings (`cbd8812`)
- Default new meets to combining age groups within a heat (`c5ae602`)
- Don't surface or retry a stale live-push queue when live push is disabled (`99fa22b`)
- Fix individual gender=ALL events hidden in entry page, LXF entrytime hour padding (`4f4bb29`)
- Merge pull request #21 from vrouleau/claude/pdf-report-filename (`5f43287`)
- Suggest the actual report name when saving a PDF/HTML report (`effcf7e`)
- Merge pull request #20 from vrouleau/claude/entries-script-age-groups-xo1gzg (`e40e062`)
- Restrict entries generator to per-event age-group eligibility (`93e7636`)
- Merge pull request #19 from vrouleau/claude/lenex-results-test-generators-cat7uz (`23a99a3`)
- Add LENEX entries and results test data generators (`d8a5a12`)
- Merge pull request #18 from vrouleau/claude/beach-position-sheets-layout-sgyphu (`0d9fbc2`)
- Simplify position sheets: fixed-size rows, capped at 16 per page (`78f4ae8`)
- Fix position sheet page fill: use absolute inches, not viewport units (`9a70d69`)
- Use 100vh instead of hardcoded inch margins for position sheet pages (`c6e403d`)
- Fix position sheet page overflow with flexbox row layout (`58cca20`)
- Redesign beach position sheets: numbered position list, one heat per page (`d0ab046`)

## [0.5.0] - 2026-08-14

### 📝 Documentation

- summarize timing console integration research (Quantum, OmniSport) (`4e828ce`)

### 🔧 Chores

- use -p team-app-test for the integration-test docker stack (`bf78216`)
- maxentries=0 skips heat distribution, creates one empty heat (`bcde79f`)

### Other

- Merge pull request #17 from vrouleau/claude/sex-gender-ui-simplification-sipglh (`64ea87b`)
- Move age groups between event pairs, not just within one prelim/final split (`1587d5c`)
- Merge pull request #16 from vrouleau/claude/sex-gender-ui-simplification-sipglh (`739ae7e`)
- Fix prelim age groups still counting for medals/scoring after Final split (`d7978ec`)
- Simplify gender labels, remove redundant tree text, translate seed method (`35b7114`)
- Fix real Splash crashes from cross-table/cross-system id collisions (`f33e2aa`)
- Merge Complément into Général: drop its 6 always-static fields (`9b8ba29`)
- Fix new events stuck at gender=X, restore Déplacer vers, drop dead panel rows (`dd29116`)
- Fix CI: widen integration test gender assertions to include ALL (`707ef39`)
- Add docs/AGE_GROUP_GENDER_MODEL.md: gender simplification design doc (`6cc8ea7`)
- Simplify event/age-group sex model, add LENEX ALL/MIXED support (`c80b448`)
- Write preveventid on meet-app's own LXF exports, not just team-app's (`e0f6944`)
- Fix convert-to-final losing the prelim's age groups (`21fcd81`)
- Fix /api/export/meet-lxf serving a stale cached file instead of the live meet (`24fd25a`)
- Set swimstyle.uniqueid on LXF import, matching real Splash's canonical-ID convention (`c5bd8ac`)
- Link prelim/final rounds via preveventid on LXF export and import (`a1e9d3e`)
- Convert-to-final: keep Final in prelim's session, revert prelim on delete (`e4d6297`)
- Fix AGEDATE never syncing on LXF import, or from flushMeet, into MEETVALUES (`da1d14a`)
- Add /api/meet/reset for in-place organizer meet flush, fix secret_links delete FK crash (`ac1237d`)
- Merge pull request #15 from vrouleau/claude/concurrent-meet-phase2-stage2 (`0917b52`)
- Phase 2 Stages 5-7: meet_id plumbing, meet-switcher, admin dashboard (`95e60b1`)
- Phase 2 Stages 2-4: meets[] in /auth, X-Meet-Id header plumbing (`07fea29`)
- Merge pull request #14 from vrouleau/claude/fix-sqlite-composite-pk-migration (`9ee4664`)
- Fix m0003 composite-PK migration crash-looping on SQLite (`1d0351d`)
- Merge pull request #13 from vrouleau/claude/concurrent-meet-phase-2-b7hx7g (`6bd8d65`)
- Fix swimevent/agegroup id collisions across concurrent meets (`2e61079`)
- Phase 2 Stage 1: stop wiping every open meet on meet creation/re-upload (`dd5d686`)
- Record Phase 2 decisions: dropdown switcher confirmed, wipe scope settled (`12bc5e2`)
- Ground Phase 2 plan in verified current code, sequence the implementation (`a24dfb2`)
- Merge pull request #12 from vrouleau/claude/reglement-quebec-audit-x0b7vb (`66c5319`)
- Rank Finale A ahead of Finale B in results/points, regardless of time (§4.4.2.1) (`4a69775`)
- Add SERC disqualification support (Règlements Québec §5.14.5 / Annexe 3) (`d55fc57`)
- Sync AGEDATE into age_base_date so the meet-config UI field actually works (`1a5afdc`)
- Merge pull request #11 from vrouleau/claude/age-group-branch-9blm7n (`d1f517c`)
- Anchor LENEX AGEDATE export to the meet's own local season year (`3ef0caa`)
- Fix age-group determination to match §1.1-1.3 season reference dates (`1db43a7`)
- Localize result-status labels (DNS/DNF/DSQ/EXH) to French (`3f2c408`)
- Implement hors concours (HC/EXH) result status (`aadb2cb`)
- HC design: resolve data-model question via real Splash .mdb inspection (`16e1cff`)
- Add design notes for hors concours (HC) feature, paused pending Splash research (`84fe6c5`)
- Include relay results in club "Classement aux points" standings (`b77e1bb`)
- Fix three data-integrity bugs found auditing a live beach meet (`d282538`)
- Exclude relay events from combined-event point standings (`e13e4ae`)
- Group club points-standings report by age bracket (`9bbfaea`)
- Merge branch 'main' of github.com:vrouleau/sauvetagesportif into main (`a7c8237`)
- Beach template: zero out maxentries fallback for Beach Flag and Sprint 90m (`a4418ab`)
- Merge pull request #8 from vrouleau/claude/beach-id-number-schema-p8c36d (`7619255`)
- Merge pull request #7 from vrouleau/claude/beach-event-heat-generation-0vaavx (`e46ff28`)
- Merge branch 'claude/concurrent-meets-phase1-data-model' into main (`e5292cf`)
- Hardcode beach number category codes by age bracket + sex (`762e023`)
- Update ILS reference and DSQ catalog spec for the beach codes fix (`b7de7e6`)
- Replace beach DSQ codes with the actual ILS rule book list (`a440c83`)
- Fix two Phase 1 regressions found via live/Postgres testing, add coverage (`f737e1b`)
- Add concurrent meets Phase 1: meetsid scoping for the Meet Manager schema (`777868f`)
- Merge pull request #6 from vrouleau/fix/reload-pool-template-historical-data-loss (`8488208`)
- Fix historical meet data loss on Reset Meet and repeated meet resets (`dc860ca`)
- Merge pull request #5 from vrouleau/claude/quantum-swiss-timing-api-fa8joa (`a04f218`)
- Merge pull request #4 from vrouleau/claude/concurrent-meet-registrations-3crz32 (`b1d944d`)
- Fold in independent live-page fix: scope to today's session (`5258870`)
- Simplify live-results design: stays a singleton, on purpose (`8e905cf`)
- Add live-results feed as a fourth singleton needing meetsid scoping (`5c77569`)
- Drop pool-exclusivity assumption from concurrent meets plan (`23adcfb`)
- Revise Phase 2 meet-switching design: persistent dropdown, not login-time picker (`2d69da5`)
- Add concurrent meets plan (Phase 1 data model, Phase 2 UI) (`9a81e3e`)

## [0.4.0] - 2026-08-04

### Other

- Remove docs/TODO_DB_ABSTRACTION.md — everything it tracked is done (`2dde1bc`)
- Clean up event context menu: add Open/15-18 category presets, remove dead duplicates, fix silent no-op (`f5ffa9c`)
- Implement DB abstraction layer refactor, fix a real PG placeholder bug (`94babef`)
- Remove docs/TODO.md (`2ddcc2f`)
- Match geologix.ini to real Splash format, retire two completed audit docs (`ba4606e`)
- Itemize club invoices per athlete instead of per event (`62faa76`)

## [0.3.53] - 2026-08-03

### Other

- Replace legacy Query.get() with Session.get() across team-app (`3776fd2`)
- Fix stale swimstyleid collision with SERC in team-app test fixture (`39c54b7`)
- Remove SMB import/export and dead point-scores code from team-app (`3ac675f`)
- Add JS test runner for SERC scoring, enforce score range server-side (`1fe049a`)
- Correct stale swimstyleid ranges and audit/prune docs/*_PLAN.md TODOs (`a8849d9`)
- Add TODO: investigate deprecating SMB import/export in team-app (`d9ae3eb`)
- Write BSGLOBAL points config in Splash's real schema, not an invented one (`1f5f843`)
- Stamp BSAPPLICATION in exported .smb so Splash accepts the file on reopen (`a3c600b`)
- Carry session lanemin/lanemax through the meet-app <-> team-app LXF pipeline (`7f267b1`)
- Fix SMB gbin string truncation using byte length instead of char count (`895fda8`)
- Implement athlete deletion in meet-app (was a silent no-op) (`da969bc`)
- Assign beach numbers to relay-only athletes (`4781a73`)
- Fix mixed-gender relay events encoded as 0 instead of 3 (#3) (`0125457`)

## [0.3.52] - 2026-08-02

### Other

- Add beach position entry sheets for pen-and-paper result capture (`f1d5dc3`)
- Show incomplete relay team count on organizer club list (`c7da94c`)
- Cascade beach positions when filling an empty cell with a taken number (`c0ab9cd`)
- Fix DSQ code dropdown opening off the bottom of the window (`7a49e18`)

## [0.3.51] - 2026-08-02

### Other

- Highlight incomplete relay teams and warn on the page header (`2b3f978`)
- Fix relay LXF export collapsing all teams of a style onto one event (`5a16d8b`)
- Fix beach heat row display ignoring per-event maxentries override (`4ee78d5`)
- Fix session lane save and session/event panel not refreshing on selection (`603d675`)
- Fix Splash .smb compatibility gaps and SQLite/Postgres portability bugs (`488ac55`)

## [0.3.50] - 2026-08-01

### Other

- Fix entries-by-event report: include relay teams, order by event number (`3d76bf9`)
- Fix flaky relay gender-balance test and CI missing backend deps (`a2ddc7f`)
- Untrack .claude/settings.json (local permission allowlist) (`8760442`)
- Fix shared-ui CI test failures (`9a84951`)
- Merge branch 'claude/python-engine-electron-meet-roir3i' into main (`7ae8003`)
- Consolidate duplicated business logic into shared-ui/src/logic (`4a8ec29`)
- Document plan to consolidate duplicated business logic into shared-ui (`f166244`)

## [0.3.49] - 2026-07-31

### Other

- Show club PIN to organizer on invite page (`36fe077`)

## [0.3.48] - 2026-07-31

### Other

- Fix intermittent unclickable text fields on Electron window focus (`50822e9`)
- Keep events context menu within viewport bounds (`0a048c2`)
- Add PostgreSQL backend-parity, concurrency, and Splash schema-contract tests (`e9bbb6a`)
- Fix prelim/final event numbering, scan disambiguation, and combined-events scoring (`214ac15`)
- Support relay teams in Finals qualification and reports (`87bf903`)

## [0.3.47] - 2026-07-30

### Other

- Require 2 native-category members for relay age-group anchor rule (`c28973e`)

## [0.3.46] - 2026-07-30

### Other

- Replace relay age-group majority rule with event-anchored composition rule (`9493aaf`)

## [0.3.45] - 2026-07-30

### Other

- Fix relay team event misattribution and age group display (`bef58a4`)

## [0.3.44] - 2026-07-30

### Other

- Fix CI: move best-times aggregation out of the FastAPI router module (`7969733`)

## [0.3.43] - 2026-07-30

### Other

- Fix Best Times tab returning empty despite uploaded historical results (`6425dd4`)
- Show beach live results as position, not formatted time (`c331ee3`)
- Add regression tests for the validated-heat results filter (`d1c45a2`)
- Restore Best Times as a tab on the merged results page (`44914aa`)
- Update coach guide docs for the renamed results link (`4425aae`)
- Remove dead best-times public API endpoints (`7ad15d3`)
- Fix Best Times footer link label and stale /best-times route (`7f2a270`)
- Add per-result validation status indicator to live results page (`a05e305`)
- Only include validated heat results in results reports and results export (`88c5fee`)
- Assign beach number immediately when registering an athlete (`a08c791`)

## [0.3.42] - 2026-07-29

### Other

- Add relay support to heat generation, display, timing, and late entry (`36980d4`)

## [0.3.41] - 2026-07-29

### 🏗️ CI

- upgrade GitHub Actions to Node 24 runtime majors (`e9d252d`)

## [0.3.40] - 2026-07-29

### Other

- Hide Pool column in meet page for beach meets (`c993e36`)
- Fix Men/Women vs Boys/Girls label to use 19+ threshold, not maxAge<=14 (`ff4f6de`)
- Normalize line endings to LF repo-wide via .gitattributes (`1336b37`)
- Make age group range labels bilingual and fix open-lower-bound display (`eeadfdb`)

## [0.3.39] - 2026-07-28

### Other

- Document meet_type semantics and the Vite symlink gotcha (`2de1ede`)
- Filter /swim-styles to the current meet's type (`85894b4`)
- Fix duplicate React instances in team-app frontend build (`12739f0`)
- Fix event fields silently dropped between write and read paths (`f617d9c`)
- Uplift team-app/frontend to react-markdown 10.1.0 (`c2b4c14`)
- Uplift team-app/frontend to Vite 7 + @vitejs/plugin-react 5 (`cbacfcc`)
- Uplift meet-app to better-sqlite3 13.0.1 (`0dcb820`)
- Uplift meet-app to Electron 43.2.0 (`9b38d4f`)
- Uplift team-app/frontend to react-router 8.3.0 (`f216062`)
- Fix @types/react version mismatch in team-app/frontend (`c25c727`)
- Fix missing Electron binary on fresh install (`99ae850`)
- Uplift meet-app to Tailwind CSS v4 (`001660a`)
- Merge remote-tracking branch 'origin/agents/uplift-ts7' (`bed3b10`)
- Merge pull request #2 from vrouleau/agents/uplift-ts7 (`7cfbfb4`)
- Uplift meet-app and shared-ui to React 19.2 (`a30cf19`)
- Uplift TypeScript to 7.0.2 and patch transitive vulnerabilities (`da50803`)
- Merge pull request #1 from vrouleau/agents/prevent-version-in-app-name (`d4b370f`)
- Fix Windows installed app name by removing version from NSIS uninstall display name (`e3d8ff3`)

# Changelog

## [0.3.38] - 2026-07-18

### Other

- Add new-swimstyle confirmation on LXF import; fix historical-data-wipe and entries-mismatch bugs (`f6b3f42`)
- Fix /api/admin/new-meet wiping archived historical meets (`cfb29a5`)

## [0.3.37] - 2026-07-13

### Other

- Fix wrong age category shown/stuck for athletes in multi-bracket events (`78b8d21`)
- Add dedicated identifier column to beach heat display, sorted by identifier (`5474255`)
- Restrict registrations-lxf roster fill to already-participating clubs (`e4f8259`)
- Include unregistered club athletes in registrations-lxf export (`37d3a0c`)
- Add move-age-group-to-event feature, fix team-app registration matching (`26e40c4`)
- Fix Add Athlete silently doing nothing in meet-app (`f7869cd`)

## [0.3.36] - 2026-07-11

### Other

- Allow reassigning an athlete's club without delete/recreate (`98ad9b5`)
- Fix combined-results grouping and add per-event results list report (`4f81e6b`)
- Fix pause/break round-tripping in LXF+SMB and stale SQLite backups (`7529b09`)

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

