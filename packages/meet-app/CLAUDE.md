# Meet App (SauvetageMeet) — Electron Desktop

## How to run

**Prerequisites (one-time):**
- Windows: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
- macOS: `xcode-select --install`

```bash
cd packages/meet-app
npm install
npm run rebuild   # compile native module for Electron
npm run dev
```

F12 opens DevTools. **Do NOT run from Claude Code terminal** (ELECTRON_RUN_AS_NODE=1 crashes it).

**After switching between `npm test` and `npm run dev`:**
- Before `npm run dev`: `npm run rebuild`
- Before `npm test`: `npm rebuild better-sqlite3`

(They compile the native module for different Node ABIs.)

**Clean build (wipes out/, rebuilds native modules, runs Vite build):**
```bash
npm run clean
```

## Unit tests

```bash
npm rebuild better-sqlite3   # ensure compiled for system Node
npm test
```

Test files in `tests/`:
- `heat-generation.test.ts` — 28 tests
- `gbin.test.ts`, `lenex.test.ts`, `schema.test.ts`, `smb.test.ts`, `meetvalues.test.ts`, `timing-scan.test.ts`
- `concurrency.test.ts` — multi-station PG concurrency (see below)
- `splash-schema-contract.test.ts` — diffs our schema against a real captured Splash-on-Postgres schema (see below)

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

**Fixture generator bug found and fixed via this setup (2026-07-31):** `scripts/generate-fixture-smb.ts` was passing `swimstyle.uniqueid: 0` (literal zero) instead of `null`. Splash treats a real `0` as "maps to catalog slot 0" in its own compiled-in base style table (slot 0 there is an unrelated yards-based IM event) rather than "no catalog mapping" — every custom lifesaving style got silently blended with that wrong entry, crashing Splash's Results tree (`TFModulResult.HeatNode`, null pointer) when clicked. Fixed by emitting `null` there so GBIN's null-disambiguation-flag encoding marks it correctly. General lesson for anything touching `.smb`/GBIN encoding: `0` and `null` are not interchangeable for optional integer fields once Splash's own null-handling is involved — check `smb.ts`'s null-sentinel logic (`docs/GBIN_FORMAT.md`) before defaulting an optional field to `0`.

Also confirmed clean (same session): a three-stage LENEX import (meet structure, then entries, then results, via `packages/team-app/tests/fixtures/{meet_template,test_results}.lxf`) into the same Splash-Postgres setup — a second, independent Splash code path from the `.smb` restore — worked with no crashes and correct Results view rendering.

**Two more real bugs found and fixed, testing meet-app's own `exportLenexResults` output (not the team-app fixture) against Splash:**
1. `<ATHLETE birthdate="...">` was writing the raw internal value (an OLE-Automation-date string like `"42883.166666666664"`) instead of an ISO date — Splash showed nonsense (or, once partially masked, wildly wrong ages). Fixed by routing it through `parseOleDate()` (now exported from `db.ts`) before writing the attribute.
2. `exportLenexResults` never wrote a `<AGEDATE>` element at all (unlike `exportMeetLenex`, which did) — LENEX's age-category calculations need it, and its total absence made Splash compute ages against some internal sentinel reference date (observed: exactly `1000 − birthYear`, i.e. Splash's fallback reference year is `1000`). Fixed by factoring the date-computation logic both functions need into a shared `computeAgeDate(mv)` helper and calling it from both — the duplication between the two functions is exactly how the gap happened in the first place (one got fixed/written correctly, the other didn't).

**Not a bug — confirmed expected behavior:** after both fixes, Splash imported the results correctly (times, status, athlete/club data all landed), but with no heat/lane placement — confirmed via Postgres statement logging that Splash's own `INSERT INTO SWIMRESULT` never includes `HEATID`/`LANE` columns at all when importing via its results-import action, regardless of what `heatid`/`lane` attributes our exported `<RESULT>` elements carry. This is intentional on Splash's side: **`exportLenexResults` produces a historical per-athlete-per-event results record (time + status), not a heat/lane seeding file** — Splash (correctly) doesn't try to graft an external system's internal heat numbering onto its own. Heat/lane placement is regenerated wherever the data currently lives, not carried through LENEX.

**Not a bug either:** the fixture's small name pool (~13 first/last names cycled across 150 athletes over 10 clubs) produces athletes that coincidentally share a full name far more often than a real competition would — each is still a distinct `athleteid` with its own birthdate/club/license, and Splash (like our own code) distinguishes athletes by ID, never by name. Looks like duplication in a quick visual scan; isn't one.

**Regression coverage added for the four bugs above** (`tests/lenex.test.ts`, "LENEX exporter" describe block) — these don't need Splash or Postgres to run, they're deterministic output-format checks: `exportLenexResults` writes an ISO birthdate not a raw OLE double, writes `<AGEDATE>` (both from `MEETVALUES.AGEDATE` and the current-year fallback), `exportMeetLenex` does too (regression guard for `computeAgeDate` staying shared), and a full export→import round-trip confirms `swimtime`/`resultstatus`/`heatid`/`lane` survive. Verified each one actually catches its bug by temporarily reverting the fix and confirming the test fails.

**Update (2026-08-11):** `computeAgeDate(mv)` above is now `computeAgeDate(db)` — it no longer reads `MEETVALUES.AGEDATE` at all. It reads this database's own `bsglobal.AGEDATE` (the same key `flushMeet()` sets from `new Date()` at meet creation/reset — see `ageGroupRules.ts`'s `getSeasonYear()`), computing Dec 31 of *that* season year instead of always defaulting to today's calendar year. This matters for a meet held early in the year for a season that started the previous fall (e.g. a pool competition in Feb 2026 for the 2025-2026 season) — the old fallback would emit `2026-12-31`, the wrong season anchor; it now correctly emits `2025-12-31`. MEETVALUES.AGEDATE was never actually wired to anything on the import side regardless (nothing set it from an incoming LXF's `<AGEDATE>`), so this was silently always hitting the "not set" fallback in practice — see `config/CLAUDE.md`'s "Age Group Rules" section for the full age-determination fix this is part of.

