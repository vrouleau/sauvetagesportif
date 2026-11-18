# Plan — dead code removal & duplication merge

Branch: `refactor/dead-code-and-dedup` (from `main` @ 2e79fc7, v0.5.25).
Source: audit done 2026-11-18 (after PR #107 unified the results importers).
Delete this file in the last commit before opening the PR.

## Ground rules

- One commit per numbered step (or per tightly linked pair), so any step can be reverted alone.
- **Before deleting anything, re-grep for callers** (`git grep -n <name>`). The audit was static;
  dynamic URLs (e.g. Admin.jsx builds `/admin/meets/${id}/${action}`) can hide callers.
- Do not change behavior in the "merge" steps — pure refactors. If two copies disagree,
  stop and note it in the PR description (pick the stricter/most recent behavior only if obvious).
- Update `CLAUDE.md` files (root, `packages/team-app/CLAUDE.md`, `packages/meet-app/CLAUDE.md`)
  in the same commit that removes/moves something they mention.
- Tests to run after each step (whatever the environment allows):
  - shared-ui + meet-app: `cd packages/meet-app && npm install && npm rebuild better-sqlite3 && npm test`
    (PG-backed suites self-skip with no Postgres — fine).
  - team-app unit: `cd packages/team-app && python3 -m pytest tests/unit/ -v`
  - team-app integration needs Docker (`python3 -m pytest tests/ -v`, see team-app CLAUDE.md;
    always `-p team-app-test`). If Docker isn't available, say so in the PR — don't skip silently.
  - team-app frontend build: `cd packages/team-app/frontend && npm install && npm run build`
    (catches broken imports after deleting shared-ui pages).
- Never run the Electron app from the terminal (ELECTRON_RUN_AS_NODE crash).
- Open a PR to `main` at the end; do not merge.

## Phase A — dead code

### A1. Unreachable entry/registration pages (shared-ui + both apps)
Evidence: meet-app tab list (`App.tsx:489`) omits `'inscription'`, nothing calls `setPage('inscription')`;
team-app `main.jsx` defines `AthletesListPage`/`InscriptionPage` wrappers but no `<Route>` uses them;
`AthletesListPage` is the only navigator to `/athletes/:id/register` → `RegisterPage` unreachable.
Remove:
- `packages/shared-ui/src/pages/InscriptionPage.tsx`, `InscriptionPage.property.test.ts`
- `packages/shared-ui/src/pages/AthletesListPage.tsx`, `RegistrationPage.tsx`
- barrel exports in `packages/shared-ui/src/index.ts` (lines ~30-32)
- `packages/meet-app/src/renderer/src/pages/InscriptionPageWrapper.tsx`, its import + render line
  and `'inscription'` from the `Page` type / labels in `App.tsx`
- team-app `main.jsx`: `AthletesListPage`, `InscriptionPage`, `RegisterPage` wrappers, the
  `/athletes/:id/register` route, and now-unused imports
- i18n keys only used by those pages (`nav.inscription`, etc. — grep each key before removing)
Keep: `CascadeTree`, `AthleteDetailPanel`, `RegistrationPanel`, `AddAthleteDialog`, `filterAthletes`
(used by `IndividualEntryPage`). Check whether `TimeInput`, `filterCategoriesAroundSuggestion`,
`computeAvailableCategories` lose their last caller.

### A2. Legacy relay "lock" / virtual-team chain (team-app + RegistrationPanel)
Evidence: `IndividualEntryPage.tsx:130` strips relay styles before `RegistrationPanel`; only the
dead `InscriptionPage` passed relay styles, so nothing can create a relay `swimresult` lock.
Registrations are wiped at every meet close, so old rows don't persist.
Remove:
- relay-lock branch in `POST /registrations` (`api.py` ~2533, "Relay lock")
- virtual teams (negative ids) in `get_relay_teams` (`api.py` ~4526-4643, "Requirement 10")
- materialization blocks for `team_id < 0` in delete / set-member / set-name handlers
  (`api.py` ~4953, ~5003, ~5349) and the "legacy lock" cross-check (~5215)
- relay section of `shared-ui/src/components/RegistrationPanel.tsx` (`relay_count > 1` rendering, ~300+)
- `registrationApiElectron.ts:230` relay branch
- tests covering only this path (`tests/unit/test_relay_backward_compat.py` Req-10 parts,
  related cases in `tests/test_a_relay_api.py` / `test_integration.py`) — grep "virtual", "legacy lock", "Requirement 10"
Double-check the entry-time / HC handlers (~5462, ~5485) — CLAUDE.md says they 400 on virtual teams; drop that branch.

### A3. Leftover results importer `POST /upload/results`
`api.py` ~2714. Test-only, hand-rolled guards, swallows import errors. Remove route + its tests;
fix the `import_historical` docstring that references it. Update team-app CLAUDE.md if mentioned.

### A4. Routes with no frontend caller
Verify each with grep, then remove route + tests + CLAUDE.md table rows:
- `GET /api/export` (zip bundle) — near-duplicate of `/export/registrations-lxf`. If removed, check
  whether `backend/scripts/simulate_results.vbs/.bat` still have any use (they were only bundled here).
- `GET /api/export/entries` + whole `backend/app/export_entries.py` module
- `GET /api/admin/backup-db` (UI uses `/admin/backups/*`) — keep `sqlite_snapshot_bytes` if backups use it
- `GET /api/admin/historical-best-times/{id}`
- `GET /api/clubs/{id}/invoice-pdf`, `GET /api/clubs/{id}/invoice-total` (UI uses `/invoices/pdf-zip`)
- Test-only, decide case by case (keep if tests use them as fixtures/helpers):
  `PUT /closure-date`, `POST /organizer/clubs/invite-all`, `POST /admin/reset-rate-limits` (likely a test helper — keep).

### A5. Unused functions
team-app: `database.reset_engine`, `models.course_to_str/course_from_str`, `meet_parser.ParsedEvent.is_prelim`,
`api._get_current_meet_id` (inline → `resolve_meetsid`), `best_times.get_best_time` (test-only — keep if
tests are valuable, else drop with them).
meet-app: `geminiBackground.stopGeminiBackground`, `ocrGemini.saveGeminiApiKey`, `timingScanDb.markScanError`,
`ocrEngine.parseTimeToMs/formatMsToTime/assembleTimeString` (test-only; prod uses shared `timeFormat.ts`),
`timingBarcode.decodeBarcode` (test-only — keep if it documents the barcode format).
Preload methods never called by the renderer (remove method + IPC handler + backing fn if orphaned):
`onNewMeet`, `onHeatStatus`, `getHeatListEvents`, `getRelayMembers`, `getUnprocessed`, `getScansForHeat`,
`commitHeatResults`, `saveDebugImage`, `pushAll`. Check main/index.ts for menu `webContents.send` before
removing `on*` listeners.

### A6. Leftover files
- `packages/meet-app/.kiro/` (still tracked despite commit 7bb25e7) — `git rm -r`.
- `scripts/`: `check_ids.py`, `check_beach_ids.py`, `fix_beach_names.py`, `fix_agegroup_null.py`,
  `gen_ico.py`, `generate_styles_only_lxf.py` have no references. **Do not delete** — list them in the
  PR description for the owner to decide (one-off maintenance tools may still be wanted).

## Phase B — merge duplicates (behavior-preserving)

1. **MEETVALUES parse/serialize** (meet-app): 7 inline copies — `db.ts` ~1723 (`readMeetValuesFromDb`),
   ~2385 (`getMeetValues`), ~2411 (`setMeetValues`); `lenex.ts` ~303, ~338, ~1150, ~1549.
   Add exported `parseMeetValues(data, {keepType})` / `serializeMeetValues(map)` (and a
   `readMeetValuesRaw(db)` / `writeMeetValuesRaw(db, map)`) in db.ts. Note two flavors: value with type
   prefix stripped vs raw `TYPE;VALUE`. Rewrite `tests/meetvalues.test.ts` to import the real functions
   (it currently tests its own copy).
2. **`_get_config` / `_set_config`** (team-app): identical in `meet_config.py`, `routers/api.py`,
   `routers/live.py`, `routers/push_notifications.py` → import from `meet_config`.
3. **LENEX time → ms**: `seed._lenex_to_ms` vs `lxf_to_team._lenex_time_to_ms`. They differ
   (cc padding, `0` → None). Keep `_lenex_time_to_ms` semantics, make seed use it, add a unit test
   covering "NT", "0", "1:02.5", "00:01:02.50".
4. **ms → LENEX time**: identical `_ms_to_lenex` in `export.py` and `export_entries.py` (moot if A4
   deletes export_entries.py).
5. **Unzip .lxf → parse .lef**: use `lxf_to_team._read_lef_xml` (defusedxml) in `seed.py:75`,
   `meet_parser.py:132`, and `api._import_relays_from_lxf` (~4061, currently plain `xml.etree` — security
   improvement too). Consider moving `_read_lef_xml` to a small `lxf_io.py` and making it public.
6. **Age bounds ↔ age code** (team-app): `api._age_group_code`, `api._relay_age_code`,
   `seed._age_code_from_bounds`, `api._age_code_to_range` → new `backend/app/age_codes.py`.
   Note differences (`_relay_age_code` has fallbacks, `_age_group_code` returns None) — keep both
   behaviors as two functions if needed, just in one module. Point `test_relay_backward_compat.py`
   at the real functions (it copies them today).
7. **Relay XML writer** in `export.py` (~493-543 vs ~580-629, RELAYPOSITIONS also emitted twice inside each)
   → one `_write_relay(relays_xml, relay, ...)`. Keep output byte-identical (both RELAYPOSITIONS blocks
   stay — meet-app reads the one inside ENTRY).
8. **Event daytime format**: `db.ts formatDaytime` (~106) vs `lenex.ts formatLenexDaytime` (~982).
   They differ in hour padding (`9:05` vs `09:05`) — one function with a `pad` option; export from db.ts
   (lenex.ts already imports from db.ts, the "self-contained" comment is stale).
9. **Point-standings rank+award loop** — `db.ts getPointStandings` ~3914 / ~3995 / ~4059 → one
   `awardPlacePoints(results, pointsScale, category, clubPoints)`. Covered by `tests/combined-events.test.ts`.
10. **Relay cross-team conflict check** — `api.py` ~5098 and ~5188 → one helper (may shrink after A2).
11. **Markdown renderer** — meet-app `GuidePage.tsx` vs team-app `Workflow.jsx`: move to
    `shared-ui/src/logic/markdown.ts` if the two are close enough; otherwise skip and note it.
12. **Gender string → int maps** — `lxf_to_team._EVENT_GENDER`, `relay_archive._GENDER`,
    `meet_parser` (~88), `api.py` (~4147) → one constant (note default differs: 0 vs 3 for unknown).

## Phase C — docs
- meet-app CLAUDE.md source layout lists non-existent `ocrOllama.ts`, `timingImageProcess.ts`,
  `pages/AthletesPage.tsx`.
- team-app CLAUDE.md lists `best_times_v2.py` (it's `best_times.py`) and any endpoints removed above.

## Done when
- All phases committed, tests green (or the PR states exactly what couldn't be run and why).
- PR opened to `main` with: summary per step, line-count delta, the A6 script list for the owner,
  and any copies that disagreed in Phase B.
- `plan.md` removed in the final commit.
