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

