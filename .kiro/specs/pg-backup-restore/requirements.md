# Requirements: PostgreSQL Backup & Restore

## Introduction

Add a backup/restore system to the team-app admin page. Supports manual backup/restore of the full PostgreSQL database, plus an auto-backup scheduler that creates daily backups with configurable retention.

## Requirements

### Requirement 1: Manual Backup

**User Story:** As an admin, I want to download a full PostgreSQL backup from the admin page so I can keep an offline copy of all data.

#### Acceptance Criteria

1. THE admin page SHALL have a "Backup" section with a "Download Backup" button
2. WHEN the button is clicked, THE backend SHALL run `pg_dump` and return the SQL file as a download
3. THE filename SHALL include the date: `backup-YYYY-MM-DD-HHMMSS.sql`

### Requirement 2: Manual Restore

**User Story:** As an admin, I want to upload a backup file to restore the database to a previous state.

#### Acceptance Criteria

1. THE admin page SHALL have a file upload input for `.sql` backup files
2. WHEN a backup is uploaded, THE backend SHALL restore it using `psql` (drop + recreate all tables)
3. THE UI SHALL show a confirmation dialog warning that this will overwrite all current data
4. AFTER restore, THE backend SHALL return a success message with the backup filename

### Requirement 3: Auto-Backup Configuration

**User Story:** As an admin, I want to configure automatic daily backups with a retention policy so I don't lose data if something goes wrong.

#### Acceptance Criteria

1. THE admin page SHALL display auto-backup settings: interval (days) and max backups to keep
2. THE backend SHALL run `pg_dump` on a schedule (default: every 1 day)
3. WHEN the number of backups exceeds the max, THE oldest backup SHALL be deleted
4. THE settings SHALL be stored in `bsglobal` (keys: `backup_interval_days`, `backup_max_count`)
5. THE default settings SHALL be: interval=1 day, max=7 backups

### Requirement 4: Auto-Backup List & Download

**User Story:** As an admin, I want to see all auto-backups and download any of them.

#### Acceptance Criteria

1. THE admin page SHALL display a list of existing auto-backups with filename, date, and size
2. EACH backup SHALL have a download button
3. EACH backup SHALL have a delete button
4. THE backups SHALL be stored in the backend's local storage volume (`/app/data/backups/`)
