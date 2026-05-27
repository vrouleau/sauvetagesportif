import Database from 'better-sqlite3'
import type { DbBackend, PreparedStatement } from './dbBackend'

export class SqliteBackend implements DbBackend {
  readonly type = 'sqlite' as const
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql)
    return {
      get(...params: any[]) { return stmt.get(...params) },
      all(...params: any[]) { return stmt.all(...params) },
      run(...params: any[]) { return stmt.run(...params) },
    }
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /**
   * Match better-sqlite3's transaction API:
   * Returns a wrapped function that executes fn inside BEGIN/COMMIT.
   * The returned function passes its arguments to fn.
   */
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.db.transaction(fn) as (...args: any[]) => T
  }

  close(): void {
    this.db.close()
  }

  /** Expose raw better-sqlite3 instance for SMB/LENEX operations that need it */
  get raw(): Database.Database {
    return this.db
  }
}
