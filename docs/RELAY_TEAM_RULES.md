# Relay Team Composition Rules

## Overview

Relay teams are composed of members from the same club. The team's age category and gender composition must follow specific rules to be valid for competition.

## Age Group Categories

Athletes are classified into the following age groups based on their age as of the meet's age base date:

| Code     | Age Range         |
|----------|-------------------|
| 10-      | 10 and under      |
| 11-12    | 11 to 12          |
| 13-14    | 13 to 14          |
| 15-18    | 15 to 18          |
| 19+      | 19 and older      |
| Masters  | Masters category  |

## Team Age Group Determination

The team's age group is NOT calculated from birthdates. It is derived from the **individual registration age group** of each team member — the category selected by the coach in the Individual Entry page (stored in `swimresult.agegroupid`).

The team's age group is determined by the **majority** age group of its members:

- **4-0**: All 4 members from the same age group → team belongs to that age group ✓
- **3-1**: 3 members from one age group + 1 from another → team belongs to the majority (3) age group ✓
- **2-2**: 2 members from one age group + 2 from another → **INVALID** composition ✗

### Rule

> A relay team must have a clear majority (≥3 out of 4, or ≥2 out of 2 for 2-person relays) of members from the same age group. A 50/50 split is not allowed.

### General Formula

For a relay of N members:
- At least ⌈(N/2) + 1⌉ members must share the same age group (strict majority)
- Equivalently: no two age groups may have the same count as the maximum

### Calculated Age Group

The team's displayed age group is the age group with the most members assigned.

## Gender Rules for Mixed (X) Events

For events with gender = "X" (mixed):

- A team of 4 must have **exactly 2 men and 2 women**
- A team of 2 must have **exactly 1 man and 1 woman**

### General Formula

For a mixed relay of N members:
- Exactly N/2 men and N/2 women are required

Events with gender = "M" or "F" require all members to match that gender.

## Eligible Athletes

An athlete is eligible for a relay team if:

1. **Club**: athlete belongs to the same club as the team
2. **Registered**: athlete has at least one individual entry (exists in `swimresult` table for this meet)
3. **Gender**: for M/F events, athlete's gender must match; for X events, depends on remaining slots (2M+2F balance)
4. **Uniqueness**: athlete cannot be on another team for the same event (cross-team uniqueness)
5. **Intra-team**: athlete cannot appear twice on the same team

## Data Source for Athlete Age Group

Each athlete's age group for relay composition is read from their individual registrations:
- Query: `SELECT DISTINCT ag.agemin, ag.agemax FROM swimresult sr JOIN agegroup ag ON sr.agegroupid = ag.agegroupid WHERE sr.athleteid = ?`
- The athlete's primary age group is derived from their individual event registrations (the category chosen by the coach)
- An athlete may be registered in different age groups for different events (e.g., 19+ for pool events, 55-59 for masters); for relay composition, use the **non-masters** registration category (15-18, 19+, etc.)

## Dropdown Filtering Rules

When populating the member selection dropdown for a position:

1. Exclude athletes already assigned to another position on the same team
2. Exclude athletes already assigned to another team for the same event
3. For mixed events: enforce the 2M/2F balance (if 2 men are already assigned, only show women)
4. Show a warning indicator if selecting an athlete would create a 2-2 age group split

## Team Numbering

- Teams are lettered A, B, C... (up to 26 per event per club)
- Team letters are stable — deleting team B does not rename C to B

## Default Team Name

When no custom name is set and members are assigned:
- Display concatenated last names separated by "/" (e.g., "Tremblay/Gagnon/Roy/Boucher")
- When no members are assigned, show the team letter (A, B, C...)
