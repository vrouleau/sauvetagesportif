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
| `INVOICE_PROVIDER` | Active invoice provider, `stripe` or `quickbooks` (unset = Stripe if `STRIPE_API_KEY` set, else none) | empty |
| `STRIPE_API_KEY` | Stripe invoicing (optional) | empty |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_ENVIRONMENT` / `QBO_REDIRECT_URI` | QuickBooks Online (Intuit app keys; environment `sandbox` default or `production`; redirect URI default `APP_BASE_URL/api/quickbooks/callback`) | empty / `sandbox` |
| `QBO_ITEM_NAME` / `QBO_INCOME_ACCOUNT` / `QBO_TAX_CODE` | QuickBooks invoice setup: service Item (default `Frais d'inscription`; auto-created under `QBO_INCOME_ACCOUNT` only if both it is set and the Item is missing), exempt tax code name (default `Exempt`; `none` omits the code) | defaults |
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

All test commands run from a **WSL terminal**. The test suite is in `tests/`.

### How it works

- `conftest.py` manages the Docker stack automatically via `docker compose -p team-app-test -f docker-compose.yml -f docker-compose.test.yml --env-file tests/test.env`
- `-p team-app-test` gives the test stack its own project name — **without it, `down -v` targets the same named volume as the plain dev stack (`docker compose up -d` with no `-p`, project name defaults to the directory name) and silently wipes your local dev database.** This has happened before; always pass `-p team-app-test` (or an equivalent unique name) for any test/e2e compose invocation, never reuse the bare `docker-compose.yml` project.
- `docker-compose.test.yml` adds a port mapping: backend exposed on `http://127.0.0.1:8000`
- It also replaces Resend with a **fake** (`tests/fake_resend/server.py`, service `fake-resend` on `127.0.0.1:8025`): the backend's `RESEND_API_URL` points at it, it records every email payload and can be told to fail (`POST /control {"fail": true}`). Tests use the `fake_resend` fixture (conftest) to read the outbox. **Tests never send real email.** The stack also sets `RESEND_FROM_EMAIL=no-reply@test.local` and `SUPPORT_EMAIL=support@test.local`.
- `tests/test.env` provides test-only credentials (`ADMIN_PIN=314159`, `SECRET_KEY=test-only-key-not-for-production`)
- By default the session fixture runs `down -v && up --build -d` (wipes the test DB, rebuilds images) then tears down after — this is safe because it's scoped to the `team-app-test` project, not the dev stack.

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
- `meet_type` — `POOL` or `BEACH` for the *current* meet (also read as `MEET_TYPE`, the meet-app/`.smb` key name)

