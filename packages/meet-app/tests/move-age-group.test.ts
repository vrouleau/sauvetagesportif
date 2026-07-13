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

import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './helpers'
import { moveAgeGroup } from '../src/main/db'

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-move-age-group')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

/** One event hosting 15-18 and 19+ brackets, plus an empty sibling event of the same style. */
function seedSplitEvent(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (2, 1, 1, 2, 2, 2, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '15-18F', 15, 18, 2, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 1, '19+F', 19, -1, 2, 2)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Junior', 'Athlete', 2, '2010-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Senior', 'Athlete', 2, '2000-01-01')`)

  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime) VALUES (1, 1, 1, 10, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, heatid, lane) VALUES (2, 2, 1, 20, 32000, 100, 3)`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, agegroupid, heatnumber, racestatus) VALUES (100, 1, 20, 1, 4)`)
}

describe('moveAgeGroup', () => {
  it('moves the age group and its entries to the target event, unseeding heats', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSplitEvent(db)

      moveAgeGroup(20, 2, db)

      const ag = db.prepare('SELECT swimeventid FROM agegroup WHERE agegroupid=?').get(20) as { swimeventid: number }
      expect(ag.swimeventid).toBe(2)

      const result = db.prepare('SELECT swimeventid, heatid, lane FROM swimresult WHERE swimresultid=2').get() as
        { swimeventid: number; heatid: number | null; lane: number | null }
      expect(result.swimeventid).toBe(2)
      expect(result.heatid).toBeNull()
      expect(result.lane).toBeNull()

      // The other age group's entry stays untouched
      const untouched = db.prepare('SELECT swimeventid FROM swimresult WHERE swimresultid=1').get() as { swimeventid: number }
      expect(untouched.swimeventid).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('rejects moving to an event of a different swim style', async () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSplitEvent(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (2, 200, 'Backstroke', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (3, 1, 2, 3, 2, 3, 'F')`)

      await expect(moveAgeGroup(20, 3, db)).rejects.toThrow(/same swim style/i)
    } finally {
      cleanup()
    }
  })

  it('rejects moving when heats are already validated', async () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSplitEvent(db)
      db.exec(`UPDATE heat SET racestatus = 5 WHERE heatid = 100`)

      await expect(moveAgeGroup(20, 2, db)).rejects.toThrow(/validated/i)

      const ag = db.prepare('SELECT swimeventid FROM agegroup WHERE agegroupid=?').get(20) as { swimeventid: number }
      expect(ag.swimeventid).toBe(1) // unchanged
    } finally {
      cleanup()
    }
  })
})
