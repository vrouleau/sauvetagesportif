---
name: meet-tests
description: Run the meet-app Vitest suite (rebuilding better-sqlite3 for system Node first, optionally against a PostgreSQL server) and report results. Use when asked to run meet-app / meet tests.
disable-model-invocation: true
argument-hint: "[pg] [vitest file or -t pattern]"
---

# Run meet-app tests

Arguments: `$ARGUMENTS`

## Steps
1. `cd packages/meet-app`.
2. `npm install` if `node_modules` is missing.
3. **Always** `npm rebuild better-sqlite3` before `npm test` — `npm run dev` compiles the native module for Electron's ABI, tests need the system Node ABI. (After testing, the user must `npm run rebuild` before `npm run dev`; remind them if they've been running the app.)
4. `npm test` (append a file name or `-t "pattern"` if given in the arguments).
5. Report pass/fail counts, failing tests with key assertions, and a root-cause guess. Don't skip tests to get green.

## PostgreSQL-backed suites
`schema.test.ts`, `heat-generation.test.ts`, `combined-events.test.ts` run `describe.each(['sqlite','pg'])`, and `concurrency.test.ts` / `splash-schema-contract.test.ts` need a real Postgres. They **skip themselves with a console warning** if `localhost:5432` is unreachable, so a green run without Postgres does NOT cover the PG backend — say so in the report.

- Start one: `docker compose -f docker-compose.postgres.yml up -d` (from `packages/meet-app`, WSL). Docker may not exist in this session; if not, state that PG suites were skipped.
- Override connection with `TEST_PG_HOST` / `TEST_PG_PORT` / `TEST_PG_USER` / `TEST_PG_PASSWORD` (e.g. portable Windows Postgres: `TEST_PG_PORT=5433 npm test`; defaults `meetmgr`/`meetmgr`).
- Each run creates and drops its own `meetapp_test_<random>` database.
- `pg` argument: confirm Postgres is reachable first and fail loudly if not, instead of silently skipping.

## Notes
- Do NOT launch the Electron app from the Claude Code terminal (`ELECTRON_RUN_AS_NODE=1` crashes it).
- Test files: `heat-generation`, `gbin`, `lenex`, `schema`, `smb`, `meetvalues`, `timing-scan`, `concurrency`, `splash-schema-contract`, `age-group-rules`, `swimstyle-ranges`.
