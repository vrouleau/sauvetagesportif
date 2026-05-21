# Requirements Document

## Introduction

This document defines the requirements for refactoring the inscription (registration) page in both the meet-app and team-app. The refactored page replaces the current flat table layout with a cascade/collapsible tree layout, aligning the look and feel with the meet page (HeatsPage/EventsPage pattern). The new design introduces clubs as parent nodes and athletes as child nodes, a text filter for athlete names, athlete detail and registration panels below the cascade, and add/delete athlete actions via context menus.

## Glossary

- **Inscription_Page**: The refactored registration page component shared between meet-app and team-app, displaying clubs and athletes in a cascade tree layout with detail panels below.
- **Cascade_Tree**: A collapsible tree UI component that displays hierarchical data with expandable/collapsible parent nodes (clubs) and child nodes (athletes).
- **Athlete_Detail_Panel**: The panel below the cascade tree that displays and allows editing of the selected athlete's personal information.
- **Registration_Panel**: The panel below the cascade tree that displays event registration data (individual and relay events) for the selected athlete.
- **Add_Athlete_Dialog**: A modal dialog for creating a new athlete within a specific club.
- **Filter_Text_Box**: A text input that filters athletes by name across all clubs in the cascade tree.
- **Context_Menu**: A right-click menu on cascade tree nodes providing add/delete athlete actions.
- **Club_Node**: A parent node in the cascade tree representing a club.
- **Athlete_Node**: A child node in the cascade tree representing an athlete within a club.
- **Coach_Mode**: The team-app mode where a logged-in coach user only sees their own club's data.
- **Admin_Mode**: The meet-app mode where the user sees all clubs and athletes.
- **Registration_API**: The abstract data layer interface providing club, athlete, and registration operations.

## Requirements

### Requirement 1: Cascade Tree Layout

**User Story:** As a meet organizer, I want to see clubs and athletes in a collapsible tree layout, so that I can navigate registrations in a structured and familiar way consistent with the meet page.

#### Acceptance Criteria

1. WHEN the Inscription_Page loads, THE Cascade_Tree SHALL display clubs as parent nodes and athletes as child nodes in a hierarchical tree structure.
2. WHEN the Inscription_Page loads, THE Cascade_Tree SHALL render all Club_Nodes in a collapsed (not-expanded) state by default.
3. WHEN a user clicks on a Club_Node, THE Cascade_Tree SHALL toggle the expansion state of that node, showing or hiding its Athlete_Nodes.
4. THE Cascade_Tree SHALL display expand/collapse indicators (▶/▼) on each Club_Node to communicate its current state.
5. WHEN a user clicks on an Athlete_Node, THE Inscription_Page SHALL set that athlete as the selected athlete and load their detail and registration data.
6. THE Cascade_Tree SHALL visually highlight the currently selected Athlete_Node.

### Requirement 2: Athlete Name Filter

**User Story:** As a meet organizer, I want to filter athletes by name across all clubs, so that I can quickly find a specific athlete without manually expanding each club.

#### Acceptance Criteria

1. THE Inscription_Page SHALL display a Filter_Text_Box above the Cascade_Tree.
2. WHEN a user types in the Filter_Text_Box, THE Cascade_Tree SHALL display only athletes whose full name (first name + last name) contains the filter text as a case-insensitive substring match.
3. WHEN a filter is active and matching athletes exist, THE Cascade_Tree SHALL auto-expand all Club_Nodes that contain matching athletes.
4. WHEN a filter is active, THE Cascade_Tree SHALL hide Club_Nodes that have no matching athletes.
5. WHEN the filter text is cleared, THE Cascade_Tree SHALL restore the manual expansion state and show all athletes.
6. THE Inscription_Page SHALL apply a 150ms debounce on filter text input to avoid excessive re-renders.

### Requirement 3: Split-Panel Layout

**User Story:** As a meet organizer, I want the inscription page to follow the same split-panel pattern as the HeatsPage, so that the application has a consistent look and feel.

#### Acceptance Criteria

1. THE Inscription_Page SHALL use a split-panel layout with the Cascade_Tree in the top portion (approximately 40%) and the detail/registration panels in the bottom portion (approximately 60%).
2. WHEN an athlete is selected, THE Inscription_Page SHALL render the Athlete_Detail_Panel and Registration_Panel in the bottom portion.
3. WHEN no athlete is selected, THE Inscription_Page SHALL display an empty state message in the bottom portion.

### Requirement 4: Athlete Detail Panel

**User Story:** As a meet organizer, I want to view and edit an athlete's personal information below the cascade tree, so that I can manage athlete data without navigating to a separate page.

#### Acceptance Criteria

1. WHEN an athlete is selected, THE Athlete_Detail_Panel SHALL display the athlete's last name, first name, gender, birthdate, license/NRAN, and club name.
2. THE Athlete_Detail_Panel SHALL allow inline editing of last name, first name, gender, birthdate, and license fields.
3. WHEN a user edits a field and removes focus (blur), THE Athlete_Detail_Panel SHALL save the change via the Registration_API.
4. THE Athlete_Detail_Panel SHALL display the club name as read-only.

