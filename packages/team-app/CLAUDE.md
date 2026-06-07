# Team App (SauvetageTeam) — Web App

## How to run (Docker via WSL)

Runs docker-ce natively inside WSL (Ubuntu). All `docker` commands run from a WSL terminal.

```bash
# In WSL terminal — repo is accessed via /mnt/c
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
cp .env_template .env    # first time only; set SECRET_KEY
docker compose up -d     # builds images, starts DB + backend + frontend
```

**Access:** http://localhost:8001 — also http://127.0.0.1:8001 with WSL2 mirrored networking (`networkingMode=mirrored` in `~/.wslconfig`)
**Default admin PIN:** `314159`

**Key .env variables** (see `.env_template` for full list):
| Variable | Purpose | Default |
|---|---|---|
| `SECRET_KEY` | Session encryption — **change this** | `change-me-to-a-random-string` |
| `ADMIN_PIN` | Admin login PIN | `314159` |
| `RESEND_API_KEY` | Email delivery (optional) | empty |
| `STRIPE_API_KEY` | Invoice generation (optional) | empty |
| `TURNSTILE_SITE_KEY` / `_SECRET_KEY` | Cloudflare CAPTCHA (optional) | empty |

**Common operations:**
```bash
docker compose logs -f backend   # tail backend logs
docker compose restart backend   # restart after a code change
docker compose down              # stop all containers
docker compose down -v           # stop + wipe volumes (full DB reset)
```

**Build context note:** `docker-compose.yml` uses `context: ../..` (monorepo root) so the frontend build can `COPY packages/shared-ui/src`. Always run `docker compose` from `packages/team-app/`.

## Integration tests (WSL)

All test commands run from a **WSL terminal**. The test suite is in `tests/`.

### How it works

- `conftest.py` manages the Docker stack automatically via `docker compose -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env`
- `docker-compose.test.yml` adds a port mapping: backend exposed on `http://127.0.0.1:8000`
- `tests/test.env` provides test-only credentials (`ADMIN_PIN=314159`, `SECRET_KEY=test-only-key-not-for-production`)
- By default the session fixture runs `down -v && up --build -d` (wipes the DB, rebuilds images) then tears down after. **This destroys the `pgdata` volume.**

### Standard run (let pytest manage the stack)

```bash
# In WSL terminal
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
pip install -r tests/requirements-test.txt   # first time: pytest + requests
python3 -m pytest tests/ -v
```

pytest wipes+rebuilds the stack, waits for backend health, runs all tests, then tears down.

### Run against a stack you already have up

```bash
MEETMGR_SKIP_STACK=1 python3 -m pytest tests/ -v
```

Backend URL defaults to `http://127.0.0.1:8000` — no override needed when using the test compose file.

### Keep the stack running after tests

```bash
MEETMGR_KEEP_STACK=1 python3 -m pytest tests/ -v
```

### Unit tests (no Docker needed)

```bash
python3 -m pytest tests/unit/ -v
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MEETMGR_URL` | `http://127.0.0.1:8000` | Backend base URL |
| `MEETMGR_SKIP_STACK` | unset | `1` = skip docker stack management |
| `MEETMGR_KEEP_STACK` | unset | `1` = skip teardown after suite |
| `ADMIN_PIN` | `314159` | Admin PIN (sourced from `tests/test.env`) |

### Regenerating test fixtures

Only needed if you change the generators:

```bash
python3 tests/generate_test_entries.py --out tests/fixtures/test_entries.lxf
python3 tests/generate_test_results.py \
    --meet tests/fixtures/meet_template.lxf \
    --entries tests/fixtures/test_entries.lxf \
    --out tests/fixtures/test_results.lxf
```

## Schema (single unified schema)

The old dual-schema architecture (separate `club`/`athlete` tables + dual-write) has been removed. There is now a single source of truth.

**Team Manager tables (authoritative for clubs, athletes, historical data):**
- `clubs` — club identity, PINs, email (via `TeamClub` model)
- `members` — athletes (via `Member` model)
- `meets` — multi-meet support (historical + current)
- `sessions` — meet sessions (linked to meet)
- `events` — meet events with `minage`/`maxage` directly (no agegroup table)
- `results` — historical results (best times computed from here)
- `membersmeets` — registration link (athlete ↔ meet)
- `relays`, `relayspos` — relay teams and positions

