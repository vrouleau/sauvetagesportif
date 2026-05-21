# Implementation Plan: Inscription Page Refactor

## Overview

Refactor the inscription (registration) page in both meet-app and team-app to use a cascade/collapsible tree layout with clubs as parent nodes and athletes as child nodes. The implementation follows the split-panel pattern from HeatsPage and is built as shared components in @meetmgr/shared-ui with thin wrappers in each app. TypeScript + React + Tailwind CSS.

## Tasks

- [x] 1. Create CascadeTree component in shared-ui
  - [x] 1.1 Create `packages/shared-ui/src/components/CascadeTree.tsx`
    - Implement collapsible tree with clubs as parent nodes and athletes as child nodes
    - Accept props: clubs, athletesByClub, selectedAthleteId, filterText, defaultExpanded, onSelectAthlete, onAddAthlete, onDeleteAthlete, role
    - Manage local state: expandedClubs (Set<number>), contextMenu position
    - Render ▶/▼ indicators on club nodes, highlight selected athlete
    - Implement right-click context menu with "Add Athlete" on club nodes and "Delete Athlete" on athlete nodes
    - Initialize expandedClubs as empty Set (all collapsed by default)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 7.1, 9.1_

  - [x]* 1.2 Write property tests for CascadeTree filtering logic
    - **Property 2: Filter Correctness**
    - **Validates: Requirements 2.2, 2.4**

  - [x]* 1.3 Write property test for default collapsed state
    - **Property 1: Cascade Default Collapsed**
    - **Validates: Requirements 1.2, 9.1, 9.2**

- [x] 2. Implement filter logic and auto-expansion
  - [x] 2.1 Create `packages/shared-ui/src/utils/filterAthletes.ts`
    - Implement `filterAthletes(athletesByClub, filterText)` function
    - Return filtered map and autoExpandClubs set
    - Case-insensitive substring match on `first_name + ' ' + last_name`
    - Implement `computeVisibleExpansion(expandedClubs, autoExpandClubs, filterText)` function
    - When filter active: return autoExpandClubs; when no filter: return manual expandedClubs
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [x]* 2.2 Write property tests for filter logic
    - **Property 4: Filter Auto-Expansion**
    - **Validates: Requirements 2.3**

  - [x]* 2.3 Write property test for filter round-trip
    - **Property 5: Filter Round-Trip**
    - **Validates: Requirements 2.5**

- [x] 3. Create AthleteDetailPanel component
  - [x] 3.1 Create `packages/shared-ui/src/components/AthleteDetailPanel.tsx`
    - Display athlete fields: last name, first name, gender, birthdate, license/NRAN, club name (read-only)
    - Implement inline editing with blur-to-save pattern
    - Call onSave callback with field name and new value on blur
    - Show empty state when no athlete is selected
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 4. Create RegistrationPanel component
  - [x] 4.1 Create `packages/shared-ui/src/components/RegistrationPanel.tsx`
    - Extract registration events content from existing RegistrationPage.tsx
    - Display category selector with age code dropdown
    - Display individual events table with checkboxes, best times, entry time inputs
    - Display relay events table with teammate selectors
    - Wire register/unregister/updateEntryTime callbacks
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 5. Create AddAthleteDialog component
  - [x] 5.1 Create `packages/shared-ui/src/components/AddAthleteDialog.tsx`
    - Modal dialog with form fields: first name, last name, gender, birthdate, license
    - Pre-fill club_id from props
    - Validate required fields (first name, last name must be non-empty/non-whitespace)
    - Follow DbConfigDialog styling pattern
    - Call onConfirm with NewAthleteData or onCancel
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

  - [x]* 5.2 Write property test for add athlete validation
    - **Property 6: Add Athlete Validation**
    - **Validates: Requirements 6.3**

- [x] 6. Checkpoint - Ensure all component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Create InscriptionPage main component
  - [x] 7.1 Create `packages/shared-ui/src/pages/InscriptionPage.tsx`
    - Accept props: role, clubId?, refreshKey?
    - Use RegistrationApiContext to get the API implementation
    - Implement useInscriptionPage custom hook for state management
    - Orchestrate CascadeTree, AthleteDetailPanel, RegistrationPanel, AddAthleteDialog
    - Split-panel layout: cascade tree top (~40%), detail panels bottom (~60%)
    - Implement 150ms debounced filter text input
    - Handle athlete selection: load registration data on select
    - Handle add/delete athlete flows with confirmation dialogs
    - Implement error state with retry button on API failure
    - _Requirements: 1.5, 2.1, 2.6, 3.1, 3.2, 3.3, 7.2, 7.3, 7.4, 7.5, 10.1, 10.2, 10.3_

  - [x] 7.2 Implement data loading with role-based filtering
    - Admin mode: load all clubs and all athletes
    - Coach mode: load only the coach's club and its athletes
    - Use loadInscriptionData logic from design
    - _Requirements: 8.1, 8.2, 8.3_

  - [x]* 7.3 Write property test for coach role isolation
    - **Property 3: Coach Role Isolation**
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [x] 8. Wire InscriptionPage into meet-app
  - [x] 8.1 Create `packages/meet-app/src/renderer/src/pages/InscriptionPageWrapper.tsx`
    - Wrap InscriptionPage with RegistrationApiProvider using registrationApiElectron
    - Pass role="admin" and refreshKey prop
    - _Requirements: 11.2_

  - [x] 8.2 Update meet-app routing/navigation to use InscriptionPageWrapper
    - Replace current AthletesPage/AthletesPageWrapper with InscriptionPageWrapper in App.tsx
    - Ensure the tab/navigation label remains the same
    - _Requirements: 11.2_

- [x] 9. Wire InscriptionPage into team-app
  - [x] 9.1 Create or update team-app inscription route to use InscriptionPage
    - Wrap InscriptionPage with RegistrationApiProvider using registrationApiHttp
    - Pass role from auth context and clubId from auth session
    - Wrap with SharedLangProvider for i18n
    - _Requirements: 8.1, 11.2_

- [x] 10. Fix all existing cascade/tree components to default collapsed
  - [x] 10.1 Audit and fix HeatsPage and EventsPage cascade default state
    - Change any `new Set(items.map(x => x.id))` initialization to `new Set()` for tree expansion state
    - Ensure expandedSessions/expandedEvents start as empty Sets
    - _Requirements: 9.3_

- [x] 11. Export new components from shared-ui index
  - [x] 11.1 Update `packages/shared-ui/src/index.ts`
    - Export InscriptionPage, CascadeTree, AthleteDetailPanel, RegistrationPanel, AddAthleteDialog
    - Export filterAthletes and computeVisibleExpansion utility functions
    - _Requirements: 11.1_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "name": "Wave 1: Core Components",
      "tasks": ["1", "2", "3", "4", "5"]
    },
    {
      "name": "Wave 2: Checkpoint",
      "tasks": ["6"]
    },
    {
      "name": "Wave 3: Page Assembly",
      "tasks": ["7"]
    },
    {
      "name": "Wave 4: Integration",
      "tasks": ["8", "9", "10", "11"]
    },
    {
      "name": "Wave 5: Final Checkpoint",
      "tasks": ["12"]
    }
  ]
}
```

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The implementation uses TypeScript + React + Tailwind CSS (matching existing codebase)
- Property tests use vitest + fast-check as specified in the design
- The CascadeTree component follows the same expand/collapse Set-based state management as HeatsPage
- RegistrationPanel extracts logic from the existing RegistrationPage.tsx to avoid duplication
