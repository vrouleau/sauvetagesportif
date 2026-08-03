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
import { deleteAthlete } from '../src/main/db'

function seedClubWithAthlete(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'AAA', 'Club A')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Jane', 'Doe', 2, '2000-01-01')`)
}

describe('deleteAthlete', () => {
  it('removes the athlete record', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedClubWithAthlete(db)
      deleteAthlete(1, db)
      const row = db.prepare('SELECT athleteid FROM athlete WHERE athleteid=?').get(1)
      expect(row).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('removes the athlete\'s individual entries (swimresult)', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedClubWithAthlete(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid) VALUES (1, 1, 1)`)

      deleteAthlete(1, db)

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM swimresult WHERE athleteid=?').get(1) as { c: number }
      expect(remaining.c).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('removes the athlete from any relay team they belong to', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedClubWithAthlete(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 400, 'Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, gender) VALUES (1, 1, 1, 2)`)
      db.exec(`INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (1, 1, 1)`)

      deleteAthlete(1, db)

      const remaining = db.prepare('SELECT COUNT(*) AS c FROM relayposition WHERE athleteid=?').get(1) as { c: number }
      expect(remaining.c).toBe(0)
      // The team itself stays (just loses this member) — same as clearing a position via set-relay-team-member
      const team = db.prepare('SELECT relayid FROM relay WHERE relayid=1').get()
      expect(team).toBeDefined()
    } finally {
      cleanup()
    }
  })

  it('throws and does not delete when the athlete has a result in a validated heat', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedClubWithAthlete(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 1, 1, 5)`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid) VALUES (1, 1, 1, 1)`)

      expect(() => deleteAthlete(1, db)).toThrow(/validated heat/i)

      const row = db.prepare('SELECT athleteid FROM athlete WHERE athleteid=?').get(1)
      expect(row).toBeDefined()
    } finally {
      cleanup()
    }
  })

  it('throws and does not delete when the athlete has a relay result in a validated heat', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedClubWithAthlete(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 400, 'Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 1, 1, 5)`)
      db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, gender, heatid) VALUES (1, 1, 1, 2, 1)`)
      db.exec(`INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (1, 1, 1)`)

      expect(() => deleteAthlete(1, db)).toThrow(/validated heat/i)

      const row = db.prepare('SELECT athleteid FROM athlete WHERE athleteid=?').get(1)
      expect(row).toBeDefined()
    } finally {
      cleanup()
    }
  })
})