**Meet Manager tables (current meet operations — registration, export, heats):**
- `swimstyle`, `swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`
- `swimresult.athleteid` → references `members.membersid` directly (no separate `athlete` table)
- `bsglobal` — key-value store for meet config, MEETVALUES, Gemini keys, etc.
- `secret_links` — self-invite links

**Key bsglobal keys:**
- `current_meetsid` — ID of the active meet in Team Manager schema
- `admin_pin` — admin authentication PIN
- `organizer_club_id` — organizer club ID (references `clubs.clubsid`)
- `closure_date` — registration deadline (synced with MEETVALUES DEADLINE)
- `backup_interval_days` — auto-backup interval (default 1)
- `backup_max_count` — auto-backup retention count (default 7)

## Best times storage

Best times are computed from the Team Manager `results` table via `best_times_v2.py` — SQL query across all historical results (18-month expiry). Fed by results upload and MDB/SMB import.

**Not updated for beach meets** (positions are not times). Pool styles use 5xx IDs, beach styles use 6xx — no collisions.

## API endpoints

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
| `GET /api/export/registrations-lxf` | Export registrations .lxf (for meet-app import) | Organizer/Admin |
| `PUT /api/sessions/{id}` | Update session fields (name, date, times, lanes) | Organizer/Admin |
| `PUT /api/closure-date` | Set registration deadline (syncs to MEETVALUES DEADLINE) | Organizer/Admin |
| `GET /api/admin/backup-db` | Download full PostgreSQL dump (.sql) | Admin |
| `POST /api/admin/restore-db` | Restore database from .sql dump | Admin |
| `GET /api/admin/backup-config` | Get auto-backup config (interval + retention) | Admin |
| `PUT /api/admin/backup-config` | Update auto-backup config | Admin |
| `GET /api/admin/backups` | List all stored backups | Admin |
| `POST /api/admin/backups/create` | Create a manual backup now | Admin |
| `GET /api/admin/backups/{filename}` | Download a specific backup | Admin |
| `DELETE /api/admin/backups/{filename}` | Delete a specific backup | Admin |
| `POST /api/admin/import-mdb` | Import Splash Team Manager .mdb file | Admin |
| `GET /api/admin/historical-meets` | List historical meets (Team Manager schema) | Admin |
| `DELETE /api/admin/historical-meets/{id}` | Delete a historical meet | Admin |
| `POST /api/admin/import-meet-results` | Import .smb as historical meet results | Admin |
| `POST /api/import-results-lxf` | Import results .lxf as historical meet; organizer path also resets current meet + PINs + clears organizer | Organizer/Admin |
| `GET /api/athletes` | Athlete list | Any authenticated |
| `GET /api/admin/gemini-keys` | Get masked Gemini API keys | Admin |
| `POST /api/admin/gemini-keys` | Set free/paid Gemini API keys | Admin |
| `GET /api/relay-teams?club_id=X` | Relay page data (events, teams, eligible athletes) | Authenticated |
| `POST /api/relay-teams` | Create relay team | Authenticated |
| `DELETE /api/relay-teams/{id}` | Delete relay team | Authenticated |
| `PUT /api/relay-teams/{id}/members/{pos}` | Assign/remove member at position | Authenticated |
| `PUT /api/relay-teams/{id}/name` | Set custom team name | Authenticated |
| `GET/POST /api/serc/config` | SERC configuration (victims, factors, bystander) | Organizer/Admin |
| `GET /api/serc/teams` | SERC relay teams (swimstyle 530) | Organizer/Admin |
| `PUT /api/serc/score` | Save individual score (0-10 or -10 rough) | Public |
| `GET /api/serc/scores/1` | All scores grouped by team | Public |
| `GET /api/serc/results` | Ranked results (weighted totals) | Public |
| `POST /api/serc/draw-order/1/randomize` | Randomize team draw order | Organizer/Admin |
| `GET /api/serc/print/sheets?lang=fr` | Printable judge sheets (fr/en/bilingual) | Public |