**Follow-up audit (2026-07-31): does the birthdate bug affect team-app too, and are there other OLE/ISO gaps?** `exportLenexResults` is the actual production path for step 5 of the meet lifecycle (meet-app → team-app, see "Meet lifecycle" in `packages/team-app/CLAUDE.md`), not just a Splash-testing artifact, so this mattered beyond Splash compatibility:
- **team-app's import doesn't crash on a malformed birthdate — it silently drops it.** `lxf_to_team.py`'s `_parse_date` (and `historical_import.py`'s equivalent) wrap the parse in `try/except ValueError: return None`. A raw OLE-double string never raises; it just becomes `None` — new members get no birthdate (breaks next season's age category), existing members (matched by license) never get birthdate updated at all, and nothing surfaces an error anywhere. Our fix stops this going forward; any *already-archived* historical meets from before the fix may have null birthdates worth a spot-check if that matters.
- **Found and fixed a second, identical-class bug**: `exportMeetLenex`'s session date (`lenex.ts` ~line 1248) was `sess.startdate ? sess.startdate.slice(0, 10) : ageDate` — `swimsession.startdate` is the same dual-format (ISO or raw-OLE-double) column as `athlete.birthdate`, and `.slice(0,10)` silently produces garbage whenever the DB came from an `.smb` restore (which never converts it — confirmed in `smb.ts`). Fixed to `parseOleDate(sess.startdate) ?? ageDate`, matching the same pattern already used correctly for the same column in `db.ts:765`. Regression test added (`tests/lenex.test.ts`, "writes an ISO-formatted session date").
- **team-app's own LENEX export is correct** — `export.py`/`export_entries.py` use proper `.date()`/`.strftime()` calls, no reverse-direction bug.
- **`importLenex`'s read path and `smb.ts`'s GBIN encode/decode are correct** — the dual-format column is handled consistently by every other reader (`parseOleDate`/`parseBirthYear`/`parseBirthDate` in `db.ts` all branch on `/^\d{4}-/` first, OLE-double fallback second).
- **Not fixed, lower confidence, team-app-side, separate from this bug:** `exportLenexResults` never writes a `startdate`/session `date` at all (unlike `exportMeetLenex`, which does since the fix above) — `lxf_to_team.py` looks for exactly those attributes to set `meets.mindate`/`maxdate`/`results.eventdate`, so they end up NULL for results imports specifically. Whether this actually matters is unclear: `best_times_v2.py` computes an 18-month cutoff that (per the audit) may not actually be applied in the query that uses it — unconfirmed, would need a closer look at `best_times_v2.py` if this turns out to matter in practice.

**Real Splash crash deleting a Final after `.smb` restore — root cause found and fixed (2026-08-14), one earlier hypothesis ruled out (2026-08-13).** Compared a manually-created-in-Splash `.mdb` (works) against one produced by restoring one of our own `.smb` exports (crashes on Delete of a Final) using PowerShell's `System.Data.Odbc` against the `Microsoft Access Driver (*.mdb, *.accdb)`. `GetSchema("Columns")` showed a per-row sync GUID column present on 4 tables in Splash's Access/MDB schema (`SWIMSTYLEGUID`, `SWIMSESSIONGUID`, `SWIMEVENTGUID`, `AGEGROUPGUID`) that our `.smb` export leaves blank on every row (no equivalent column in our own schema). This was a plausible-looking correlation — blank/duplicate GUIDs in the crashing file, unique real GUIDs in the working one — **but it was only a correlation, not a confirmed cause**. A fix was written (generate a unique `randomUUID()` per row for those 4 columns on export) and tested live against real Splash: **it did not stop the crash.** Reverted in full (no `ColDef.synthetic`, no guid columns, no test).

**Actual root cause: `SWIMEVENT.PREVEVENTID` and `AGEGROUP.AGEMAX`/`AGEMIN` written as `NULL` instead of Splash's own `-1` "unset" sentinel.** Found by giving up on schema diffing and instead directly sampling a real, populated Splash-native `.mdb` (`Microsoft.ACE.OLEDB.12.0`, same technique as the `HEAT.RACESTATUS` fix above) for NULL-prevalence across every integer column of `SWIMEVENT`/`AGEGROUP`: `PREVEVENTID` was NULL in **0 of 84** real rows (always either `-1` or a real linked event id) and `AGEMAX`/`AGEMIN` were NULL in **0 of 90** real rows — while our own `.smb` export wrote raw `NULL` for both, since our own schema legitimately uses NULL as "unset" internally (`preveventid INTEGER` with no default; `db.ts`'s `normalizedMaxAge` explicitly converts Splash's `-1`/`≥99` "Open" sentinel to `null` on read, but nothing ever converted back on export — the exact same class of bug the LXF exporter (`lenex.ts`) already had fixed for `preveventid`, just never ported to the `.smb` path). Confirmed as the actual crash mechanism, not just a correlation: the live-crashing `meet.mdb` was captured *mid-delete* — the prelim's `ROUND` had already been reverted PRE→TIM (the first step of Splash's delete-final routine) but the Final's `SWIMEVENT` row was still present, meaning the crash happens in whatever Splash does *next*, most likely walking every other `SWIMEVENT` row's `PREVEVENTID` and hitting a NULL Access field where its own code expects a non-nullable Integer (a NULL→Integer variant conversion is a classic unhandled-exception source in Access-backed Delphi/VB apps). Fixed in `smb.ts`: export now remaps NULL→`-1` for both fields (mirroring the existing `round` remap), and restore now remaps `-1`→NULL back for `preveventid` (some of our own code, e.g. `if (finalEvent?.preveventid)` in `db.ts`, checks this truthily and would misread a literal `-1` as "has a parent" — `agemax`/`agemin` need no such reverse step since `db.ts` already treats `-1`/`≥99` as equivalent to NULL at every read site). Regression tests: `tests/smb.test.ts`, "writes swimevent.preveventid=-1…" and "writes agegroup.agemax/agemin=-1…". **Not yet live-reconfirmed against real Splash** (the fix follows directly from the same live-sampling technique that resolved `HEAT.RACESTATUS`, but hasn't had its own fresh Delete-Final retest yet — if it turns out insufficient, re-run the same `Microsoft.ACE.OLEDB.12.0` NULL-prevalence sweep across the *other* SMB_TABLES entries, since the fix pattern (NULL where Splash needs a sentinel) may recur elsewhere).

Also worth flagging for next time: this whole bug is SQLite (meet-app) → `.smb` (Access/MDB) → real Splash — Postgres is not part of this path at all; the schema-diff fixture (`splash-schema.csv`) happens to be Postgres-sourced but that's incidental to this investigation, not relevant to the crash itself.

**Second, deeper crash — root cause found and fixed for real (2026-08-14), two hypotheses tried and ruled out first.** With the NULL-sentinel fix in place, live-testing Delete-a-Final against real Splash produced a *different*, more informative crash: a clean Delphi exception dialog ("Invalid class typecast") with a full call stack, not a raw access violation. Reading the stack (innermost first): `eventDM.HandleNotification` (line 766, where the typecast fails) ← `modulEvent.DoHandleNotification` ← a generic message-dispatch chain (`BSMessages`, `BSForms`) ← `TBSItem.NotifyA`/`DoSave` ← `BItemsImpEx.UpdateColumn`/`EndEdit` ← `eventBOImp.TEvent.SetNextEvent` ← `TEvent.DoBeforeDelete` ← `BItemsAbstract.Delete` ← `modulEvent.ActDeleteExecute`. The generic `BItemsAbstract`/`BItemsImp`/`BSItemsImp` classes in this stack back Splash's whole outline tree — a "wrong object type retrieved from a generic/cached collection" fits this symptom.

First re-tried the GUID hypothesis (see above) on the theory that this deeper code path had never actually been exercised with real GUIDs present. **Ruled out conclusively this time** — re-added unique `randomUUID()` GUIDs (`SWIMSTYLEGUID`/`SWIMSESSIONGUID`/`SWIMEVENTGUID`/`AGEGROUPGUID`, `ColDef.synthetic`) and live-retested: **identical crash, same address, same call stack.** No effect whatsoever. (Kept in `smb.ts` regardless — it's still a real correctness improvement matching Splash's own always-real-GUID convention, just not the cause of this bug.)

**Actual root cause, found via a user-directed differential test:** a much cleaner experiment than continued stack-trace archaeology — export a plain Timed Final (no split at all), import into Splash, then use *Splash's own* "convert to Final" to create the Prelim/Final split natively, instead of importing one we'd already split. **This crashed identically**, proving the bug had nothing to do with how we represent an already-split PRE/FIN pair — it happens the moment Splash's own native code touches an event that originated from our import, before any prelim/final linking logic runs at all. This reframed the search entirely: compared our exported id scheme (each table numbered independently from ~1: `swimeventid`, `agegroupid`, `swimsessionid` can all simultaneously equal 1) against real Splash `.mdb` files, where `SWIMEVENT`/`AGEGROUP`/`SWIMSESSION`/`CLUB`/`ATHLETE`/`HEAT` id ranges heavily overlap and interleave (e.g. `SWIMEVENT` 1060-3374 and `AGEGROUP` 1061-3375 in one real file — nearly identical ranges) — the signature of a single id counter shared across every table, not independent per-table counters. **Confirmed directly**: real Splash `.mdb` files contain a table literally named `BSUIDTABLE` with a row `{NAME: 'BS_GLOBAL_UID', LASTUID: <n>}` — Splash's global id generator, sampled via `Microsoft.ACE.OLEDB.12.0`.

Validated with a standalone, app-code-untouched diagnostic tool (`scripts/remap_smb_ids.ts`, at the user's explicit request — "don't touch the app code for the test") that remaps every table's ids in an already-exported `.smb` into disjoint per-table ranges, rewriting every FK reference to match. **Both crashes — converting a Timed Final to Prelim/Final, and deleting an already-split Final — stopped** after restoring the remapped file. Conclusive.

**Real fix — and it turned out to already half-exist in the codebase.** `nextId()` (`db.ts`) already special-cased PG mode to draw every new row's id from a single sequence, `nextval('gen_bs_global_uid')` — literally named after Splash's own `BS_GLOBAL_UID`, piggybacking on the sequence real Splash itself creates the moment it connects to a shared Postgres database. SQLite mode (what `.smb` export/import actually uses) had never gotten the same treatment — it computed `MAX(pkCol)+1` scoped to just the one target table. Fixed by extending the SQLite branch to compute `MAX` across *every* id-bearing table (`swimstyle`, `swimsession`, `club`, `athlete`, `swimevent`, `agegroup`, `heat`, `swimresult`, `dsqitem`, `relay`) and taking the overall max + 1 — safe with no locking since SQLite mode is inherently single-writer (one Electron process). Also fixed 3 heat-creation call sites that bypassed `nextId()` entirely with their own inline `MAX(heatid)+1` (would have kept colliding otherwise). Along the way, fixed a latent gap this surfaced in PG-mode testing: `nextId()`'s PG branch assumed `gen_bs_global_uid` always already exists (true in the documented normal workflow — Splash connects to a shared database first and creates it — but not true for a bare Postgres container nothing has initialized yet, e.g. this project's own PG test containers); `runSchemaInit()` (`schema.ts`) now runs `CREATE SEQUENCE IF NOT EXISTS gen_bs_global_uid` on PG connect, harmless either way — reuses Splash's sequence if it already connected first, creates it fresh otherwise.

The `smb.ts` export-time id-remapping originally implemented to fix this (mirroring the diagnostic script) was **reverted** — it caused id drift on export/restore round-trips through meet-app itself (existing tests caught this immediately) and was fixing the symptom in the wrong layer. Fixing `nextId()` at the source means every table's ids are correct from the moment they're created, with no translation needed anywhere, and no other export path (LXF) needs the same fix ported separately.

Regression test: `tests/schema.test.ts`, "nextId() never returns an id already used by a different table" (runs against both SQLite and PG).

**Follow-up gap found the same day: `lenex.ts` had its own stale, unfixed copy of `nextId()`.** `importLenex` — the LXF import path, used far more than `.smb` restore (every team-app entries import goes through it) — had a *local* `nextId(table, col)` helper (`lenex.ts:194`, literally commented "same logic as db.ts nextId but uses the passed db") that still did the old per-table `MAX(col)+1`, used for auto-assigning `club`/`athlete`/`swimresult`/`relay` ids whenever the incoming LXF didn't supply one. Fixing `db.ts`'s real `nextId()` never touched this copy, so the exact same collision class could still happen on the far more common import path. `swimevent`/`agegroup`/`heat` were never at risk here — the importer requires a real id from the file for those and skips the element entirely if missing (`lenex.ts:445,507,531`), no fallback generation involved. Fixed by deleting the local copy and importing the real `nextId` from `db.ts` instead (`lenex.ts` already imported `parseOleDate` from the same module, so no new circular-dependency concern). Regression test: `tests/lenex.test.ts`, "auto-assigns a club id that does not collide with an existing swimevent/agegroup id". All 395 tests pass.

**Follow-up, same investigation: the cross-system club/athlete id collision was fixed too — at the root, in `importLenex`, not via a team-app migration.** team-app's `clubs.clubsid`/`members.membersid` (plain SQLAlchemy `Column(Integer, primary_key=True)`, identical on its live SQLite backend or Postgres, never flushed, grows forever) used to get preserved verbatim as meet-app's own `club.clubid`/`athlete.athleteid` on every LXF import (`parseInt(aa.athleteid...)`, falling back to `nextId()` only when absent). Directly sampling three real, populated Splash `.mdb` files settled how real Splash itself handles this: `CLUB`/`ATHLETE` ids there are never anything reused from an external source — they're simply the next values off Splash's own single global counter, created in whatever order the rows were added (confirmed: in two of the three files, `CLUB`/`ATHLETE` ids start literally one after the other, right where `SWIMEVENT`/`AGEGROUP` left off). Real Splash never trusts an incoming id as a literal database key at all.

Adopted the same principle. `importLenex` (`lenex.ts`) no longer treats the incoming `clubid`/`athleteid` LXF attribute as a primary key — it's reconciled against a local row via the already-existing (previously unused) `externalid` column instead: look up by `externalid` first, reuse that row's real local id if found, mint a fresh one via `nextId()` (now collision-safe) only the first time a given external id is seen. This fully decouples meet-app's own id space from team-app's — the two counters never need to stay apart by convention or a reseeded starting value, because meet-app's ids are never chosen based on what an external system's counter happens to be. `RELAYPOSITION` (which references an athlete by the same external id later in the same file) resolves through the same `externalid` lookup rather than using the raw attribute value directly.

Deliberately **not** matched by license (team-app's own results-import matching key, `lxf_to_team.py:280-286`) — too many real athletes have no license number. `externalid` is structural, database-assigned identity on team-app's side (impossible to be missing, unlike a free-text field), which is exactly why it works as the reconciliation key here. Team-app's own results-import reconciles the *other* direction the same way it always has — athlete by license, club by code (`lxf_to_team.py:250`) — genuinely unaffected by this change, since it was never comparing against meet-app's `athleteid`/`clubid` numerically to begin with.

Handles the "parallel meets" edge case cleanly too: a walk-up athlete registered directly in meet-app mid-meet (no team-app record, no `externalid`) just mints a fresh id from `nextId()` like any local row; if a *different* new athlete is simultaneously added in team-app, it's fully irrelevant to meet-app until/unless it's later imported, at which point `nextId()` computes against meet-app's live, current state — including the walk-up athlete already committed — so there's no window where the two systems' counters need to agree. The two id spaces are decoupled by construction, not just unlikely to collide.

Regression tests added: `tests/lenex.test.ts` — "never adopts an incoming external clubid/athleteid as the local primary key, even when it numerically collides with an existing local id" and "reuses the same local athleteid/clubid across repeated imports of the same external id" (proves re-registration/re-import stays idempotent, matching the pre-existing `ON CONFLICT` upsert behavior). All 397 tests pass.

**Related, unresolved (2026-08-13): a `gender="X"` individual "Mixte" event round-trips through meet-app's own LXF export/Splash-import as "All", not "Mixte".** Restoring the equivalent event via `.smb` shows "Mixte" correctly (raw column copy: our internal `gender=3` lands directly in Splash's `SWIMEVENT.Gender`, which is confirmed to mean "Mixte" there). But going through `exportMeetLenex`/`exportLenexResults`'s `decodeGender()` (which writes `X` for internal gender=3, matching team-app's `_GENDER_MAP` and the LENEX standard's mixed-relay code) and then real Splash's own LXF importer, the event lands with `Gender=0` ("All") instead of `3` ("Mixte") — confirmed via the same Access-driver diff technique above. Standard LENEX's `X` gender may only be valid for `relaycount>1` (mixed relay); Splash's own individual-event "Mixte" concept (this app's own lifesaving-specific "open to both genders" category, see `ReportPage.tsx`'s `gender==='X' → 'Mixte'` for adult age groups) might not have a standard-LENEX representation at all, or might use a different attribute value real Splash's own exporter would reveal. Not yet root-caused — would need a genuine Splash-exported LXF of an individual Mixte event (real Splash's own output, not ours) to know the correct string, same as how `preveventid` and the round encoding were resolved.

