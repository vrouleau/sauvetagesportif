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

// Relay entry time + HC (exhibition) across the LXF round trip:
// - entries import: ENTRY status="EXH" -> resultstatus=4 (individual and relay),
//   relay ENTRY entrytime -> relay.entrytime (seeds relay heats)
// - results export: each relay's result as RELAY > RESULTS > RESULT (team total,
//   status, the members who swam it), with relay-only swimmers as ATHLETEs —
//   team-app archives it as relay history.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import { importLenex, exportLenexResults, readZipEntries, writeZipSingleEntry } from '../src/main/lenex'

function tmpPath(tag: string): string {
  return join(tmpdir(), `relay-hc-${tag}-${randomBytes(4).toString('hex')}.lxf`)
}

function importXml(db: Database.Database, xml: string): void {
  const p = tmpPath('in')
  writeZipSingleEntry(p, 'meet.lef', xml)
  try { importLenex(p, db) } finally { try { unlinkSync(p) } catch { /* ignore */ } }
}

const STRUCTURE = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Test Meet" city="X" nation="CAN" course="LCM">
  <SESSIONS><SESSION number="1" name="Session 1"><EVENTS>
    <EVENT eventid="100" number="1" gender="F" round="TIM">
      <SWIMSTYLE swimstyleid="501" distance="50" relaycount="1" name="50 Libre" />
      <AGEGROUPS><AGEGROUP agegroupid="1000" name="Open" agemin="19" agemax="-1" gender="F" /></AGEGROUPS>
    </EVENT>
    <EVENT eventid="200" number="2" gender="F" round="TIM">
      <SWIMSTYLE swimstyleid="506" distance="200" relaycount="4" name="4x50 Relais" />
      <AGEGROUPS><AGEGROUP agegroupid="2000" name="Open" agemin="19" agemax="-1" gender="F" /></AGEGROUPS>
    </EVENT>
  </EVENTS></SESSION></SESSIONS>
</MEET></MEETS></LENEX>`

function entries(athleteEntryStatus: string, relayEntryAttrs: string): string {
  const athletes = [1, 2, 3, 4].map(i =>
    `<ATHLETE athleteid="50${i}" firstname="F${i}" lastname="L${i}" birthdate="2000-01-0${i}" gender="F">
       <ENTRIES><ENTRY eventid="100" agegroupid="1000" entrytime="00:00:3${i}.00"${i === 1 ? athleteEntryStatus : ''} /></ENTRIES>
     </ATHLETE>`).join('')
  const positions = [1, 2, 3, 4].map(i => `<RELAYPOSITION number="${i}" athleteid="50${i}" />`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Test Meet" city="X" nation="CAN" course="LCM">
  <CLUBS><CLUB clubid="1" code="TST" name="Test Club"><ATHLETES>${athletes}</ATHLETES>
    <RELAYS><RELAY number="1" gender="F"><ENTRIES>
      <ENTRY eventid="200"${relayEntryAttrs}><RELAYPOSITIONS>${positions}</RELAYPOSITIONS></ENTRY>
    </ENTRIES></RELAY></RELAYS>
  </CLUB></CLUBS>
</MEET></MEETS></LENEX>`
}

describe('entries import: relay entry time and EXH status', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    importXml(db, STRUCTURE)
  })
  afterEach(() => cleanup())

  it('imports ENTRY status="EXH" as resultstatus=4 for an individual entry', () => {
    importXml(db, entries(' status="EXH"', ''))
    const rows = db.prepare(
      `SELECT a.externalid, sr.resultstatus FROM swimresult sr JOIN athlete a ON a.athleteid = sr.athleteid
       WHERE sr.swimeventid = 100 ORDER BY a.externalid`
    ).all() as Array<{ externalid: string; resultstatus: number | null }>
    expect(rows.map(r => r.resultstatus)).toEqual([4, null, null, null])
  })

  it('imports a relay ENTRY entrytime and status="EXH" onto the relay row', () => {
    importXml(db, entries('', ' entrytime="00:02:05.43" status="EXH"'))
    const relay = db.prepare(`SELECT entrytime, resultstatus FROM relay WHERE swimeventid = 200`).get() as
      { entrytime: number | null; resultstatus: number | null }
    expect(relay).toEqual({ entrytime: 125430, resultstatus: 4 })
  })

  it('leaves a normal relay entry with no status', () => {
    importXml(db, entries('', ' entrytime="00:02:05.43"'))
    const relay = db.prepare(`SELECT resultstatus FROM relay WHERE swimeventid = 200`).get() as { resultstatus: number | null }
    expect(relay.resultstatus).toBeNull()
  })
})

