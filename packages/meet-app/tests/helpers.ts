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
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { unlinkSync } from 'fs'
import { Pool } from 'pg'
import { PgBackend, type PgConnectionConfig } from '../src/main/pgBackend'
import { SCHEMA_DDL, runSchemaInit } from '../src/main/schema'
import type { DbBackend } from '../src/main/dbBackend'

/**
 * Create a temporary SQLite database with the meet schema initialized.
 * Returns the db instance and a cleanup function.
 *
 * Schema comes from src/main/schema.ts's SCHEMA_DDL — the SAME DDL the app
 * runs in production for a fresh local SQLite database — so this fixture
 * can never drift out of sync with what the app actually creates.
 */
export function createTestDb(): { db: Database.Database; cleanup: () => void; path: string } {
  const dbPath = join(tmpdir(), `sauvetagemeet-test-${randomBytes(4).toString('hex')}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const ddl of SCHEMA_DDL) db.exec(ddl)

  return {
    db,
    path: dbPath,
    cleanup: () => { db.close(); try { unlinkSync(dbPath) } catch {} },
  }
}

// ── PostgreSQL backend (for backend-parity and concurrency tests) ────────────
//
// A real Postgres server is required — see packages/meet-app/docker-compose.postgres.yml.
// Tests using this should always check isPgTestAvailable() first and skip
// gracefully (via a top-level `await` + conditional describe.each) when the
// container isn't running, so `npm test` still passes on a machine with no
// Docker/Postgres set up.

export type TestBackendKind = 'sqlite' | 'pg'

function getPgTestConnectionConfig(): PgConnectionConfig {
  return {
    host: process.env.TEST_PG_HOST || 'localhost',
    port: Number(process.env.TEST_PG_PORT) || 5432,
    database: process.env.TEST_PG_DATABASE || 'postgres',
    user: process.env.TEST_PG_USER || 'meetmgr',
    password: process.env.TEST_PG_PASSWORD || 'meetmgr',
  }
}

let pgAvailableCache: boolean | null = null

/** Probe the configured Postgres server. Result is cached for the life of the test file. */
export async function isPgTestAvailable(): Promise<boolean> {
  if (pgAvailableCache !== null) return pgAvailableCache
  const cfg = getPgTestConnectionConfig()
  const pool = new Pool({ ...cfg, max: 1, connectionTimeoutMillis: 2000 })
  try {
    const client = await pool.connect()
    await client.query('SELECT 1')
    client.release()
    pgAvailableCache = true
  } catch {
    pgAvailableCache = false
  } finally {
    await pool.end()
  }
  return pgAvailableCache
}

/**
 * Create a throwaway Postgres database (schema from SCHEMA_DDL) and return a
 * real PgBackend connected to it. Each call gets its own database so parallel
 * vitest workers/files never collide.
 */
export async function createPgTestDb(): Promise<{ db: PgBackend; cleanup: () => Promise<void>; databaseName: string }> {
  const cfg = getPgTestConnectionConfig()
  const dbName = `meetapp_test_${randomBytes(6).toString('hex')}`

  const adminPool = new Pool({ ...cfg, max: 1 })
  await adminPool.query(`CREATE DATABASE ${dbName}`)
  await adminPool.end()

  const backend = new PgBackend({ ...cfg, database: dbName })
  runSchemaInit(backend)

  return {
    db: backend,
    databaseName: dbName,
    cleanup: async () => {
      backend.close()
      const dropPool = new Pool({ ...cfg, max: 1 })
      try {
        // WITH (FORCE) disconnects any lingering sessions first (PG 13+) —
        // backend.close() tears down asynchronously so a plain DROP can race it.
        await dropPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      } finally {
        await dropPool.end()
      }
    },
  }
}

/** Open a second independent connection to an already-created test database (simulates a second station). */
export function connectSecondPgStation(databaseName: string): PgBackend {
  const cfg = getPgTestConnectionConfig()
  return new PgBackend({ ...cfg, database: databaseName })
}

/** Tables in child→parent order — safe to DELETE without violating foreign keys. */
const TABLES_DELETE_ORDER = [
  'relaysplit', 'relayposition', 'relay',
  'split', 'swimresult', 'heat', 'agegroup', 'swimevent',
  'athlete', 'swimsession', 'club', 'swimstyle', 'dsqitem', 'bsglobal',
]

/** Clear all rows from every app table, keeping the schema. Works on either backend. */
export function resetTestDb(db: DbBackend): void {
  for (const table of TABLES_DELETE_ORDER) db.exec(`DELETE FROM ${table}`)
}

/** List column names for a table — backend-aware (PRAGMA on SQLite, information_schema on PG). */
export function getTableColumns(db: DbBackend, kind: TestBackendKind, table: string): string[] {
  if (kind === 'sqlite') {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return cols.map(c => c.name)
  }
  const cols = db.prepare(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? ORDER BY column_name`
  ).all(table) as Array<{ name: string }>
  return cols.map(c => c.name)
}

/** List table names present in the database — backend-aware. */
export function listTableNames(db: DbBackend, kind: TestBackendKind): string[] {
  if (kind === 'sqlite') {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
    return rows.map(r => r.name)
  }
  const rows = db.prepare(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  ).all() as Array<{ name: string }>
  return rows.map(r => r.name)
}

/** Seed a basic meet structure into the test DB. Works on either backend. */
export function seedMeet(db: Database.Database | DbBackend) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (2, 200, 'Backstroke', 1, 2)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (2, 2, 'Session 2', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 5, 1, 'F')`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (2, 1, 2, 2, 2, 5, 2, 'F')`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (3, 2, 1, 3, 1, 1, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (1, 1, 'Open', 18, NULL, 1, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (2, 1, 'Junior', 12, 17, 1, 2)`)
  db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'John', 'Doe', 1, '2000-01-15', 'CAN')`)
}