**Splash schema contract (Layer 3)** — `splash-schema-contract.test.ts` diffs `schema.ts`'s `SCHEMA_DDL` against `tests/fixtures/splash-schema.csv`, a real `information_schema.columns` dump captured 2026-07-31 from an actual Splash Meet Manager instance connected via ODBC DSN to a fresh Postgres database (not our own reverse-engineering of the format — the genuine article). It fails on any column Splash has that we don't (silent data loss / crash reading a real Splash-created DB), and on any column we have that Splash doesn't unless it's on the `KNOWN_EXTRA_COLUMNS` allowlist in the test file (currently just `dsqitem.name_en` — our own bilingual-DSQ addition, intentionally backfilled onto pre-existing Splash tables via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `connectionManager.ts`). This is what caught `agegroup.afinal8lanes` (a real Splash column we were missing, now added) in the same session the fixture was captured.

Regenerating the fixture (only needed if Splash's own schema changes): connect real Splash to a fresh empty Postgres via its ODBC DSN — just opening the connection makes Splash create its full ~34-table schema — then dump with the `psql` command in the test file's header comment.

**Operational finding, not a bug**: restoring an `.smb` backup directly into a Splash-Postgres connection that has never been opened (i.e. an empty database with zero tables) crashes Splash with a generic "database contains wrong data" error. The fix is procedural, not code: let Splash connect to the target Postgres database first (which makes it auto-create its schema), *then* restore the `.smb` into it. Confirmed 2026-07-31 — same `fixture_pool.smb`, same DSN, crashed against a schema-less database and restored cleanly once Splash had initialized its own tables first.

### Key utility: `msToDisplay(ms)`
Converts integer milliseconds to display format (`M:SS.cc` or `SS.cc`). Returns `undefined` for `null`, `0`, negative values, and max-int sentinel (2147483647) — all treated as "no time" (NT).

## Critical rule: IPC listener cleanup

Preload `on*` methods return a cleanup function. Always collect them in `useEffect` and call them on unmount:

```tsx
useEffect(() => {
  const cleanups = [
    m.onImportLenex(() => handleImportLenex()),
    m.onSaveSMB(() => handleSaveSMB()),
  ]
  return () => { cleanups.forEach(fn => fn()) }
}, [])
```

Without cleanup, React StrictMode (or HMR) causes duplicate listeners → duplicate dialogs.

## Source layout

```
src/main/
  index.ts              — Electron main process, IPC handlers, native menu
  db.ts                 — SQLite (better-sqlite3), all queries, heat generation
  combinedEvents.ts     — COMBINEDEVENTS XML generator (auto-regen on event/agegroup changes)
  lenex.ts              — LENEX .lxf import + export (importLenex, exportMeetLenex, exportResultsLenex)
  quantum.ts            — Swiss Timing Quantum protocol bridge
  smb.ts                — SMB save/restore (Splash Meet Backup format)
  timingBarcode.ts      — Barcode encode/decode (E{n}-H{n}-L{n} format)
  timingSheets.ts       — Timing sheet PDF generator (HTML + Code128 SVG)
  timingScanDb.ts       — Local SQLite for scanned images + processing state
  timingImageProcess.ts — Image crop/preprocessing for OCR
  ocrEngine.ts          — OCR engine interface + time parsing utilities
  ocrGemini.ts          — Gemini 2.5 Flash Lite vision OCR (primary)
  ocrOllama.ts          — Ollama local vision model (fallback)
  geminiBackground.ts   — Background Gemini processing loop (main process)
src/preload/index.ts    — contextBridge API
src/renderer/src/
  App.tsx               — App shell (title bar, tabs, modals)
  meetApiElectron.ts    — MeetAPI adapter (IPC → SQLite)
  registrationApiElectron.ts — RegistrationAPI adapter (IPC → SQLite)
  pages/EventsPage.tsx  — Thin wrapper: ApiProvider + shared EventsPage
  pages/HeatsPage.tsx   — Heat runner + Quantum toolbar + Print timing sheets
  pages/AthletesPage.tsx— Athlete list + editor
  pages/TimingScanPage.tsx — Camera barcode scanner (batch mode)
  pages/TimingProcessPage.tsx — OCR processing queue + manual time entry
```

## IPC channels

| Channel | Purpose |
|---|---|
| `db:sessions` | Get sessions + events + age groups |
| `db:update-event` | Update event fields |
| `db:update-age-group` | Update age group fields |
| `db:reorder-events` | Reorder events (sortcode) |
| `db:generate-heats` | Generate heats (seeding) for event/session/all |
| `db:get-meet-config` | Read MEETVALUES from bsglobal |
| `db:set-meet-config` | Write MEETVALUES to bsglobal |
| `db:get-swim-styles` | List all swimstyles |
| `file:save-smb` | Save meet as .smb |
| `file:restore-smb` | Restore meet from .smb |
| `file:import-lenex` | Import .lxf (meet structure + entries + best times) |
| `file:export-meet-lenex` | Export meet structure as .lxf (sessions/events/agegroups, no athletes) — for team-app invitation setup |
| `file:export-lenex-results` | Export results as .lxf (full athletes + times) — for team-app historical import |

### Prelim/Final event numbering

`handleConvertToFinal` (shared-ui `EventsPage.tsx`) splits a Timed Final into a
Prelim + Final pair. The Final reuses the prelim's `eventnumber` (Splash
convention — confirmed against a real Splash `.mdb`: prelim and final share
`EventNumber` but have distinct `SwimEventID`s, differentiated by `round`).
Do NOT mint a new event number for the final — that's what causes "Event 5"'s
final to show up as an unrelated "Event 83". Because `eventnumber` can now be
shared, timing-scan barcode matching keys on `swimeventid` instead — see
"Barcode format" below.

