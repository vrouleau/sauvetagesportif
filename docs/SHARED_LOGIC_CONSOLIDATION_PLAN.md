# Plan: Consolidate Duplicated Business Logic into shared-ui

**Status:** Executed. Cases 1, 2, 3 (bonus dedup), and 4 landed as pure-function
modules under `shared-ui/src/logic/` (`relayRules.ts`, `ageGroupCode.ts`,
`timeFormat.ts`), imported from both apps via the new `main`-process `@shared`
alias. Case 5 (SERC scoring) got the lighter treatment the plan called for —
each language's formula was extracted into its own standalone, fixture-testable
function, without merging (still Python vs JS in the same app). Cross-language
drift protection: `tests/fixtures/relay_age_rules.json` and
`tests/fixtures/serc_scoring.json`, iterated by both the TS and Python test
suites. Known gap: `team-app/frontend` has no JS test runner configured, so
`computeSercTotal()` (`sercScoring.js`) isn't automatically checked against the
fixture the way `compute_serc_total()` (Python) is — only the Python side runs
in CI today.
**Origin:** Triggered by noticing relay-team validation rules (swim-up/adjacency,
"native anchor" count, mixed-gender quota) were implemented three times
independently — once in team-app's Python backend, once in meet-app's TS main
process, and once in shared-ui's `RelayEntryPage.tsx` for live dropdown
filtering. Two of those three copies are already plain TypeScript with zero
DOM/React dependency, which makes them collapsible into one shared-ui module.
This doc catalogs that case plus every other case found by the same search,
so execution can be picked up later without re-investigating.

## Pattern

The monorepo has three logic homes: team-app backend (Python), meet-app
backend (`src/main/*.ts`, Node/Electron), and shared-ui (`src/**/*.tsx`,
plain TS/React, imported by both apps' renderers). Whenever a rule is a
**pure function** — no DB access, no I/O, just computation over data already
fetched — it's cheap for it to accidentally get reimplemented at each layer
that needs it, and each copy can silently drift from the others. The fix
differs depending on which layers are involved:

- **meet-app backend ↔ shared-ui (both TS):** genuinely mergeable into one
  module today. No cross-language barrier.
- **team-app backend (Python) ↔ TS side(s):** cannot literally share a
  module. The realistic fix is a single documented spec / fixture table that
  both implementations are tested against, so drift becomes a test failure
  instead of a silent bug (same pattern already used for
  `config/combined-events-config.json` as shared *data*).

## Confirmed cases

### 1. Relay team validation rules (original finding)

Rules: team category = event's category; member must match exact category or
the one adjacent-younger category (swim-up only, never reverse); at least 2
members must match the exact category ("native anchor"); mixed events need
exactly 2M+2F; SERC (swimstyle 530) has no restrictions; eligibility = same
club, registered individually, no duplicate across teams for the same event.

| Location | Language | What |
|---|---|---|
| `team-app/backend/app/routers/api.py:225-350, 4546-5077` | Python | `_age_code_allowed_on_team`, `_would_miss_native_anchor`, gender-quota + eligibility checks in `create_relay_team`/`set_relay_team_member` |
| `meet-app/src/main/index.ts:499-577, 895-1120` | TS (main) | `isAgeCodeAllowedOnTeam`, `wouldMissNativeAnchor`, same checks in the `db:create-relay-team`/`db:set-relay-team-member` IPC handlers |
| `shared-ui/src/pages/RelayEntryPage.tsx:61-86, 212-345` | TS (shared-ui) | Same functions again, used to pre-filter the member dropdown live |

~230-260 lines duplicated across the two TS copies (Python is the third,
unmergeable copy). **Action:** extract the pure functions into
`shared-ui/src/logic/relayRules.ts`, export from the barrel, import from both
`RelayEntryPage.tsx` and `meet-app/src/main/index.ts`. Requires adding a
`resolve.alias` for `@shared` to the `main` block of
`meet-app/electron.vite.config.ts` (currently only the `renderer` block has
it — confirmed by reading the file). Keep the Python copy as-is; add a shared
fixture-based test (see "Testing strategy" below) so it can't silently drift
from the TS version.

### 2. Age-group bracket code classification

Maps an age group's name/min/max to a canonical bracket code (`'10-'`,
`'11-12'`, `'13-14'`, `'15-18'`, `'Open'`, `'Masters'`).

