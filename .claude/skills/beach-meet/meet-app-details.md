# meet-app beach numbers (original notes)

## Beach Numbers

Athletes in beach meets get a unique jersey/bib identifier stored in `athlete.nameprefix`.

### Format: `Letter + 3 chars` (e.g., `C201`; `CA01` for Masters)
- **Letter (A-Z):** Club letter (from club code chars, fallback first unused A-Z)
- **Category char:** **Fixed global code** per (age bracket, sex) — same code for every club, not
  assigned dynamically. Brackets follow `AGE_CODE_ORDER` (`shared-ui/src/logic/ageGroupCode.ts`):
  10-, 11-12, 13-14, 15-18, Open, Masters, each with an F slot then an M slot:
  `10-F=0 10-M=1 11-12F=2 11-12M=3 13-14F=4 13-14M=5 15-18F=6 15-18M=7 OpenF=8 OpenM=9 MastersF=A MastersM=B`.
  Bracket comes from the athlete's age group (`agemin`/`agemax`/`name` via `ageGroupCodeFor`); sex
  comes from the athlete's own `athlete.gender` (not the age group's — a relay's age group can be
  mixed/X, but each teammate keeps their own individual-sex category).
- **Last 2 chars (01-99):** Alphabetical sequence within category

### Source: `src/main/beachNumber.ts`
| Function | Purpose |
|----------|---------|
| `generateBeachNumbers(db)` | Full idempotent regen — clears all, recomputes from scratch |
| `assignLateBeachNumber(db, athleteId)` | Late arrival — assigns next available in club/category |

### Triggers
- **LXF import** (`importLenex`): calls `generateBeachNumbers` when `MEET_TYPE='BEACH'`
- **Late entry** (`registerForEvent`): calls `assignLateBeachNumber` for the new athlete
- **Heat generation** (`generateHeats`): calls `assignLateBeachNumber` for any athletes with entries but no beach number

### Constraints & properties
- Max 26 clubs, 12 fixed categories (6 age brackets × 2 sexes), 99 athletes per category per club
- Deterministic, unique, idempotent, stable (late arrivals don't shift existing)
- Club letter assignment: tries each char of `club.code`, fallback first available A-Z
- An athlete with no resolvable sex (`athlete.gender` not 1 or 2) gets no beach number and is
  reported in `BeachNumberResult.errors` — every real athlete has a gender from LXF import, so
  this should only happen with malformed data

### Display
- HeatsPage: shown next to athlete name
- "Identifiants plage" PDF report

### Tests: `tests/beach-number.test.ts`
- Property-based tests (fast-check): uniqueness, determinism, format validity
- Unit tests: sequence numbering, late arrival, capacity errors