The Final is created in the *same* session as the prelim, placed directly
after it (no separate "Finales" session is created). The link is `preveventid`
on the Final row, pointing back at the prelim — exposed to the frontend as
`CompetitionEvent.prevEventId`. Deleting a Final reverses the split: the
paired prelim's `round` is set back to `5` (TIM/Finale directe), as if it had
never been converted.

### LXF round-trip details

**Import (`importLenex`):**
- Remaps `swimstyleid` via `uniqueid` attribute (Splash uses internal auto-increment IDs in MDB but canonical 5xx UIDs in Lenex)
- Events with `round=11` (MDB encoding for Break/Pause) are marked `internalevent='T'`
- Extracts MEETVALUES metadata from meet attributes (name, course, agedate, deadline, etc.)
- Auto-detects `MEET_TYPE` from swim style IDs: if any `swimstyleid >= 600` → `BEACH`, else `POOL` (only when not already set)

**Export (`exportMeetLenex`, `exportLenexResults`):**
- Includes pause event names in the output
- Uses correct swimstyleids (canonical UIDs)
- Writes meet-level attributes (course, agedate, organizer, etc.) from MEETVALUES
- Writes `preveventid` on every `<EVENT>` (own row's value, or `-1` if unset) — real Splash
  crashes with an access violation opening a Final whose `preveventid` link was never
  established (see "Prelim/Final event numbering" above). This was missed when the
  attribute was first added (only `importLenex`'s read side and team-app's export.py got it —
  see a1e9d3e); a Final created via "Convert to Final" in meet-app and re-exported straight
  to a real Splash `.mdb` reproduced the crash until both meet-app export functions were
  fixed to write it too.
| `timing:save-scan` | Store scanned image + barcode metadata |
| `timing:get-scans-for-processing` | List scans by status filter |
| `timing:run-ocr` | Run OCR engine on a scan (Gemini/Ollama/etc) |
| `timing:validate-scan` | Accept times → write to swimresult |
| `timing:generate-sheets` | Generate timing sheet HTML for a session |
| `timing:set-gemini-background` | Enable/disable background Gemini processing |
| `timing:get-gemini-key` | Get masked API keys |
| `timing:set-gemini-key` | Set free/paid API keys |
| `timing:clear-all-scans` | Delete all scan records |
| `db:get-clubs` | Get real database club IDs |
| `db:get-relay-page-data` | Relay events, teams, eligible athletes |
| `db:create-relay-team` | Create relay team |
| `db:delete-relay-team` | Delete relay team |
| `db:set-relay-team-member` | Assign/remove member at position |
| `db:set-relay-team-name` | Set custom team name |
| `db:get-meet-type` | Get meet type (POOL/BEACH) from BSGLOBAL |
| `db:get-matching-age` | Age to use for age-group matching (season-reference-date rules, see `config/CLAUDE.md`) |
| `menu:open-guide` | Open in-app workflow guide (pool/beach) |
| `db:register` | Register athlete for event (create swimresult) |
| `db:unregister` | Unregister athlete from event (delete unseeded swimresult) |
| `db:get-relay-members` | Get relay position members by relay ID |
| `db:get-relay-members-by-event` | Get relay members for event+club |
| `db:set-relay-member` | Set/clear a relay position member |

## Relay Entry

Relay team management for events with `relaycount > 1`.

### UI
- `RelayEntryPageWrapper` in renderer wraps the shared `RelayEntryPage` component
- Two entry tabs: "Inscriptions individuelles" (individual) / "Inscriptions relais" (relay)

### Data flow
```
RelayEntryPage (shared-ui)
  → registrationApiElectron.ts
    → IPC: db:get-relay-page-data, db:create-relay-team, db:delete-relay-team,
           db:set-relay-team-member, db:set-relay-team-name
      → SQLite: relay, relayposition tables
```

### Schema
- `relay` table — team records (event, club, letter)
- `relayposition` table — member assignments (position 1-4)
- `relaysplit` table — relay split times
- All three included in SMB save/restore (`SMB_TABLES`)

### LXF import
`importLenex` processes `RELAY` and `RELAYPOSITION` elements, creating relay teams from imported .lxf files.

### Team composition
Age group: a team's category = the event it was created under. Members must be that exact category or the single adjacent-younger one (swim-up); ≥2 members must match exactly (1-3/0-4 invalid). No per-team age label shown in UI. See `docs/RELAY_TEAM_RULES.md` for full rules (any split valid beyond the anchor — 4-0/3-1/2-2 — 2M+2F for mixed).

## Heat Generation

Full rules: `docs/HEAT_GENERATION_RULES.md`

### Implementation
- **Backend**: `src/main/db.ts` → `generateHeats(eventId?, sessionId?, db?)`
- **IPC**: `db:generate-heats` channel
- **Preload**: `window.api.db.generateHeats(eventId?, sessionId?)`
- **UI**: "Générer séries" button in EventsPage toolbar
- **Tests**: `tests/heat-generation.test.ts` (28 tests)

### Seeding methods (`agegroup.finalseedtype` or `MEETVALUES.SEEDMETHOD`)
- `0` = Circle seeding (FINA prelims — round-robin across heats)
- `1` = Pyramid seeding (fastest in last heat — timed finals)
- `2` = Straight seeding (fastest in heat 1)

### Meet-level config keys (MEETVALUES in bsglobal)
| Key | Type | Description |
|-----|------|-------------|
| `SEEDMETHOD` | I | Default seeding method (0/1/2) |
| `FASTHEATCOUNT` | I | FINA "last N heats" circle-seed rule |
| `MINPERHEAT` | I | Minimum swimmers per heat (default 3) |
| `SEEDBONUSLAST` | B | Seed bonus entries after regular |
| `SEEDEXHLAST` | B | Seed exhibition entries after regular |
| `SEEDLATELAST` | B | Seed late entries after regular |
| `COMBINEAGEGROUPS` | B | Pool all age groups into one seeding |
| `QUALIFROM` | S | Qualification period start (YYYY-MM-DD) |
| `QUALITO` | S | Qualification period end (YYYY-MM-DD) |
| `QUALICOURSE` | I | 0=all courses, 1=same course only |

### Per-age-group overrides (agegroup table)
- `finalseedtype` — overrides SEEDMETHOD
- `fastheatcount` — overrides FASTHEATCOUNT
- `heatcount` — minimum number of heats

### Lane assignment
Default: center-out (e.g., 5,6,4,7,3,8,2,1 for 8 lanes starting at 1).
Custom: `swimsession.lanesbyplace` (comma-separated lane numbers).

### Entry priority (when seed*last flags are set)
1. Regular timed entries
2. Late entries (`swimresult.lateentry='T'`)
3. Bonus entries (`swimresult.bonusentry='T'`)
4. Exhibition entries (`swimresult.infocode` contains 'EXH')
5. No-time entries (NT)

### Beach mode
- Max participants per heat = `swimevent.maxentries` → `swimstyle.distance` → 16 (fallback)
- Athletes shuffled randomly and distributed evenly across heats
- No lane assignment (sequential numbers as placeholders)
- Auto-assigns beach numbers to athletes missing one before generating heats
- `swimevent.maxentries = 0` → no heat distribution: events like beach flags/sprint that only run a final (results entered manually on the beach) get a single empty heat shell instead of entries being split across heats

## Beach Numbers

Athletes in beach meets get a unique jersey/bib identifier stored in `athlete.nameprefix`.

### Format: `Letter + 3 chars` (e.g., `C201`; `CA01` for Masters)
- **Letter (A-Z):** Club letter (from club code chars, fallback first unused A-Z)
- **Category char:** **Fixed global code** per (age bracket, sex) — same code for every club, not
  assigned dynamically. Brackets follow `AGE_CODE_ORDER` (`shared-ui/src/logic/ageGroupCode.ts`):
  10-, 11-12, 13-14, 15-18, Open, Masters, each with an F slot then an M slot:
  `10-F=0 10-M=1 11-12F=2 11-12M=3 13-14F=4 13-14M=5 15-18F=6 15-18M=7 OpenF=8 OpenM=9 MastersF=A MastersM=B`.
  Bracket comes from the athlete's age group (`agemin`/`agemax`/`name` via `ageGroupCodeFor`); sex
  comes from the athlete's own `athlete.gender` (not the age group's — a relay's age group can be
  mixed/X, but each teammate keeps their own individual-sex category).
