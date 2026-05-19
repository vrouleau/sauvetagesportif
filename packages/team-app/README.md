# @meetmgr/team-app

Web app for team registration, athlete entries, and invoices.

## Stack
- FastAPI backend (Python)
- React 18 + Tailwind frontend (via @meetmgr/shared-ui)
- PostgreSQL (Docker)

## Data layer
Implements `MeetAPI` from `@meetmgr/shared-ui` by wrapping HTTP fetch calls to the FastAPI backend.

## Migration from sauvetageteam
This package will be migrated from the standalone `sauvetageteam` repo.