| Location | Language | Function |
|---|---|---|
| `meet-app/src/main/index.ts:310-330` | TS (main) | `ageGroupCodeFor()` |
| `meet-app/src/renderer/src/registrationApiElectron.ts:94-116` | TS (renderer) | `ageCodeFromGroup()` — byte-for-byte identical body; `index.ts` even has a comment admitting it "mirrors" the renderer version |
| `team-app/backend/app/routers/api.py:235-246, 3979-4021` | Python | `_age_group_code()`, `_relay_age_code()`, `_age_code_to_range()` |

~20-25 lines per TS copy, pure regex/arithmetic over already-fetched data.
**Action:** same treatment as case 1 — pull the TS logic into
`shared-ui/src/logic/ageGroupCode.ts`, import from both `index.ts` and
`registrationApiElectron.ts`.

### 3. Age-code adjacency ordering — duplicated a third and fourth time inside shared-ui itself

The `AGE_CODE_ORDER` array plus "candidate must be same or one bracket
younger" check (the same concept as case 1's swim-up rule, but for
*individual* entry age-group dropdowns, not relay teams) appears in:

| Location | Notes |
|---|---|
| `team-app/backend/app/routers/api.py:232, 249-258` | Python, `_AGE_CODE_ORDER` + `_age_code_allowed_on_team()` |
| `shared-ui/src/components/RegistrationPanel.tsx:43, 134-144` | TS, own `AGE_CODE_ORDER` + inline ±1-window filter |
| `shared-ui/src/pages/RegistrationPage.tsx:42, 178-186` | TS, **same array and logic copy-pasted again inside shared-ui** |

