# Team App (SauvetageTeam) — Web App

## How to run (Docker via WSL)

Runs docker-ce natively inside WSL (Ubuntu). All `docker` commands run from a WSL terminal.

```bash
# In WSL terminal — repo is accessed via /mnt/c
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
cp .env_template .env    # first time only; set SECRET_KEY
docker compose up -d     # builds images, starts DB + backend + frontend
```

**Access:** http://localhost:8001 (WSL localhost is forwarded to Windows)
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

## Schema (dual-schema architecture)

**Team Manager schema (new — authoritative for auth, clubs, athletes):**
- `clubs` — club identity, PINs, email (via `TeamClub` model)
- `members` — athletes (via `Member` model)
- `meets` — multi-meet support (historical + current)
- `sessions` — meet sessions (linked to meet)
- `events` — meet events with `minage`/`maxage` directly (no agegroup table)
- `results` — registrations AND historical results (best times computed from here)
- `swimstyle` — shared between both schemas

**Meet Manager schema (old — still used for registration view, export, combined events):**
- `club`, `athlete`, `swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`
- Kept in sync via dual-write on all mutations
- Will be removed once all read paths are migrated

**Key bsglobal keys:**
- `current_meetsid` — ID of the active meet in Team Manager schema
- `admin_pin` — admin authentication PIN
- `organizer_club_id` — organizer club ID (references `clubs.clubsid`)
- `bt_{athlete_id}` — JSON best times (legacy, being replaced by `results` table)

## Best times storage

**Dual system (transition):**
1. **Legacy JSON blobs** in `bsglobal` as `bt_{athlete_id}` keys: `{style_uid: {course: {time_ms, date, source}}}`. Updated on results upload, expired after 18 months.
2. **Team Manager `results` table**: `best_times_v2.py` computes best times via SQL query across all historical results. Fed by results upload sync and MDB/SMB import.

The registration page tries `best_times_v2` first (queries `results` table), falls back to JSON blobs if empty. **Not updated for beach meets** (positions are not times). Pool styles use 5xx IDs, beach styles use 6xx — no collisions.

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
| `GET /api/admin/backup-db` | Download full PostgreSQL dump (.sql) | Admin |
| `POST /api/admin/restore-db` | Restore database from .sql dump | Admin |
| `POST /api/admin/import-mdb` | Import Splash Team Manager .mdb file | Admin |
| `GET /api/admin/historical-meets` | List historical meets (Team Manager schema) | Admin |
| `DELETE /api/admin/historical-meets/{id}` | Delete a historical meet | Admin |
| `POST /api/admin/import-meet-results` | Import .smb as historical meet results | Admin |
| `POST /api/import-results-lxf` | Import results .lxf as historical meet; organizer path also resets current meet + PINs + clears organizer | Organizer/Admin |
| `GET /api/athletes` | Athlete list | Any authenticated |
| `GET /api/admin/gemini-keys` | Get masked Gemini API keys | Admin |
| `POST /api/admin/gemini-keys` | Set free/paid Gemini API keys | Admin |

## Source layout

```
backend/app/
  main.py               — FastAPI app, startup, audit logging
  models.py             — SQLAlchemy models (old Meet Manager schema, kept for dual-write)
  models_team.py        — Team Manager schema (clubs, members, meets, events, results)
  routers/api.py        — All API endpoints
  combined_events.py    — COMBINEDEVENTS XML generator (Python port)
  events.py             — LENEX meet structure parser (dual-writes to both schemas)
  best_times.py         — Best time storage (bsglobal JSON blobs + sync to results table)
  best_times_v2.py      — Best times computed from Team Manager results table
  export.py             — LENEX export (registrations + Gemini key transport; session names + pause events included)
  export_entries.py     — LENEX export (all clubs + athletes + best times)
  invoices.py           — Stripe invoice generation
  seed.py               — Entries .lxf parser (dual-writes clubs/athletes to both schemas)
  mdb_import.py         — Splash Team Manager .mdb import (via mdbtools)
  smb_to_team.py        — Import .smb as historical meet in Team Manager schema
  lxf_to_team.py        — Import results .lxf as historical meet (merges clubs/members, upserts if same name)
  smb.py                — SMB file format handler (Splash Meet Backup)
frontend/src/
  main.jsx              — React app, routing, EventsPage wrapper
  meetApi.js            — MeetAPI adapter (HTTP → FastAPI)
  i18n.jsx              — Team-app specific translations
  pages/                — Athletes, Organizer, Admin, DataManagement, etc.
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
- Resets the current meet (clears registrations, events, bsglobal meet keys)
- Regenerates all club PINs (coaches must re-authenticate for next meet)
- Clears `organizer_club_id` — organizer is logged out
- Admin then sets a new organizer for the next meet via Admin page

**Admin import** (`POST /api/import-results-lxf` with admin PIN): same historical archival, **no reset**. If a completed meet with the same name already exists, its results are replaced rather than duplicated.

## In-App Documentation

- Location: `frontend/public/docs/`
- Files: `team-admin_{lang}.md`, `team-organizer_{lang}.md`, `team-coach_{lang}.md`
- Accessed via: `/usage` route (tab navigation between guides)
- Screenshots: `frontend/public/docs/assets/team-*.png`

## Combined Events

Auto-generated XML in `bsglobal` defining cumulative point standings per age/gender category.

- **Implementation**: `backend/app/combined_events.py` — called from `api.py` after `upload_meet`
- **Config**: `../../config/combined-events-config.json` (see `config/CLAUDE.md` at repo root)
