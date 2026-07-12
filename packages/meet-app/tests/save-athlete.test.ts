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

import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers'
import { saveAthlete } from '../src/main/db'

describe('saveAthlete', () => {
  it('creates a new athlete row when id is 0 (Add Athlete flow)', async () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)

      const before = db.prepare(`SELECT COUNT(*) AS c FROM athlete`).get() as { c: number }
      expect(before.c).toBe(0)

      const result = await saveAthlete({
        id: 0,
        lastName: 'Doe',
        firstName: 'Jane',
        birthDate: '2010-01-01',
        gender: 'F',
        nation: 'CAN',
        clubCode: 'TST',
        clubName: 'Test Club',
      }, db)

      expect(result.id).toBeGreaterThan(0)
      const row = db.prepare(`SELECT * FROM athlete WHERE athleteid = ?`).get(result.id) as {
        firstname: string; lastname: string; clubid: number
      }
      expect(row.firstname).toBe('Jane')
      expect(row.lastname).toBe('Doe')
      expect(row.clubid).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('still updates an existing athlete when id is non-zero', async () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
      db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Old', 'Name', 1, '2000-01-01')`)

      const result = await saveAthlete({
        id: 1,
        lastName: 'New',
        firstName: 'Name',
        birthDate: '2000-01-01',
        gender: 'M',
        nation: 'CAN',
        clubCode: 'TST',
        clubName: 'Test Club',
      }, db)

      expect(result.id).toBe(1)
      const count = db.prepare(`SELECT COUNT(*) AS c FROM athlete`).get() as { c: number }
      expect(count.c).toBe(1) // no extra row created
      const row = db.prepare(`SELECT firstname FROM athlete WHERE athleteid = 1`).get() as { firstname: string }
      expect(row.firstname).toBe('Name')
    } finally {
      cleanup()
    }
  })
})