## Relay Teams

Full CRUD management for relay team entries (events with `relaycount > 1`).

### Workflow
1. Coach navigates to "Inscriptions relais" tab
2. Selects a relay event → sees existing teams (A, B, C…)
3. Creates a team → assigns members from dropdown (filtered by eligibility)
4. Team age group auto-computed from majority of members' individual registration age groups
5. Exported in .lxf via `relays`/`relayspos` tables (Team Manager schema)

### Key rules
- Team age group: majority rule (3-1 OK, 2-2 invalid) — see `docs/RELAY_TEAM_RULES.md`
- Mixed events: exactly 2M + 2F
- **SERC events (swimstyle 530): NO gender/age restrictions** — any mix allowed
- Member eligibility: same club, registered for individual events, not on another team for same event
- Team naming: auto = concatenated last names; custom name via `PUT /api/relay-teams/{id}/name`

### LXF import
`upload_entries` (seed.py) also imports relay teams from uploaded .lxf files.

### SMB import/export
`relay`, `relayposition`, `relaysplit` tables handled in SMB backup/restore.

## Source layout

```
backend/app/
  main.py               — FastAPI app, startup, audit logging, auto-backup scheduler
  models.py             — SQLAlchemy models (meet operations: swimresult.athleteid → members.membersid)
  models_team.py        — Team Manager schema (clubs, members, meets, events, results)
  models_serc.py        — SERC models (serc_config, serc_draw_order, serc_score)
  routers/api.py        — All API endpoints
  routers/serc.py       — SERC API (config, teams, scores, draw order, results)
  routers/serc_print.py — SERC printable judge sheets (bilingual, one page per team per section)
  combined_events.py    — COMBINEDEVENTS XML generator (Python port)
  events.py             — LENEX meet structure parser
  best_times_v2.py      — Best times computed from Team Manager results table
  export.py             — LENEX export (registrations + Gemini key transport; session names + pause events included)
  export_entries.py     — LENEX export (all clubs + athletes + best times)
  invoices.py           — Stripe invoice generation
  seed.py               — Entries .lxf parser (clubs/athletes/HANDICAP into members table)
  mdb_import.py         — Splash Team Manager .mdb import (via mdbtools)
  smb_to_team.py        — Import .smb as historical meet in Team Manager schema
  lxf_to_team.py        — Import results .lxf as historical meet (merges clubs/members/HANDICAP, upserts if same name)
  historical_import.py  — Import older results .lxf as historical meet (merges clubs/members/HANDICAP)
  smb.py                — SMB file format handler (Splash Meet Backup)
frontend/src/
  main.jsx              — React app, routing, EventsPage wrapper
  meetApi.js            — MeetAPI adapter (HTTP → FastAPI)
  i18n.jsx              — Team-app specific translations
  pages/                — Athletes, Organizer, Admin, Serc, SercJudge, etc.
```

## Meet lifecycle (LXF round-trip)

Full data flow between meet-app and team-app:

| Step | Direction | What | How |
|---|---|---|---|
| 1. Setup | meet-app → team-app | Meet structure (events, sessions, agegroups) | meet-app: File → "Exporter la structure du meet LENEX…" → upload via Organizer page |
| 2. Invitations | team-app | Clubs register athletes | Organizer sends PINs; coaches log in and register |
| 3. Entries | team-app → meet-app | Registrations + entry times | team-app: Organizer → "Télécharger LXF"; meet-app: File → Importer LENEX |
| 4. Competition | meet-app | Run heats, record times | — |
| 5. Results | meet-app → team-app | Final results + athletes | meet-app: File → "Exporter les résultats LENEX…"; team-app: Organizer → "Importer résultats" |

**Step 5 (organizer path) also closes the meet cycle:**
- Archives results as a completed historical meet (`meetstate=3`)
- Resets the current meet (clears registrations, events, bsglobal meet keys) — **both organizer and admin paths trigger reset**
- Regenerates all club PINs (coaches must re-authenticate for next meet)
- Clears `organizer_club_id` (organizer path) — organizer is logged out
- Admin then sets a new organizer for the next meet via Admin page