`meet_type` is a **cached flag**, not an independent source of truth — the
real signal is always the swimstyleid range (pool 500-531, beach 601-624).
It's recomputed fresh on every `POST /api/upload/meet`, scanning only *that
upload's own* events — deliberately not the SwimStyle catalog (see below),
so a stale historical style can't misclassify a new upload. `POST
/api/admin/new-meet` sets it explicitly from the request body. Historical
imports (`import-historical`, `import-results-lxf`) never touch it.

**Swimstyle id guard:** every LXF upload flags style ids outside `config/swimstyle-ranges.json` (pool 500-531 / beach 601-624) in the same 409 `new_swimstyles` warning as catalog-new ids (`reason` field per style, `?force=true` overrides); a meet structure mixing pool and beach ids is a 400 `mixed_swimstyles` (not overridable). See `config/CLAUDE.md`.

**SwimStyle catalog is never pruned across meets.** Historical events/results
keep referencing old style ids, so once a pool meet has ever run, its 5xx
styles stay in the catalog forever (same in reverse for 6xx beach styles).
Any endpoint that reads the catalog directly (`GET /api/swim-styles`) must
filter by the current `meet_type`, or it'll offer styles from the wrong
sport — this bit us for real once already.

**Full catalog travels with every LXF export** (`generate_lxf`, `generate_meet_lxf_from_db`):
LENEX only carries a SWIMSTYLE inside an EVENT, so the zip also gets a hidden
`.swimstyles` JSON dotfile (`export.current_meet_swimstyles` — the same
meet-type-filtered list `GET /api/swim-styles` returns). meet-app loads it on
import so a last-minute event can use a style no event had. Splash ignores dotfiles.

## Best times storage

One resolver in `best_times.py` (`get_best_times_for_member` / `get_public_best_times`) feeds registration, the public Best Times page and the LXF exports. Per (athlete, style, course), anything older than `BEST_TIME_MAX_AGE_MONTHS` (default 18) is ignored:
1. **Coach best time** (`athlete_best_times`, migration m0006) — authoritative while valid, even if a faster historical result exists.
2. Otherwise the **fastest official, non-HC result** from `results`, with that result's own date — or its meet's `mindate` when the result has none (most historical rows). Rows with neither date never expire.

Coach best times are written only at meet close, never on registration:
- `capture_coach_best_times` — `import-results-lxf` (before the import) and `close-meet-without-results` store each individual registration's entry time for the meet's course, dated to the meet start (`mindate`, else first session date). Entry times equal to the current best time (the pre-filled default) are skipped so a historical value isn't re-dated — and so are entry times equal to one of the athlete's *expired* times for that style/course (`_expired_times`): a best time pre-filled at registration that aged out before the meet was closed, which would otherwise be re-dated to this meet and kept for another 18 months. Relays and beach meets skipped.
- `refresh_best_times_from_meet` — end of every results import (`lxf_to_team.archive_results_lxf`, both entry points): a faster result replaces the stored time/date, unless the meet is older than the stored value.

**Entry-time help bubble:** `GET /api/athletes/{id}/registration` returns each style's `best_time_{lcm,scm}_date`/`_source` and a top-level `best_time_policy` (`max_age_months`, `typed_time_date` = `coach_best_time_date()`, the date capture would stamp). The shared `RegistrationPanel` shows a "?" next to each individual entry time (only when `best_time_policy` is present — meet-app has no best times): the BT's origin, date and expiry, and that a typed time becomes the new BT at meet close.

**Team events never have individual best times:** styles with `relaycount > 1` (relays, SERC, Lancer de la corde 10/12.5 m 523/524 — a pair, entered in the relay tab) are excluded from the resolver, even if a file recorded them per athlete.

**Relay best times (separate, only to suggest relay entry times):** `get_relay_best_times(db, member_ids, style, course)` — every member of an archived relay team (`relays.totaltime` + `relayspos`, written by both results imports via `relay_archive.py`) is credited with the team's total; a member's relay best time is the fastest one. Same rules as individual: pool only, official, `relays.resultstatus` NULL/0 (HC/DSQ/DNS/DNF excluded), 18-month expiry (team's `eventdate`, else meet `mindate`), SERC excluded, deck throws (distance < 25 m) course-free. Live registrations (no `totaltime`) never count. `GET /api/relay-teams` returns it per member (`relayBestTimeMs`); the shared relay page suggests the team entry time as the average of the members who have one.

**Throws are course-free:** individual pool styles with `0 < distance < 25` (`COURSE_FREE_MAX_DISTANCE`) — Lancer de précision 4/7 m (521/522) — don't depend on the pool's length: one best time across 50 m and 25 m (latest coach value, else fastest result), kept under the course it was actually done in (`pick_course()` reads it for any course). Registration and the public page get a `course_free` flag and show a single box. This relies on `swimstyle.distance`: meet uploads (`events.py`) now correct distance and upgrade relaycount of existing styles from the meet file (historical imports used to create them with no distance and relaycount=1); migration `m0007` applied the bundled pool/beach templates once to existing catalogs (an open meet can't be re-uploaded without losing its registrations).

**Beach meets never count** (results are finishing positions stored as ms, not times): the resolver, refresh, capture and the athlete-history best times all exclude styles `>= BEACH_STYLE_MIN` (600). Pool styles use 5xx IDs, beach styles use 6xx — no collisions. Beach results are no longer archived at all (both results importers refuse them — see "Beach meets are never archived"); the exclusions above still guard beach rows archived before that.

## API endpoints

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /api/sessions` | Sessions + events + age groups (for EventsPage) | Public |
| `GET /api/swim-styles` | Swimstyles for the current meet's type only (for dropdown) — see catalog note above | Public |
| `GET /api/meet-info` | Meet metadata | Public |
| `GET /api/self-invite/meets` | Active (non-archived) meets with `registration_open` + `closure_date` — login screen lists them with their registration status and offers self-invite (`/self-invite?meet=ID`, sent as `X-Meet-Id`) only for meets still open; says so when none is | Public |
| `GET /api/events` | Flat event list | Public |
| `POST /api/auth` | PIN authentication | Public |
| `GET /api/clubs` | Club list with fees/counts; `email` for organizer/admin, **`pin` for the admin only** (a PIN is a club's whole identity — an organizer who could read the others' would be able to log in as any club; organizers send PINs via one-time `send-pin` links) | Public / role-filtered |
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
| `POST /api/clubs/{id}/invoice` | Push the invoice to the active provider (`INVOICE_PROVIDER`) | Organizer/Admin |
| `GET /api/quickbooks/callback` | Intuit OAuth redirect target — **public** (a browser redirect has no PIN header); authenticated by the one-time `state` from connect; redirects to `/organizer?quickbooks=success\|error&reason=…` | Public (state) |
| `GET /api/invoice-provider` | Active provider + connection status (`provider: none` when there is none) + capability `sends_invoice` | Organizer/Admin |
| `POST /api/invoice-provider/connect` / `disconnect` | Connect/disconnect the active provider (Stripe: Connect onboarding link) | Organizer/Admin |
| `POST /api/clubs/{id}/send-invoice-email` | Email invoice (HTML + PDF, Interac instructions, Reply-To organizer) | Organizer/Admin |
| `POST /api/invoices/notify-organizer` | One summary email to the organizer for a batch of emailed invoices (`{club_ids, lang}`) | Organizer/Admin |
| `GET /api/admin/gemini-keys` | Get masked Gemini API keys | Admin |
| `POST /api/admin/gemini-keys` | Set free/paid Gemini API keys | Admin |
| `GET /api/relay-teams?club_id=X` | Relay page data (events, teams, eligible athletes) | Authenticated |
| `POST /api/relay-teams` | Create relay team | Authenticated |
| `DELETE /api/relay-teams/{id}` | Delete relay team | Authenticated |
| `PUT /api/relay-teams/{id}/members/{pos}` | Assign/remove member at position | Authenticated |
| `PUT /api/relay-teams/{id}/name` | Set custom team name | Authenticated |
| `PUT /api/relay-teams/{id}/entry-time` | Set/clear pool relay entry time `{entryTimeMs}` — 400 on beach/SERC | Authenticated (own club) |
| `PUT /api/relay-teams/{id}/hc` | Set/clear HC `{isHC}` (`relays.resultstatus=4`) | Authenticated (own club) |
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
4. Team age group = the category of the event the team was created under (not computed from members); no per-team label shown, event card header applies
5. Exported in .lxf via `relays`/`relayspos` tables (Team Manager schema)

