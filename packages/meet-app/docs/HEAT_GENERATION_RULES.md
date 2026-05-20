# Heat Generation Rules

This document describes the heat seeding algorithms implemented in `src/main/db.ts` (`generateHeats()`), the configuration parameters that control them, and the competitive swimming regulations they are based on.

---

## Sources

- **World Aquatics (formerly FINA) Swimming Rules** — SW 3.1 "Seeding of Heats", SW 3.2 "Finals"
  - https://www.worldaquatics.com/rules/swimming
  - Specific rules: SW 3.1.1 (formation of heats), SW 3.1.2 (lane assignment), SW 3.1.4 (minimum per heat)
- **Swimming Canada Officials Manual** — Heat seeding procedures
- **Splash Meet Manager documentation** — Field definitions for `finalseedtype`, `fastheatcount`, `seedbonuslast`, `lanesbyplace`, etc.
- **LENEX data format specification** — `<AGEGROUP finalseedtype="...">` attribute definition

---

## Seeding Methods

### 1. Circle Seeding (default — prelims)

**Config:** `SEEDMETHOD=0` or `agegroup.finalseedtype=0`

Used for preliminary heats. The goal is to distribute swimmers of similar speed across all heats so each heat is roughly equal in competitiveness.

**Algorithm:**
1. Sort all entries by seed time (fastest first). NTs go last.
2. Distribute in round-robin: swimmer 1 → heat 1, swimmer 2 → heat 2, swimmer 3 → heat 3, then wrap.
3. Within each heat, assign lanes center-out by time (fastest gets center lane).

**Example (24 swimmers, 8 lanes, 3 heats):**
- Swimmer 1 → Heat 1, Swimmer 2 → Heat 2, Swimmer 3 → Heat 3
- Swimmer 4 → Heat 1, Swimmer 5 → Heat 2, Swimmer 6 → Heat 3
- ...continues wrapping

**Reference:** FINA SW 3.1.1 — "When there are two or more heats, the fastest swimmer shall be placed in heat 2, the next fastest in heat 1, the next fastest in heat 2..."

### 2. Pyramid Seeding (timed finals / direct finals)

**Config:** `SEEDMETHOD=1` or `agegroup.finalseedtype=1`

Used for timed finals or direct finals where the last heat should contain the fastest swimmers (for spectator interest).

**Algorithm:**
1. Sort all entries by seed time (fastest first). NTs go last.
2. Fill heats from the **last heat backward** to the first.
3. The fastest N swimmers (N = lane count) go into the last heat.
4. Next N fastest go into the second-to-last heat.
5. Continue until all swimmers are assigned.
6. Within each heat, assign lanes center-out.

**Example (24 swimmers, 8 lanes, 3 heats):**
- Heat 3 (last): swimmers ranked 1–8
- Heat 2: swimmers ranked 9–16
- Heat 1 (first): swimmers ranked 17–24

**Reference:** Common practice in timed finals events. Also called "spearhead" or "snake" seeding.

### 3. Straight Seeding

**Config:** `SEEDMETHOD=2` or `agegroup.finalseedtype=2`

Fastest swimmers in heat 1, fill sequentially. Rarely used in competition but available for special cases.

**Algorithm:**
1. Sort entries by seed time.
2. Fill heat 1 first (fastest N swimmers), then heat 2, etc.

---

## FINA "Last N Heats" Rule

**Config:** `FASTHEATCOUNT` (meet-level) or `agegroup.fastheatcount` (per age group)

When set to a value > 0 (typically 3), only the last N heats are circle-seeded. Earlier heats are filled sequentially with the slowest swimmers.

**Algorithm (e.g., fastheatcount=3, 5 heats total):**
1. Calculate fast slots: 3 × laneCount = 24 swimmers for the last 3 heats.
2. The fastest 24 swimmers are circle-seeded across heats 3, 4, 5.
3. Remaining swimmers fill heats 1 and 2 sequentially (slowest in heat 1).

**Reference:** FINA SW 3.1.1 — "If there are more than three heats, the fastest three heats shall be circle seeded. The remaining heats shall be seeded fastest to slowest."

---

## Lane Assignment (Center-Out)

**Config:** `swimsession.lanesbyplace` (custom) or default center-out

Within each heat, swimmers are assigned lanes based on their seed time using a center-out pattern. The fastest swimmer gets the center lane, then alternates right and left outward.

**Standard patterns:**

| Pool | Lane Order |
|------|-----------|
| 6 lanes (1–6) | 3, 4, 2, 5, 1, 6 |
| 8 lanes (1–8) | 4, 5, 3, 6, 2, 7, 1, 8 |
| 10 lanes (0–9) | 4, 5, 3, 6, 2, 7, 1, 8, 0, 9 |

**Custom override:** The `lanesbyplace` field on `swimsession` accepts a comma-separated list of lane numbers (e.g., `"4,5,3,6,2,7,1,8"`). Position in the list = rank.

**Reference:** FINA SW 3.1.2 — "The swimmer with the fastest time shall be placed in the centre lane... the next fastest to the left, then alternating right and left."

---

## Qualification Period

**Config:** `QUALIFROM`, `QUALITO`, `QUALICOURSE` (in MEETVALUES)

Defines a date range during which entry times must have been achieved to be accepted as valid seed times.

