# Implementation Plan: Remove Dual Schema

## Overview

Remove the `Club` and `Athlete` model classes and all dual-write code from the team-app backend. After this refactor, `clubs`/`members` (TeamClub/Member) are the single source of truth for identity, and `swimresult.athleteid` references `members.membersid` directly. The system deploys fresh via `docker compose down -v` — no migration needed.

## Tasks

- [x] 1. Update models and schema
  - [x] 1.1 Remove `Club` and `Athlete` classes from `models.py`, update `SwimResult.athleteid` FK to reference `members.membersid`, replace `athlete` relationship with `member` relationship pointing to `Member`
    - Remove the entire `Club` class definition and its `athletes` relationship
    - Remove the entire `Athlete` class definition and its `club`/`results` relationships
    - Change `SwimResult.athleteid` FK from `ForeignKey("athlete.athleteid")` to `ForeignKey("members.membersid")`
    - Replace `athlete = relationship("Athlete", back_populates="results")` with `member = relationship("Member", back_populates="swim_results")`
    - Keep all other models: `SwimStyle`, `SwimSession`, `SwimEvent`, `AgeGroup`, `SwimResult`, `Heat`, `Split`, `BsGlobal`, `SecretLink`
    - Keep helper constants and functions (`GENDER_M`, `gender_to_str`, etc.)
    - _Requirements: 1.1, 1.3, 2.1, 2.3, 3.1, 8.2, 8.3_

  - [x] 1.2 Add `swim_results` relationship to `Member` in `models_team.py`
    - Add `swim_results = relationship("SwimResult", back_populates="member", foreign_keys="[SwimResult.athleteid]")` to the `Member` class
    - _Requirements: 2.3, 3.1_

- [x] 2. Rewrite seed.py (LXF entries import)
  - [x] 2.1 Remove all `Club`/`Athlete` imports and dual-write code from `seed.py`, write only to `TeamClub` and `Member`
    - Remove `from .models import Club, Athlete, gender_from_str`
    - Import `gender_from_str` from `.models` (it stays there) or move it
    - Replace `db.query(Club)` lookups with `db.query(TeamClub)` (lookup by code or name)
    - Replace `Club(...)` creation with `TeamClub(...)` creation only (no parallel write)
    - Replace `db.query(Athlete)` lookups with `db.query(Member)` (lookup by firstname + lastname + clubsid)
    - Replace `Athlete(...)` creation with `Member(...)` creation only (no parallel write)
    - Map `exception` field to `handicapex` on Member
    - Remove the `db.flush()` + `membersid=ath.athleteid` pattern (Member gets its own auto-increment ID)
    - _Requirements: 4.3, 4.4, 6.1, 6.2_

  - [ ]* 2.2 Write property test for seed import table placement
    - **Property 3: Import Table Placement**
    - **Validates: Requirements 4.3, 4.4, 6.1, 6.2, 6.3**

- [x] 3. Rewrite export.py (registrations LXF export)
  - [x] 3.1 Replace `Club`/`Athlete` imports and usage in `export.py` with `TeamClub`/`Member`
    - Replace `from .models import Club, Athlete, ...` with imports from `.models_team import TeamClub, Member`
    - Change `joinedload(SwimResult.athlete).joinedload(Athlete.club)` to `joinedload(SwimResult.member).joinedload(Member.club)`
    - Update grouping logic: `reg.athlete` → `reg.member`, `ath.club` → `member.club`
    - Update attribute access: `club.clubid` → `club.clubsid`, `ath.athleteid` → `member.membersid`, `ath.exception` → `member.handicapex`
    - Update `get_best_time_date(db, ath.athleteid, ...)` → `get_best_time_date(db, member.membersid, ...)`
    - _Requirements: 2.5, 3.4, 7.1, 7.2_

  - [ ]* 3.2 Write property test for export athlete data correctness
    - **Property 1: Export Athlete Data Matches Members Table**
    - **Validates: Requirements 2.5, 3.4, 7.1, 7.3**

