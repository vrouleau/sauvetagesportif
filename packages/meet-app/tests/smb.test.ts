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
import { createTestDb, seedMeet } from './helpers'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { unlinkSync, existsSync } from 'fs'
import type Database from 'better-sqlite3'

// Import the SMB functions directly
import { saveSMB, restoreSMB } from '../src/main/smb'

describe('SMB save/restore', () => {
  let db: Database.Database
  let cleanup: () => void
  let smbPath: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    smbPath = join(tmpdir(), `test-${randomBytes(4).toString('hex')}.smb`)
  })

  afterEach(() => {
    cleanup()
    try { unlinkSync(smbPath) } catch {}
  })

  it('saves an SMB file that exists on disk', () => {
    seedMeet(db)
    const result = saveSMB(smbPath, db)
    expect(existsSync(smbPath)).toBe(true)
    expect(result.tables).toBeGreaterThan(0)
    expect(result.rows).toBeGreaterThan(0)
  })

  it('round-trips data through save/restore', () => {
    seedMeet(db)

    // Save
    saveSMB(smbPath, db)

    // Verify data exists before restore
    const sessionsBefore = db.prepare('SELECT COUNT(*) as c FROM swimsession').get() as { c: number }
    expect(sessionsBefore.c).toBe(2)

    // Wipe the DB
    db.exec('DELETE FROM split')
    db.exec('DELETE FROM swimresult')
    db.exec('DELETE FROM heat')
    db.exec('DELETE FROM agegroup')
    db.exec('DELETE FROM swimevent')
    db.exec('DELETE FROM swimsession')
    db.exec('DELETE FROM swimstyle')
    db.exec('DELETE FROM athlete')
    db.exec('DELETE FROM club')

    const sessionsAfterWipe = db.prepare('SELECT COUNT(*) as c FROM swimsession').get() as { c: number }
    expect(sessionsAfterWipe.c).toBe(0)

    // Restore
    const result = restoreSMB(smbPath, db)
    expect(result.rows).toBeGreaterThan(0)

    // Verify data is back
    const sessionsAfterRestore = db.prepare('SELECT COUNT(*) as c FROM swimsession').get() as { c: number }
    expect(sessionsAfterRestore.c).toBe(2)

    const eventsAfterRestore = db.prepare('SELECT COUNT(*) as c FROM swimevent').get() as { c: number }
    expect(eventsAfterRestore.c).toBe(3)

    const stylesAfterRestore = db.prepare('SELECT COUNT(*) as c FROM swimstyle').get() as { c: number }
    expect(stylesAfterRestore.c).toBe(2)
  })

  it('preserves bsglobal data through round-trip', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', 'NAME=S;Test Meet')`).run()
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('admin_pin', '123456')`).run()

    saveSMB(smbPath, db)

    // Wipe
    db.exec('DELETE FROM bsglobal')
    expect((db.prepare('SELECT COUNT(*) as c FROM bsglobal').get() as { c: number }).c).toBe(0)

    // Restore
    restoreSMB(smbPath, db)

    const meetvals = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string }
    expect(meetvals.data).toContain('NAME=S;Test Meet')

    const pin = db.prepare(`SELECT data FROM bsglobal WHERE name='admin_pin'`).get() as { data: string }
    expect(pin.data).toBe('123456')
  })

  it('handles empty database gracefully', () => {
    // No data seeded — save should still work
    const result = saveSMB(smbPath, db)
    expect(existsSync(smbPath)).toBe(true)
    expect(result.rows).toBe(0)
  })

  it('normalizes Splash MDB round encoding on restore', () => {
    // Simulate a Splash-native SMB: insert data with MDB round encoding directly,
    // then save raw (saveSMB will reverse-map canonical→MDB, but we already have MDB values,
    // so we need to insert canonical values that saveSMB will convert to MDB for us).
    // Instead, let's use canonical values, save (produces MDB in file), restore, verify canonical.
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    // TIM event (canonical round=5)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (100, 1, 1, 10, 2, 5, 1, 'F')`)
    // PRE event (canonical round=1)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (200, 1, 1, 11, 2, 1, 2, 'F', -1)`)
    // FIN event (canonical round=4, references PRE)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (300, 1, 1, 12, 2, 4, 5, 'F', 200)`)

    // Save — file will contain Splash MDB encoding (5→1, 1→2, 4→9)
    saveSMB(smbPath, db)

    // Wipe
    db.exec('DELETE FROM swimevent')
    db.exec('DELETE FROM swimsession')
    db.exec('DELETE FROM swimstyle')

    // Restore — should detect MDB encoding (round=9 in file) and normalize back
    restoreSMB(smbPath, db)

    // Verify round values are back to canonical
    const timEvent = db.prepare('SELECT round, gender FROM swimevent WHERE swimeventid=100').get() as { round: number; gender: number }
    expect(timEvent.round).toBe(5)  // Restored to canonical TIM
    expect(timEvent.gender).toBe(2) // F, unchanged

    const preEvent = db.prepare('SELECT round, gender FROM swimevent WHERE swimeventid=200').get() as { round: number; gender: number }
    expect(preEvent.round).toBe(1)  // Restored to canonical PRE
    expect(preEvent.gender).toBe(2) // F, unchanged (was already set)

    const finEvent = db.prepare('SELECT round FROM swimevent WHERE swimeventid=300').get() as { round: number }
    expect(finEvent.round).toBe(4)  // Restored to canonical FIN
  })
})