**Behavior:**
- Entries with `qtdate` (qualification time date) outside the period → entry time treated as NT for seeding
- `QUALICOURSE=0`: accept times from any course (LCM, SCM, SCY)
- `QUALICOURSE=1`: only accept times achieved in the same course as the meet

**Relevant DB fields on `swimresult`:**
- `qtdate` — date the qualifying time was achieved
- `entrycourse` — course type of the qualifying time

**Use case:** Championship meets requiring times from a specific season (e.g., "times must be from Jan 1, 2025 to Dec 31, 2025").

---

## Entry Priority Ordering

**Config:** `SEEDBONUSLAST`, `SEEDEXHLAST`, `SEEDLATELAST` (meet-level or event-level)

When enabled, certain entry types are seeded after regular entries, placing them in slower heats and outer lanes.

**Priority order (lowest number = seeded first):**

| Priority | Entry Type | Condition |
|----------|-----------|-----------|
| 1 | Regular entries with valid times | Default |
| 2 | Late entries | `seedlateentrylast='T'` and `swimresult.lateentry='T'` |
| 3 | Bonus entries | `seedbonuslast='T'` and `swimresult.bonusentry='T'` |
| 4 | Exhibition entries | `seedexhlast='T'` and `swimresult.infocode` contains 'EXH' |
| 5 | No-time entries (NT) | Always last |

Within each priority group, entries are sorted by seed time (fastest first).

**Definitions:**
- **Bonus entries:** Additional entries beyond a swimmer's primary events (e.g., allowed a 4th swim at a championship)
- **Exhibition entries:** Swims that don't count for official results (visiting swimmers, over-age, etc.)
- **Late entries:** Entries submitted after the registration deadline

---

## Combine Age Groups

**Config:** `COMBINEAGEGROUPS` (meet-level or `swimevent.combineagegroups`)

When enabled, swimmers from different age groups within the same event swim together in the same heats. Results are still scored separately by age group.

**Use case:** Small meets where separating age groups would create many half-empty heats.

---

## Minimum Swimmers Per Heat

**Config:** `MINPERHEAT` (meet-level, default: 3)

Enforces that no heat has fewer than the specified number of swimmers (except when total entries are very small).

**Algorithm:**
- After initial heat distribution, if a heat has fewer than `MINPERHEAT` swimmers and the next heat has more than `MINPERHEAT`, swimmers are moved from the next heat to balance.

**Reference:** FINA SW 3.1.4 — "Where the number of entries does not evenly divide into heats, the first heat(s) shall have fewer swimmers. No heat shall have fewer than three swimmers."

---

## Configuration Hierarchy

Parameters can be set at multiple levels. The effective value is determined by:

1. **Age group level** (`agegroup.finalseedtype`, `agegroup.fastheatcount`) — highest priority
2. **Event level** (`swimevent.seedbonuslast`, `swimevent.combineagegroups`, etc.)
3. **Meet level** (`MEETVALUES` in `bsglobal`: `SEEDMETHOD`, `FASTHEATCOUNT`, etc.) — fallback

---

## Database Fields Reference

### Meet-level config (stored in `bsglobal` as MEETVALUES)

| Key | Type | Description |
|-----|------|-------------|
| `SEEDMETHOD` | I | 0=circle, 1=pyramid, 2=straight |
| `FASTHEATCOUNT` | I | Number of heats to circle-seed (FINA rule) |
| `SEEDBONUSLAST` | B | Seed bonus entries last (T/F) |
| `SEEDEXHLAST` | B | Seed exhibition entries last (T/F) |
| `SEEDLATELAST` | B | Seed late entries last (T/F) |
| `COMBINEAGEGROUPS` | B | Combine age groups in heats (T/F) |
| `MINPERHEAT` | I | Minimum swimmers per heat |
| `QUALIFROM` | S | Qualification period start date (YYYY-MM-DD) |
| `QUALITO` | S | Qualification period end date (YYYY-MM-DD) |
| `QUALICOURSE` | I | 0=all courses, 1=same course only |
| `LANESORDER` | I | 0=default center-out, 1=custom |

### Session-level (`swimsession`)

| Field | Description |
|-------|-------------|
| `lanemin` | First lane number |
| `lanemax` | Last lane number |
| `lanesbyplace` | Custom lane order (comma-separated) |
| `course` | Pool course (1=LCM, 2=SCY, 3=SCM) |

### Event-level (`swimevent`)

| Field | Description |
|-------|-------------|
| `seedbonuslast` | Override: seed bonus entries last |
| `seedexhlast` | Override: seed exhibition entries last |
| `seedlateentrylast` | Override: seed late entries last |
| `combineagegroups` | Override: combine age groups |

### Age group-level (`agegroup`)

| Field | Description |
|-------|-------------|
| `finalseedtype` | Seeding algorithm (0=circle, 1=pyramid, 2=straight) |
| `fastheatcount` | Fast heat count override |
| `heatcount` | Minimum number of heats |

### Entry-level (`swimresult`)

| Field | Description |
|-------|-------------|
| `entrytime` | Seed time in milliseconds (NULL = NT) |
| `bonusentry` | 'T' if bonus entry |
| `lateentry` | 'T' if late entry |
| `infocode` | Contains 'EXH' for exhibition |
| `qtdate` | Date qualifying time was achieved |
| `entrycourse` | Course of qualifying time |
