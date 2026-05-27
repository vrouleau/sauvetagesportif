/**
 * DbBackend — Abstraction over SQLite (better-sqlite3) and PostgreSQL (pg).
 *
 * All db.ts queries go through this interface so the app can switch between
 * a local SQLite file and a shared PostgreSQL server at runtime.
 */

export interface PreparedStatement {
  get(...params: any[]): any
  all(...params: any[]): any[]
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
}

export interface DbBackend {
  /** Prepare a SQL statement (uses ? placeholders regardless of backend) */
  prepare(sql: string): PreparedStatement

  /** Execute raw SQL (DDL, multi-statement) */
  exec(sql: string): void

  /**
   * Wrap a function in a transaction (matches better-sqlite3 API).
   * Returns a new function that, when called, executes fn inside BEGIN/COMMIT.
   */
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T

  /** Close the connection */
  close(): void

  /** Backend type identifier */
  readonly type: 'sqlite' | 'pg'
}
