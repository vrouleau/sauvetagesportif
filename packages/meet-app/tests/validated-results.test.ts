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
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTestDb } from './helpers'
import { getCombinedResults, getPointStandings } from '../src/main/db'
import { exportLenexResults } from '../src/main/lenex'

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-validated-results')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

/**
 * Seeds one event under the "Cumulatif 11-12 ans - filles" combined-events
 * category (ageMin=11, ageMax=12, gender=2 — matches config/combined-events-config.json)
 * with two athletes: one with a result in a validated (racestatus=5) heat,
 * one with a faster result in an unvalidated heat. Only the validated result
 * should ever surface in reports.
 */
function seedEventWithMixedValidation(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '11-12F', 11, 12, 2, 1)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Validated', 'Athlete', 2, '2014-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Unvalidated', 'Athlete', 2, '2014-01-01')`)

  // Heat 1 is validated (racestatus=5), heat 2 is not (e.g. still just timed/completed)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 1, 1, 5, 1)`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (2, 1, 2, 4, 2)`)

  // Unvalidated athlete is faster — if the filter were missing, it would rank #1 and
  // push the validated athlete's placement/points down instead of being excluded outright.
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (1, 1, 1, 10, 1, 35000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (2, 2, 1, 10, 2, 20000)`)
}

describe('getCombinedResults excludes unvalidated heats', () => {
  it('only counts results from validated (racestatus=5) heats', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedEventWithMixedValidation(db)
      const categories = getCombinedResults([1], db)

      const cat = categories.find(c => c.name === 'Cumulatif 11-12 ans - filles')
      expect(cat).toBeDefined()
      expect(cat!.athletes.map(a => a.athleteId)).toEqual([1])
      expect(cat!.athletes[0].totalPoints).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })
})

describe('getPointStandings excludes unvalidated heats', () => {
  it('only awards club points for results from validated heats', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedEventWithMixedValidation(db)
      const { clubs } = getPointStandings([1], db)

      // Both athletes share the same club, so if the unvalidated result leaked in,
      // the club would still get points from it (place 1) on top of the validated
      // result's points — assert the total matches a single (validated-only) placement.
      expect(clubs).toHaveLength(1)
      const validatedOnlyPoints = clubs[0].totalPoints
      expect(validatedOnlyPoints).toBeGreaterThan(0)

      // Now validate the second heat too and confirm points increase — proving the
      // filter is actually load-bearing and not incidentally always empty/all-in.
      db.prepare(`UPDATE heat SET racestatus = 5 WHERE heatid = 2`).run()
      const { clubs: clubsAfter } = getPointStandings([1], db)
      expect(clubsAfter[0].totalPoints).toBeGreaterThan(validatedOnlyPoints)
    } finally {
      cleanup()
    }
  })
})

describe('exportLenexResults excludes unvalidated heats', () => {
  it('only exports results tied to a validated heat', () => {
    const { db, cleanup } = createTestDb()
    const filePath = join(tmpdir(), `sauvetagemeet-test-export-${randomBytes(4).toString('hex')}.lxf`)
    try {
      seedEventWithMixedValidation(db)
      const summary = exportLenexResults(filePath, db)

      expect(summary.results).toBe(1)
      expect(summary.athletes).toBe(1)
    } finally {
      cleanup()
      rmSync(filePath, { force: true })
    }
  })
})
