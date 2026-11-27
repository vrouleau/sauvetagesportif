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

**Vite symlink gotcha:** the frontend Dockerfile copies `shared-ui/src` in
separately, then symlinks `/shared-ui/node_modules -> /app/node_modules` so
its imports resolve. `vite.config.js`'s `resolve` must **not** set
`preserveSymlinks: true` — that makes Vite treat `react` imported from
`/app/src/*` and from `/shared-ui/src/*` (via the symlink) as two distinct
modules instead of collapsing them to the same real path, so the bundle
ships two React instances. Symptom: a full white-screen crash the instant
any shared-ui component calls a hook — `Cannot read properties of null
(reading 'useState')` — invisible at build time, only shows up once a
shared-ui page is actually loaded in a browser.

## Integration tests (WSL)

Run from a WSL terminal in `packages/team-app/`: `python3 -m pytest tests/ -v` (unit only: `tests/unit/`). **Always** use compose project `-p team-app-test` for test stacks — without it `down -v` wipes the dev database. Full details, env vars, fixtures → **`/team-tests` skill** (`reference.md`).

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
- `meet_type` — `POOL` or `BEACH` for the *current* meet (also read as `MEET_TYPE`, the meet-app/`.smb` key name)

**`meet_type`** is a cached flag (real signal = swimstyleid range); swimstyle catalog is never pruned; LXF uploads carry the `.swimstyles` dotfile → `lxf-roundtrip` skill (`team-app-lifecycle.md`).

## Best times

One resolver (`best_times.py`) feeds registration, the public Best Times page and LXF exports; 18-month expiry; coach times vs archived results; beach never counts → **`best-times` skill**.

## API endpoints

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /api/sessions` | Sessions + events + age groups (for EventsPage) | Public |
| `GET /api/swim-styles` | Swimstyles for the current meet's type only (for dropdown) — see catalog note above | Public |
| `GET /api/meet-info` | Meet metadata | Public |
| `GET /api/self-invite/meets` | Active (non-archived) meets with `registration_open` + `closure_date` — login screen lists them with their registration status and offers self-invite (`/self-invite?meet=ID`, sent as `X-Meet-Id`) only for meets still open; says so when none is | Public |
| `GET /api/events` | Flat event list | Public |
| `POST /api/auth` | PIN authentication | Public |
| `POST /api/upload/meet` | Upload meet .lxf (event structure) | Organizer/Admin |
| `POST /api/upload/entries` | Upload entries/results .lxf (clubs + athletes + best times) | Admin |
| `POST /api/admin/new-meet` | Create new meet from template (pool/beach) | Organizer/Admin |
| `GET /api/export/registrations-lxf` | Export registrations .lxf (for meet-app import) | Organizer/Admin |
| `GET /api/print/entries?lang=fr&section=all\|individual\|relays` | Printable HTML of individual and/or relay entries, grouped by club (one page per club) — "Print Entries" button on the Invitation page (all) and the Individual / Relay entries pages (own section). Admin/organizer: every club; coach: own club only | Authenticated |
| `PUT /api/sessions/{id}` | Update session fields (name, date, times, lanes) | Organizer/Admin |
| `PUT /api/closure-date` | Set registration deadline (syncs to MEETVALUES DEADLINE) | Organizer/Admin |
| `POST /api/admin/restore-db` | Restore database from .db backup | Admin |
| `GET /api/admin/backup-config` | Get auto-backup config (interval + retention) | Admin |
| `PUT /api/admin/backup-config` | Update auto-backup config | Admin |
| `GET /api/admin/backups` | List all stored backups | Admin |
| `POST /api/admin/backups/create` | Create a manual backup now | Admin |
| `GET /api/admin/backups/{filename}` | Download a specific backup | Admin |
| `DELETE /api/admin/backups/{filename}` | Delete a specific backup | Admin |
| `GET /api/admin/historical-meets` | List historical meets (Team Manager schema) | Admin |
| `DELETE /api/admin/historical-meets/{id}` | Delete a historical meet | Admin |
| `POST /api/import-results-lxf` | Import results .lxf as historical meet; organizer path also resets current meet + PINs + clears organizer. Guards (before any write): 400 `not_results_file` if no RESULT has a time/status; 400 `beach_results_not_archived` if the file uses any beach style (also on `admin/import-historical`; close a beach meet with `admin/close-meet-without-results`); 409 `meet_mismatch` (override `?force_meet=true`, separate from `?force`) if the file's meet name or event ids don't match the open meet being closed — see `lxf_to_team.py` | Organizer/Admin |
| `GET /api/athletes` | Athlete list | Any authenticated |
| `POST /api/invoices/pdf-zip` | ZIP of invoice PDFs (`{club_ids}`) | Organizer/Admin |
| `GET /api/invoices/quickbooks-export/options` | The export form's remembered values (defaults until the first export) | Organizer/Admin |
| `POST /api/invoices/quickbooks-export` | ZIP of QuickBooks Online import files (`{club_ids, lang, item_name, tax_code, due_days}`): `1-customers.csv`, `2-invoices[-n].csv` (≤100 invoices / ≤1,000 rows per file), `README.txt` — see "Export to QuickBooks" | Organizer/Admin |
| `POST /api/clubs/{id}/invoice` | Send Stripe invoice | Organizer/Admin |
| `POST /api/clubs/{id}/send-invoice-email` | Email invoice (HTML + PDF, Interac instructions, Reply-To organizer) | Organizer/Admin |
| `POST /api/invoices/notify-organizer` | One summary email to the organizer for a batch of emailed invoices (`{club_ids, lang}`) | Organizer/Admin |
| `GET /api/admin/gemini-keys` | Get masked Gemini API keys | Admin |
| `POST /api/admin/gemini-keys` | Set free/paid Gemini API keys | Admin |
| Relay + SERC endpoints (`/api/relay-teams…`, `/api/serc/…`) | see `relay-entry` skill (`team-app-details.md`) | — |

## Relay Teams

Coach workflow, composition rules, HC/entry time → **`relay-entry` skill** (`team-app-details.md`).

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
  events.py             — LENEX meet structure parser
  best_times.py         — Best times: one resolver over archived results + coach-entered times (see "Best times storage")
  export.py             — LENEX export (registrations + Gemini key transport; session names + pause events included; SERC events/relays excluded — meet-app has no notion of them)
  invoices.py           — Invoice line items, deterministic invoice numbers (YEAR-MEET-CLUB[-Rn]), PDF renderer
  emailing.py           — Resend transport, shared email footer, invoice + organizer-summary email templates
  i18n.py               — Backend translations: `t(key, lang, **params)` / `tn(key, n, lang)` over `locales/{fr,en}.json` (flat keys, same keys in both — `tests/unit/test_i18n.py` enforces it). New user-facing backend text goes in the catalogues, never in an inline `lang == "en"` branch. Whole blocks (judge sheets, print labels) are read with `Section(prefix)[lang]` / `tree()`; the invitation, invoice and organizer-summary emails are built in `emailing.py`, the QuickBooks README in `quickbooks_export.py` — all from the catalogues. Frontends keep their own catalogues (`i18n.ts`, `i18n.jsx`); nothing is shared with the backend
  age_codes.py          — Age-group bounds <-> category codes (age_group_code strict / relay_age_code lenient, age_code_to_range)
  lxf_io.py             — Reading uploaded .lxf zips: read_lef_xml (the .lef, parsed with defusedxml — used by every LXF import), read_lxf_entry (another entry, e.g. the hidden .meetvalues)
  seed.py               — Entries .lxf parser (clubs/athletes/HANDICAP into members table)
  lxf_to_team.py        — THE results importer (archive_results_lxf: results .lxf → historical meet, merges clubs/members/HANDICAP, replaces a same name + date archive) + pre-import guards; import_lxf_as_meet = Organizer/Admin "Import results" entry point
  historical_import.py  — Admin "Import historical" entry point: thin wrapper over archive_results_lxf (open-meet warning, confirm before replacing)
frontend/src/
  main.jsx              — React app, routing, EventsPage wrapper
  meetApi.js            — MeetAPI adapter (HTTP → FastAPI)
  i18n.jsx              — Team-app specific translations
  pages/                — Athletes, Organizer, Admin, Serc, SercJudge, etc.
```

