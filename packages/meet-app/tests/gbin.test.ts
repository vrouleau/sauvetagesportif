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
import { encodeGbin, decodeGbin, D_NULL_SENTINEL } from '../src/main/smb'
import type { ColDef } from '../src/main/smb'

// ── Fixtures: synthetic table data ────────────────────────────────────────────

const SWIMSTYLE_COLS: ColDef[] = [
  { name: 'SWIMSTYLEID', type: 'I', size: 32 },
  { name: 'CODE', type: 'S', size: 10 },
  { name: 'DISTANCE', type: 'I', size: 16 },
  { name: 'NAME', type: 'S', size: 50 },
  { name: 'RELAYCOUNT', type: 'I', size: 16 },
  { name: 'STROKE', type: 'I', size: 16 },
  { name: 'SORTCODE', type: 'I', size: 32 },
  { name: 'TECHNIQUE', type: 'I', size: 16 },
  { name: 'UNIQUEID', type: 'I', size: 16 },
]

const SWIMSTYLE_ROWS = [
  { swimstyleid: 101, code: '50FR', distance: 50, name: '50 m Nage libre', relaycount: 1, stroke: 1, sortcode: 100, technique: 0, uniqueid: 1 },
  { swimstyleid: 102, code: '100FR', distance: 100, name: '100 m Nage libre', relaycount: 1, stroke: 1, sortcode: 200, technique: 0, uniqueid: 2 },
  { swimstyleid: 103, code: '50DO', distance: 50, name: '50 m Dos', relaycount: 1, stroke: 2, sortcode: 300, technique: 0, uniqueid: 3 },
  { swimstyleid: 201, code: '4x50', distance: 200, name: '4x50 m Relais libre', relaycount: 4, stroke: 6, sortcode: 400, technique: 0, uniqueid: 4 },
]

const SWIMSESSION_COLS: ColDef[] = [
  { name: 'SWIMSESSIONID', type: 'I', size: 32 },
  { name: 'COURSE', type: 'I', size: 16 },
  { name: 'DAYTIME', type: 'D', size: 32 },
  { name: 'ENDTIME', type: 'D', size: 32 },
  { name: 'FEEATHLETE', type: 'F', size: 0 },
  { name: 'FOLLOWING', type: 'S', size: 1 },
  { name: 'LANEMIN', type: 'I', size: 16 },
  { name: 'LANEMAX', type: 'I', size: 16 },
  { name: 'LANESBYPLACE', type: 'S', size: 100 },
  { name: 'MAXENTRIESATHLETE', type: 'I', size: 16 },
  { name: 'MAXENTRIESRELAY', type: 'I', size: 16 },
  { name: 'NAME', type: 'S', size: 100 },
  { name: 'OFFICIALMEETING', type: 'D', size: 32 },
  { name: 'POOLGLOBAL', type: 'S', size: 1 },
  { name: 'POOLTYPE', type: 'I', size: 16 },
  { name: 'REMARKS', type: 'M', size: 0 },
  { name: 'REMARKSJURY', type: 'M', size: 0 },
  { name: 'ROUNDTOTENTHS', type: 'S', size: 1 },
  { name: 'SESSIONNUMBER', type: 'I', size: 16 },
  { name: 'STARTDATE', type: 'D', size: 32 },
  { name: 'TIMING', type: 'I', size: 16 },
  { name: 'TLMEETING', type: 'D', size: 32 },
  { name: 'TOUCHPADMODE', type: 'I', size: 16 },
  { name: 'WARMUPFROM', type: 'D', size: 32 },
  { name: 'WARMUPUNTIL', type: 'D', size: 32 },
]

const SWIMSESSION_ROWS = [
  {
    swimsessionid: 1001, course: 3, daytime: null, endtime: null,
    feeathlete: 45.0, following: 'F', lanemin: 1, lanemax: 6,
    lanesbyplace: null, maxentriesathlete: null, maxentriesrelay: null,
    name: 'Session 1 - Préliminaires', officialmeeting: null,
    poolglobal: 'F', pooltype: 0, remarks: null, remarksjury: null,
    roundtotenths: 'F', sessionnumber: 1, startdate: null,
    timing: 0, tlmeeting: null, touchpadmode: 0,
    warmupfrom: null, warmupuntil: null,
  },
  {
    swimsessionid: 1002, course: 3, daytime: null, endtime: null,
    feeathlete: null, following: 'F', lanemin: 1, lanemax: 6,
    lanesbyplace: null, maxentriesathlete: null, maxentriesrelay: null,
    name: 'Session 2 - Finales', officialmeeting: null,
    poolglobal: 'F', pooltype: 0, remarks: null, remarksjury: null,
    roundtotenths: 'F', sessionnumber: 2, startdate: null,
    timing: 0, tlmeeting: null, touchpadmode: 0,
    warmupfrom: null, warmupuntil: null,
  },
]

