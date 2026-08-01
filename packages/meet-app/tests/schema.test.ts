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
 * Schema integrity tests — verify that all query functions work against
 * a freshly created database (catches missing columns in schema DDL).
 *
 * Runs against BOTH backends (SQLite + PostgreSQL) so a column/type that only
 * exists — or only gets read back correctly — on one backend fails loudly
 * here instead of at a meet. The PG half is skipped automatically if no
 * Postgres server is reachable (see packages/meet-app/docker-compose.postgres.yml).
 */
import { describe, it, expect } from 'vitest'
import {
  createTestDb, createPgTestDb, isPgTestAvailable,
  getTableColumns, listTableNames,
  type TestBackendKind,
} from './helpers'
import type { DbBackend } from '../src/main/dbBackend'
import { runColumnBackfills } from '../src/main/schema'

const pgAvailable = await isPgTestAvailable()
const BACKENDS: TestBackendKind[] = pgAvailable ? ['sqlite', 'pg'] : ['sqlite']
if (!pgAvailable) {
  console.warn(
    '[schema.test.ts] Postgres not reachable — skipping PG-backend schema tests. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

describe.each(BACKENDS)('Schema integrity [%s]', (kind) => {
  async function withDb(fn: (db: DbBackend) => void | Promise<void>) {
    if (kind === 'sqlite') {
      const { db, cleanup } = createTestDb()
      try {
        await fn(db as unknown as DbBackend)
      } finally {
        cleanup()
      }
    } else {
      const { db, cleanup } = await createPgTestDb()
      try {
        await fn(db)
      } finally {
        await cleanup()
      }
    }
  }

  it('athlete table has all columns used by getAthletes query', async () => {
    await withDb((db) => {
      const stmt = db.prepare(`
        SELECT a.athleteid, a.firstname, a.lastname, a.birthdate, a.gender, a.nation, a.license, a.domicile,
               a.handicapex, c.code AS clubcode, c.name AS clubname
        FROM athlete a
        LEFT JOIN club c ON a.clubid = c.clubid
        ORDER BY a.lastname, a.firstname
      `)
      const rows = stmt.all()
      expect(rows).toEqual([])
    })
  })

  it('athlete table has all columns used by saveAthlete query', async () => {
    await withDb((db) => {
      db.prepare(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`).run()
      // This is the exact UPDATE from db.ts saveAthlete()
      db.prepare(`
        UPDATE athlete
        SET firstname=?, lastname=?, birthdate=?, gender=?, nation=?,
            license=?, domicile=?, clubid=?, handicapex=?
        WHERE athleteid=?
      `).run('John', 'Doe', '2010-01-01', 1, 'CAN', '', '', 1, '', 999)
      // And the INSERT
      db.prepare(`
        INSERT INTO athlete (athleteid, firstname, lastname, birthdate, gender, nation, license, domicile, clubid, handicapex)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'Jane', 'Doe', '2010-01-01', 2, 'CAN', '', '', 1, '')
      const row = db.prepare(`SELECT * FROM athlete WHERE athleteid = 1`).get() as any
      expect(row.firstname).toBe('Jane')
      expect(row.domicile).toBe('')
    })
  })

  it('swimresult table has dsqitemid column', async () => {
    await withDb((db) => {
      const colNames = getTableColumns(db, kind, 'swimresult')
      expect(colNames).toContain('dsqitemid')
      expect(colNames).toContain('dsqofficialid')
      expect(colNames).toContain('noadvance')
    })
  })

  it('dsqitem table exists and has correct columns', async () => {
    await withDb((db) => {
      const colNames = getTableColumns(db, kind, 'dsqitem')
      expect(colNames).toContain('dsqitemid')
      expect(colNames).toContain('code')
      expect(colNames).toContain('name')
      expect(colNames).toContain('name_en')
      expect(colNames).toContain('sortcode')
    })
  })

  it('bsglobal table can store and retrieve values', async () => {
    await withDb((db) => {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES (?, ?)`).run('TEST_KEY', 'test_value')
      const row = db.prepare(`SELECT data FROM bsglobal WHERE name = ?`).get('TEST_KEY') as { data: string }
      expect(row.data).toBe('test_value')
    })
  })

  it('getMeetValues query works on fresh schema', async () => {
    await withDb((db) => {
      const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string } | undefined
      expect(row).toBeUndefined() // No MEETVALUES yet, but query doesn't crash
    })
  })

  it('heat list query works on fresh schema', async () => {
    await withDb((db) => {
      const rows = db.prepare(`
        SELECT s.swimsessionid, s.sessionnumber, s.name, s.daytime, s.lanemin, s.lanemax
        FROM swimsession s
        ORDER BY s.sessionnumber
      `).all()
      expect(rows).toEqual([])
    })
  })

  it('all tables from schema exist', async () => {
    await withDb((db) => {
      const tableNames = listTableNames(db, kind)
      expect(tableNames).toContain('bsglobal')
      expect(tableNames).toContain('swimstyle')
      expect(tableNames).toContain('club')
      expect(tableNames).toContain('swimsession')
      expect(tableNames).toContain('athlete')
      expect(tableNames).toContain('swimevent')
      expect(tableNames).toContain('agegroup')
      expect(tableNames).toContain('heat')
      expect(tableNames).toContain('swimresult')
      expect(tableNames).toContain('split')
      expect(tableNames).toContain('dsqitem')
    })
  })

  it('backfills agegroup.afinal8lanes onto a database that predates the column', async () => {
    // CREATE TABLE IF NOT EXISTS never adds a column to an already-existing table, so a column
    // added to SCHEMA_DDL after real databases already existed silently never reaches them — bit
    // us twice (dsqitem.name_en, then agegroup.afinal8lanes causing "no such column:
    // afinal8lanes" exporting a .smb from an existing meet-app database). runColumnBackfills()
    // exists specifically to close this gap generically; this simulates the "old" pre-column
    // database directly rather than relying on the current schema already having the column.
    await withDb((db) => {
      db.exec(`DROP TABLE agegroup`)
      db.exec(`CREATE TABLE agegroup (
        agegroupid INTEGER PRIMARY KEY,
        swimeventid INTEGER,
        agemin INTEGER, agemax INTEGER, gender INTEGER
      )`)
      db.prepare(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax, gender) VALUES (1, 1, 10, 12, 1)`).run()

      runColumnBackfills(db)

      const row = db.prepare(`SELECT afinal8lanes FROM agegroup WHERE agegroupid = 1`).get() as { afinal8lanes: string | null }
      expect(row.afinal8lanes).toBe('F')
    })
  })
})
