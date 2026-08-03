# TODO: Database Abstraction Layer Refactor

**Priority:** Unblocked — DSQ catalog merged in `3615e65` (this file's own origin commit); ~10+ commits since.
**Problem:** The `DbBackend` interface is incomplete — SQLite-specific syntax leaks through in multiple places. Behaviorally this has since been patched at each call site with inline backend sniffing rather than through the interface, so runtime correctness is no longer at risk, but the leaky-abstraction debt itself is unchanged.

**Status as of 2026-08-03 audit:**

| Location | Issue | Status |
|----------|-------|--------|
| `smb.ts` restoreSMB | `INSERT OR IGNORE` vs `ON CONFLICT DO NOTHING` | **Fixed, ad-hoc** — `isPg` ternary at call site (`smb.ts:1047-1050`), not a `DbBackend` method. Verified against real Splash+Postgres. |
| `smb.ts` restoreSMB | `PRAGMA foreign_keys` vs `SET session_replication_role` | **Fixed, ad-hoc** — `typeof db.pragma === 'function'` branch (`smb.ts:1010, 1107`), the exact sniffing hack this doc calls out below as unresolved. |
| `lenex.ts` importLenex / `index.ts` seedDsqCodes | `INSERT OR REPLACE INTO bsglobal` | **Fixed, cleanly** — both now use portable `ON CONFLICT (...) DO UPDATE` (SQLite 3.24+/PG both support it), no branching needed. See `index.ts:146-154`. |
| `smb.ts` date columns | OLE sentinel values need filtering for PG's stricter TIMESTAMP | **Fixed, ad-hoc** — inline sentinel-range filter in `restoreSMB` (`smb.ts:1054-1076`), not a `DbBackend`-level concern. |
| Various | `typeof db.pragma === 'function'` / `isPg` sniffing | **Still unresolved** — this is the actual remaining ask. `dbBackend.ts`'s `DbBackend` interface still has no dialect helpers (unchanged since this doc was written); `smb.ts` duck-types its `db: Database.Database` parameter and sniffs for a `pragma` method at runtime to tell backends apart. |

**Also still missing:** the Testing Strategy's ask to run SMB restore against PG in CI. `schema.test.ts`, `heat-generation.test.ts`, and `combined-events.test.ts` already run `describe.each(['sqlite','pg'])`; `smb.test.ts` does not — it only exercises `restoreSMB` against SQLite. Coverage against real PG has so far come from manual sessions (see `packages/meet-app/CLAUDE.md`'s PG-backend testing notes), not an automated suite.

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

## Testing Strategy

When implementing this refactor, add a PG integration test to CI:
1. Spin up a PostgreSQL container in the CI workflow
2. Run SMB restore against PG (verifies INSERT syntax, date handling, FK disable)
3. Run LXF import against PG (verifies entries import, event structure preservation)
4. Verify getDsqItems works on both backends (with and without name_en column)
5. Verify all queries in getHeatListSessions/getAthletes/saveResult work on PG

This catches dialect issues at CI time rather than at user-testing time.
