# Audit: "Nombre de séries" and "Méthode de répartition" (age group pane)

Status: **discussion notes, no code changed.** Written to continue the review elsewhere.
Both fields are in the age-group detail pane of the shared `EventsPage`
(`packages/shared-ui/src/pages/EventsPage.tsx` ~L1666-1699, label strings in `i18n.ts` L78-84).

| UI label | Column | Written by |
|---|---|---|
| Nombre de séries | `agegroup.heatcount` | `api.updateAgeGroup(id, {heatcount})` |
| Méthode de répartition | `agegroup.finalseedtype` | `api.updateAgeGroup(id, {finalseedtype})` |

The user's framing, in order: (1) heat count is dictated by entries and lanes, so what does the field do?
(2) age groups are mixed in the same event heat, so why a seeding method per age group?
Only Challenge 1 has been worked through; Challenge 2 is still open.

---

## Challenge 1: `heatcount`

### 1a. Heat generation (`generateHeats` → `seedAndAssignHeats`, `packages/meet-app/src/main/db.ts`)
- `requiredHeats = max(heatcount, ceil(entries / laneCount))` (`db.ts:2179`). Lanes = session `lanemax - lanemin + 1`.
  So the count comes from entries and lanes; `heatcount` is only a **floor**. Default is 1, so usually inert.
- The generator builds `requiredHeats` buckets, fills them by seeding method, then **skips empty buckets** (`db.ts:2289`).
  It never creates empty heats. With `heatcount=5` and 3 swimmers:

  | Method | Result |
  |---|---|
  | Circular (default) | 3 heats of 1 swimmer (round-robin into buckets 1-3) |
  | Pyramidal | 1 heat of 3, numbered "heat 5" |
  | Straight | 1 heat of 3, numbered "heat 1" |

  `MINPERHEAT` (default 3) does not repair the circular case; it only pulls swimmers from a heat that has more than the minimum.
- Test: `tests/heat-generation.test.ts:669` (8 entries, 8 lanes, `heatcount=3` → 3 heats).
- In **combined** mode (`COMBINEAGEGROUPS`) or when entries have no `agegroupid`, only `ageGroups[0].heatcount` is read (`db.ts:1887-1909`). The field on other age groups is ignored.
- Beach meets ignore it (`generateHeatsBeach` uses `maxentries`/`distance`).

### 1b. Finals: a second, unrelated meaning
On a **FIN** event, `heatcount` = **number of finals (A, B, C…)**, not derived from entries.
- `autoQualify` (`db.ts:3178`): the top `lanes` swimmers get `A`, the next `lanes` get `B`, … up to `heatcount` finals, then 2 reserves (`R`).
- `seedFinals` (`db.ts:3258`): creates one heat per letter, `heatCount` letters.
- `getFinalEvents` (`db.ts:~2796`) returns it as `heatCount`; `FinalsPage.tsx` only **displays** it ("N série(s)"). There is no other input, so this field is the only place the number of finals is stored.
- All of these read **only the first age group** (`ORDER BY sortcode LIMIT 1`). A different value on age group 2 is ignored.

### 1c. Why the user got A and B without ever changing the field
- "Convert to Final" (`EventsPage.tsx:505-564`) creates the Final with phase `'Finale'` (round FIN), then copies age groups via `createAgeGroup`.
- `createAgeGroup` (`db.ts:1585-1587`) sets `heatcount = 2` when the event's round is FIN, else 1.
- So a Final made in the app starts at 2 (A + B). The "1" the user remembers is most likely on the prelim or direct final, where it is only the floor.
- **Unverified by running.** Check: select an age group under the Final in the tree and see whether it shows 2.

### 1d. Where it would break
- LXF import hardcodes `heatcount=1` for new age groups (`lenex.ts:463`; the conflict branch does not update it). A Final that arrives via import would give A + reserves only, no B.
- Display and generator both default null to 1, which hides "unset" vs "one final".
- `heatcount` is **not exported** in LXF (only `finalseedtype` is, `lenex.ts:1673`). team-app stores it (`routers/api.py:1622, 2080`) but never generates heats.
- Splash reads/writes `agegroup.heatcount` directly on a shared Postgres, so the column must stay.