const SPLIT_COLS: ColDef[] = [
  { name: 'SWIMRESULTID', type: 'I', size: 32 },
  { name: 'DISTANCE', type: 'I', size: 16 },
  { name: 'SWIMTIME', type: 'I', size: 32 },
]

const SPLIT_ROWS = [
  { swimresultid: 5001, distance: 50, swimtime: 32450 },
  { swimresultid: 5001, distance: 100, swimtime: 67890 },
  { swimresultid: 5002, distance: 50, swimtime: 28100 },
  { swimresultid: 5002, distance: 100, swimtime: 59200 },
]

const BSGLOBAL_COLS: ColDef[] = [
  { name: 'NAME', type: 'S', size: 50 },
  { name: 'DATA', type: 'M', size: 0 },
]

const BSGLOBAL_ROWS = [
  { name: 'MeetName', data: 'Championnats régionaux 2026' },
  { name: 'MeetCity', data: 'Gatineau' },
  { name: 'MeetNation', data: 'CAN' },
  { name: 'MeetCourse', data: '3' },
]

// Helper to wrap cols in a table def
function tableDef(cols: ColDef[]): { name: string; cols: ColDef[] } {
  return { name: 'TEST', cols }
}

// ── Tests: gbin encode/decode roundtrip ───────────────────────────────────────

