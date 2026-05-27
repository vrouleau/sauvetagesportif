# Requirements Document

## Introduction

Remove the dual-write architecture from team-app. The codebase currently maintains two parallel sets of tables for clubs and athletes (`club`/`athlete` duplicating `clubs`/`members`) with every mutation writing to both. This was a transitional strategy during phases A-H of the migration. Now that all endpoints use the Team Manager tables for auth and identity, the old duplicates must be removed.

The target architecture has two distinct table groups serving different purposes:

1. **Team Manager tables** (persistent, cross-meet): `clubs`, `members`, `meets`, `sessions`, `events`, `results`, `relays`, `relayspos`, `membersmeets`, `swimstyle` — matches the Splash Team Manager `.mdb` schema. Holds all historical meet data. Best times are computed from `results` across all meets.

2. **Meet Manager tables** (current meet, from SMB import): `swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`, `bsglobal` — holds the active competition structure imported via SMB. Used for registration view, heat display, and LXF export. References `members.membersid` for athlete identity (no separate `athlete` table).

The old `club` and `athlete` tables are removed entirely — `clubs` and `members` are the single source of truth for identity and auth.

## Glossary

- **Team_Tables**: `clubs`, `members`, `meets`, `sessions`, `events`, `results`, `relays`, `relayspos`, `membersmeets` — persistent historical data matching Splash Team MDB
- **Meet_Tables**: `swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`, `bsglobal`, `swimstyle` — current meet competition data from SMB import
- **Old_Duplicates**: `club` and `athlete` tables that duplicate `clubs` and `members` — to be removed
- **Dual_Write**: The current pattern where mutations write to both old and new tables simultaneously — to be eliminated
- **SMB_Import**: Upload of a Splash Meet Backup (`.smb`) that populates Meet_Tables with the current competition structure
- **Best_Times**: Swim times computed from `results` table across all historical meets for a given member + swimstyle

## Requirements

### Requirement 1: Remove Old Club Table

**User Story:** As a developer, I want the `club` table removed and all code that references it updated to use `clubs` (TeamClub), so there is no duplication of club data.

#### Acceptance Criteria

1. THE `club` model class SHALL be removed from `models.py`
2. ALL code that creates, reads, updates, or deletes `club` rows SHALL be removed or rewritten to use `clubs` (TeamClub)
3. THE `swimresult` table FK `athleteid` SHALL reference `members.membersid` (not `athlete.athleteid`)
4. THE SMB import SHALL NOT write to a `club` table — club data from SMB goes into `clubs` only
5. ALL dual-write code that writes to both `club` and `clubs` SHALL be removed

### Requirement 2: Remove Old Athlete Table

**User Story:** As a developer, I want the `athlete` table removed and all code that references it updated to use `members`, so there is no duplication of athlete data.

#### Acceptance Criteria

1. THE `athlete` model class SHALL be removed from `models.py`
2. ALL code that creates, reads, updates, or deletes `athlete` rows SHALL be removed or rewritten to use `members` (Member)
3. THE `swimresult` table SHALL reference `members.membersid` directly (column renamed from `athleteid` to `membersid`, or kept as `athleteid` with FK pointing to `members`)
4. THE SMB import SHALL NOT write to an `athlete` table — athlete data from SMB goes into `members` only
5. THE LXF export SHALL read athlete data from `members` joined with `clubs`
6. ALL dual-write code that writes to both `athlete` and `members` SHALL be removed

### Requirement 3: Meet Manager Tables Reference Members Directly

**User Story:** As a developer, I want the Meet Manager tables (`swimresult`) to reference `members.membersid` for athlete identity, so there is a single source of truth for athletes.

#### Acceptance Criteria

1. THE `swimresult` table SHALL have a foreign key to `members.membersid` for athlete identity
2. WHEN an SMB is imported, THE athlete IDs in `swimresult` rows SHALL correspond to `members.membersid` values
3. THE registration endpoint SHALL create `swimresult` rows referencing `members.membersid`
4. THE LXF export SHALL join `swimresult` with `members` (not `athlete`) to get athlete names, birthdates, and club info

### Requirement 4: Remove All Dual-Write Code

**User Story:** As a developer, I want all dual-write patterns eliminated, so each piece of data is written to exactly one table.

#### Acceptance Criteria

1. THE `create_club` endpoint SHALL write only to `clubs` (not to both `clubs` and `club`)
2. THE `create_athlete` endpoint SHALL write only to `members` (not to both `members` and `athlete`)
3. THE `seed_from_lxf` function SHALL write clubs to `clubs` and athletes to `members` only
4. THE `upload_meet_smb` function SHALL write clubs to `clubs`, athletes to `members`, and meet data to Meet_Tables
5. THE `create_registration` endpoint SHALL write to `swimresult` only (no parallel write to `results` for the current meet registration)
6. THE `delete_registration` endpoint SHALL delete from `swimresult` only (no parallel delete from `results`)

### Requirement 5: Historical Results Import (LXF Results → Team Tables)

**User Story:** As a developer, I want results imported from meet-app (via LXF) to be stored in the Team Manager `results` table as historical data, so best times can be computed across all past meets.

#### Acceptance Criteria

1. WHEN results LXF is imported via the organizer path, THE import SHALL create `results` rows in the Team_Tables with `meetsid`, `membersid`, `stylesid`, `totaltime`, `course`
2. THE best times computation SHALL query `results` across all meets where `meetstate=3` (completed) to find the fastest time per member + swimstyle + course
3. THE registration view SHALL display best times computed from historical `results`

### Requirement 6: SMB Import Writes to Correct Tables

**User Story:** As a developer, I want the SMB import to write club/athlete data to Team_Tables and meet structure to Meet_Tables without any duplication.

#### Acceptance Criteria

1. WHEN an SMB is imported, clubs SHALL be written to `clubs` only (with fresh PINs)
2. WHEN an SMB is imported, athletes SHALL be written to `members` only
3. WHEN an SMB is imported, meet structure (sessions, events, agegroups, heats, results, splits) SHALL be written to Meet_Tables (`swimsession`, `swimevent`, `agegroup`, `swimresult`, `heat`, `split`)
4. WHEN an SMB is imported, `swimresult.athleteid` values SHALL match `members.membersid` values (same IDs from the SMB)
5. THE SMB import SHALL NOT create any rows in `club` or `athlete` tables (they no longer exist)

### Requirement 7: LXF Export Reads from Correct Tables

**User Story:** As a developer, I want the LXF export to read athlete/club identity from Team_Tables and meet structure from Meet_Tables, producing correct output without any old tables.

#### Acceptance Criteria

1. THE registrations LXF export SHALL join `swimresult` with `members` and `clubs` for athlete/club data
2. THE registrations LXF export SHALL read events from `swimevent`, sessions from `swimsession`, age groups from `agegroup`
3. THE entries LXF export SHALL read from `members` and `clubs`
4. THE export SHALL produce identical LENEX XML structure as before the migration

### Requirement 8: Clean Schema on Fresh Deploy

**User Story:** As a developer, I want a fresh `docker compose down -v && up --build` to create the correct schema without any old tables, since there are no live sites to migrate.

#### Acceptance Criteria

1. THE SQLAlchemy `Base.metadata.create_all()` SHALL create only the correct tables (no `club`, no `athlete`)
2. THE `models.py` file SHALL only contain `SwimStyle`, `BsGlobal`, `SecretLink`, and the Meet Manager table models (`SwimSession`, `SwimEvent`, `AgeGroup`, `SwimResult`, `Heat`, `Split`)
3. THE `SwimResult` model SHALL reference `members.membersid` (no dependency on a removed `athlete` table)
