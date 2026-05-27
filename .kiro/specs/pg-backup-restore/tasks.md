# Implementation Plan: PostgreSQL Backup & Restore

## Tasks

- [ ] 1. Backend: backup/restore endpoints
  - [ ] 1.1 Add `GET /api/admin/backup-db` endpoint — runs pg_dump, returns SQL as download
  - [ ] 1.2 Add `POST /api/admin/restore-db` endpoint — accepts .sql upload, runs psql restore
  - [ ] 1.3 Add `GET /api/admin/backup-config` endpoint — returns interval_days and max_count from bsglobal
  - [ ] 1.4 Add `PUT /api/admin/backup-config` endpoint — updates interval_days and max_count in bsglobal
  - [ ] 1.5 Add `GET /api/admin/backups` endpoint — lists files in /app/data/backups/ with name, size, date
  - [ ] 1.6 Add `GET /api/admin/backups/{filename}` endpoint — downloads a specific backup file
  - [ ] 1.7 Add `DELETE /api/admin/backups/{filename}` endpoint — deletes a specific backup file

- [ ] 2. Backend: auto-backup scheduler
  - [ ] 2.1 Add background asyncio task that runs pg_dump on schedule and enforces retention
  - [ ] 2.2 Start the task on app startup, read config from bsglobal

- [ ] 3. Frontend: admin page backup section
  - [ ] 3.1 Add "Database Backup" section to Admin.jsx with download button and restore file input
  - [ ] 3.2 Add auto-backup config inputs (interval days, max count) with save button
  - [ ] 3.3 Add backup list table with download and delete buttons per row
  - [ ] 3.4 Add confirmation dialog for restore (warns about data overwrite)

- [ ] 4. Checkpoint — rebuild Docker, test manually

## Notes

- Existing `GET /api/admin/backup-db` and `POST /api/admin/restore-db` endpoints already exist in the codebase — extend/reuse them
- The Docker container already has `postgresql-client` installed (pg_dump + psql available)
- Storage volume: `appdata` mounted at `/app/data` — backups go in `/app/data/backups/`
- No database migration needed
