# @meetmgr/meet-app

Electron desktop app for running lifesaving competitions. Replaces Splash Meet Manager.

## Stack
- Electron + electron-vite
- React 18 + Tailwind (via @meetmgr/shared-ui)
- Local SQLite (better-sqlite3) + remote PG sync
- Swiss Timing Quantum integration

## Data layer
Implements `MeetAPI` from `@meetmgr/shared-ui` by wrapping Electron IPC calls to the main process (which talks to local SQLite).

## Migration from sauvetagemeet
This package will be migrated from the standalone `sauvetagemeet` repo.
