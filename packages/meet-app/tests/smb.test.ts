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
import { createTestDb, seedMeet } from './helpers'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { unlinkSync, existsSync } from 'fs'
import type Database from 'better-sqlite3'

// Import the SMB functions directly
import { saveSMB, restoreSMB, readZipEntries, decodeGbin } from '../src/main/smb'

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

  it('stamps BSAPPLICATION="Meet Manager - MEET" so real Splash accepts the file on reopen', () => {
    // Every real Splash-native .mdb sampled has this BSGLOBAL key; every .mdb that had one of
    // our own .smb backups restored into it was missing it (we never wrote it) — and Splash threw
    // a generic "invalid data" error the next time it reopened such a file, despite the restore
    // itself and that same session's usage working fine. Always stamp it on export.
    saveSMB(smbPath, db)
    db.exec('DELETE FROM bsglobal')
    restoreSMB(smbPath, db)

    const row = db.prepare(`SELECT data FROM bsglobal WHERE name='BSAPPLICATION'`).get() as { data: string } | undefined
    expect(row?.data).toBe('Meet Manager - MEET')
  })

  it('does not duplicate BSAPPLICATION if already present in our own bsglobal', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('BSAPPLICATION', 'Meet Manager - MEET')`).run()
    saveSMB(smbPath, db)
    db.exec('DELETE FROM bsglobal')
    restoreSMB(smbPath, db)

    const rows = db.prepare(`SELECT data FROM bsglobal WHERE name='BSAPPLICATION'`).all() as { data: string }[]
    expect(rows.length).toBe(1)
    expect(rows[0].data).toBe('Meet Manager - MEET')
  })

  it('handles empty database gracefully', () => {
    // No data seeded — save should still work. RECORDAGEGROUP's single sentinel row
    // (see saveSMB's `tableName === 'recordagegroup'` case) is always present regardless
    // of content, and BSGLOBAL always gets a synthesized BSAPPLICATION row (see
    // `tableName === 'bsglobal'` case), so an otherwise-empty database produces exactly 2 rows.
    const result = saveSMB(smbPath, db)
    expect(existsSync(smbPath)).toBe(true)
    expect(result.rows).toBe(2)
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

  it('rewrites dsqitem.options to the safe default instead of overflowing OPTIONS;S;5', () => {
    // Our own dsqitem.options stores a human-readable tag list (see config/dsq-codes.json),
    // consumed by scripts/generate_dsq_xml.py — but that overflows Splash's real 5-char
    // OPTIONS gbin column and breaks restore into real Splash. saveSMB must rewrite it.
    db.prepare(
      `INSERT INTO dsqitem (dsqitemid, code, lenexcode, name, options, sortcode) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(4001, '1', '1', 'Test DSQ', 'INDIVIDUAL,RELAY', 1)

    saveSMB(smbPath, db)

    db.exec('DELETE FROM dsqitem')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT options FROM dsqitem WHERE dsqitemid=4001').get() as { options: string }
    expect(row.options).toBe('00000')
  })

  it('round-trips RELAY.athletes/relaycode values that overflow a 16-bit field', () => {
    // Real Splash (≥11.84174) declares these I;32, not I;16 — a 16-bit encode throws
    // (Buffer.writeInt16LE range error) once a value exceeds 32767.
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle Relay', 4, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode) VALUES (100, 1, 1, 10, 2, 5, 1)`)
    db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'CLB', 'Club')`)
    db.prepare(
      `INSERT INTO relay (relayid, clubid, swimeventid, athletes, relaycode) VALUES (?, ?, ?, ?, ?)`
    ).run(1, 1, 100, 40000, 99999)

    expect(() => saveSMB(smbPath, db)).not.toThrow()

    db.exec('DELETE FROM relay')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT athletes, relaycode FROM relay WHERE relayid=1').get() as { athletes: number; relaycode: number }
    expect(row.athletes).toBe(40000)
    expect(row.relaycode).toBe(99999)
  })

  it('truncates an oversized S field with a warning instead of corrupting the gbin layout', () => {
    db.prepare(
      `INSERT INTO dsqitem (dsqitemid, code, lenexcode, name, options, sortcode) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(4002, '2', 'AVERYLONGLENEXCODETHATOVERFLOWS', 'Test DSQ 2', 'RELAY', 2)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    saveSMB(smbPath, db)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DSQITEM.LENEXCODE'))
    warnSpy.mockRestore()

    db.exec('DELETE FROM dsqitem')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT lenexcode FROM dsqitem WHERE dsqitemid=4002').get() as { lenexcode: string }
    expect(row.lenexcode).toBe('AVERYLONGL') // clamped to LENEXCODE;S;10 (byte length)
  })

  it('does not truncate an accented S field whose char count fits but byte count exceeds declared size', () => {
    // col.size for S columns is a max *character* count (Splash's Access/Jet Text field width),
    // not a UTF-8 byte count. French text full of accented characters (2 bytes each in UTF-8)
    // used to get clamped well before the real 250-char limit — see docs/GBIN_FORMAT.md.
    const name = 'é'.repeat(240) // 240 chars, 480 bytes — under the 250-char limit, over as bytes
    db.prepare(
      `INSERT INTO dsqitem (dsqitemid, code, lenexcode, name, options, sortcode) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(4003, '3', '3', name, 'RELAY', 3)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    saveSMB(smbPath, db)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()

    db.exec('DELETE FROM dsqitem')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT name FROM dsqitem WHERE dsqitemid=4003').get() as { name: string }
    expect(row.name).toBe(name)
  })

  it('includes relaysplit in save/restore (previously silently dropped)', () => {
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle Relay', 4, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode) VALUES (100, 1, 1, 10, 2, 5, 1)`)
    db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'CLB', 'Club')`)
    db.exec(`INSERT INTO relay (relayid, clubid, swimeventid) VALUES (1, 1, 100)`)
    db.prepare(`INSERT INTO relaysplit (relayid, distance, swimtime) VALUES (?, ?, ?)`).run(1, 25, 15230)

    saveSMB(smbPath, db)

    db.exec('DELETE FROM relaysplit')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT swimtime FROM relaysplit WHERE relayid=1 AND distance=25').get() as { swimtime: number } | undefined
    expect(row?.swimtime).toBe(15230)
  })

  it('backfills a NULL heat.agegroupid from its members before export (beach cross-age-group heats)', () => {
    // Beach heat generation pools entries across every age group in an event, so
    // heat.agegroupid is legitimately NULL in our own DB (see generateHeatsBeach, db.ts).
    // Real Splash crashes viewing a heat whose AGEGROUPID FK is null — saveSMB must
    // backfill a real value drawn from the heat's own members for export only.
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Beach Flags', 1, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode) VALUES (100, 1, 1, 10, 3, 5, 1)`)
    db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax, gender, sortcode) VALUES (500, 100, 10, 12, 3, 1)`)
    db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'CLB', 'Club')`)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname) VALUES (1, 1, 'A', 'B')`)
    // Heat with no agegroupid (beach's cross-age-group pooling)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 100, 1, 4, 100)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, agegroupid) VALUES (1, 1, 100, 1, 500)`)

    saveSMB(smbPath, db)

    db.exec('DELETE FROM heat')
    restoreSMB(smbPath, db)

    const row = db.prepare('SELECT agegroupid FROM heat WHERE heatid=1').get() as { agegroupid: number | null }
    expect(row.agegroupid).toBe(500)
  })

  it('exports RECORDLIST/RECORDAGEGROUP etc as present-but-empty gbin files, not omitted entirely', () => {
    // Real Splash apparently requires these record-checking tables to at least exist (even with
    // 0 rows) in a restored file — omitting them entirely crashed Splash's Results module with an
    // access violation the moment any heat was viewed, even with zero results entered. We have no
    // records-tracking feature, so these are always empty, but must be genuinely present.
    seedMeet(db)
    saveSMB(smbPath, db)

    const zipEntries = readZipEntries(smbPath)
    for (const t of ['RECORDLIST', 'RECORDAGEGROUP', 'RECORDLISTAGEGROUP', 'RECORD', 'RECORDSPLIT', 'RECORDPOSITION']) {
      expect(zipEntries.has(`${t}-0001.gbin`)).toBe(true)
    }

    // Restore must not error even though these tables have no backing table in our own schema
    expect(() => restoreSMB(smbPath, db)).not.toThrow()
  })

  it('remaps racestatus 4 (our "seeded, not validated") to Splash\'s own 2 on export, and back on restore', () => {
    // Confirmed by directly sampling three real, populated Splash competition databases via
    // Microsoft.ACE.OLEDB.12.0: real Splash never writes racestatus=4 for this state — it uses 2.
    // Writing 4 (our own internal encoding, see decodeHeatStatus()/validateHeat() in db.ts) into a
    // real Splash-format .smb was the actual cause of an access violation opening any heat in
    // Splash's Results module (THeat.VerifyStatus/UpdateStatus — the code that interprets this
    // field). 5 (validated) already matches Splash's own encoding and is untouched.
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode) VALUES (100, 1, 1, 10, 2, 5, 1)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 100, 1, 4, 100)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (2, 100, 2, 5, 200)`)

    saveSMB(smbPath, db)

    const zipEntries = readZipEntries(smbPath)
    const gbin = zipEntries.get('HEAT-0001.gbin')!
    const { rows: exportedRows } = decodeGbin(gbin)
    const exported1 = exportedRows.find((r) => r.heatid === 1) as { racestatus: number }
    const exported2 = exportedRows.find((r) => r.heatid === 2) as { racestatus: number }
    expect(exported1.racestatus).toBe(2)  // 4 → Splash's 2
    expect(exported2.racestatus).toBe(5)  // 5 unchanged

    db.exec('DELETE FROM heat')
    restoreSMB(smbPath, db)

    const restored1 = db.prepare('SELECT racestatus FROM heat WHERE heatid=1').get() as { racestatus: number }
    const restored2 = db.prepare('SELECT racestatus FROM heat WHERE heatid=2').get() as { racestatus: number }
    expect(restored1.racestatus).toBe(4)  // round-trips back to our canonical 4
    expect(restored2.racestatus).toBe(5)
  })
})