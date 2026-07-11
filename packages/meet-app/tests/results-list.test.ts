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
import { getResultsList } from '../src/main/db'

/**
 * Reproduces the same age-group scoping bug as the Combined Results report:
 * a single swimeventid hosting two age groups (11-12 and 19+) must produce
 * two separate result groups, not one merged list.
 */
function seedSharedEvent(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '11-12F', 11, 12, 2, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 1, '19+F', 19, -1, 2, 2)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Junior', 'Athlete', 2, '2014-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Senior', 'Athlete', 2, '2000-01-01')`)

  // Junior swims under the 11-12 age group, senior under 19+ — same swimeventid
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (1, 1, 1, 10, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (2, 2, 1, 20, 32000)`)
}

describe('getResultsList age-group scoping', () => {
  it('splits results for a shared swimeventid into distinct age-group buckets', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSharedEvent(db)
      const events = getResultsList([1], db)

      expect(events).toHaveLength(1)
      expect(events[0].ageGroups).toHaveLength(2)

      const junior = events[0].ageGroups.find(ag => ag.agegroupId === 10)
      const senior = events[0].ageGroups.find(ag => ag.agegroupId === 20)

      expect(junior?.athletes.map(a => a.athleteId)).toEqual([1])
      expect(senior?.athletes.map(a => a.athleteId)).toEqual([2])
    } finally {
      cleanup()
    }
  })

  it('orders athletes within an age group by result ascending', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSharedEvent(db)
      db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (3, 1, 'Faster', 'Athlete', 2, '2013-01-01')`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (3, 3, 1, 10, 25000)`)

      const events = getResultsList([1], db)
      const junior = events[0].ageGroups.find(ag => ag.agegroupId === 10)

      expect(junior?.athletes.map(a => a.athleteId)).toEqual([3, 1])
    } finally {
      cleanup()
    }
  })
})
