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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers'

/**
 * Tests for age group name resolution in heat list queries.
 *
 * The agegroup.name column is often NULL (Splash doesn't always populate it).
 * The app should fall back to "agemin-agemax" when name is NULL, and show "???"
 * when neither name nor age range is available.
 */
describe('Age group name resolution', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup

    // Seed minimal meet structure
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, lanemin, lanemax) VALUES (1, 1, 'Session 1', 1, 8)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 5, 1, 'F')`)
    db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'John', 'Doe', 1, '2000-01-15', 'CAN')`)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (2, 1, 'Jane', 'Smith', 2, '2005-06-20', 'CAN')`)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (3, 1, 'Bob', 'Brown', 1, '1998-03-10', 'CAN')`)
  })

  afterEach(() => cleanup())

  /** Run the same COALESCE query used by getHeatListSessions */
  function queryAgeName(swimresultId: number): string {
    const row = db.prepare(`
      SELECT COALESCE(ag.name, CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || ag.agemax END, '???') AS agegroupname
      FROM swimresult r
      LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
      WHERE r.swimresultid = ?
    `).get(swimresultId) as { agegroupname: string }
    return row.agegroupname
  }

  it('uses agegroup.name when it is populated', () => {
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, 'Senior', 19, 99, 1, 1)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 1, 1, 10, 1, 1, 60000)`)

    expect(queryAgeName(1)).toBe('Senior')
  })

  it('falls back to agemin-agemax when name is NULL', () => {
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, NULL, 15, 18, 1, 1)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 2, 1, 10, 1, 1, 62000)`)

    expect(queryAgeName(1)).toBe('15-18')
  })

  it('shows ??? when agegroupid is NULL on swimresult', () => {
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 3, 1, NULL, 1, 1, 65000)`)

    expect(queryAgeName(1)).toBe('???')
  })

  it('shows ??? when agegroupid references a non-existent agegroup', () => {
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    // agegroupid=999 doesn't exist in agegroup table
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 1, 1, 999, 1, 1, 60000)`)

    expect(queryAgeName(1)).toBe('???')
  })

  it('shows ??? when agegroup exists but has NULL agemin and NULL name', () => {
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, NULL, NULL, NULL, 1, 1)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 1, 1, 10, 1, 1, 60000)`)

    expect(queryAgeName(1)).toBe('???')
  })

  it('handles multiple athletes with different age group scenarios', () => {
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, 'Open', 19, 99, 1, 1)`)
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (11, 1, NULL, 15, 18, 1, 2)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, sortcode) VALUES (1, 1, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (1, 1, 1, 10, 1, 1, 60000)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (2, 2, 1, 11, 1, 2, 62000)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime) VALUES (3, 3, 1, NULL, 1, 3, 65000)`)

    expect(queryAgeName(1)).toBe('Open')
    expect(queryAgeName(2)).toBe('15-18')
    expect(queryAgeName(3)).toBe('???')
  })
})