- **Last 2 chars (01-99):** Alphabetical sequence within category

### Source: `src/main/beachNumber.ts`
| Function | Purpose |
|----------|---------|
| `generateBeachNumbers(db)` | Full idempotent regen — clears all, recomputes from scratch |
| `assignLateBeachNumber(db, athleteId)` | Late arrival — assigns next available in club/category |

### Triggers
- **LXF import** (`importLenex`): calls `generateBeachNumbers` when `MEET_TYPE='BEACH'`
- **Late entry** (`registerForEvent`): calls `assignLateBeachNumber` for the new athlete
- **Heat generation** (`generateHeats`): calls `assignLateBeachNumber` for any athletes with entries but no beach number

### Constraints & properties
- Max 26 clubs, 12 fixed categories (6 age brackets × 2 sexes), 99 athletes per category per club
- Deterministic, unique, idempotent, stable (late arrivals don't shift existing)
- Club letter assignment: tries each char of `club.code`, fallback first available A-Z
- An athlete with no resolvable sex (`athlete.gender` not 1 or 2) gets no beach number and is
  reported in `BeachNumberResult.errors` — every real athlete has a gender from LXF import, so
  this should only happen with malformed data

### Display
- HeatsPage: shown next to athlete name
- AthletesPage: read-only column
- "Identifiants plage" PDF report

### Tests: `tests/beach-number.test.ts`
- Property-based tests (fast-check): uniqueness, determinism, format validity
- Unit tests: sequence numbering, late arrival, capacity errors

## Timing Sheet OCR Scanning

### Workflow
1. **Print** timing sheets from HeatsPage ("🖨 Fiches chrono") — portrait, 3 strips/page
2. **Scan** sheets in batch (Scanner tab) — camera reads Code128 barcode, captures image
3. **Process** (Traitement tab) — Gemini reads times in background, operator validates/corrects
4. **Accept** → writes `backuptime1`, `backuptime2`, averaged `swimtime` to `swimresult`

### Sheet layout
- Full-width Code128 barcode SVG (format: `E{eventNumber}-H{heatNumber}-L{lane}`)
- Event name, heat, lane, athlete name + club code
- Two rows of 5 digit boxes (M:SS.HH) labeled "Chrono 1" / "Chrono 2"
- Corner registration marks for future perspective correction

### Barcode format
`E{eventNumber}-U{swimEventId}-H{heatNumber}-L{lane}` — e.g. `E5-U1496-H2-L3` = Event 5, Heat 2, Lane 3.
`swimEventId` (the internal `swimevent` primary key) is what validate-scan actually
matches on — it's always unique, unlike `eventNumber`, which a prelim and its final
can share (see "Prelim/Final event numbering" below).

### Scan storage
Separate SQLite: `{userData}/timing_scans.sqlite`
- `timing_scan` table: image blob, barcode, event/heat/lane, status, recognized/validated times
- Statuses: `unprocessed` → `recognized` (Gemini filled) → `validated` (operator confirmed)
- Cleared via "Vider les scans" button or `npm run clean`

### Gemini OCR
- Model: `gemini-2.5-flash-lite` (1.4s/scan, no thinking overhead)
- Fallback: `gemini-2.5-flash` if lite unavailable
- Background processing in main process (runs on any page)
- Dual API keys in BSGLOBAL: `GEMINI_KEY_FREE` + `GEMINI_KEY_PAID`
- Auto-fallback: free → paid on 429 → back to free after 60s

### Key management flow
1. Admin sets keys in team-app (Admin page → "Clés API Gemini")
2. Keys stored in PostgreSQL `bsglobal` table
3. Keys travel to meet-app via `.lxf` export: embedded as `.keys` JSON dotfile
   inside the zip archive (transparent). Team-app's own `.smb` import/export
   was removed (superseded by LXF) — this is now the only path.
4. Gemini OCR works automatically in meet-app (transparent to end users)

### Time entry
- Manual: type `14500` → parsed as `1:45.00` (same parser as HeatsPage)
- Gemini: auto-fills fields, operator confirms with Enter
- Both chronos required to accept
- Accept immediately writes to meet DB (`swimresult.backuptime1/2 + swimtime`)

## In-App Documentation

- Location: `src/renderer/public/docs/`
- Files: `meet-pool_{lang}.md`, `meet-beach_{lang}.md`
- Accessed via: Aide menu → "Guide — Compétition piscine/plage" (full-screen overlay)
- Screenshots: `public/docs/assets/meet-*.png`
- Renderer: custom `GuidePage.tsx` with built-in markdown-to-HTML converter (no external dependency)

## Combined Events

Auto-generated XML in `bsglobal` defining cumulative point standings per age/gender category.

- **Implementation**: `src/main/combinedEvents.ts` — called from `db.ts` after event/agegroup CRUD
- **Config**: `../../config/combined-events-config.json` (see `config/CLAUDE.md` at repo root)

### Prelim/Final resolution

`queryEventsWithAgeGroups` (and the COMBINEDEVENTS XML it feeds) intentionally references
the **prelim's** event/agegroup ids — that's the stable "event slot" Splash's own export
uses, and what the report UI's event tree lets the user select. But `getCombinedResults`
and `getPointStandings` (`db.ts`) resolve each matched pair through `resolveToFinal()`
before querying `swimresult`, so the actual points come from the **final's** placements
when a final exists. Verified athlete-by-athlete against a real Splash `.mdb` for an
actual competition (CanadienMai2026_S40): Splash's own combined-events totals reflect
final results, not prelim heat times — scoring off the prelim would use stale/slower
times once finals have been swum.

### Finale A/B ordering (§4.4.2.1)

At CQS, when 16 finalists split into Finale A (ranks 1-8) and Finale B (ranks 9-16), a
B-finalist's time is never compared against an A-finalist's for medals/points — A always
outranks B, even if a B swimmer posted the faster raw time (Règlements Québec §4.4.2.1;
Finale B swims first, Finale A last, per `seedFinals`' `finalOrder` handling). `autoQualify`
already writes this grouping to `swimresult.qualcode` / `relay.qualcode` (`'A'`, `'B'`, `'C'`,
… or `'R'` for reserve) when splitting finalists across heats — `getCombinedResults`,
`getPointStandings`, and `getResultsList` all order by `qualcode` before `swimtime`, reusing
that existing column rather than adding a parallel concept. Meets that never call
`autoQualify`/`seedFinals` (the common case — a single final, no A/B split) leave `qualcode`
NULL on every row, so this is a no-op tiebreaker there: pure time ordering, unchanged. Tests:
`tests/combined-events.test.ts` ("Finale A/B qualification ordering") and
`tests/results-list.test.ts` — the latter matters most since `getResultsList` is what the
printed "Liste des résultats" report (medals) reads its rank order from.

## Fixture data

- Generator: `scripts/generate-fixture-smb.ts`
- Output: `fixture_pool.smb`, `fixture_beach.smb` (10 clubs, 150 athletes, events, registrations)
- Usage: File → Restaurer un meet (.smb)

## Simulate Results (test script)

Injects random swim times into all `swimresult` rows that have no time yet. Useful for end-to-end testing of the results export flow without running a real competition.

- **Script**: `scripts/simulate_results.bat` (calls `scripts/simulate_results.py`)
- **Default DB**: auto-detects `%APPDATA%\SauvetageMeet-Dev\meet.db` (unpackaged, i.e. `npm run dev` — matches `app.setName()` in `src/main/index.ts`) vs. `%APPDATA%\SauvetageMeet\meet.db` (packaged build). **If both exist, the script refuses to guess and asks for an explicit path** — silently running against the wrong one used to look identical to a real "0 results, nothing to simulate" run (bit us for real once: `npm run dev` writes to `-Dev`, but the old hardcoded default pointed at the non-`-Dev` path).
- **Logic**: `swimtime = entrytime ± 5%` (random if NT: 30–180s), 5% DSQ
- **Side effect**: marks affected heats as official (`racestatus=5`)
- **Idempotent**: only fills rows where `swimtime` is NULL or 0 — safe to re-run after generating finals

```bash
# Default path (auto-detected)
scripts\simulate_results.bat

# Custom path (required if both packaged and dev databases exist)
scripts\simulate_results.bat "C:\path\to\meet.db"
```
