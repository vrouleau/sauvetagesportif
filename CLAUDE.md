# Sauvetage Sportif — AI Context

## What this is
Monorepo for lifesaving competition management. Two apps sharing UI components:
- **meet-app**: Electron desktop app — "SauvetageMeet" (replaces Splash Meet Manager)
- **team-app**: Web app — "SauvetageTeam" (team registration before competition)

Per-package context:
- `packages/meet-app/CLAUDE.md` — Electron app, IPC channels, heat generation, OCR scanning, LXF export
- `packages/team-app/CLAUDE.md` — Docker stack, API endpoints, schema, meet lifecycle, integration tests
- `config/CLAUDE.md` — Shared config files, meet templates, combined events

## LXF round-trip (meet-app ↔ team-app)

| Step | Who exports | Who imports | Content |
|---|---|---|---|
| Meet setup | meet-app (File → Exporter structure) | team-app (Organizer → upload) | Sessions, events, agegroups — no athletes |
| Entries | team-app (Organizer → Télécharger LXF) | meet-app (File → Importer LENEX) | Clubs, athletes, registrations, entry times |
| Results | meet-app (File → Exporter résultats) | team-app (Organizer → Importer résultats) | Athletes + final times → archived as historical meet |

Every meet editor field travels in both directions (meet can be set up in either app); results import also resets the meet cycle. Details, field map (`config/lenex-meet-fields.json`), swimstyle checks and templates → **`lxf-roundtrip` skill**.

## Branding
- App names: **SauvetageMeet** (desktop) / **SauvetageTeam** (web)
- Logo: Société de sauvetage stylized "S" swimmer symbol (from sauvetage.qc.ca)
- App icon: `packages/meet-app/resources/icon.ico` / `icon.png`
- UI logo: displayed in the title bar of both apps

## How to run

### Meet app (Electron) — see `packages/meet-app/CLAUDE.md`
```bash
cd packages/meet-app && npm install && npm run rebuild && npm run dev
```
Do NOT run from Claude Code terminal (ELECTRON_RUN_AS_NODE=1 crashes it).

### Team app (Docker via WSL) — see `packages/team-app/CLAUDE.md`
```bash
# In WSL terminal
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
docker compose up -d   # http://localhost:8001, admin PIN: 314159
```

### Tests
```bash
# Meet app (PowerShell)
cd packages/meet-app && npm rebuild better-sqlite3 && npm test

# Team app integration (WSL) — see packages/team-app/CLAUDE.md for full options
cd /mnt/c/Users/eoivnru/Documents/MeetManager/sauvetagesportif/packages/team-app
python3 -m pytest tests/ -v
```

