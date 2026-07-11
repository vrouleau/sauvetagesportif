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
import { setAthleteClub } from '../src/main/db'

function seedTwoClubsWithAthlete(db: ReturnType<typeof createTestDb>['db']) {
  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'AAA', 'Club A')`)
  db.exec(`INSERT INTO club (clubid, code, name) VALUES (2, 'BBB', 'Club B')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Jane', 'Doe', 2, '2000-01-01')`)
}

describe('setAthleteClub', () => {
  it('moves an athlete to a different existing club', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedTwoClubsWithAthlete(db)
      setAthleteClub(1, 2, db)
      const row = db.prepare('SELECT clubid FROM athlete WHERE athleteid=?').get(1) as { clubid: number }
      expect(row.clubid).toBe(2)
    } finally {
      cleanup()
    }
  })

  it('throws when the target club does not exist', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedTwoClubsWithAthlete(db)
      expect(() => setAthleteClub(1, 999, db)).toThrow(/club not found/i)
    } finally {
      cleanup()
    }
  })

  it('refuses to move an athlete who is currently on a relay team', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedTwoClubsWithAthlete(db)
      db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 400, 'Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
      db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, gender) VALUES (1, 1, 1, 2)`)
      db.exec(`INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (1, 1, 1)`)

      expect(() => setAthleteClub(1, 2, db)).toThrow(/relay team/i)

      const row = db.prepare('SELECT clubid FROM athlete WHERE athleteid=?').get(1) as { clubid: number }
      expect(row.clubid).toBe(1) // unchanged
    } finally {
      cleanup()
    }
  })
})
