# "Hors Concours" (HC) — Design Notes (WIP)

Status: **planning paused** — pending Splash Meet Manager research on how it
models this (see "Open question" below). Nothing implemented yet.

## Goal

Let an athlete/relay team compete in an event without their result counting
toward points/standings — French term "hors concours" (non-competitive),
abbreviated **HC**. Applies to pool and beach, individual and relay.

- **Pool**: time is still recorded and displayed to the athlete/spectators —
  only the points/standings impact is suppressed.
- **Beach**: no position number shown for HC athletes (like DNS/DNF today);
  other athletes in the heat are numbered normally among themselves.

## Current system (research findings)

DNS/DNF/DSQ today live in `swimresult.resultstatus` / `relay.resultstatus`
(INTEGER: `1`=DNS, `2`=DNF, `3`=DSQ, `null`/`0`=normal — see
`decodeResultStatus`/`encodeResultStatus` in `src/main/db.ts:85-97`, duplicated
in `src/main/lenex.ts:739-752` for LENEX export). Picking one of these in the
UI (a `<select>` in `HeatsPage.tsx` ~line 1660) **clears the time/position** —
the column's whole contract today is "no result to show."

Points/standings exclusion is a repeated predicate in `db.ts`:
`resultstatus IS NULL OR resultstatus = 0`, found in `getCombinedResults`
(~3272), `getPointStandings` (~3754), and a couple of ranking queries
(~3610, ~3641). Client-side rank display in `HeatsPage.tsx:449` filters the
same three status strings.

Relay has a fully parallel path: `relay.resultstatus`/`relay.dsqitemid`,
`saveRelayResult()` (db.ts:1123), duplicated (not shared) SQL branches in the
ranking functions. Status lives only on the parent `relay` row, not on
`relayposition`/`relaysplit`.

There's also `swimresult.infocode` containing `'EXH'` (db.ts:2015-2016) —
"exhibition" entries — but it's a narrow, backend-only heuristic used only to
seed exhibition entries last when generating heats. It has **no UI**, and is
**not** excluded from the points/standings queries above. Related in spirit,
not the same mechanism as HC.

No "hors concours"/NC status exists anywhere in code, config, or docs today.
LENEX export/import round-trips `resultstatus` as the literal string
`"DNS"/"DNF"/"DSQ"` on `<RESULT status="...">` — only those three values are
currently read/written.

## Decisions confirmed so far

1. **Entry point**: settable both (a) at registration time
   (`IndividualEntryPage`/`RelayEntryPage`, shared-ui) so an athlete/team is
   flagged HC ahead of the meet and it carries forward automatically to
   results entered for them, and (b) at time entry (`HeatsPage`/`FinalsPage`)
   per result, same as DNS/DNF/DSQ are today.
2. **Finals scope**: HC excludes from finals qualification, not just from
   points/standings — an HC swimmer can swim finals if manually placed there,
   but their prelim time does not count toward automatic qualification
   ranking.
3. **Beach display**: HC athletes show `"HC"` in place of a position number
   (same visual treatment as DNS/DNF today). Other athletes in the heat are
   numbered 1, 2, 3... among themselves, unaffected by any HC athletes mixed
   into the same heat.

## Open question — blocking further design

Since HC needs to **keep the time/position visible** (unlike DNS/DNF/DSQ,
whose whole contract is "no result"), reusing `resultstatus` as a 4th value
would require special-casing it everywhere that column is read. Two options
on the table:

- **New boolean flag** (`hors_concours` on `swimresult` and `relay`,
  independent of `resultstatus`) — cleaner, doesn't disturb the existing
  DNS/DNF/DSQ contract.
- **Extend `resultstatus`** to a 4th value, with the time/position no longer
  cleared/hidden for that value specifically — more invasive.

User wants to check how **Splash Meet Manager** itself models "hors concours"
(if at all) before deciding — this matters for LENEX/Splash round-trip
compatibility, the same way `dsq-codes.json`/`DSQITEMS` mirrors Splash's own
DSQ-reason catalog. **Paused here pending that lookup.**

## Remaining work once the data model is decided

- Schema change (`schema.ts`) + migration path (existing DBs).
- `db.ts`: `saveResult`/`saveRelayResult` read/write the new flag;
  points/standings queries (`getCombinedResults`, `getPointStandings`, the
  two ranking queries) exclude HC same as DNS/DNF/DSQ; finals-qualification
  ranking query also excludes HC (per decision #2 above).
- Beach: wherever positions are numbered/displayed, skip HC athletes from the
  numbering (decision #3).
- `lenex.ts`: export/import support for the new flag — format depends on the
  data-model decision and the Splash-compatibility research.
- UI: `HeatsPage`/`FinalsPage` — HC toggle alongside the existing DNS/DNF/DSQ
  control, keeping the time/position field enabled/visible when HC is set.
  `IndividualEntryPage`/`RelayEntryPage` (shared-ui) — HC checkbox at
  registration, applies to both meet-app and team-app (shared component —
  team-app-side plumbing through `meetApi.js`/FastAPI/Postgres would also be
  needed if the flag should reach team-app, TBD).
- i18n: FR "Hors concours" / EN — need a decision on the English label
  ("Non-competitive"? "Exhibition"? — note this could collide conceptually
  with the existing unrelated EXH infocode wording).
- Tests: unit tests for the new exclusion logic (mirroring existing
  DNS/DNF/DSQ coverage), LENEX round-trip test if applicable.
