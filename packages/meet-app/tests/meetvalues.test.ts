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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from './helpers'
import type Database from 'better-sqlite3'

// Tests the real MEETVALUES parser/writer from db.ts. connectionManager is
// mocked (it imports Electron) so getLocalDb() — used by getMeetValues /
// setMeetValues — hands back the test database.
const { dbState } = vi.hoisted(() => ({ dbState: { db: null as unknown } }))
vi.mock('../src/main/connectionManager', () => ({
  isPgConnected: () => false,
  getDb: () => dbState.db,
  closeDb: () => {},
}))

const {
  parseMeetValues, serializeMeetValues, readMeetValues, readMeetValuesRaw, writeMeetValuesRaw,
  getMeetValues, setMeetValues,
} = await import('../src/main/db')

describe('parseMeetValues / serializeMeetValues', () => {
  it('strips the type prefix by default, keeps it with keepType', () => {
    const blob = 'NAME=S;Test Meet\r\nCOURSE=I;1\nNOTYPE=plain\r\nbroken line'
    expect(parseMeetValues(blob)).toEqual({ NAME: 'Test Meet', COURSE: '1', NOTYPE: 'plain' })
    expect(parseMeetValues(blob, { keepType: true })).toEqual({ NAME: 'S;Test Meet', COURSE: 'I;1', NOTYPE: 'plain' })
  })

  it('keeps everything after the first ";" and the first "="', () => {
    expect(parseMeetValues('NOTE=S;a;b=c')).toEqual({ NOTE: 'a;b=c' })
  })

  it('returns {} for an empty or missing blob', () => {
    expect(parseMeetValues(null)).toEqual({})
    expect(parseMeetValues(undefined)).toEqual({})
    expect(parseMeetValues('')).toEqual({})
  })

  it('serializes with CRLF and round-trips raw values', () => {
    const raw = { NAME: 'S;X', COURSE: 'I;3' }
    expect(serializeMeetValues(raw)).toBe('NAME=S;X\r\nCOURSE=I;3')
    expect(parseMeetValues(serializeMeetValues(raw), { keepType: true })).toEqual(raw)
  })
})

describe('MEETVALUES parser/writer', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    dbState.db = db
  })

  afterEach(() => {
    dbState.db = null
    cleanup()
  })

  it('returns empty object when no MEETVALUES exists', () => {
    expect(getMeetValues()).toEqual({})
    expect(readMeetValuesRaw(db)).toEqual({})
  })

  it('parses Splash MEETVALUES format correctly', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Test Meet\r\nCOURSE=I;1\r\nMASTERS=B;T\r\nLANEMIN=I;1\r\nLANEMAX=I;8'
    )
    const vals = readMeetValues(db)
    expect(vals.NAME).toBe('Test Meet')
    expect(vals.COURSE).toBe('1')
    expect(vals.MASTERS).toBe('T')
    expect(vals.LANEMIN).toBe('1')
    expect(vals.LANEMAX).toBe('8')
    expect(getMeetValues()).toEqual(vals)
  })

  it('handles empty values', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;\r\nCITY=S;'
    )
    const vals = getMeetValues()
    expect(vals.NAME).toBe('')
    expect(vals.CITY).toBe('')
  })

  it('writes new values correctly', () => {
    setMeetValues({
      NAME: { type: 'S', value: 'New Meet' },
      COURSE: { type: 'I', value: '3' },
    })
    const vals = getMeetValues()
    expect(vals.NAME).toBe('New Meet')
    expect(vals.COURSE).toBe('3')
    // first-class keys are synced too
    const meetName = db.prepare(`SELECT data FROM bsglobal WHERE name='MeetName'`).get() as { data: string }
    expect(meetName.data).toBe('New Meet')
  })

  it('preserves existing values when updating', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Original\r\nCITY=S;Montreal'
    )
    setMeetValues({ COURSE: { type: 'I', value: '1' } })
    const vals = getMeetValues()
    expect(vals.NAME).toBe('Original')
    expect(vals.CITY).toBe('Montreal')
    expect(vals.COURSE).toBe('1')
    expect(readMeetValuesRaw(db)).toEqual({ NAME: 'S;Original', CITY: 'S;Montreal', COURSE: 'I;1' })
  })

  it('overwrites existing values', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run(
      'NAME=S;Old Name'
    )
    setMeetValues({ NAME: { type: 'S', value: 'New Name' } })
    expect(getMeetValues().NAME).toBe('New Name')
  })

  it('writeMeetValuesRaw replaces the whole blob', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?)`).run('NAME=S;Old')
    writeMeetValuesRaw(db, { CITY: 'S;Gatineau' })
    const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string }
    expect(row.data).toBe('CITY=S;Gatineau')
  })
})

describe('setMeetValues (real) — pool length', () => {
  let db: Database.Database
  let cleanup: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; cleanup = t.cleanup })
  afterEach(() => cleanup())

  it("changing the meet's COURSE moves every session to it (fixing it late needs no rebuild)", async () => {
    const { setMeetValues: realSetMeetValues } = await import('../src/main/db')
    db.prepare(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'S1', 3), (2, 2, 'S2', 3)`).run()
    realSetMeetValues({ COURSE: { type: 'I', value: '1' } }, db)
    const courses = (db.prepare(`SELECT course FROM swimsession ORDER BY swimsessionid`).all() as Array<{ course: number }>)
      .map(r => r.course)
    expect(courses).toEqual([1, 1])
    expect((db.prepare(`SELECT data FROM bsglobal WHERE name='MeetCourse'`).get() as { data: string }).data).toBe('1')
  })
})
