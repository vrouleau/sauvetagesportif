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