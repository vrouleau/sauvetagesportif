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
 * A shared Postgres database is created by whoever connects to it first — real Splash or
 * meet-app. When meet-app is first, it creates exactly the database Splash would have
 * (config/splash-pg-schema.sql + splash-pg-seed.sql, captured with pg_dump from a database
 * Splash created): the same 35 tables, types, defaults, keys, indexes, sequences and seed rows.
 * So two meet-app stations can share one without Splash, and Splash can open it later.
 *
 * meet-app's own SCHEMA_DDL (schema.ts) is only for its local SQLite file.
 */
import type { DbBackend } from './dbBackend'

export type SplashSchemaResult = 'created' | 'existing'

function tablesOf(db: DbBackend): string[] {
  const rows = db.prepare(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  ).all() as Array<{ name: string }>
  return rows.map(r => String(r.name).toLowerCase())
}

/**
 * Make sure the connected Postgres database has Splash's schema.
 * - no tables → create Splash's schema and seed rows (one script, one transaction)
 * - has bsglobal → a Splash/meet-app database already: left as it is
 * - only an empty `dsqitem` → left over by older meet-app versions on an empty database: replaced
 * - anything else → refused, nothing is touched
 */
export function ensureSplashSchema(db: DbBackend, schemaSql: string, seedSql: string): SplashSchemaResult {
  const tables = tablesOf(db)
  if (tables.includes('bsglobal')) return 'existing'

  if (tables.length === 1 && tables[0] === 'dsqitem') {
    const n = db.prepare(`SELECT COUNT(*) AS c FROM dsqitem`).get() as { c: number | string }
    if (Number(n.c) === 0) {
      db.exec(`DROP TABLE dsqitem`)
      tables.length = 0
    }
  }
  if (tables.length > 0) {
    throw new Error(
      `Cette base de données Postgres contient déjà des tables (${tables.slice(0, 5).join(', ')}` +
      `${tables.length > 5 ? '…' : ''}) qui ne sont pas celles de Splash Meet Manager / SauvetageMeet. ` +
      `Utilisez une base de données vide. — This Postgres database already has tables that are not ` +
      `Splash Meet Manager's; use an empty database.`
    )
  }

  // One multi-statement script = one transaction: all of it or nothing. With no tables, a
  // gen_bs_global_uid sequence can only be a leftover (meet-app creates it too) — Splash's
  // schema creates its own.
  db.exec(`BEGIN;\nDROP SEQUENCE IF EXISTS gen_bs_global_uid;\nDROP SEQUENCE IF EXISTS gen_layout;\n${schemaSql}\n${seedSql}\nCOMMIT;`)
  return 'created'
}
