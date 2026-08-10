# "Hors Concours" (HC) — Design Notes

Status: **data model decided, ready to implement.** Splash Meet Manager's own
`.mdb` files were inspected directly (see "Splash ground-truth investigation"
below) and settle the previously-open question.

## Goal

Let an athlete/relay team compete in an event without their result counting
toward points/standings — French term "hors concours" (non-competitive),
abbreviated **HC**, Splash's own English label: **"Exhibition Swim" (EXH)**.
Applies to pool and beach, individual and relay.

- **Pool**: time is still recorded and displayed to the athlete/spectators —
  only the points/standings impact is suppressed.
- **Beach**: position is still recorded, but HC athletes sort to the bottom
  of the heat's finish order (see below) rather than keeping their natural
  place; other athletes in the heat are numbered normally among themselves.

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
**not** excluded from the points/standings queries above. Turns out this is
**not** the same mechanism Splash itself uses for HC/EXH (see below) — the
name overlap is coincidental.

LENEX export/import round-trips `resultstatus` as the literal string
`"DNS"/"DNF"/"DSQ"` on `<RESULT status="...">` — only those three values are
currently read/written; Splash's 4th value (below) is not currently
represented in LENEX at all as far as our code goes.

## Splash ground-truth investigation (2026-08-10)

A live Splash results-grid screenshot ("Série 1, Non officielle" — an
*unofficial*, i.e. not-yet-finalized, heat) prompted a follow-up: query
Splash's own `.mdb` files directly (via `Microsoft.ACE.OLEDB.12.0`) across
every real meet file in `C:\ProgramData\Meet Manager\Meets\`, rather than
trust the live-editing UI's on-screen state. This is the ground truth — it's
what Splash itself persists and would need to round-trip via `.smb`/LENEX.

**`RESULTSTATUS` has more than 4 values in real data.** Across
`CanadienMai2026_S40.mdb`, `CQS Piscine 2026 - CSSG.mdb`, `CQS Plage
2026.mdb`, `CAEM - 31 janvier 2026.mdb`, `CSRN 15 février 2026.mdb`, and
`Championnats canadiens 2026 V9.mdb`, observed values on `SWIMRESULT` and
`RELAY` were `0, 1, 2, 3, 4, 6, 13` (plus one single `5` seen once, on
`RELAY` only). Only `0`/`1`/`2`/`3` are documented/handled in our code today.

**`RESULTSTATUS = 4` is Splash's HC/EXH encoding, confirmed by direct
inspection:**
- Individual (`CanadienMai2026_S40.mdb`): rows with `RESULTSTATUS=4` have a
  real, non-zero `SWIMTIME` (e.g. `106120` = 1:06.12, `135660` = 2:15.66) —
  the time is genuinely kept, not cleared.
- Relay (`CQS Plage 2026.mdb`, a beach meet): `RELAYID=20`, `RESULTSTATUS=4`,
  `SWIMTIME=1000` (beach position 1, in our own ×1000ms encoding) — also
  kept.
- Cross-referencing `RESULTPLACE` (Splash's per-result finish-place table,
  `RESULTID` → `PLACE`): a `RESULTSTATUS=4` row's `PLACE` is `32767` — the
  `INT16` max-value sentinel, Splash's own "no place assigned" marker (same
  pattern as our own max-int-sentinel treatment of NT elsewhere). A normal
  `RESULTSTATUS=0` row in the same file has a real `PLACE` (e.g. `2`). **This
  is exactly the HC contract**: time/position stays on the row, but the
  athlete is excluded from ranking/placement.
- No dedicated lookup/enum table exists in the schema (checked all ~34
  tables) — Splash hardcodes the status meanings in its own executable, same
  as our `decodeResultStatus`. No table encodes the English "Exhibition Swim"
  label directly; that's UI-only text tied to the numeric code.

**Other unexplained values (`5`, `6`, `13`) are not HC** — sampled rows for
`6` and `13` have `SWIMTIME=0` and `RESULTPLACE.PLACE=32767` (excluded, like
DSQ), consistent with some other kind of scratch/withdrawal/DQ variant, not
a kept-result status. `5` was seen exactly once (a `RELAY` row, also
`SWIMTIME=0`). None of these matter for HC; noted here only so a future
"what does Splash do for DSQ reasons/scratches" investigation doesn't have to
rediscover them from scratch.

**Correction to the earlier screenshot-based read:** the screenshot showed a
DSQ'd swimmer (`GARNIER, Muller`) with what looked like a kept time (`Temps
final = 8.00`), which I'd initially read as "Splash never clears DSQ time."
The `.mdb` ground truth contradicts that: across every sampled meet
(hundreds of `RESULTSTATUS=3` rows total), **DSQ rows persist with
`SWIMTIME=0`** — matching our own app's current behavior, not contradicting
it. The likely explanation: the screenshot's heat was explicitly labeled
"**Non officielle**" (unofficial) — Splash's *live editing* grid appears to
retain whatever value was last typed in the time field so the operator can
toggle status back and forth without re-entering it, but what actually gets
**persisted** once a heat is finalized clears the time for DSQ (and
presumably DNS/DNF). **No change needed to our existing DNS/DNF/DSQ
time-clearing behavior** — that part of the original screenshot read doesn't
hold up against real data and should be disregarded.

The "position is entered via the time field" observation from the screenshot
still stands and is orthogonal to this: Splash's arrival-order/rank display
is computed by sorting the time/position column, independent of whether that
column ends up cleared or kept for a given status.

## Decided data model

**Extend `resultstatus` to a 4th value, matching Splash's own numbering
(`4` = HC/EXH), rather than adding a separate boolean flag.** This was the
open question the doc was previously paused on; Splash's own `.mdb` evidence
answers it directly — Splash itself reuses the same column with a
per-value contract change (value `4` doesn't clear the time; values
`1`/`2`/`3` do), rather than a second orthogonal flag. Mirroring that:
- Keeps our code's shape close to Splash's own model (helps any future
  `.mdb`/`.smb`/ODBC-adjacent interop, and keeps `decodeResultStatus` as the
  single place status meaning lives, rather than splitting HC across a
  parallel flag).
- Only the "clear time on non-null status" behavior in `HeatsPage.tsx`/
  `saveResult`/`saveRelayResult` needs to become conditional on the specific
  value (skip clearing for `4`), not a structural schema change beyond
  widening the accepted value range.
- The narrow `infocode='EXH'` heuristic (db.ts:2015) is unrelated to this and
  should **not** be repurposed for HC — it's a different, narrower mechanism
  (heat-seeding order only) that predates this investigation and turned out
  not to be Splash's actual mechanism either.

## Decisions confirmed

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
   into the same heat. (Splash's own beach/pool behavior — sort HC to the
   bottom of finish order while keeping the underlying time/position value —
   is a reasonable alternative to consider at implementation time, but this
   decision, made before the Splash research, stands unless revisited.)
4. **Data model**: extend `resultstatus` with value `4` (not a new boolean
   column), matching Splash's own encoding — see "Decided data model" above.
5. **DSQ time-clearing behavior**: unchanged. The earlier screenshot-driven
   idea that DSQ should keep its time was based on a misread of Splash's live
   *unofficial* editing UI, not its persisted data, and is retracted (see
   "Correction" above).

## Remaining work

- Schema/logic change: `db.ts`'s `decodeResultStatus`/`encodeResultStatus`
  gain a 4th value; `saveResult`/`saveRelayResult` stop clearing
  time/position specifically for that value (they still clear for
  `1`/`2`/`3`).
- Points/standings queries (`getCombinedResults`, `getPointStandings`, the
  two ranking queries ~3610/~3641) exclude `resultstatus=4` same as
  `1`/`2`/`3`; finals-qualification ranking query also excludes it (per
  decision #2).
- Beach: wherever positions are numbered/displayed, skip HC athletes from the
  numbering (decision #3).
- `lenex.ts`: export/import support for the new value — Splash's own LENEX
  round-trip behavior for `resultstatus=4` is still unverified (only the raw
  `.mdb` was inspected, not a Splash-generated `.lxf`); worth a quick check
  before finalizing the export string (likely a 4th `<RESULT status="...">`
  literal, naming TBD — "EXH" would match Splash's own UI label).
- UI: `HeatsPage`/`FinalsPage` — HC toggle alongside the existing DNS/DNF/DSQ
  control, keeping the time/position field enabled/visible when HC is set.
  `IndividualEntryPage`/`RelayEntryPage` (shared-ui) — HC checkbox at
  registration, applies to both meet-app and team-app (shared component —
  team-app-side plumbing through `meetApi.js`/FastAPI/Postgres would also be
  needed if the flag should reach team-app, TBD).
- i18n: FR "Hors concours" / EN — Splash's own label is "Exhibition Swim"
  (EXH), which settles the earlier open naming question; still need to
  decide our exact UI string but "Exhibition" is the evidence-backed choice.
- Tests: unit tests for the new exclusion logic (mirroring existing
  DNS/DNF/DSQ coverage), LENEX round-trip test if applicable.