### Requirement 5: Registration Panel

**User Story:** As a meet organizer, I want to view and manage an athlete's event registrations below the cascade tree, so that I can register athletes for events without navigating away.

#### Acceptance Criteria

1. WHEN an athlete is selected, THE Registration_Panel SHALL display the athlete's individual event registrations and relay event registrations.
2. THE Registration_Panel SHALL provide a category selector with age code dropdown.
3. WHEN a user checks an event checkbox, THE Registration_Panel SHALL register the athlete for that event via the Registration_API.
4. WHEN a user unchecks an event checkbox, THE Registration_Panel SHALL unregister the athlete from that event via the Registration_API.
5. THE Registration_Panel SHALL display best times and allow entry time input for each event.

### Requirement 6: Add Athlete

**User Story:** As a meet organizer, I want to add a new athlete to a club via a context menu on the cascade tree, so that I can quickly create athletes in the correct club context.

#### Acceptance Criteria

1. WHEN a user right-clicks on a Club_Node, THE Context_Menu SHALL display an "Add Athlete" option.
2. WHEN the user selects "Add Athlete" from the Context_Menu, THE Inscription_Page SHALL open the Add_Athlete_Dialog pre-filled with the selected club.
3. THE Add_Athlete_Dialog SHALL require first name and last name fields to be non-empty.
4. WHEN the user confirms the Add_Athlete_Dialog with valid data, THE Inscription_Page SHALL create the athlete via the Registration_API and refresh the Cascade_Tree to include the new athlete.
5. WHEN the user cancels the Add_Athlete_Dialog, THE Inscription_Page SHALL close the dialog without changes.

### Requirement 7: Delete Athlete

**User Story:** As a meet organizer, I want to delete an athlete via a context menu on the cascade tree, so that I can remove incorrectly added athletes.

#### Acceptance Criteria

1. WHEN a user right-clicks on an Athlete_Node, THE Context_Menu SHALL display a "Delete Athlete" option.
2. WHEN the user selects "Delete Athlete" from the Context_Menu, THE Inscription_Page SHALL display a confirmation dialog with the athlete's name.
3. IF the athlete has active registrations, THEN THE confirmation dialog SHALL warn about cascading deletion of registrations.
4. WHEN the user confirms deletion, THE Inscription_Page SHALL delete the athlete via the Registration_API and refresh the Cascade_Tree.
5. WHEN the user cancels deletion, THE Inscription_Page SHALL close the dialog without changes.

### Requirement 8: Coach Mode (Team-App)

**User Story:** As a team coach, I want to see only my own club's athletes when using the team-app, so that I can focus on managing my team without seeing other clubs' data.

#### Acceptance Criteria

1. WHILE the user role is "coach" and a clubId is provided, THE Inscription_Page SHALL display only the coach's club in the Cascade_Tree.
2. WHILE the user role is "coach", THE Inscription_Page SHALL load athletes only for the coach's club from the Registration_API.
3. WHILE the user role is "admin", THE Inscription_Page SHALL display all clubs and their athletes in the Cascade_Tree.

### Requirement 9: Default Collapsed State for All Cascades

**User Story:** As a user, I want all cascade/tree lists in the application to open in a collapsed state by default, so that I can see an overview first and expand only what I need.

#### Acceptance Criteria

1. THE Cascade_Tree component SHALL initialize with all nodes in a collapsed state (expandedClubs set is empty).
2. WHEN the Inscription_Page loads, THE Cascade_Tree SHALL not auto-expand any Club_Node unless a filter is active.
3. WHERE other cascade/tree components exist in the application, THE application SHALL ensure they also open in a collapsed state by default.

### Requirement 10: Error Handling

**User Story:** As a user, I want clear feedback when errors occur during data loading or operations, so that I can understand what went wrong and retry.

#### Acceptance Criteria

1. IF the Registration_API fails during initial data loading, THEN THE Inscription_Page SHALL display a centered error message with a retry button.
2. IF a network error occurs during register/unregister operations, THEN THE Inscription_Page SHALL display an inline error toast and revert any optimistic UI update.
3. WHEN the user clicks the retry button after a load failure, THE Inscription_Page SHALL re-fetch all data from the Registration_API.

### Requirement 11: Shared Component Architecture

**User Story:** As a developer, I want the inscription page components to be shared between meet-app and team-app, so that both applications maintain consistent behavior with minimal code duplication.

#### Acceptance Criteria

1. THE Inscription_Page, Cascade_Tree, Athlete_Detail_Panel, Registration_Panel, and Add_Athlete_Dialog SHALL be implemented in the @meetmgr/shared-ui package.
2. THE meet-app and team-app SHALL each provide a wrapper component that supplies the appropriate Registration_API implementation and role/clubId props.
3. THE Inscription_Page SHALL accept a Registration_API via React context (RegistrationApiContext) to abstract the data layer.
