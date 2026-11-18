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
import { SqliteBackend } from '../src/main/sqliteBackend'
import { saveSMB, restoreSMB } from '../src/main/smb'
import { encodeBarcode, decodeBarcode } from '../src/main/timingBarcode'

// ── Barcode tests ─────────────────────────────────────────────────────────────

describe('Barcode encoding/decoding', () => {
  it('encodes a barcode correctly', () => {
    expect(encodeBarcode(5, 1496, 2, 3)).toBe('E5-U1496-H2-L3')
    expect(encodeBarcode(12, 1067, 1, 6)).toBe('E12-U1067-H1-L6')
  })

  it('decodes a valid barcode', () => {
    const result = decodeBarcode('E5-U1496-H2-L3')
    expect(result).toEqual({ eventNumber: 5, swimEventId: 1496, heatNumber: 2, lane: 3 })
  })

  it('decodes multi-digit numbers', () => {
    const result = decodeBarcode('E12-U1067-H3-L10')
    expect(result).toEqual({ eventNumber: 12, swimEventId: 1067, heatNumber: 3, lane: 10 })
  })

  it('disambiguates a prelim and final sharing the same event number', () => {
    // Splash convention: prelim and final can share the human event number,
    // but the barcode's swimEventId (internal primary key) is always unique.
    const prelim = decodeBarcode('E5-U1072-H1-L3')
    const final = decodeBarcode('E5-U1496-H1-L3')
    expect(prelim?.eventNumber).toBe(final?.eventNumber)
    expect(prelim?.swimEventId).not.toBe(final?.swimEventId)
  })

  it('returns null for invalid format', () => {
    expect(decodeBarcode('invalid')).toBeNull()
    expect(decodeBarcode('E1-H1')).toBeNull()
    expect(decodeBarcode('E1-H1-L0-J1')).toBeNull() // old format
    expect(decodeBarcode('E1-H1-L3')).toBeNull() // pre-swimEventId format
    expect(decodeBarcode('')).toBeNull()
  })

  it('roundtrips encode/decode', () => {
    const encoded = encodeBarcode(7, 1145, 4, 5)
    const decoded = decodeBarcode(encoded)
    expect(decoded).toEqual({ eventNumber: 7, swimEventId: 1145, heatNumber: 4, lane: 5 })
  })

  it('rejects invalid inputs', () => {
    expect(() => encodeBarcode(0, 1, 1, 1)).toThrow()
    expect(() => encodeBarcode(1, 0, 1, 1)).toThrow()
    expect(() => encodeBarcode(1, 1, 0, 1)).toThrow()
    expect(() => encodeBarcode(1, 1, 1, 0)).toThrow()
  })
})

// ── Time parsing tests ────────────────────────────────────────────────────────

describe('Gemini keys roundtrip via SMB', () => {
  let db: Database.Database
  let backend: SqliteBackend
  let cleanup: () => void
  let smbPath: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    backend = new SqliteBackend(db)
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
    saveSMB(smbPath, backend)

    // Wipe the database
    db.exec('DELETE FROM bsglobal')
    const freeAfterWipe = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get()
    expect(freeAfterWipe).toBeUndefined()

    // Restore SMB
    restoreSMB(smbPath, backend)

    // Verify keys survived the roundtrip
    const freeAfter = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get() as { data: string }
    const paidAfter = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_PAID'`).get() as { data: string }
    expect(freeAfter.data).toBe('AIzaSyFreeKeyTest1234')
    expect(paidAfter.data).toBe('AIzaSyPaidKeyTest5678')
  })

  it('handles missing keys gracefully', () => {
    seedMeet(db)

    // No Gemini keys set
    saveSMB(smbPath, backend)

    // Restore
    restoreSMB(smbPath, backend)

    // Should not have any Gemini keys
    const free = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get()
    expect(free).toBeUndefined()
  })
})