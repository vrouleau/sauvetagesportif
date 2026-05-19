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
})
