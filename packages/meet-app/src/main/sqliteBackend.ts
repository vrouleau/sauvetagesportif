// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

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