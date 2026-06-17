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
 */
import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers'

describe('Schema integrity', () => {
  it('athlete table has all columns used by getAthletes query', () => {
    const { db, cleanup } = createTestDb()
    try {
      // This is the exact query from db.ts getAthletes()
      const stmt = db.prepare(`
        SELECT a.athleteid, a.firstname, a.lastname, a.birthdate, a.gender, a.nation, a.license, a.domicile,
               a.handicapex, c.code AS clubcode, c.name AS clubname
        FROM athlete a
        LEFT JOIN club c ON a.clubid = c.clubid
        ORDER BY a.lastname, a.firstname
      `)
      const rows = stmt.all()
      expect(rows).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('athlete table has all columns used by saveAthlete query', () => {
    const { db, cleanup } = createTestDb()
    try {
      // Insert a club first
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
    } finally {
      cleanup()
    }
  })

  it('swimresult table has dsqitemid column', () => {
    const { db, cleanup } = createTestDb()
    try {
      const cols = db.prepare(`PRAGMA table_info(swimresult)`).all() as Array<{ name: string }>
      const colNames = cols.map(c => c.name)
      expect(colNames).toContain('dsqitemid')
      expect(colNames).toContain('dsqofficialid')
      expect(colNames).toContain('noadvance')
    } finally {
      cleanup()
    }
  })

  it('dsqitem table exists and has correct columns', () => {
    const { db, cleanup } = createTestDb()
    try {
      const cols = db.prepare(`PRAGMA table_info(dsqitem)`).all() as Array<{ name: string }>
      const colNames = cols.map(c => c.name)
      expect(colNames).toContain('dsqitemid')
      expect(colNames).toContain('code')
      expect(colNames).toContain('name')
      expect(colNames).toContain('name_en')
      expect(colNames).toContain('sortcode')
    } finally {
      cleanup()
    }
  })

  it('bsglobal table can store and retrieve values', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES (?, ?)`).run('TEST_KEY', 'test_value')
      const row = db.prepare(`SELECT data FROM bsglobal WHERE name = ?`).get('TEST_KEY') as { data: string }
      expect(row.data).toBe('test_value')
    } finally {
      cleanup()
    }
  })

  it('getMeetValues query works on fresh schema', () => {
    const { db, cleanup } = createTestDb()
    try {
      const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string } | undefined
      expect(row).toBeUndefined() // No MEETVALUES yet, but query doesn't crash
    } finally {
      cleanup()
    }
  })

  it('heat list query works on fresh schema', () => {
    const { db, cleanup } = createTestDb()
    try {
      const rows = db.prepare(`
        SELECT s.swimsessionid, s.sessionnumber, s.name, s.daytime, s.lanemin, s.lanemax
        FROM swimsession s
        ORDER BY s.sessionnumber
      `).all()
      expect(rows).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('all tables from schema exist', () => {
    const { db, cleanup } = createTestDb()
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)
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
    } finally {
      cleanup()
    }
  })
})