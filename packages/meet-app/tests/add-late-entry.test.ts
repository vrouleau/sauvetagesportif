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
import { addLateEntry } from '../src/main/db'

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-add-late-entry')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

/** One event hosting two age brackets, mirroring how a late entry might land in either. */
function seedSplitEvent(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '15-18F', 15, 18, 2, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 1, '19+F', 19, -1, 2, 2)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  // Junior born 2010 is 15-18 as of any date in this meet's era; Senior born 1995 is 19+.
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Junior', 'Athlete', 2, '2010-06-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Senior', 'Athlete', 2, '1995-06-01')`)

  db.exec(`INSERT INTO heat (heatid, swimeventid, agegroupid, heatnumber, racestatus) VALUES (100, 1, 10, 1, 4)`)
}

describe('addLateEntry', () => {
  it('sets agegroupid by matching the athlete\'s birthdate against the event\'s brackets', async () => {
    // Regression test: addLateEntry's INSERT used to omit agegroupid entirely, leaving it
    // NULL forever — invisible in most views, but silently dropped from the athlete's own
    // category in point-standings scoring (which requires an exact agegroupid match), even
    // though the athlete has a real, valid result. Found auditing a real beach meet where a
    // late entry's missing agegroupid inflated other clubs' point totals in that category.
    const { db, cleanup } = createTestDb()
    try {
      seedSplitEvent(db)

      const juniorResultId = await addLateEntry(1, 1, 100, 4, 30000, db)
      const seniorResultId = await addLateEntry(2, 1, 100, 5, 32000, db)

      const junior = db.prepare('SELECT agegroupid FROM swimresult WHERE swimresultid=?').get(juniorResultId) as { agegroupid: number | null }
      const senior = db.prepare('SELECT agegroupid FROM swimresult WHERE swimresultid=?').get(seniorResultId) as { agegroupid: number | null }

      expect(junior.agegroupid).toBe(10) // 15-18F
      expect(senior.agegroupid).toBe(20) // 19+F
    } finally {
      cleanup()
    }
  })

  it('falls back to the single bracket when an event has only one age group', async () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (30, 1, 'Open', 1, -1, 2, 1)`)
      db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
      db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Any', 'Athlete', 2, '2005-06-01')`)
      db.exec(`INSERT INTO heat (heatid, swimeventid, agegroupid, heatnumber, racestatus) VALUES (100, 1, 30, 1, 4)`)

      const resultId = await addLateEntry(1, 1, 100, 4, 30000, db)
      const row = db.prepare('SELECT agegroupid FROM swimresult WHERE swimresultid=?').get(resultId) as { agegroupid: number | null }
      expect(row.agegroupid).toBe(30)
    } finally {
      cleanup()
    }
  })
})
