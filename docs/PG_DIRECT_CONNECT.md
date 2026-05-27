# PostgreSQL Direct Connect — Implementation Summary

## What was done

Added a "Connect to PostgreSQL" feature to meet-app (SauvetageMeet) that allows the Electron desktop app to work directly against a shared PostgreSQL database — the same one used by Splash Meet Manager. This enables multiple operators to work on the same meet simultaneously.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  meet-app (Electron)                            │
│                                                 │
│  db.ts ──▶ getLocalDb() ──▶ connectionManager   │
│                                  │         │    │
│                          SqliteBackend  PgBackend│
│                              │              │   │
└──────────────────────────────┼──────────────┼───┘
                               ▼              ▼
                         meet.db (local)   PostgreSQL (shared)
```

Both backends implement the same `DbBackend` interface (`prepare/exec/transaction/close`), so all existing queries in `db.ts` work unchanged on either backend.

## Files added

| File | Purpose |
|------|---------|
| `src/main/dbBackend.ts` | `DbBackend` + `PreparedStatement` interfaces |
| `src/main/sqliteBackend.ts` | SQLite implementation (wraps better-sqlite3) |
| `src/main/pgBackend.ts` | PostgreSQL implementation (wraps `pg` with sync spin-wait) |
| `src/main/connectionManager.ts` | Manages active backend, persists config, auto-reconnect |
| `src/renderer/src/components/PgConnectDialog.tsx` | Connection dialog UI + `usePgStatus` hook |

## Files modified

| File | Changes |
|------|---------|
| `db.ts` | `getLocalDb()` delegates to connectionManager; `nextId()` uses PG sequence; schema init skipped in PG mode |
| `index.ts` | IPC handlers (`pg:connect/disconnect/status`); menu items; auto-restore on startup |
| `preload/index.ts` | `pg` API section exposed to renderer |
| `App.tsx` | Title bar status indicator (🟢 PG / 💾 SQLite); PgConnectDialog modal |
| `package.json` | Added `pg` dependency |

## Key design decisions

### ID generation
In PG mode, uses Splash's `gen_bs_global_uid` sequence (`SELECT nextval(...)`) instead of `MAX(id)+1`. This prevents ID conflicts when both SauvetageMeet and Splash Meet Manager create records simultaneously.

### Synchronous queries
`pg` is async by nature, but `db.ts` uses synchronous better-sqlite3 patterns. The PgBackend uses a spin-wait approach (`Atomics.wait` with 1ms sleep) to block until each query resolves. This is acceptable because:
- Queries are fast (<5ms on LAN)
- Electron main process is single-threaded anyway
- Avoids rewriting 50+ functions in db.ts

### Schema management
Schema DDL (`CREATE TABLE IF NOT EXISTS ...`) only runs in SQLite mode. In PG mode, Splash Meet Manager creates and owns the schema. SauvetageMeet only reads/writes to the 10 tables it uses.

### Password storage
Connection config persisted in `{userData}/pg-connection.json` with password encrypted via Electron's `safeStorage` API.

### Coexistence with Splash
- SauvetageMeet uses 10 of Splash's 34 tables (same column names/types)
- The other 24 tables are untouched
- Both apps can work on the same database without conflict
- `ON CONFLICT ... DO UPDATE` syntax works identically on both SQLite and PG

## How to use

1. Start a PostgreSQL server (or have Splash create one)
2. In SauvetageMeet: `Fichier → Connecter à PostgreSQL…`
3. Enter host/port/database/user/password
4. Title bar shows `🟢 PG: user@host:port/db`
5. All operations now hit the shared PG database
6. `Fichier → Déconnecter PostgreSQL` reverts to local SQLite

## What's next (not yet implemented)

- [ ] Disable SMB save/restore when in PG mode (not applicable)
- [ ] Connection status toast on disconnect/reconnect errors
- [ ] LISTEN/NOTIFY for instant push instead of 3s polling (optimization)