**Admin import** (`POST /api/import-results-lxf` with admin PIN): same historical archival + reset. If a completed meet with the same name already exists, its results are replaced rather than duplicated.

**Empty meet state:** After reset (or fresh install), the meet has no events. Self-invite page shows "no meet planned" when empty. Admin or organizer uploads a new meet .lxf to start the next cycle.

## In-App Documentation

- Location: `frontend/public/docs/`
- Files: `team-admin_{lang}.md`, `team-organizer_{lang}.md`, `team-coach_{lang}.md`
- Accessed via: `/usage` route (tab navigation between guides)
- Screenshots: `frontend/public/docs/assets/team-*.png`

## Combined Events

Auto-generated XML in `bsglobal` defining cumulative point standings per age/gender category.

- **Implementation**: `backend/app/combined_events.py` — called from `api.py` after `upload_meet`
- **Config**: `../../config/combined-events-config.json` (see `config/CLAUDE.md` at repo root)

## Backup & Restore (Admin page)

Dedicated backup/restore section in the Admin page (replaces the old Data Management page backup).

**Manual backup/restore:**
- `GET /api/admin/backup-db` — download full pg_dump (.sql)
- `POST /api/admin/restore-db` — restore from .sql dump (wipes all data)
- `POST /api/admin/backups/create` — create a named backup stored server-side

**Auto-backup scheduler:**
- Background loop in `main.py` (`_auto_backup_loop`) runs pg_dump on a configurable interval
- Config stored in bsglobal: `backup_interval_days` (default 1), `backup_max_count` (default 7)
- Backups stored in `{MEET_STORAGE}/../backups/` as `auto-YYYY-MM-DD-HHMMSS.sql`
- Retention enforced: oldest backups deleted when count exceeds `backup_max_count`

**Backup list UI:**
- `GET /api/admin/backups` — list all backups (name, size, date)
- `GET /api/admin/backups/{filename}` — download specific backup
- `DELETE /api/admin/backups/{filename}` — delete specific backup

## LXF Normalization (offline tool)

Historic .lxf files from previous seasons often have stale swimstyle IDs, accent issues, or missing HANDICAP exception codes. Fix them offline with `scripts/normalize_lxf.py` before importing:

```bash
python scripts/normalize_lxf.py TEMPLATE.lxf ENTRIES.lxf HISTORIC.lxf
```

- Remaps swimstyle IDs to the current template's canonical IDs (matched by name, not ID)
- Fuzzy-matches clubs (code → name → difflib 0.80) and athletes (license → exact → difflib 0.85)
- Copies `<HANDICAP exception="X" />` child elements to athletes missing them
- Logs all changes verbosely; `⚠ verify` suffix on fuzzy matches for manual review

## HANDICAP / Para exception codes

Athletes with a Para/disability classification carry `<HANDICAP exception="X" />` as a child element of `<ATHLETE>` in LXF (not a direct attribute).

All three LXF import paths read this element and set `members.handicapex`:
- `seed.py` — Upload Lenex (Admin page)
- `lxf_to_team.py` — Import results .lxf (Invitation / Admin page)
- `historical_import.py` — Import historical .lxf (Admin page)

Existing members missing `handicapex` are backfilled on re-import; existing non-null values are never overwritten.

## Closure Date

Registration deadline that blocks coach mutations after the date passes.

- Stored in bsglobal as `closure_date` (YYYY-MM-DD format)
- Synced bidirectionally with MEETVALUES `DEADLINE` field (Splash format: `D;YYYYMMDDHHMMSSMMM`)
- Editable via `PUT /api/closure-date` (organizer or admin)
- Organizer page shows it read-only; meet config panel allows editing
- Enforced on: athlete create/update/delete, registration create/delete

## Session Date

Sessions have a `date` field editable via the EventsPage session properties panel.
- `PUT /api/sessions/{id}` accepts `{date: "YYYY-MM-DD", ...}` along with other session fields (name, warmupfrom, warmupto, officialfrom, officialto, lanemin, lanemax)

## Age Group Codes

Age groups with `agemax >= 99` are treated as "Open" (19 & over) per Splash convention. The combined events engine matches these to the Open category (`agemax == -1 || agemax == 99`).
