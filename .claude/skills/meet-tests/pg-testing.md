# PostgreSQL backend testing (meet-app)

### PostgreSQL backend testing (schema/data cross-compatibility)

The app has two DB backends (`connectionManager.ts` → `SqliteBackend` / `PgBackend`, both implementing `DbBackend`). The **hard requirement** is that a shared PostgreSQL server can be hit concurrently by multiple SauvetageMeet stations, and by real Splash Meet Manager, without behavior drift or corruption. Two test layers cover this:

**Backend parity** — `schema.test.ts`, `heat-generation.test.ts`, and `combined-events.test.ts` run every test against *both* backends via `describe.each(['sqlite','pg'])`. This catches anything that behaves differently on PG (e.g. `inClause()`'s PG-vs-SQLite branch in `db.ts`, `pgBackend.ts`'s placeholder rewriting/row normalization — running this suite is what caught that Postgres returns `COUNT(*)` as a string, not a number, now fixed in `pgWorker.js`'s type parsers).

**Multi-station concurrency** — `concurrency.test.ts` runs two independent connections against one real Postgres database to reproduce races two real stations would hit. **Confirmed concurrency model: only one station ever changes event structure** (heat generation, event/agegroup edits, beach-number assignment) during a meet; multiple stations *do* concurrently enter results (timing) and read/generate reports. So this suite only covers concurrent results-entry and report reads — it deliberately does not test concurrent heat generation or beach-number assignment, since those never run from more than one station. It uses raw `pg` `Client`s rather than two `PgBackend` instances — see the file's top comment for why (`PgBackend` blocks synchronously per call, so two instances driven from the same test process can never truly overlap).

Note: an earlier version of this suite *did* test concurrent heat-id allocation (`db.ts:1902`/`:2140`, `SELECT MAX(heatid)+1` then INSERT, no locking) and concurrent late beach-number assignment (`beachNumber.ts:347-356`, same MAX+1 pattern) — both reproduced real duplicate-id races against a live Postgres container. Those tests were removed as out of scope once the single-station-for-event-structure model was confirmed, but the underlying MAX+1-without-locking pattern in both functions is still there; it would need a locking strategy (`SELECT ... FOR UPDATE`, an advisory lock, or a real sequence) if that assumption ever changes.

**Running the PG-backed tests locally:**
```bash
# WSL terminal, once:
cd packages/meet-app
docker compose -f docker-compose.postgres.yml up -d
```
Then `npm test` from Windows or WSL — `tests/helpers.ts`'s `isPgTestAvailable()` probes `localhost:5432` (override via `TEST_PG_HOST`/`TEST_PG_PORT`/`TEST_PG_USER`/`TEST_PG_PASSWORD`) and the PG-backed suites **skip themselves with a console warning** if no server is reachable, so `npm test` still passes with no Docker running. CI always has a Postgres service (see `.github/workflows/ci.yml`), so these run on every PR.

**Alternative: native Windows Postgres (no WSL, for testing against real Splash Meet Manager)**

Real Splash runs on Windows and needs to reach the DB directly — if WSL2→Windows port forwarding isn't working (seen 2026-07-31: Windows' Host Network Service held a phantom reservation on port 5432, invisible to `netstat` but blocking real binds — a `netstat`/`Test-NetConnection` mismatch and a stuck `SYN_SENT` on an unrelated, previously-working WSL-forwarded port were the tells; a real Windows reboot would likely clear it, `wsl --shutdown` alone did not), a portable (no installer, no admin rights, no Windows service) Postgres works around it entirely:

- Binaries: `%UserProfile%\pgsql-portable\pgsql` (extracted from EDB's official Windows "binaries" zip, not the installer)
- Data dir: `%UserProfile%\pgsql-portable\data`, port **5433** (5432 was avoided — that's the port with the phantom reservation above)
- Role/database: `meetmgr` / `meetmgr` / db `meetmgr` (superuser), matching the project's usual convention
- Start: `& "$env:UserProfile\pgsql-portable\pgsql\bin\pg_ctl.exe" -D "$env:UserProfile\pgsql-portable\data" -l "$env:UserProfile\pgsql-portable\server.log" -o "-p 5433" start`
- Stop: same command with `stop` instead of `start`
- Point meet-app tests at it: `TEST_PG_PORT=5433 npm test` (rest of the env vars default to matching `meetmgr`/`meetmgr`)
- Point Splash or meet-app's "Connect to PostgreSQL" dialog at `127.0.0.1:5433`, user `meetmgr`, password `meetmgr`

Each test run creates and drops its own throwaway database (`meetapp_test_<random>`) against that server — never a fixed shared one — so parallel test files/CI runs don't collide.
