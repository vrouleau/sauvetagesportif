---
name: splash-encoding
description: Database column encoding conventions shared by meet-app (SQLite and shared PostgreSQL) and team-app — Splash's round codes, gender codes, times in ms, T/F booleans, agemax -1, MEETVALUES format, null vs 0 in GBIN. Use when writing SQL, migrations, importers/exporters, or touching db.ts, smb.ts, pgBackend, or bsglobal.
---

# Splash column encoding

meet-app stores every Splash column **the way Splash does** — Splash reads our rows directly on a shared Postgres database (see `packages/meet-app/CLAUDE.md`, "Splash's encoding"). Schema reference: `config/splash-pg-schema.sql`, seed rows: `config/splash-pg-seed.sql`.

| Column | Encoding |
|---|---|
| `swimevent.roundname` | event name (NOT `name`) |
| `swimevent.internalevent` | `'T'` = pause/admin event |
| `swimevent.round` (meet-app) | Splash codes (`packages/meet-app/src/main/rounds.ts`): `1`=TIM, `2`=PRE, `6`=SEM, `9`=FIN, `11`=Break (also `internalevent='T'`) |
| `swimevent.round` (team-app) | own codes: `1`=PRE, `2`=SEM, `4`=FIN, `5`=TIM. Shared EventsPage sends LENEX names; each backend maps. |
| Gender | `0`=All (individual only), `1`=M, `2`=F, `3`=Mixed (relay only) |
| Times | INTEGER ms (`0` = no time, same as NULL) |
| Boolean | CHAR(1) `'T'`/`'F'` |
| `agegroup.agemax` | `99` or `-1` both = Open; meet-app writes `-1`, never NULL |
| `swimevent.preveventid` | "no linked prelim" = `-1` |
| Result status | HC/exhibition = `resultstatus=4` (relay, relays, swimresult) |
| Beach results | position × 1000 ms |

## Gender rules
Age group gender always mirrors its parent event's — never independently set (cascades on event gender update, both apps). Individual: All/M/F. Relay: Mixed/M/F, no All. LENEX `GENDER` enum is `ALL|M|F|MIXED` (old exports wrote `X` for Mixed; still accepted on import). Design rationale: `docs/AGE_GROUP_GENDER_MODEL.md`.

## MEETVALUES (meet-level config in `bsglobal`)
Splash format: `KEY=TYPE;VALUE\r\n`. Types: `I` integer, `S` string, `B` boolean (T/F), `D` date (`YYYYMMDDHHMMSSMMM`), `F` float.

## Gotchas
- **`0` vs `null`**: not interchangeable for optional integer fields once Splash's null handling is involved. E.g. `swimstyle.uniqueid: 0` makes Splash map to its built-in catalog slot 0 and crash its Results tree; emit `null`. Check `smb.ts`'s null-sentinel logic and `docs/GBIN_FORMAT.md` before defaulting to `0`.
- **Postgres returns `COUNT(*)` as a string**: handled by `pgWorker.js` type parsers; backend parity differences live in `db.ts` (`inClause()`) and `pgBackend.ts` (placeholder rewriting).
- **Dates**: see `docs/DATE_HANDLING.md`. Age bracket reference dates: `config/age-group-rules.json`.
- SQLite and the optional shared PostgreSQL must behave identically (`describe.each(['sqlite','pg'])` suites).

More: `meet-app-splash-columns.md` (how meet-app stores rounds, courses, heat racestatus, dsqitem options). Investigation history: `splash-interop` skill.