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
import { unlinkSync } from 'fs'
import type Database from 'better-sqlite3'
import { saveSMB, restoreSMB } from '../src/main/smb'
import { encodeBarcode, decodeBarcode } from '../src/main/timingBarcode'
import { parseTimeToMs, formatMsToTime, assembleTimeString } from '../src/main/ocrEngine'

// ── Barcode tests ─────────────────────────────────────────────────────────────

describe('Barcode encoding/decoding', () => {
  it('encodes a barcode correctly', () => {
    expect(encodeBarcode(5, 2, 3)).toBe('E5-H2-L3')
    expect(encodeBarcode(12, 1, 6)).toBe('E12-H1-L6')
  })

  it('decodes a valid barcode', () => {
    const result = decodeBarcode('E5-H2-L3')
    expect(result).toEqual({ eventNumber: 5, heatNumber: 2, lane: 3 })
  })

  it('decodes multi-digit numbers', () => {
    const result = decodeBarcode('E12-H3-L10')
    expect(result).toEqual({ eventNumber: 12, heatNumber: 3, lane: 10 })
  })

  it('returns null for invalid format', () => {
    expect(decodeBarcode('invalid')).toBeNull()
    expect(decodeBarcode('E1-H1')).toBeNull()
    expect(decodeBarcode('E1-H1-L0-J1')).toBeNull() // old format
    expect(decodeBarcode('')).toBeNull()
  })

  it('roundtrips encode/decode', () => {
    const encoded = encodeBarcode(7, 4, 5)
    const decoded = decodeBarcode(encoded)
    expect(decoded).toEqual({ eventNumber: 7, heatNumber: 4, lane: 5 })
  })

  it('rejects invalid inputs', () => {
    expect(() => encodeBarcode(0, 1, 1)).toThrow()
    expect(() => encodeBarcode(1, 0, 1)).toThrow()
    expect(() => encodeBarcode(1, 1, 0)).toThrow()
  })
})

// ── Time parsing tests ────────────────────────────────────────────────────────

describe('Time parsing utilities', () => {
  it('parses M:SS.HH format', () => {
    expect(parseTimeToMs('1:23.45')).toBe(83450)
    expect(parseTimeToMs('0:45.12')).toBe(45120)
    expect(parseTimeToMs('2:01.00')).toBe(121000)
  })

  it('parses SS.HH format', () => {
    expect(parseTimeToMs('45.12')).toBe(45120)
    expect(parseTimeToMs('59.99')).toBe(59990)
  })

  it('formats ms to M:SS.HH', () => {
    expect(formatMsToTime(83450)).toBe('1:23.45')
    expect(formatMsToTime(45120)).toBe('0:45.12')
    expect(formatMsToTime(121000)).toBe('2:01.00')
  })

  it('roundtrips parse/format', () => {
    const times = ['1:23.45', '0:45.12', '2:01.00', '0:30.00', '3:59.99']
    for (const t of times) {
      expect(formatMsToTime(parseTimeToMs(t))).toBe(t)
    }
  })

  it('throws on invalid format', () => {
    expect(() => parseTimeToMs('invalid')).toThrow()
    expect(() => parseTimeToMs('')).toThrow()
  })

  it('assembles digit results into time string', () => {
    const digits = [
      { text: '1', confidence: 0.9 },
      { text: '2', confidence: 0.9 },
      { text: '3', confidence: 0.9 },
      { text: '4', confidence: 0.9 },
      { text: '5', confidence: 0.9 },
    ]
    expect(assembleTimeString(digits)).toBe('1:23.45')
  })
})

// ── Gemini keys in BSGLOBAL roundtrip via SMB ─────────────────────────────────

describe('Gemini keys roundtrip via SMB', () => {
  let db: Database.Database
  let cleanup: () => void
  let smbPath: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    smbPath = join(tmpdir(), `test-gemini-${randomBytes(4).toString('hex')}.smb`)
  })

  afterEach(() => {
    cleanup()
    try { unlinkSync(smbPath) } catch {}
  })

  it('preserves Gemini API keys through SMB save/restore', () => {
    seedMeet(db)

    // Store Gemini keys in BSGLOBAL
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('GEMINI_KEY_FREE', 'AIzaSyFreeKeyTest1234')`).run()
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('GEMINI_KEY_PAID', 'AIzaSyPaidKeyTest5678')`).run()

    // Verify keys are there
    const freeBefore = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get() as { data: string }
    expect(freeBefore.data).toBe('AIzaSyFreeKeyTest1234')

    // Save SMB
    saveSMB(smbPath, db)

    // Wipe the database
    db.exec('DELETE FROM bsglobal')
    const freeAfterWipe = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get()
    expect(freeAfterWipe).toBeUndefined()

    // Restore SMB
    restoreSMB(smbPath, db)

    // Verify keys survived the roundtrip
    const freeAfter = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get() as { data: string }
    const paidAfter = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_PAID'`).get() as { data: string }
    expect(freeAfter.data).toBe('AIzaSyFreeKeyTest1234')
    expect(paidAfter.data).toBe('AIzaSyPaidKeyTest5678')
  })

  it('handles missing keys gracefully', () => {
    seedMeet(db)

    // No Gemini keys set
    saveSMB(smbPath, db)

    // Restore
    restoreSMB(smbPath, db)

    // Should not have any Gemini keys
    const free = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get()
    expect(free).toBeUndefined()
  })
})