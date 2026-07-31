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
  resolveToFinal,
  type CategoryConfig,
} from '../src/main/combinedEvents'
import { getCombinedResults } from '../src/main/db'

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

/**
 * Reproduces the real-world bug (found by comparing against a live Splash
 * .mdb for an actual competition): when an event has been split into a Prelim
 * + Final pair, combined-events point totals must come from the FINAL's
 * placements, not the prelim's heat times. Splash's own combined-events XML
 * always references the prelim's event id as the stable "event slot" (the
 * final doesn't exist until someone converts the event), but the points
 * Splash actually prints are computed from the final's results whenever one
 * exists — verified athlete-by-athlete against CanadienMai2026_S40.mdb.
 */
function seedPrelimFinalPair(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)

  // Prelim: no preveventid (the stable "event slot" Splash's XML references)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (100, 1, 1, 5, 1, 1, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (101, 100, '19+M', 19, -1, 1, 1)`)

  // Final: preveventid links back to the prelim
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (200, 1, 1, 5, 1, 4, 2, 'F', 100)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (201, 200, '19+M', 19, 99, 1, 1)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'A', 'Athlete', 1, '2000-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'B', 'Athlete', 1, '2000-01-01')`)

  // One official (racestatus=5) heat per event, since getCombinedResults joins swimresult -> heat
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (100, 100, 1, 5)`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (200, 200, 1, 5)`)

  // Athlete 1 is slower in the prelim (2nd) but wins the final (1st) — the
  // point total must reflect the final placement, not the prelim's.
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (1, 1, 100, 101, 100, 32000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (2, 2, 100, 101, 100, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (3, 1, 200, 201, 200, 29000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (4, 2, 200, 201, 200, 31000)`)
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

describe('combinedEvents prelim/final resolution', () => {
  it('resolveToFinal resolves a prelim event+agegroup to its final counterpart', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedPrelimFinalPair(db)
      expect(resolveToFinal(db, 100, 101)).toEqual({ eventId: 200, agegroupId: 201 })
    } finally {
      cleanup()
    }
  })

  it('resolveToFinal falls back to the prelim when no final exists', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedSharedEvent(db)
      expect(resolveToFinal(db, 1, 10)).toEqual({ eventId: 1, agegroupId: 10 })
    } finally {
      cleanup()
    }
  })

  it('getCombinedResults scores off the FINAL placement, not the prelim heat time', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedPrelimFinalPair(db)
      // Select the PRELIM event (id 100) — the row a user actually ticks in the report tree
      const categories = getCombinedResults([100], db)
      const cat = categories.find(c => c.name.includes('19 ans et plus') && c.name.includes('hommes'))
      expect(cat).toBeDefined()
      // Athlete 1 was 2nd in the prelim (32000ms, slower) but 1st in the final (29000ms) —
      // combined-events points must reflect the final placement.
      expect(cat!.athletes[0].firstName).toBe('A')
      expect(cat!.athletes[0].totalPoints).toBeGreaterThan(cat!.athletes[1].totalPoints)
    } finally {
      cleanup()
    }
  })
})