**Bonus finding, related and worth folding into the same cleanup pass:**
`RegistrationPanel.tsx` (404 lines, used by `IndividualEntryPage.tsx` in both
apps) and `RegistrationPage.tsx` (399 lines, used by team-app's `main.jsx`)
are near-total duplicates of each other *within shared-ui* — not a
cross-app/cross-language problem, just two components that should probably
be one, or share a common hook/logic module. Worth scoping as part of this
work since the duplicated `msToTime`/`parseTime`/`normalize`/`AGE_CODE_ORDER`
code (case 4 below) is duplicated specifically because these two files are
duplicated.

### 4. Entry-time formatting/parsing (`M:SS.cc` ↔ milliseconds)

Team-app's backend doesn't parse time strings at all — it only validates
`entry_time_ms >= 0` server-side, receiving ms as a number from the client.
So this isn't a 3-way backend split like case 1; it's meet-app's own pure TS
module being reimplemented instead of imported, everywhere it's needed:

| Location | Function(s) |
|---|---|
| `meet-app/src/main/db.ts:62-83` | `msToDisplay()` / `displayToMs()` — **canonical**, pure, no I/O |
| `meet-app/src/renderer/src/pages/ReportPage.tsx:668-677` | `msToDisplay()` reimplemented, slightly different rounding |
| `meet-app/src/renderer/src/pages/HeatsPage.tsx:436-551` | `parseTimeSecs`, `parseSingleTime`, `timeToCs`, `csToTime`, `parseTimeInput` (~120 lines, most elaborate — handles multi-time averaging + beach-position mode) |
| `meet-app/src/renderer/src/pages/TimingProcessPage.tsx:404` | `parseTimeInput()`, another variant |
| `meet-app/src/main/ocrEngine.ts:40` | `parseTimeToMs()`, OCR-specific variant |
| `shared-ui/src/components/RegistrationPanel.tsx:25-65` | `msToTime()`/`parseTime()`/`normalize()` |
| `shared-ui/src/pages/RegistrationPage.tsx:24-64` | Same three functions again (see case 3 bonus finding) |

~200+ lines across 7 call sites in 6 files, all pure string↔number
functions. **This is the largest and cleanest consolidation target.**
**Action:** promote `msToDisplay`/`displayToMs` (extended to cover the loose
typed-input parsing from `HeatsPage.tsx`, e.g. `"4500"` → ms) into
`shared-ui/src/logic/timeFormat.ts`; repoint every listed call site at it.
Since meet-app's main process needs it too, this depends on the same `main`
alias fix as case 1.

### 5. SERC weighted-score formula (Python ↔ JS, not mergeable, still worth fixing)

Weighted-total formula (sum of `raw_score * factor` across
overall/bystander/victim sections, plus a flat "rough handling" add, rounded
to 2 decimals):

| Location | Function |
|---|---|
| `team-app/backend/app/routers/serc.py:288-309` | `calc_team_draw()` — used for `/serc/results` and draw-order randomization |
| `team-app/frontend/src/pages/Serc.jsx:463-485` | `calcTotal()` — used for the judge's live running-total column |

No meet-app equivalent exists (SERC has no meet-app UI), so this can't be
merged into one module the way cases 1/2/4 can — it's Python vs. JS in the
same app. **Action:** lower priority than the TS-mergeable cases; treat as a
"keep in sync via test fixture" item only (see below).

**Separately noticed, not a duplication bug but worth flagging:** score-range
validation (0-10 in 0.5 steps) is enforced only client-side
(`SercJudge.jsx:43`, hardcoded `SCORE_VALUES` array); `serc.py`'s
`set_score()` (`serc.py:183-224`) validates the "rough handling" special case
but not the general range. This is a server-side validation gap, not
duplication — track separately, out of scope for this plan.

## Areas investigated with no duplication found

Recorded so these don't get re-investigated later:

- **Beach number encoding** (`meet-app/src/main/beachNumber.ts`) — only
  consumer anywhere is display of the pre-computed `nameprefix` string; no
  re-derivation logic exists client-side or in team-app.
- **Point scores** (`pointScores.ts` / `point_scores.py`) — already a clean
  1:1 backend-to-backend port; no frontend/shared-ui mirror exists.
- **Combined events** (`combinedEvents.ts` / Python equivalent) — backend-only,
  DB-driven regeneration; no client-side matching logic exists.
- **DSQ codes** — meet-app's status enum + `dsqitem` DB lookup is I/O-bound,
  not portable; team-app has no equivalent concept. Nothing to consolidate.
- **Best times** — `best_times.py` is pure Postgres aggregation (not
  portable regardless of language); meet-app doesn't compute best times at
  all, only stores/passes through imported values.

## Proposed mechanics

1. Add `shared-ui/src/logic/` (plain `.ts`, no React imports) as the home for
   consolidated pure functions, separate from `shared-ui/src/components` and
   `pages`, so it's obviously safe to import from a non-React context
   (meet-app's Electron main process).
2. Add a `resolve.alias` for `@shared` to the `main` block of
   `packages/meet-app/electron.vite.config.ts` (it currently exists only
   under `renderer`), so `src/main/*.ts` can import from
   `shared-ui/src/logic/*`.
3. Migrate cases in order of size/risk: case 4 (time formatting, largest,
   most call sites) → case 2 (age bracket code) → case 1 (relay rules,
   already scoped in detail) → case 3 bonus (dedupe `RegistrationPanel.tsx`
   vs `RegistrationPage.tsx`).
4. For the two cases with a Python-side copy that can't be merged (case 1's
   `api.py` copy, case 5 SERC scoring): write one fixture file per rule
   (JSON array of `{input, expected}` cases) checked into `docs/` or a
   `test-fixtures/` folder, and add a unit test in both the TS module's test
   suite and the Python test suite that iterates the same fixture. This
   doesn't eliminate the second implementation but turns drift into a CI
   failure instead of a silent bug.

## Explicitly out of scope for this plan

- The earlier, separate question of embedding a Python runtime inside
  meet-app to unify with team-app's backend — rejected; the two backends are
  coupled to different DB layers (synchronous SQLite vs. synchronous
  SQLAlchemy/Postgres), so a shared "engine" would need a persistence-agnostic
  refactor that's the same cost regardless of host language, plus new
  cross-platform Python packaging risk meet-app doesn't currently carry.
- The SERC server-side score-range validation gap (noted under case 5) — a
  correctness/hardening issue, not a duplication issue.