describe('gbin encode/decode roundtrip', () => {
  it('integer and string columns roundtrip correctly (swimstyle)', () => {
    const encoded = encodeGbin(tableDef(SWIMSTYLE_COLS), SWIMSTYLE_ROWS)
    const { cols, rows } = decodeGbin(encoded)

    expect(rows).toHaveLength(SWIMSTYLE_ROWS.length)
    expect(cols).toHaveLength(SWIMSTYLE_COLS.length)

    for (let i = 0; i < SWIMSTYLE_ROWS.length; i++) {
      for (const key of Object.keys(SWIMSTYLE_ROWS[i])) {
        expect(rows[i][key]).toBe(SWIMSTYLE_ROWS[i][key as keyof typeof SWIMSTYLE_ROWS[0]])
      }
    }
  })

  it('float, date, memo, and nullable columns roundtrip correctly (swimsession)', () => {
    const encoded = encodeGbin(tableDef(SWIMSESSION_COLS), SWIMSESSION_ROWS)
    const { rows } = decodeGbin(encoded)

    expect(rows).toHaveLength(SWIMSESSION_ROWS.length)

    // Session 1: feeathlete=45.0 (non-null float)
    expect(rows[0].name).toBe('Session 1 - Préliminaires')
    expect(rows[0].feeathlete).toBe(45.0)
    expect(rows[0].lanemin).toBe(1)
    expect(rows[0].lanemax).toBe(6)
    expect(rows[0].sessionnumber).toBe(1)
    expect(rows[0].course).toBe(3)

    // Session 2: feeathlete=null (null float)
    expect(rows[1].name).toBe('Session 2 - Finales')
    expect(rows[1].feeathlete).toBeNull()
    expect(rows[1].sessionnumber).toBe(2)
  })

  it('simple integer-only table roundtrips correctly (split)', () => {
    const encoded = encodeGbin(tableDef(SPLIT_COLS), SPLIT_ROWS)
    const { rows } = decodeGbin(encoded)

    expect(rows).toHaveLength(SPLIT_ROWS.length)
    for (let i = 0; i < SPLIT_ROWS.length; i++) {
      expect(rows[i].swimresultid).toBe(SPLIT_ROWS[i].swimresultid)
      expect(rows[i].distance).toBe(SPLIT_ROWS[i].distance)
      expect(rows[i].swimtime).toBe(SPLIT_ROWS[i].swimtime)
    }
  })

  it('string + memo columns roundtrip correctly (bsglobal)', () => {
    const encoded = encodeGbin(tableDef(BSGLOBAL_COLS), BSGLOBAL_ROWS)
    const { rows } = decodeGbin(encoded)

    expect(rows).toHaveLength(BSGLOBAL_ROWS.length)
    for (let i = 0; i < BSGLOBAL_ROWS.length; i++) {
      expect(rows[i].name).toBe(BSGLOBAL_ROWS[i].name)
      expect(rows[i].data).toBe(BSGLOBAL_ROWS[i].data)
    }
  })

  it('null integer is distinct from zero', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'VALUE', type: 'I', size: 32 },
    ]
    const rows = [
      { id: 1, value: 0 },
      { id: 2, value: null },
      { id: 3, value: 42 },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].value).toBe(0)
    expect(decoded[1].value).toBeNull()
    expect(decoded[2].value).toBe(42)
  })

  it('null I;16 integer is distinct from zero', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'LANE', type: 'I', size: 16 },
    ]
    const rows = [
      { id: 1, lane: 0 },
      { id: 2, lane: null },
      { id: 3, lane: 5 },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].lane).toBe(0)
    expect(decoded[1].lane).toBeNull()
    expect(decoded[2].lane).toBe(5)
  })

  it('null float is distinct from zero', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'FEE', type: 'F', size: 0 },
    ]
    const rows = [
      { id: 1, fee: 0.0 },
      { id: 2, fee: null },
      { id: 3, fee: 99.50 },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].fee).toBe(0.0)
    expect(decoded[1].fee).toBeNull()
    expect(decoded[2].fee).toBe(99.50)
  })

  it('null date is distinct from sentinel value', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'STARTDATE', type: 'D', size: 32 },
    ]
    const rows = [
      { id: 1, startdate: 45000.5 },   // a real OLE date
      { id: 2, startdate: null },        // null
      { id: 3, startdate: D_NULL_SENTINEL }, // the sentinel as a real value
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].startdate).toBe(45000.5)
    expect(decoded[1].startdate).toBeNull()
    expect(decoded[2].startdate).toBe(D_NULL_SENTINEL)
  })

  it('null string (S) encodes as length=0', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'TEXT', type: 'S', size: 50 },
    ]
    const rows = [
      { id: 1, text: 'hello' },
      { id: 2, text: null },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].text).toBe('hello')
    expect(decoded[1].text).toBeNull()
  })

  it('null memo (M) encodes as length=0', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'NOTES', type: 'M', size: 0 },
    ]
    const rows = [
      { id: 1, notes: 'Some long text here' },
      { id: 2, notes: null },
      { id: 3, notes: 'Another note' },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].notes).toBe('Some long text here')
    expect(decoded[1].notes).toBeNull()
    expect(decoded[2].notes).toBe('Another note')
  })

  it('UTF-8 characters (accents, special chars) survive roundtrip', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 100 },
    ]
    const rows = [
      { id: 1, name: '50 m Remorquage mannequin' },
      { id: 2, name: 'Épreuve spéciale — été' },
      { id: 3, name: '100m Nage avec obstacles' },
      { id: 4, name: 'Relais 4×50 m sauvetage' },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    for (let i = 0; i < rows.length; i++) {
      expect(decoded[i].name).toBe(rows[i].name)
    }
  })

  it('UTF-8 in memo fields survives roundtrip', () => {
    const cols: ColDef[] = [
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'DATA', type: 'M', size: 0 },
    ]
    const rows = [
      { name: 'MEETVALUES', data: 'NAME=S;Championnats québécois\nCITY=S;Montréal' },
      { name: 'NOTES', data: 'Piscine 25m — 6 couloirs\nTempérature: 27°C' },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].data).toBe(rows[0].data)
    expect(decoded[1].data).toBe(rows[1].data)
  })

  it('large 32-bit integer values encode/decode correctly', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'TIME_MS', type: 'I', size: 32 },
    ]
    const rows = [
      { id: 1, time_ms: 3600000 },     // 1 hour in ms
      { id: 2, time_ms: 65430 },        // ~1:05.43
      { id: 3, time_ms: 2147483647 },   // max int32 → Splash "no time" sentinel → null
      { id: 4, time_ms: -2147483648 },  // min int32
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].time_ms).toBe(3600000)
    expect(decoded[1].time_ms).toBe(65430)
    expect(decoded[2].time_ms).toBe(null)  // max int32 is the "no time" sentinel
    expect(decoded[3].time_ms).toBe(-2147483648)
  })

  it('large 16-bit integer values encode/decode correctly', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'LANE', type: 'I', size: 16 },
    ]
    const rows = [
      { id: 1, lane: 32767 },   // max int16
      { id: 2, lane: -32768 },  // min int16
      { id: 3, lane: 1 },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    for (let i = 0; i < rows.length; i++) {
      expect(decoded[i].lane).toBe(rows[i].lane)
    }
  })

  it('empty table (no rows) roundtrips correctly', () => {
    const encoded = encodeGbin(tableDef(SWIMSTYLE_COLS), [])
    const { cols, rows } = decodeGbin(encoded)

    expect(rows).toHaveLength(0)
    expect(cols).toHaveLength(SWIMSTYLE_COLS.length)
  })

  it('header column definitions are preserved', () => {
    const encoded = encodeGbin(tableDef(SWIMSTYLE_COLS), [])
    const { cols } = decodeGbin(encoded)

    for (let i = 0; i < SWIMSTYLE_COLS.length; i++) {
      expect(cols[i].name).toBe(SWIMSTYLE_COLS[i].name)
      expect(cols[i].type).toBe(SWIMSTYLE_COLS[i].type)
      expect(cols[i].size).toBe(SWIMSTYLE_COLS[i].size)
    }
  })

  it('float precision is maintained', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'AMOUNT', type: 'F', size: 0 },
    ]
    const rows = [
      { id: 1, amount: 0.01 },
      { id: 2, amount: 123456.789 },
      { id: 3, amount: -99.99 },
      { id: 4, amount: 3.141592653589793 },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    for (let i = 0; i < rows.length; i++) {
      expect(decoded[i].amount).toBe(rows[i].amount)
    }
  })

  it('multiple rows with mixed null/non-null values', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'SCORE', type: 'F', size: 0 },
      { name: 'DATE', type: 'D', size: 32 },
      { name: 'NOTES', type: 'M', size: 0 },
    ]
    const rows = [
      { id: 1, name: 'Alice', score: 95.5, date: 45000.0, notes: 'First place' },
      { id: 2, name: null, score: null, date: null, notes: null },
      { id: 3, name: 'Charlie', score: 0.0, date: 45001.0, notes: null },
      { id: 4, name: null, score: 88.3, date: null, notes: 'Late entry' },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded).toHaveLength(4)

    // Row 1: all non-null
    expect(decoded[0].id).toBe(1)
    expect(decoded[0].name).toBe('Alice')
    expect(decoded[0].score).toBe(95.5)
    expect(decoded[0].date).toBe(45000.0)
    expect(decoded[0].notes).toBe('First place')

    // Row 2: all null (except id)
    expect(decoded[1].id).toBe(2)
    expect(decoded[1].name).toBeNull()
    expect(decoded[1].score).toBeNull()
    expect(decoded[1].date).toBeNull()
    expect(decoded[1].notes).toBeNull()

    // Row 3: score=0.0 (real zero, not null)
    expect(decoded[2].id).toBe(3)
    expect(decoded[2].name).toBe('Charlie')
    expect(decoded[2].score).toBe(0.0)
    expect(decoded[2].notes).toBeNull()

    // Row 4: mixed
    expect(decoded[3].id).toBe(4)
    expect(decoded[3].name).toBeNull()
    expect(decoded[3].score).toBe(88.3)
    expect(decoded[3].date).toBeNull()
    expect(decoded[3].notes).toBe('Late entry')
  })

  it('long strings near size boundary', () => {
    const cols: ColDef[] = [
      { name: 'ID', type: 'I', size: 32 },
      { name: 'LONGNAME', type: 'S', size: 255 },
    ]
    const longStr = 'A'.repeat(250)
    const rows = [
      { id: 1, longname: longStr },
      { id: 2, longname: 'short' },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].longname).toBe(longStr)
    expect(decoded[1].longname).toBe('short')
  })

  it('long memo content', () => {
    const cols: ColDef[] = [
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'DATA', type: 'M', size: 0 },
    ]
    const longMemo = 'Line\n'.repeat(500)
    const rows = [
      { name: 'config', data: longMemo },
    ]
    const encoded = encodeGbin(tableDef(cols), rows)
    const { rows: decoded } = decodeGbin(encoded)

    expect(decoded[0].data).toBe(longMemo)
  })
})