## Meet lifecycle (LXF round-trip)

Setup → invitations → entries → competition → results; step 5 archives, resets the meet, regenerates PINs → **`lxf-roundtrip` skill** (`team-app-lifecycle.md`).

## In-App Documentation

- Location: `frontend/public/docs/`
- Files: `team-admin_{lang}.md`, `team-organizer_{lang}.md`, `team-coach_{lang}.md`
- Accessed via: `/usage` route (tab navigation between guides)
- Screenshots: `frontend/public/docs/assets/team-*.png`


## Combined events

Meet-app only; team-app has no implementation → `combined-events` skill.

## Backup & Restore (Admin page)

Dedicated backup/restore section in the Admin page (replaces the old Data Management page backup).

**Manual backup/restore:**
- `POST /api/admin/restore-db` — restore from .db backup (wipes all data)
- `POST /api/admin/backups/create` — create a named backup stored server-side

**Auto-backup scheduler:**
- Background loop in `main.py` (`_auto_backup_loop`) snapshots the SQLite DB on a configurable interval
- Config stored in bsglobal: `backup_interval_days` (default 1), `backup_max_count` (default 7)
- Backups stored in `{MEET_STORAGE}/../backups/` as `auto-YYYY-MM-DD-HHMMSS.db`
- Retention enforced: oldest backups deleted when count exceeds `backup_max_count`

**Backup list UI:**
- `GET /api/admin/backups` — list all backups (name, size, date)
- `GET /api/admin/backups/{filename}` — download specific backup
- `DELETE /api/admin/backups/{filename}` — delete specific backup


## LXF normalization / HANDICAP codes

Offline `scripts/normalize_lxf.py` and `<HANDICAP exception>` handling → **`lxf-normalize` skill**.

## Invoices & outgoing email

Invoice numbers, QuickBooks export, Interac email path, Resend → **`team-invoicing` skill**.

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
