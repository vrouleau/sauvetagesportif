---
name: combined-events
description: Combined events / cumulative point standings in meet-app (combinedEvents.ts, combined-events-config.json) — prelim vs final resolution, Finale A/B ordering (qualcode), results list ordering. Use when touching combined events XML, getCombinedResults, getPointStandings, getResultsList or medal ordering.
---

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

## team-app

## Combined Events

Meet-app only (`src/main/combinedEvents.ts`, see `packages/meet-app/CLAUDE.md`)
— generates cumulative point-standings XML from `config/combined-events-config.json`
in meet-app's own `bsglobal`. team-app had a Python port (`combined_events.py`)
until 2026-06-16, when it was swapped for `point_scores.py` (a different,
Splash-native `POINTSCORE` mechanism); that in turn was removed 2026-08-03 as
dead code — nothing in team-app ever read either, and LXF export never
carried `COMBINEDEVENTS`/`POINTSCORE` to meet-app. team-app currently has no
combined-events implementation of its own, and doesn't need one.