### 1e. Conclusion so far
The field is not redundant: on Finals it is the only store of the number of finals, and for events created in the app the default (2) is right, so it is rarely seen. On prelims and direct finals it is a floor with a questionable effect (uneven heats under circular, silent no-op under pyramid/straight). The defect is **one control doing two jobs under one label**.

Options (none chosen):
1. Relabel by context: "Nombre de finales (A, B…)" on FIN events; "Minimum de séries" (or hide) elsewhere. No schema or Splash impact.
2. Move the number of finals into `FinalsPage` as a real input (still stored in `heatcount`).
3. Make the finals code read the max or the right row across age groups instead of the first.
4. Verify the LXF-import case (1d) and fix the hardcoded 1 on Finals.

---

## Challenge 2: `finalseedtype` (still open)

How the generator resolves the method: `agegroup.finalseedtype ?? MEETVALUES.SEEDMETHOD` (`db.ts:1887, 1907, 1920`). Values: 0 circular, 1 pyramid, 2 straight.

| Situation | Behaviour |
|---|---|
| Separate age groups (default, `COMBINEAGEGROUPS` off, entries have an age group) | Each age group seeded on its own into its own heats; per-group value is honoured |
| Combined (`COMBINEAGEGROUPS` on, meet or event level) | One pool; **only `ageGroups[0]`'s** method, fast-heat count and heatcount are used; other age groups' values are dead |
| Entries have no `agegroupid` | Same as combined (first age group only) |

Findings:
- Premise check: age groups are **not** mixed by default. Mixing happens only with `COMBINEAGEGROUPS`, and that is exactly the case where the per-age-group field is silently ignored on all but the first group.
- The dropdown offers only Circular and Pyramidal; the code and the meet-level panel also support Straight.
- The select shows `group.finalSeedType ?? 0`, so an unset group displays "Circular" even if the meet-level `SEEDMETHOD` is Pyramid. The UI can say something the generator won't do.
- Meet-level `SEEDMETHOD` already exists (`EventsPage.tsx` ~L2398). `swimevent` has no seed-type column (only `seedbonuslast`, `seedexhlast`, `seedlateentrylast`, `combineagegroups`). Splash stores `finalseedtype` per age group, so that column stays.
- Risks of moving it to event level and writing it to every age group: value duplicated across rows, new age groups must inherit it, Splash's own UI is per age group so values can diverge, and a new column or derived value is extra schema.
- Smaller alternative: keep the data model; show "Default (meet): …" when unset, add Straight, and when combining is on show the field only on the first age group (or as one event-level control that writes to it).

Questions to settle:
1. Do organizers actually use the heat floor? If not, relabel it "Minimum" or show it only when relevant.
2. How common is combined-age-group seeding in real meets? If rare, the dead-field problem is cosmetic.

---

## Key code locations
| What | Where |
|---|---|
| Heat floor and seeding | `packages/meet-app/src/main/db.ts` `generateHeats` ~L1780, `seedAndAssignHeats` ~L2161 |
| Per-age-group resolution | `db.ts:1884-1932` |
| `createAgeGroup` default | `db.ts:1585-1587` |
| Finals | `autoQualify` ~L3178, `seedFinals` ~L3258, `getFinalEvents` ~L2796 |
| LXF import age groups | `packages/meet-app/src/main/lenex.ts:461-466`; export `:1673` |
| Convert to Final | `packages/shared-ui/src/pages/EventsPage.tsx:505-564` |
| Fields UI | `EventsPage.tsx:1666-1699`; strings `shared-ui/src/i18n.ts:78-84` |
| Heat rules doc | `packages/meet-app/docs/HEAT_GENERATION_RULES.md` |
| Finals UI | `packages/meet-app/src/renderer/src/pages/FinalsPage.tsx` |
