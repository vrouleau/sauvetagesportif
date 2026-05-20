# Implementation Plan: Combined Results Definition

## Overview

Implement the `regenerateCombinedEvents` function that auto-generates the COMBINEDEVENTS XML in BSGLOBAL whenever events or age groups are modified. The category definitions (points scales, age groups) are loaded from an external JSON config file bundled with the app, editable at runtime on the installation path.

## Tasks

- [x] 1. Create the bundled config file `resources/combined-events-config.json` with the 10 category definitions (age groups, points scales, flags). Verify the JSON is valid and matches the `CombinedEventsConfig` interface from the design.
  - **Files to create:** `packages/meet-app/resources/combined-events-config.json`

- [x] 2. Create `src/main/combinedEvents.ts` with TypeScript interfaces (`CategoryConfig`, `CombinedEventsConfig`, `EventWithAgeGroup`, `CombinedEventDef`) and implement `loadCombinedEventsConfig()` that resolves config from userData with fallback to bundled resources. Handle missing/malformed config with clear error messages.
  - **Files to create:** `packages/meet-app/src/main/combinedEvents.ts`

- [x] 3. Implement `queryEventsWithAgeGroups(db)` (JOIN query for individual non-relay events with their age groups) and `findMatchingEvents(events, category)` (age range + gender matching logic). Handle mixed gender (0) vs gendered categories, and ageMax = -1 (no upper limit).
  - **Files to modify:** `packages/meet-app/src/main/combinedEvents.ts`

- [x] 4. Implement `escapeXml(str)` utility and `buildCombinedEventsXml(definitions)` that produces the full XML string with `\r\n` line endings, proper indentation matching Splash format, self-closing tags for no-events categories, and normal tags with `<EVENTS>` children.
  - **Files to modify:** `packages/meet-app/src/main/combinedEvents.ts`

- [x] 5. Implement the main `regenerateCombinedEvents(db)` orchestrator: load config, query events, match to categories, build XML, upsert into BSGLOBAL. Sort event IDs within each category for deterministic output. Skip categories with no matching events (except `isSpecialNoEvents`). Use `INSERT ... ON CONFLICT DO UPDATE` for the BSGLOBAL upsert.
  - **Files to modify:** `packages/meet-app/src/main/combinedEvents.ts`

- [x] 6. Integrate into `db.ts`: import `regenerateCombinedEvents` and call it at the end of `createEvent()`, `deleteEvent()`, `updateEvent()` (when gender or swimstyleid changes), `createAgeGroup()`, `deleteAgeGroup()`, and `updateAgeGroup()` (when agemin, agemax, or gender changes).
  - **Files to modify:** `packages/meet-app/src/main/db.ts`

- [x] 7. Ensure config file is included in packaged app: verify electron-vite/electron-builder config includes `resources/combined-events-config.json` in the packaged output. Add `extraResources` entry in `package.json` build config if needed.
  - **Files to modify:** `packages/meet-app/package.json` (if extraResources config needed)

- [x] 8. Verify against real data: run the app with the existing CQS meet database, trigger a regeneration, compare the generated COMBINEDEVENTS XML against the known-good XML from the MDB. Verify all 10 categories are present with correct event lists, points scales, and valid event references.

## Task Dependency Graph

```json
{
  "waves": [
    {"tasks": ["1"]},
    {"tasks": ["2"]},
    {"tasks": ["3", "4"]},
    {"tasks": ["5"]},
    {"tasks": ["6", "7"]},
    {"tasks": ["8"]}
  ]
}
```

## Notes

- The config file approach allows runtime modifications without rebuilding the app. Users can edit `{userData}/combined-events-config.json` to adjust points scales or categories for a specific meet.
- Deleting the user data copy resets to the bundled default on next regeneration call.
- The function is idempotent — calling it multiple times without DB changes produces identical XML.
- The 13-14 garçons category uses a reduced points scale (7 places) compared to the standard (16 places) — this is configurable via the JSON file.