### Key rules
- Team age group: anchored to the event's own category; members must be that exact category or the single adjacent-younger one (swim-up), ≥2 members must match exactly (1-3/0-4 invalid), any split beyond that is OK (4-0/3-1/2-2) — see `docs/RELAY_TEAM_RULES.md`
- Mixed events: exactly 2M + 2F
- **SERC events (swimstyle 530): NO gender/age restrictions** — any mix allowed
- Member eligibility: same club, registered for individual events, not on another team for same event
- Team naming: auto = concatenated last names; custom name via `PUT /api/relay-teams/{id}/name`
- **HC (exhibition) teams**: no gender/age restrictions (like SERC); exported as relay `ENTRY status="EXH"` (individual HC registrations too, `swimresult.resultstatus=4`)
- **Entry time** (pool, not SERC): exported as the relay `ENTRY@entrytime`; suggested from the members' relay best times (see "Best times storage")
- Closure date and club ownership apply to entry time and HC like every other relay edit

### LXF import
`upload_entries` (seed.py) also imports relay teams from uploaded .lxf files.

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
  invoice_providers/    — One module per invoice provider behind `base.InvoiceProvider` (`stripe_provider.py`, `quickbooks_provider.py` + `quickbooks_auth.py`); `secret_box.py` = Fernet over `SECRET_KEY` for stored secrets; `INVOICE_PROVIDER` picks the single active one
  invoices.py           — Invoice line items, deterministic invoice numbers (YEAR-MEET-CLUB[-Rn]), PDF renderer
  emailing.py           — Resend transport, shared email footer, invoice + organizer-summary email templates
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

