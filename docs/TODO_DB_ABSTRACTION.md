# TODO: Database Abstraction Layer Refactor

**Priority:** After DSQ catalog merge to main
**Problem:** The `DbBackend` interface is incomplete — SQLite-specific syntax leaks through in multiple places, causing runtime errors on PostgreSQL.

## Current Issues

| Location | SQLite syntax | PG equivalent |
|----------|--------------|---------------|
| `smb.ts` restoreSMB | `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `smb.ts` restoreSMB | `PRAGMA foreign_keys = OFF/ON` | `SET session_replication_role = replica/DEFAULT` |
| `lenex.ts` importLenex | `INSERT OR REPLACE INTO bsglobal` | `INSERT ... ON CONFLICT DO UPDATE` |
| `index.ts` seedDsqCodes | `INSERT OR REPLACE INTO bsglobal` | `INSERT ... ON CONFLICT DO UPDATE` |
| `smb.ts` date columns | TEXT (any value accepted) | TIMESTAMP (validates values, rejects OLE sentinels) |
| Various | `typeof db.pragma === 'function'` | Backend type sniffing hack |

## Proposed Solution

Extend `DbBackend` interface with dialect-aware helpers:

```typescript
interface DbBackend {
  // Existing
  prepare(sql: string): PreparedStatement
  exec(sql: string): void
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T
  close(): void
  readonly type: 'sqlite' | 'pg'

  // New: dialect helpers
  disableForeignKeys(): void
  enableForeignKeys(): void
  upsertSql(table: string, cols: string[], conflictCol: string): string
  insertIgnoreSql(table: string, cols: string[]): string
}
```

Or alternatively, a standalone `sqlDialect(db: DbBackend)` helper module.

## Scope

- Audit all `INSERT OR IGNORE`, `INSERT OR REPLACE`, `PRAGMA` usage
- Replace with DbBackend methods or dialect helper
- Remove all `typeof db.pragma` sniffing
- Handle date sentinel values at the DbBackend level (PgBackend normalizes on insert)
- Add integration tests that run SMB restore on both SQLite and PG
