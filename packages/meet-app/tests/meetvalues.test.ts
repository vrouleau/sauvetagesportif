import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers'
import type Database from 'better-sqlite3'

// We test the MEETVALUES parser/writer logic directly on SQLite
// (same logic as db.ts getMeetValues/setMeetValues but without the electron app import)

function getMeetValues(db: Database.Database): Record<string, string> {
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
  if (!row?.data) return {}
  const result: Record<string, string> = {}
  for (const line of row.data.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const rest = line.slice(eq + 1)
    const semi = rest.indexOf(';')
    result[key] = semi >= 0 ? rest.slice(semi + 1) : rest
  }
  return result
}

function setMeetValues(db: Database.Database, updates: Record<string, { type: string; value: string }>) {
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
  const existing: Record<string, string> = {}
  if (row?.data) {
    for (const line of row.data.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq < 0) continue
      existing[line.slice(0, eq)] = line.slice(eq + 1)
    }
  }
  for (const [key, { type, value }] of Object.entries(updates)) {
    existing[key] = `${type};${value}`
  }
  const data = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\r\n')
  db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`).run(data)
}

describe('MEETVALUES parser/writer', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it('returns empty object when no MEETVALUES exists', () => {
    expect(getMeetValues(db)).toEqual({})
  })

  it('parses Splash MEETVALUES format correctly', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Test Meet\r\nCOURSE=I;1\r\nMASTERS=B;T\r\nLANEMIN=I;1\r\nLANEMAX=I;8'
    )
    const vals = getMeetValues(db)
    expect(vals.NAME).toBe('Test Meet')
    expect(vals.COURSE).toBe('1')
    expect(vals.MASTERS).toBe('T')
    expect(vals.LANEMIN).toBe('1')
    expect(vals.LANEMAX).toBe('8')
  })

  it('handles empty values', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;\r\nCITY=S;'
    )
    const vals = getMeetValues(db)
    expect(vals.NAME).toBe('')
    expect(vals.CITY).toBe('')
  })

  it('writes new values correctly', () => {
    setMeetValues(db, {
      NAME: { type: 'S', value: 'New Meet' },
      COURSE: { type: 'I', value: '3' },
    })
    const vals = getMeetValues(db)
    expect(vals.NAME).toBe('New Meet')
    expect(vals.COURSE).toBe('3')
  })

  it('preserves existing values when updating', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Original\r\nCITY=S;Montreal'
    )
    setMeetValues(db, { COURSE: { type: 'I', value: '1' } })
    const vals = getMeetValues(db)
    expect(vals.NAME).toBe('Original')
    expect(vals.CITY).toBe('Montreal')
    expect(vals.COURSE).toBe('1')
  })

  it('overwrites existing values', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Old Name'
    )
    setMeetValues(db, { NAME: { type: 'S', value: 'New Name' } })
    expect(getMeetValues(db).NAME).toBe('New Name')
  })
})