**Admin import** (`POST /api/import-results-lxf` with admin PIN): same historical archival + reset. Both paths refuse a file with no results (an entries/meet-structure LXF picked by mistake) and ask for confirmation before closing the open meet with a file whose meet name or event ids don't match it. If a completed meet with the same name and start date already exists, its results are replaced rather than duplicated (a dateless file matches by name only when exactly one completed meet has it).

**One results importer:** `import-results-lxf` (`lxf_to_team.import_lxf_as_meet`) and `admin/import-historical` (`historical_import.import_historical_meet`) are thin entry points over `lxf_to_team.archive_results_lxf`; they differ only in policy — the admin one warns when the file looks like the open meet and asks (`needs_force`) before replacing an archived meet, the closing one replaces it silently. Same athlete matching, sessions/events, defusedxml parsing and response keys (`results_imported`, `relays_imported`, `athletes_matched`…) for both. They used to be two copies that drifted (one never wrote `results.eventnumb`); keep any new import rule in `archive_results_lxf`.

**Beach meets are never archived:** the results importer refuses (both entry points) a file with any style `>= BEACH_STYLE_MIN` (`is_beach_results`, decided from the file, not the per-install `meet_type` flag). The Organizer page hides "Importer résultats" for a beach meet; it's closed with "Fermer sans résultats".

**Archived results carry `results.eventnumb`** (the event number): `results.py` groups a historical meet's results by it and the athlete history sorts by it. The Organizer import used to leave it NULL (all events lumped under "event 0").

**Next-meet stub:** when the closed (or deleted) meet was the last open one, `_reload_pool_template` creates the next meet from the pool template with the same meet config as "New meet" (`_init_meet_from_template`: meet_course, filename, masters, currency, fees, AGEDATE, COMBINEAGEGROUPS). It used to get only AGEDATE — no `meet_course` — which hid every relay entry-time suggestion in the next meet.

**MEETVALUES blob** (meet-scoped `meet_config` row, Splash `KEY=TYPE;VALUE` CRLF lines): read and write it only through `meet_config.parse_meetvalues` / `serialize_meetvalues` / `read_meetvalues` / `write_meetvalues` (`keep_type=True` = raw `TYPE;VALUE`, else the prefix is stripped), or `_update_meetvalue` for one key — never hand-split the blob. Team-app twin of meet-app's `parseMeetValues`/`serializeMeetValues` (`db.ts`).

