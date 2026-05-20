## Ready for tomorrow

Here is a clean, pickup-ready plan for you and Kiro.

---

## Current state

- `agegroup.finalseedtype` already exists in the DB schema.
- `swimsession` already stores some session/meet settings, but not the full pane shown in `Meet Config.png` / Meetconfig_part2.png.
- The only DB field we can reliably use today for the config pane is `agegroup.finalseedtype` and existing session fields like `lanemin`, `lanemax`, `timing`, `touchpadmode`, `feeathlete`, `maxentriesathlete`, etc.

---

## Implementation plan

### 1. LENEX import
File: `src/main/lenex.ts`

- Parse `<AGEGROUP ... finalseedtype="...">`
- Store it into `agegroup.finalseedtype`
- This is the key existing import path for the heat seeding setting

### 2. Session/event query
File: `src/main/db.ts`

- Extend `getSessions()` so the age group query also selects `finalseedtype`
- Map it into the frontend model via `AgeGroupRow.finalSeedType`

### 3. Heat generation backend
File: `src/main/db.ts`

Add a dedicated function like `generateHeats()` that:

- Loads age groups and event/session metadata:
  - `agegroup.swimeventid`
  - `agegroup.heatcount`
  - `agegroup.finalseedtype`
  - session `lanemin`, `lanemax`
- Loads entries:
  - `swimresult` rows per `swimeventid` + `agegroupid`
  - ordered by `entrytime` ascending
- Computes:
  - `laneCount = lanemax - lanemin + 1`
  - `requiredHeats = max(heatcount, ceil(entries / laneCount))`
- Regenerates heats:
  - delete existing `heat` rows for those groups or globally
  - reset `swimresult.heatid` and `lane`
  - insert `heat` rows
  - assign results to heats and lanes
- Lane assignment:
  - use preferred order ([4,5,3,6,2,7,1,8] for 8 lanes, etc.)
  - optionally reverse every other heat when `finalseedtype` indicates finals-style seeding

### 4. IPC endpoint
Files:
- `src/main/index.ts`
- `src/preload/index.ts`

Expose a new IPC call:
- `db.generateHeats`
- `db.getSessions` already exists
- optionally a `db.refreshHeatAssignments` or similar if needed

### 5. Renderer UI
File: `src/renderer/src/pages/EventsPage.tsx`

- Add a “Generate heats” button in the event/session UI
- Call the preload API
- Refresh the data after completion
- Prefer placing it somewhere near the session/properties panel

### 6. UI field support
File: `src/renderer/src/pages/EventsPage.tsx`

- Add `finalSeedType` to the age group property panel
- Render it as a select/dropdown or numeric field
- Use the existing `AgeGroupRow` model to show the imported `finalseedtype`

---

## What I would not do yet

- I would not try to model the entire meet config pane from the screenshots yet.
- The existing DB does not contain enough fields to fully populate that pane.
- So focus first on:
  - `agegroup.finalseedtype`
  - heat generation
  - minimal UI for the new setting

---

## Pickup checklist for tomorrow

1. Confirm `src/main/lenex.ts` imports `finalseedtype`
2. Confirm `src/main/db.ts` loads `finalseedtype` into the session model
3. Implement `generateHeats()` in `src/main/db.ts`
4. Add IPC and preload support
5. Add button / panel hook in `src/renderer/src/pages/EventsPage.tsx`
6. Test with an imported LENEX and a session containing age groups

---

## Notes for Kiro

- This is a backend-first feature: the DB has the key field, and heat generation can be built without schema changes.
- The UI pane screenshot contains more configuration than the current database supports.
- The safe starting point is: import `finalseedtype`, expose it in the agegroup UI, then build “Generate heats” on top of that.

If you want, I can also turn this into a concrete task list with file names and exact function names for your first coding session.