## Project structure
```
config/
  age-group-rules.json         — Shared age-group reference dates (both apps, see config/CLAUDE.md)
  combined-events-config.json  — Shared category/points config (both apps)
  template_pool.lxf            — Pool meet template (swimstyleids 500-531)
  template_beach.lxf           — Beach meet template (swimstyleids 601-624)
  splash-pg-schema.sql         — Splash's own Postgres schema (pg_dump); meet-app creates it on an empty shared PG database
  splash-pg-seed.sql           — Rows Splash writes into a new database (see the `splash-interop` skill)

packages/
  shared-ui/src/
    pages/EventsPage.tsx    — THE shared component (sessions tree + meet editor)
    pages/IndividualEntryPage.tsx — Individual event entry (relaycount=1), toolbar with Add/Delete buttons
    pages/RelayEntryPage.tsx — Relay team management (team CRUD, member dropdowns, age groups in headers)
    components/HelpTip.tsx  — "?" help bubble (hover or tap, styled, i18n text) — use it instead of a bare `title` for anything a user must understand
    context/ApiContext.tsx   — MeetAPI provider (DI for data layer)
    context/LangContext.tsx  — FR/EN language context
    data/api.ts             — MeetAPI interface + shared types
    i18n.ts                 — All FR/EN translations
    index.ts                — Barrel export

  meet-app/                 — Electron desktop (see packages/meet-app/CLAUDE.md)
    src/main/               — Main process: db.ts, IPC handlers, OCR, SMB, LENEX
    src/renderer/src/       — React UI: App.tsx, pages/
    tests/                  — Vitest unit tests
    docs/                   — HEAT_GENERATION_RULES.md, GBIN_FORMAT.md

  team-app/                 — Web app (see packages/team-app/CLAUDE.md)
    backend/app/            — FastAPI: models, routers, exporters, importers
    frontend/src/           — React UI: pages/, meetApi.js
    tests/                  — pytest integration tests + unit tests

scripts/
  generate_dsq_xml.py     — Generates Splash DSQ XML from config/dsq-codes.json.
                             Usage: python scripts/generate_dsq_xml.py [--lang fr|en] [--type pool|beach] [--output FILE]
                             Default: French, pool → config/dsq.xml (Windows-1252 encoding)
  normalize_lxf.py         — Standalone tool: normalizes historic .lxf files against a current
                             template (remaps swimstyle IDs, fuzzy-matches clubs/athletes, copies
                             HANDICAP exception codes). Usage:
                             python scripts/normalize_lxf.py TEMPLATE.lxf ENTRIES.lxf HISTORIC.lxf
  generate_entries_lxf.py  — Testing tool: generates a synthetic LENEX entries file (clubs,
                             athletes spread across age brackets, individual entries, compliant
                             relay teams) for the meet-app <-> team-app round trip, importable
                             straight into a fresh meet-app database (File → Importer LENEX).
                             Usage: python scripts/generate_entries_lxf.py --clubs N --athletes N
                             --type pool|beach --output FILE.lxf [--seed N]
                             Pairs with packages/meet-app/scripts/generate_results.py (see
                             packages/meet-app/CLAUDE.md) to fill in realistic results afterward.
  audit_duplicate_athletes.py — Read-only audit of duplicate team-app members (same name +
                             birthdate, same license, similar names, blank names) with what
                             references each copy. Usage: python scripts/audit_duplicate_athletes.py
                             DB.db [--csv plan.csv]. The CSV is the merge plan (edit suggest_keep).
  merge_duplicate_athletes.py — Merges the duplicates listed in that plan (results, meet links,
                             relay slots, registrations, best times → keeper; deletes the copies).
                             Input DB opened read-only; dry run by default, --out FILE writes a
                             merged copy to restore via Admin. Usage: python
                             scripts/merge_duplicate_athletes.py DB.db plan.csv [--out merged.db]
                             [--delete-blank]
```

## Shared critical rules

### Shared code pattern
Both apps use the same shared-ui pages; changes go in `packages/shared-ui/src/` (single source of truth; meet-app via the `@shared` Vite alias, team-app via Docker `COPY packages/shared-ui/src`). Checklist → **`shared-ui-change` skill**.

### Docker build context
Team-app `docker-compose.yml` uses `context: ../..` (monorepo root). Always run `docker compose` from `packages/team-app/`, never from the root.

### Column encoding (SQLite; also meet-app's optional shared PostgreSQL)
meet-app stores every Splash column the way Splash does (Splash reads our rows directly on a shared Postgres database). The rules everyone trips on:
- Times: INTEGER ms (`0` = no time, same as NULL). Boolean: CHAR(1) `'T'`/`'F'`.
- Gender: `0`=All (individual only), `1`=M, `2`=F, `3`=Mixed (relay only); an age group's gender always mirrors its event's.
- `swimevent.round` differs per app (meet-app uses Splash codes, team-app its own); `agemax` `-1`/`99` = Open.
- `0` and `null` are not interchangeable for optional integers once Splash/GBIN is involved.

Full table, round codes, MEETVALUES format (`KEY=TYPE;VALUE\r\n`) → **`splash-encoding` skill**.

## Domain skills (load on demand)
Detailed implementation knowledge lives in `.claude/skills/`:
| Working on… | Skill |
|---|---|
| Relay teams, composition rules, entry time/HC, SERC, relay IPC/API | `relay-entry` |
| Beach meets: bibs (`nameprefix`), ranked results, pool-vs-beach behavior, ID ranges (pool 500-531 / beach 601-624) | `beach-meet` |
| LXF import/export, meet-level fields, templates, meet reset | `lxf-roundtrip` |
| Anything in `packages/shared-ui` | `shared-ui-change` |
| SQL, migrations, importers/exporters, Splash/PG interop | `splash-encoding` |

Action skills (run on request): `/team-tests`, `/meet-tests`, `/roundtrip-test`, `/dedupe-athletes`.
