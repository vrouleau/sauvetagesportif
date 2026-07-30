# Relay Team Composition Rules

## Overview

Relay teams are composed of members from the same club. The team's age category and gender composition must follow specific rules to be valid for competition.

These rules apply **identically to both pool and beach meets**. Although the ILS defines 3-person relays for some beach events (Board Relay, Ski Relay), Sauvetage Sportif Québec runs all relay events with **4-person teams**. The same validation logic applies regardless of meet type.

### Meet Types and Relay Events

| Meet Type | Example Relay Events | Team Size | Gender Rules |
|-----------|---------------------|-----------|--------------|
| Pool | Manikin Relay 4×25m, Obstacle Relay 4×50m, Medley Relay 4×50m, Pool Lifesaver Relay 4×50m, Rescue Tow Relay 4×50m | 4 | M, F, or X (Pool Lifesaver = 2M+2F) |
| Beach | Relais Sprint Sur Plage 4×90m | 4 | X (Mixed: 2M+2F) |

> **ILS Reference**: Pool Lifesaver Relay (CRB S3-30): "Each team shall consist of two males and two females. Teams are permitted to select their own gender order."  
> The same 2M+2F rule is applied to mixed beach relay events by Sauvetage Sportif Québec.

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

A relay team's age category is **not** calculated from member composition — it's the category of the **event card** the team was created under (e.g. a team created under the "Open" event is an Open team). Each relay event maps to exactly one age category in the meet's structure, so this is unambiguous in the normal case; the UI shows the category once, in the event card header, and no longer repeats it per team.

Members must be from that exact ("native") category, or the single **adjacent-younger** category (swim-up). Swim-up is **one-directional**: a younger athlete may join an older team's relay, but an older athlete can never appear on a younger team's relay — so there's no separate "older" category to allow.

At least **2 members must match the native category exactly** — a team with only 1 (or 0) native member, propped up by swim-up members, is invalid. Beyond that minimum, any split is valid — there is no majority requirement:

- **4-0, 3-1, 2-2** (native/swim-up split): all valid, as long as ≥2 members are native ✓
- **1-3, 0-4** (fewer than 2 native members) → **INVALID** ✗
- **A member from any category other than native or the single adjacent-younger one** (skipping a category, or an older category) → **INVALID** ✗

### Examples (Open event, adjacent-younger = 15-18)

- 4×Open members → **valid**
- 3×Open + 1×15-18 members → **valid**
- 2×Open + 2×15-18 members → **valid**
- 1×Open + 3×15-18 members → **INVALID** — only 1 native (Open) member
- 0×Open + 4×15-18 members → **INVALID** — no native (Open) member
- 2×Open + 2×13-14 members → **INVALID** — 13-14 skips 15-18
- 2×Open + 1×19+ member (an older category, if one existed) → **INVALID** — no swim-down

### Incremental assignment UX

The "at least 2 native members" requirement is only enforced once it would actually become impossible to reach — i.e. when the number of already-assigned native members plus the positions still open (including the one being assigned) drops below 2. In practice this can start blocking swim-up assignments a couple of positions before the last one, not just on the very last position — assigning a swim-up member is only fine while enough empty positions remain that 2 native members could still be added later. The "member must be native or single-adjacent-younger" check, by contrast, is unconditional and applies to every assignment regardless of position.

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
4. Exclude an athlete whose age category is neither the event's native category nor the single adjacent-younger one
5. Exclude an athlete if assigning them would make it impossible to ever reach 2 native-category members (native members so far, plus remaining open positions including this one, would total fewer than 2)

## Team Numbering

- Teams are lettered A, B, C... (up to 26 per event per club)
- Team letters are stable — deleting team B does not rename C to B

## Default Team Name

When no custom name is set and members are assigned:
- Display concatenated last names separated by "/" (e.g., "Tremblay/Gagnon/Roy/Boucher")
- When no members are assigned, show the team letter (A, B, C...)
