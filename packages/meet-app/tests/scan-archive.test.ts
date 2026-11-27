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
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyScansTo, writeArchiveMeta, readArchiveInfo, replaceScansFromArchive, archiveFileName,
  InvalidScanArchiveError,
} from '../src/main/scanArchive'

// Same columns as timingScanDb.ts (SCHEMA_SQL), which can't be imported here (it needs electron).
const SCAN_TABLE = `
CREATE TABLE timing_scan (
  scan_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_number INTEGER NOT NULL, swim_event_id INTEGER NOT NULL, heat_number INTEGER NOT NULL, lane INTEGER NOT NULL,
  barcode_raw TEXT NOT NULL, image_blob BLOB NOT NULL, scanned_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unprocessed',
  recognized_time1 TEXT, recognized_time2 TEXT, validated_time1 TEXT, validated_time2 TEXT,
  time_ms1 INTEGER, time_ms2 INTEGER, ocr_engine TEXT, ocr_raw TEXT, ocr_confidence REAL,
  processed_at TEXT, validated_at TEXT, notes TEXT
)`

const META = { meetName: 'Invitation Provinciale', meetType: 'POOL', savedAt: '2026-11-28T10:00:00.000Z' }

let dir: string
let db: Database.Database

function addScan(d: Database.Database, barcode: string, status: string, bytes: number[]): void {
  d.prepare(`INSERT INTO timing_scan (event_number, swim_event_id, heat_number, lane, barcode_raw, image_blob, scanned_at, status, ocr_raw)
             VALUES (7, 4054, 1, 2, ?, ?, 'now', ?, 'C1:0:42.38')`).run(barcode, Buffer.from(bytes), status)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-archive-'))
  db = new Database(join(dir, 'timing_scans.sqlite'))
  db.exec(SCAN_TABLE)
  addScan(db, 'E7-U4054-H1-L2', 'validated', [1, 2, 3])
  addScan(db, 'E7-U4054-H2-L2', 'recognized', [4, 5])
  addScan(db, 'BLANK-RPDJ-01', 'unprocessed', [6])
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('save', () => {
  it('writes a copy of every scan plus the meet it came from, and describes it', () => {
    const file = join(dir, 'meet.scans')
    copyScansTo(db, file)
    const a = new Database(file)
    writeArchiveMeta(a, META)
    expect(readArchiveInfo(a)).toEqual({ ...META, total: 3, validated: 1, pending: 2 })
    a.close()
  })

  it('refuses to overwrite an existing file (the caller removes it first)', () => {
    const file = join(dir, 'meet.scans')
    copyScansTo(db, file)
    expect(() => copyScansTo(db, file)).toThrow()
  })

  it('handles a path with an apostrophe', () => {
    const file = join(dir, "l'archive.scans")
    copyScansTo(db, file)
    expect(existsSync(file)).toBe(true)
  })
})

describe('load', () => {
  function makeArchive(): string {
    const file = join(dir, 'meet.scans')
    copyScansTo(db, file)
    const a = new Database(file)
    writeArchiveMeta(a, META)
    a.close()
    return file
  }

  it('replaces the current scans, keeping scan ids and image bytes', () => {
    const file = makeArchive()
    const other = new Database(join(dir, 'other.sqlite'))
    other.exec(SCAN_TABLE)
    addScan(other, 'OLD-1', 'validated', [9, 9, 9, 9])
    addScan(other, 'OLD-2', 'unprocessed', [8])

    expect(replaceScansFromArchive(other, file)).toBe(3)
    const rows = other.prepare('SELECT scan_id, barcode_raw, status, ocr_raw, image_blob FROM timing_scan ORDER BY scan_id').all() as Array<{
      scan_id: number; barcode_raw: string; status: string; ocr_raw: string; image_blob: Buffer
    }>
    expect(rows.map((r) => [r.scan_id, r.barcode_raw, r.status])).toEqual([
      [1, 'E7-U4054-H1-L2', 'validated'], [2, 'E7-U4054-H2-L2', 'recognized'], [3, 'BLANK-RPDJ-01', 'unprocessed'],
    ])
    expect([...rows[0].image_blob]).toEqual([1, 2, 3])
    expect(rows[0].ocr_raw).toBe('C1:0:42.38')
    other.close()
  })

  it('detaches the archive afterwards, so the file is not left locked', () => {
    const file = makeArchive()
    replaceScansFromArchive(db, file)
    expect(() => db.exec('DETACH DATABASE scan_archive')).toThrow()
  })

  it('loads an archive from an older schema by the columns both sides have', () => {
    const old = new Database(join(dir, 'old.scans'))
    old.exec(`CREATE TABLE timing_scan (scan_id INTEGER PRIMARY KEY AUTOINCREMENT, event_number INTEGER NOT NULL, swim_event_id INTEGER NOT NULL,
      heat_number INTEGER NOT NULL, lane INTEGER NOT NULL, barcode_raw TEXT NOT NULL, image_blob BLOB NOT NULL, scanned_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unprocessed', validated_time1 TEXT)`)
    old.exec(`INSERT INTO timing_scan (event_number, swim_event_id, heat_number, lane, barcode_raw, image_blob, scanned_at, status, validated_time1)
              VALUES (2, 2, 7, 2, 'E2-U2-H7-L2', x'ffd8', 'then', 'validated', '0:42.38')`)
    // no metadata table: still readable, meet unknown
    expect(readArchiveInfo(old)).toEqual({ meetName: '', meetType: '', savedAt: '', total: 1, validated: 1, pending: 0 })
    old.close()

    expect(replaceScansFromArchive(db, join(dir, 'old.scans'))).toBe(1)
    expect(db.prepare('SELECT barcode_raw, validated_time1, ocr_raw FROM timing_scan').all()).toEqual([
      { barcode_raw: 'E2-U2-H7-L2', validated_time1: '0:42.38', ocr_raw: null },
    ])
  })

  it('is all or nothing: a load that cannot complete keeps the current scans', () => {
    const file = makeArchive()
    const strict = new Database(join(dir, 'strict.sqlite'))
    strict.exec(`CREATE TABLE timing_scan (scan_id INTEGER PRIMARY KEY, event_number INTEGER NOT NULL, swim_event_id INTEGER NOT NULL,
      heat_number INTEGER NOT NULL, lane INTEGER NOT NULL, barcode_raw TEXT NOT NULL, image_blob BLOB NOT NULL, scanned_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unprocessed', required_but_missing TEXT NOT NULL)`)
    strict.exec(`INSERT INTO timing_scan VALUES (1, 1, 1, 1, 1, 'KEEP-ME', x'00', 't', 'validated', 'x')`)

    expect(() => replaceScansFromArchive(strict, file)).toThrow()
    expect(strict.prepare('SELECT barcode_raw FROM timing_scan').all()).toEqual([{ barcode_raw: 'KEEP-ME' }])
    expect(() => strict.exec('DETACH DATABASE scan_archive')).toThrow() // already detached
    strict.close()
  })
})

describe('invalid files', () => {
  it('a text file is not an archive', () => {
    const file = join(dir, 'junk.scans')
    writeFileSync(file, 'this is not a database')
    const d = new Database(file)
    expect(() => readArchiveInfo(d)).toThrow(InvalidScanArchiveError)
    d.close()
  })

  it('an SQLite file without a timing_scan table is not an archive', () => {
    const d = new Database(join(dir, 'other.scans'))
    d.exec('CREATE TABLE something_else (a)')
    expect(() => readArchiveInfo(d)).toThrow(InvalidScanArchiveError)
    d.close()
  })
})

describe('archiveFileName', () => {
  const day = new Date('2026-11-28T15:00:00Z')

  it('is fiches-<meet>-<date>.scans, safe on every OS', () => {
    expect(archiveFileName('Coupe Québec / Piscine!', day)).toBe('fiches-Coupe-Quebec-Piscine-2026-11-28.scans')
    expect(archiveFileName('', day)).toBe('fiches-2026-11-28.scans')
  })

  it('cuts long names at 40 characters without leaving a trailing dash', () => {
    expect(archiveFileName('Invitation Provinciale Novembre 2026 — Québec/Piscine!', day))
      .toBe('fiches-Invitation-Provinciale-Novembre-2026-Que-2026-11-28.scans')
    expect(archiveFileName('A'.repeat(39) + ' B', day)).toBe(`fiches-${'A'.repeat(39)}-2026-11-28.scans`)
  })
})
