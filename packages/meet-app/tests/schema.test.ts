import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, seedMeet } from './helpers'
import type Database from 'better-sqlite3'

describe('Schema and queries', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    seedMeet(db)
  })

  afterEach(() => cleanup())

  it('creates all required tables', () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('bsglobal')
    expect(names).toContain('swimstyle')
    expect(names).toContain('club')
    expect(names).toContain('swimsession')
    expect(names).toContain('athlete')
    expect(names).toContain('swimevent')
    expect(names).toContain('agegroup')
    expect(names).toContain('heat')
    expect(names).toContain('swimresult')
    expect(names).toContain('split')
  })

  it('enforces foreign key on swimevent → swimsession', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO swimevent (swimeventid, swimsessionid, eventnumber, gender, round, sortcode) VALUES (99, 999, 1, 1, 5, 1)`
      ).run()
    }).toThrow()
  })

  it('cascades delete from swimsession to swimevent', () => {
    const before = (db.prepare('SELECT COUNT(*) as c FROM swimevent WHERE swimsessionid=1').get() as { c: number }).c
    expect(before).toBeGreaterThan(0)

    db.prepare('DELETE FROM swimsession WHERE swimsessionid=1').run()

    const after = (db.prepare('SELECT COUNT(*) as c FROM swimevent WHERE swimsessionid=1').get() as { c: number }).c
    expect(after).toBe(0)
  })

  it('cascades delete from swimevent to agegroup', () => {
    const before = (db.prepare('SELECT COUNT(*) as c FROM agegroup WHERE swimeventid=1').get() as { c: number }).c
    expect(before).toBeGreaterThan(0)

    db.prepare('DELETE FROM swimevent WHERE swimeventid=1').run()

    const after = (db.prepare('SELECT COUNT(*) as c FROM agegroup WHERE swimeventid=1').get() as { c: number }).c
    expect(after).toBe(0)
  })

  it('reorder events updates sortcode', () => {
    // Event 1 has sortcode=1, event 2 has sortcode=2
    db.prepare('UPDATE swimevent SET sortcode=10 WHERE swimeventid=1').run()
    db.prepare('UPDATE swimevent SET sortcode=5 WHERE swimeventid=2').run()

    const events = db.prepare(
      'SELECT swimeventid, sortcode FROM swimevent WHERE swimsessionid=1 ORDER BY sortcode'
    ).all() as Array<{ swimeventid: number; sortcode: number }>

    expect(events[0].swimeventid).toBe(2) // sortcode 5 first
    expect(events[1].swimeventid).toBe(1) // sortcode 10 second
  })

  it('updates age group fields', () => {
    db.prepare('UPDATE agegroup SET agemin=15, agemax=25, gender=2 WHERE agegroupid=1').run()
    const ag = db.prepare('SELECT agemin, agemax, gender FROM agegroup WHERE agegroupid=1').get() as { agemin: number; agemax: number; gender: number }
    expect(ag.agemin).toBe(15)
    expect(ag.agemax).toBe(25)
    expect(ag.gender).toBe(2)
  })

  it('updates event swimstyleid', () => {
    db.prepare('UPDATE swimevent SET swimstyleid=2 WHERE swimeventid=1').run()
    const ev = db.prepare('SELECT swimstyleid FROM swimevent WHERE swimeventid=1').get() as { swimstyleid: number }
    expect(ev.swimstyleid).toBe(2)
  })

  it('bsglobal upsert works', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('test_key', 'value1')`).run()
    const r1 = db.prepare(`SELECT data FROM bsglobal WHERE name='test_key'`).get() as { data: string }
    expect(r1.data).toBe('value1')

    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('test_key', 'value2') ON CONFLICT(name) DO UPDATE SET data=excluded.data`).run()
    const r2 = db.prepare(`SELECT data FROM bsglobal WHERE name='test_key'`).get() as { data: string }
    expect(r2.data).toBe('value2')
  })
})
