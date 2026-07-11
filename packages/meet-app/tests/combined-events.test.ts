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
import {
  queryEventsWithAgeGroups,
  findMatchingEvents,
  regenerateCombinedEvents,
  type CategoryConfig,
} from '../src/main/combinedEvents'

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-combined-events')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

/**
 * Reproduces the "Résultat combiné" grouping bug: a single swimeventid hosting
 * two age groups (e.g. 11-12 and 19+) must be split by agegroupid so that each
 * combined-events category only pulls the results for its own age bracket,
 * not every age group swimming under that event.
 */
function seedSharedEvent(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  // One swimevent shared by two age groups (11-12 girls, 19+ women)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '11-12F', 11, 12, 2, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 1, '19+F', 19, -1, 2, 2)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Junior', 'Athlete', 2, '2014-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Senior', 'Athlete', 2, '2000-01-01')`)

  // Junior athlete swims under the 11-12 age group, senior under 19+ — same swimeventid
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (1, 1, 1, 10, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (2, 2, 1, 20, 32000)`)
}

const cat1112: CategoryConfig = {
  ageMin: 11, ageMax: 12, gender: 2,
  name: 'Cumulatif 11-12 ans - filles',
  pointsForPlaces: '20,18,16,14',
  sortbyresfirst: 'F', finalusetype: '2', isSpecialNoEvents: false,
}

const cat19plus: CategoryConfig = {
  ageMin: 19, ageMax: -1, gender: 2,
  name: 'Cumulatif 19 ans et plus - dames',
  pointsForPlaces: '20,18,16,14',
  sortbyresfirst: 'F', finalusetype: '2', isSpecialNoEvents: false,
}

describe('combinedEvents age-group scoping', () => {
  it('findMatchingEvents keeps distinct agegroupIds for the same swimeventid', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSharedEvent(db)
      const events = queryEventsWithAgeGroups(db)

      const matched1112 = findMatchingEvents(events, cat1112)
      const matched19plus = findMatchingEvents(events, cat19plus)

      expect(matched1112).toEqual([{ eventId: 1, agegroupId: 10 }])
      expect(matched19plus).toEqual([{ eventId: 1, agegroupId: 20 }])
    } finally {
      cleanup()
    }
  })

  it('regenerateCombinedEvents emits agegroupid on each EVENT so categories do not merge', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSharedEvent(db)
      regenerateCombinedEvents(db)

      const row = db.prepare(`SELECT data FROM bsglobal WHERE name = 'COMBINEDEVENTS'`).get() as { data: string }
      expect(row.data).toContain('eventid="1" agegroupid="10"')
      expect(row.data).toContain('eventid="1" agegroupid="20"')
    } finally {
      cleanup()
    }
  })
})