**Meet course (pool length):** stored in three places that must agree — `meet_config.meet_course` (LENEX string, canonical), `meets.course` and MEETVALUES `COURSE` (team-app's own ints 1=LCM, 2=SCY, 3=SCM — **not** Splash's, where 2=SCM, 3=SCY; meet-app stores Splash's). The shared editor and the API (`/meet-config` COURSE, session `course`) use the LENEX name, never the number. Write it only with `meet_config._set_meet_course`, read it only with `_get_meet_course` (never None: a meet with no stored course is LCM, what the meet editor shows). New sessions take the meet's course. **Changing the course in the meet editor** (`set_meet_config` COURSE) moves the meet's sessions to it and recomputes every relay entry time still following the suggestion for the new course (`best_times.refresh_relay_entry_times_for_course`; typed times kept) — an organizer who fixes the pool length late rebuilds nothing. `best_times.suggest_relay_entry_time` is the Python copy of shared-ui's `suggestRelayEntryTime` (same half-up rounding) — keep them in step.

**Meet editor fields in LXF:** every field of the meet editor travels in both directions, mapped by `config/lenex-meet-fields.json` (see `config/CLAUDE.md`): standard LENEX the way Splash writes it (MEET attributes, POOL, FACILITY, QUALIFY, CONTACT, FEES) and the hidden `.meetvalues` entry for the seeding/heat settings. Both exports write it (`export._add_meet_element`, closure date → `deadline`, `meet_currency` on FEEs); a structure upload applies the file's fields and takes its deadline as the closure date; a meet created from a template takes the template's fields (not its deadline) as defaults.

**Empty meet state:** After reset (or fresh install), the meet has no events. Self-invite page shows "no meet planned" when empty; the login screen's meet list skips the nameless/eventless stub and says no meet is planned. Admin or organizer uploads a new meet .lxf to start the next cycle.

## In-App Documentation

- Location: `frontend/public/docs/`
- Files: `team-admin_{lang}.md`, `team-organizer_{lang}.md`, `team-coach_{lang}.md`
- Accessed via: `/usage` route (tab navigation between guides)
- Screenshots: `frontend/public/docs/assets/team-*.png`

## Combined Events

Meet-app only (`src/main/combinedEvents.ts`, see `packages/meet-app/CLAUDE.md`)
— generates cumulative point-standings XML from `config/combined-events-config.json`
in meet-app's own `bsglobal`. team-app had a Python port (`combined_events.py`)
until 2026-06-16, when it was swapped for `point_scores.py` (a different,
Splash-native `POINTSCORE` mechanism); that in turn was removed 2026-08-03 as
dead code — nothing in team-app ever read either, and LXF export never
carried `COMBINEDEVENTS`/`POINTSCORE` to meet-app. team-app currently has no
combined-events implementation of its own, and doesn't need one.

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

Both LXF importers read this element and set `members.handicapex`:
- `seed.py` — Upload Lenex (Admin page)
- `lxf_to_team.py` — results importer behind Import results .lxf (Invitation page) and Import historical .lxf (Admin page)

Existing members missing `handicapex` are backfilled on re-import; existing non-null values are never overwritten.

## Invoices

After the closure date the Organizer page shows **Download PDF / Send PDF / Send to the provider** (the provider button's label follows `INVOICE_PROVIDER`; hidden when there is none).
- **Invoice number** (`invoices.invoice_number`): `YEAR-MEETSID-CLUBSID`, e.g. `2026-012-0045`. Year = `meets.mindate`, else first session date. Revision suffix `-R2`… when a send's total differs from the last sent total (`club_meet_invites.invoice_rev` / `invoice_last_total_cents`, migration m0005). Downloading a PDF previews the number without persisting; `record_invoice_sent` persists it on a successful send.
- **Provider**: exactly one of Stripe/QuickBooks per installation, from the `INVOICE_PROVIDER` env var (never both). The router (`send_club_invoice`) does the provider-neutral work — meet, organizer, line items, invoice number, `record_invoice_sent` — and hands an `InvoiceContext` to `provider.push()`; a provider raises `ProviderError(message, status)`. Plan: `docs/QUICKBOOKS_PLAN.md`.
- **QuickBooks connection** (`quickbooks_auth.py`): one company per installation (the Société's), connected via Intuit OAuth2 from the same Connect button Stripe uses. Tokens live in `bsglobal.qbo_connection`, Fernet-encrypted (`secret_box`, key from `SECRET_KEY`). Every refresh rotates the refresh token, so it is committed before the new access token is used, and refreshes are serialized by a process-wide lock that re-reads the stored tokens (single backend process assumed). Only `invalid_grant` flips the connection to *reconnect required*; network/5xx never do. `status()` is local (no Intuit call). `main._quickbooks_keepalive_loop` refreshes an idle connection weekly so the 100-day rolling refresh window never lapses. `QBO_ENVIRONMENT` defaults to `sandbox`; a connection made in another environment counts as not connected. Restoring an older DB backup brings back a rotated (dead) refresh token → reconnect. **Push** (`quickbooks_provider.push`): *create only* — never emailed from here, the Société sends from QuickBooks. Customer = the club (`qbo_customers` club→customer map keyed by realm; else exact `DisplayName`, reusing an existing customer; else created; `:` → `-`). Invoice `DocNumber` = our number **without** `-Rn` (`doc_number`); one `SalesItemLineDetail` line per invoice item against one service Item, exempt `TaxCodeRef`, `BillEmail` set but no `EmailStatus`. Idempotent: a re-push finds its invoice by the id recorded in `club_meet_invites.provider_invoice_id` (+ `provider_account` = realm, `invoice_provider`; migration m0009), else by DocNumber; same lines → `unchanged` (touches nothing). **Changed entries update that same invoice** (`_sync_existing`): a *sparse* update with only `Line` — verified against the sandbox: it replaces the whole line array and keeps DocNumber/date/customer/memo; a stale `SyncToken` (code `5010`) is re-read and every check repeated. Lines are compared by text/amount/qty/unit price, so swapping an athlete at the same total still updates. **Refused with a 409** (`_refuse_if_settled`) when QuickBooks shows a payment/credit (`Balance != TotalAmt`) or a void (`TotalAmt == Balance == 0`) — the Société adjusts those in QuickBooks; an unchanged paid invoice is still a harmless no-op. **No payment read-back:** accounting stays in QuickBooks — the app shows no paid/unpaid state and only reads an invoice's balance to refuse an update (above). `sends_invoice` is False for QuickBooks (create only), so the batch message reads "N created, N updated, N unchanged in QuickBooks" instead of "N invoice(s) sent". The router returns `action` (`created|updated|unchanged`); the `-Rn` revision still moves on our PDF/email numbers, QuickBooks keeps the original DocNumber. `ProviderError.code` carries QuickBooks' error code (`610` = not found).
- **Send count**: `club_meet_invites.stripe_send_count` is the shared counter for Stripe *and* email sends (name predates the email path).
- **Email path**: pays by Interac e-Transfer to the organizer club's email, invoice number in the memo. No Autodeposit: security question "What is the invoice number?" / « Quel est le numéro de facture? », answer = invoice number. The UI then calls `notify-organizer` once per batch; it rebuilds numbers from persisted revisions, not from the request.
- **Who is named** (`_invoice_email_parties`): Interac recipient = organizer club's email if the meet has an organizer, else `SUPPORT_EMAIL` (no organizer → the admin is the organizer). Contact sentence, Reply-To and batch summary = `SUPPORT_EMAIL` when the admin sends or there is no organizer, else the organizer. No Interac recipient (organizer without email, or no organizer and no `SUPPORT_EMAIL`) → 400 before anything is sent.

### Outgoing email (all via `emailing.send_email`)
- From address = `RESEND_FROM_EMAIL` (must be on a Resend-verified domain); display name = organizer club name (`from_header`), `SauvetageTeam` when there's no organizer and for the organizer batch summary.
- Reply-To is always set where a human can answer — invite: organizer email (support when the recipient is the organizer / no organizer); invoice: see `_invoice_email_parties`. Without Reply-To, replies go to the no-reply From address.

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