describe('results export: relay results', () => {
  let db: Database.Database
  let cleanup: () => void
  let outPath: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    outPath = tmpPath('out')
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (501, 50, 'Libre', 1, 1), (506, 200, 'Relais', 4, 1)`)
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent)
             VALUES (10, 1, 501, 1, 2, 1, 'F'), (20, 1, 506, 2, 2, 2, 'F')`)
    db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`)
    for (let i = 1; i <= 4; i++) {
      db.prepare(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation)
                  VALUES (?, 1, ?, ?, 2, '2000-01-01', 'CAN')`).run(i, `F${i}`, `L${i}`)
    }
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 10, 1, 5), (2, 20, 1, 5)`)
    // Only athlete 1 swam an individual event; 2-4 swam the relay only.
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, swimtime) VALUES (30, 1, 10, 1, 4, 31000)`)
  })
  afterEach(() => {
    cleanup()
    try { unlinkSync(outPath) } catch { /* not written */ }
  })

  function addRelay(relayid: number, heatid: number | null, swimtime: number | null, status: number | null) {
    db.prepare(`INSERT INTO relay (relayid, clubid, swimeventid, teamnumber, heatid, lane, swimtime, resultstatus)
                VALUES (?, 1, 20, ?, ?, 3, ?, ?)`).run(relayid, relayid - 40, heatid, swimtime, status)
    for (let i = 1; i <= 4; i++) {
      db.prepare(`INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (?, ?, ?)`).run(relayid, i, i)
    }
  }

  function exportXml(): string {
    exportLenexResults(outPath, db)
    const entries = readZipEntries(outPath)
    const lef = [...entries.keys()].find(n => n.endsWith('.lef'))!
    return entries.get(lef)!.toString('utf8')
  }

  it('writes RELAY > RESULTS > RESULT with the team total and members', () => {
    addRelay(41, 2, 121500, null)
    const xml = exportXml()
    const relay = xml.slice(xml.indexOf('<RELAY '), xml.indexOf('</RELAY>'))
    expect(relay).toMatch(/<RESULT resultid="41" eventid="20" heatid="2" lane="3" swimtime="00:02:01\.50">/)
    const resultBlock = relay.slice(relay.indexOf('<RESULTS>'))
    for (let i = 1; i <= 4; i++) {
      expect(resultBlock).toContain(`<RELAYPOSITION number="${i}" athleteid="${i}" />`)
    }
  })

  it('writes relay-only swimmers as ATHLETE elements', () => {
    addRelay(41, 2, 121500, null)
    const xml = exportXml()
    for (let i = 1; i <= 4; i++) {
      expect(xml).toMatch(new RegExp(`<ATHLETE athleteid="${i}" `))
    }
  })

  it('writes the relay status (EXH) with its time', () => {
    addRelay(41, 2, 121500, 4)
    expect(exportXml()).toMatch(/swimtime="00:02:01\.50" status="EXH">/)
  })

  it('writes no result for a relay whose heat is not validated', () => {
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (3, 20, 2, 4)`)
    addRelay(42, 3, 121500, null)
    const xml = exportXml()
    expect(xml).not.toContain('resultid="42"')
    expect(xml).not.toMatch(/<ATHLETE athleteid="2" /)  // relay-only swimmer of an unvalidated relay
  })
})