- [x] 4. Rewrite export_entries.py (entries LXF export)
  - [x] 4.1 Replace `Club`/`Athlete` imports and usage in `export_entries.py` with `TeamClub`/`Member`
    - Replace `from .models import Club, Athlete, ...` with imports from `.models_team import TeamClub, Member`
    - Change `db.query(Club).options(joinedload(Club.athletes))` to `db.query(TeamClub).options(joinedload(TeamClub.members))`
    - Update iteration: `club.athletes` → `club.members`
    - Update attribute access: `ath.athleteid` → `member.membersid`, `ath.firstname` → `member.firstname`, `ath.exception` → `member.handicapex`
    - _Requirements: 7.3, 7.4_

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Rewrite API dual-write code in `routers/api.py`
  - [x] 6.1 Remove `Club`/`Athlete` imports from `routers/api.py` and remove all dual-write blocks in club/athlete CRUD endpoints
    - Remove `Club, Athlete` from the `from ..models import (...)` statement
    - In `create_club`: remove any `Club(...)` creation, keep only `TeamClub(...)` write
    - In `delete_club`: remove `db.query(Club)` delete, keep only `TeamClub`/`Member`/`SwimResult`/`SecretLink` deletes
    - In `create_athlete`: remove `Athlete(...)` creation, keep only `Member(...)` write
    - In `delete_athlete`: remove `db.query(Athlete)` delete, keep only `Member` + cascading `SwimResult` delete
    - In `update_athlete`: remove sync to `Athlete`, keep only `Member` update
    - _Requirements: 4.1, 4.2, 1.2, 2.2_

  - [x] 6.2 Remove dual-write in `create_registration` and `delete_registration` — write/delete only `SwimResult`, query `Member` for ownership
    - In `create_registration`: replace `db.query(Athlete).get(...)` ownership check with `db.query(Member).get(...)`
    - Remove any parallel write to `Result` (Team Manager results table) for current-meet registrations
    - In `delete_registration`: replace `Athlete` ownership check with `Member` query
    - Remove any parallel delete from `Result`
    - _Requirements: 3.3, 4.5, 4.6_

  - [x] 6.3 Remove dual-write in `upload_meet_smb` — write clubs only to `TeamClub`, athletes only to `Member`, remove `Club`/`Athlete` table wipes and inserts
    - Remove `db.query(Athlete).delete()` and `db.query(Club).delete()` from the wipe section
    - Remove `db.add(Club(...))` in the club import loop — keep only `db.add(TeamClub(...))`
    - Remove `db.add(Athlete(...))` in the athlete import loop — keep only `db.add(Member(...))`
    - `SwimResult` rows keep their `athleteid` values from the SMB (matching `members.membersid`)
    - _Requirements: 4.4, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 6.4 Write property test for referential integrity after SMB import
    - **Property 2: Referential Integrity After Import**
    - **Validates: Requirements 3.2, 6.4**

- [x] 7. Rewrite invoices.py
  - [x] 7.1 Replace `Club`/`Athlete` imports and usage in `invoices.py` with `TeamClub`/`Member`
    - Replace `from .models import Athlete, Club, ...` with `from .models_team import TeamClub, Member`
    - In `_club_line_items`: change join from `Athlete` to `Member`, use `Member.membersid` and `Member.clubsid`
    - In `create_invoice_for_club`: change `db.query(Club)` to `db.query(TeamClub)`, `Club.athletes` to `TeamClub.members`
    - In `create_invoices_for_all_clubs`: change `db.query(Club)` to `db.query(TeamClub)`
    - In `generate_invoice_pdf`: change `db.query(Club)` to `db.query(TeamClub)`
    - In `_find_or_create_customer`: update `club.clubid` to `club.clubsid`
    - Update athlete count query to use `Member.membersid` and `Member.clubsid`
    - _Requirements: 1.2, 2.2_

- [x] 8. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Verify schema and run integration tests
  - [x] 9.1 Verify that `Base.metadata.tables` does not contain `club` or `athlete` keys, and that `SwimResult` FK points to `members.membersid` — add or update a unit test asserting this
    - Write a test that imports `Base` from `models` and asserts `"club" not in Base.metadata.tables` and `"athlete" not in Base.metadata.tables`
    - Assert `SwimResult.__table__.c.athleteid.foreign_keys` references `members.membersid`
    - _Requirements: 8.1, 8.2, 8.3_

  - [x]* 9.2 Write unit tests for single-write behavior (no dual-write)
    - Test `create_club` writes only to `clubs` table
    - Test `create_athlete` writes only to `members` table
    - Test `create_registration` writes only to `swimresult` table
    - Test `delete_registration` deletes only from `swimresult` table
    - _Requirements: 4.1, 4.2, 4.5, 4.6_

  - [x]* 9.3 Write property test for results import completeness
    - **Property 4: Results Import Completeness**
    - **Validates: Requirements 5.1**

  - [x]* 9.4 Write property test for best times computation
    - **Property 5: Best Times Computation Correctness**
    - **Validates: Requirements 5.2**

- [x] 10. Final checkpoint
  - Ensure all tests pass (`python3 -m pytest tests/ -v`), ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The column name `swimresult.athleteid` is preserved (not renamed to `membersid`) to minimize code churn — only the FK target changes
- `Member.athleteid` and `TeamClub.clubid` property aliases remain for backward compatibility
- No database migration is needed — fresh deploy via `docker compose down -v && up --build`
- Property tests use `hypothesis` library (Python PBT standard)
- Integration tests run via `python3 -m pytest tests/ -v` (Docker stack required)
- `best_times.py` has no direct dependency on `Club`/`Athlete` — it reads `bsglobal` keys only
- `events.py` dual-write (Team Manager + Meet Manager tables) is intentional and correct — not removed

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "6.1", "6.2", "6.3", "7.1"] },
    { "id": 3, "tasks": ["6.4", "9.1"] },
    { "id": 4, "tasks": ["9.2", "9.3", "9.4"] }
  ]
}
```
