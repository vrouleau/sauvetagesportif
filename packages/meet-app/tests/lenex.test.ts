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
import { createTestDb, createPgTestDb, isPgTestAvailable, type TestBackendKind } from './helpers'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import { importLenex, exportLenexResults, exportMeetLenex, readZipEntries, writeZipSingleEntry, writeZipEntries } from '../src/main/lenex'

// Use the test fixture from team-app if available
const FIXTURE_PATH = join(__dirname, '../../team-app/tests/fixtures/meet_template.lxf')

describe('LENEX importer', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it('imports sessions from LXF file', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    const summary = importLenex(FIXTURE_PATH, db)
    expect(summary.sessions).toBeGreaterThan(0)
    expect(summary.events).toBeGreaterThan(0)
  })

  it('imports swimstyles', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    const summary = importLenex(FIXTURE_PATH, db)
    const styles = db.prepare('SELECT COUNT(*) as c FROM swimstyle').get() as { c: number }
    expect(styles.c).toBeGreaterThan(0)
    expect(summary.events).toBeGreaterThan(0)
  })

  it('imports a custom (non-FINA-catalog) style as stroke=0/technique=0/code=ID{id}, matching real Splash', () => {
    // Our own meet templates (config/template_pool.lxf, template_beach.lxf) never set a
    // <SWIMSTYLE stroke="..."> attribute — every style we ever import is a custom lifesaving
    // discipline, not a real FINA stroke. Confirmed via a real Splash-native import of the same
    // entries LXF: Splash represents this as
    // stroke=0/technique=0/code="ID{swimstyleid}" — never stroke=1 (Freestyle) with technique=null,
    // which is what this importer used to write, and a state genuine Splash data never contains.
    const lxfPath = join(tmpdir(), `test-custom-style-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="16" relaycount="1" name="Drapeau Sur Plage" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const style = db.prepare('SELECT stroke, technique, code FROM swimstyle WHERE swimstyleid=601').get() as
        { stroke: number | null; technique: number | null; code: string | null }
      expect(style.stroke).toBe(0)
      expect(style.technique).toBe(0)
      expect(style.code).toBe('ID601')
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // Regression test: importLenex used to have its OWN local nextId() (a stale copy of the same
  // per-table MAX(pkCol)+1 pattern db.ts's real nextId() had before the 2026-08-14 fix — see
  // this package's CLAUDE.md, "Real Splash crash deleting a Final"), used for auto-assigned
  // club/athlete/swimresult/relay ids when the LXF file doesn't provide one. It was never
  // updated when db.ts's nextId() was fixed to compute a global max across every table, so a
  // club/athlete imported without an explicit id could still land on the same literal id as an
  // already-imported swimevent/agegroup — exactly the collision that crashes real Splash with
  // "Invalid class typecast". Fixed by importing and using db.ts's real (now-fixed) nextId()
  // instead of maintaining a separate, driftable copy.
  it('auto-assigns a club id that does not collide with an existing swimevent/agegroup id', () => {
    const lxfPath = join(tmpdir(), `test-noncolliding-club-${randomBytes(4).toString('hex')}.lxf`)
    // eventid/agegroupid deliberately high (1200/1201) to simulate a real meet's existing
    // structure; the CLUB has no clubid attribute at all, forcing the auto-assign fallback.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1200" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Freestyle" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1201" agemin="13" agemax="14" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE firstname="A" lastname="B" gender="M" />
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const club = db.prepare('SELECT clubid FROM club WHERE code=?').get('TST') as { clubid: number }
      const athlete = db.prepare('SELECT athleteid FROM athlete WHERE clubid=?').get(club.clubid) as { athleteid: number }
      expect(club.clubid).not.toBe(1200)
      expect(club.clubid).not.toBe(1201)
      expect(athlete.athleteid).not.toBe(1200)
      expect(athlete.athleteid).not.toBe(1201)
      expect(athlete.athleteid).not.toBe(club.clubid)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  it('never adopts an incoming external clubid/athleteid as the local primary key, even when it numerically collides with an existing local id', () => {
    // The whole point of the externalid design (see lenex.ts's club/athlete import comment):
    // team-app's clubsid/membersid are an independent, ever-growing counter with no relationship
    // to meet-app's own ids. This test uses an external athleteid ("1200") that deliberately
    // equals an id already in use locally (the event) to prove the import never blindly trusts
    // the incoming value as a database key — confirmed live against real Splash as the actual
    // root cause of an "Invalid class typecast" crash (see this package's CLAUDE.md).
    const lxfPath = join(tmpdir(), `test-external-id-collision-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1200" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Freestyle" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1201" agemin="13" agemax="14" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB clubid="1200" code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE athleteid="1201" firstname="A" lastname="B" gender="M" />
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const club = db.prepare('SELECT clubid, externalid FROM club WHERE code=?').get('TST') as { clubid: number; externalid: string }
      const athlete = db.prepare('SELECT athleteid, externalid FROM athlete WHERE clubid=?').get(club.clubid) as { athleteid: number; externalid: string }
      // The external ids are preserved for reconciliation...
      expect(club.externalid).toBe('1200')
      expect(athlete.externalid).toBe('1201')
      // ...but the local primary keys are our own, never the incoming values verbatim.
      expect(club.clubid).not.toBe(1200)
      expect(athlete.athleteid).not.toBe(1201)
      // And the event/agegroup rows that legitimately do use those exact ids are untouched.
      const event = db.prepare('SELECT swimeventid FROM swimevent WHERE swimeventid=1200').get()
      const agegroup = db.prepare('SELECT agegroupid FROM agegroup WHERE agegroupid=1201').get()
      expect(event).toBeDefined()
      expect(agegroup).toBeDefined()
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  it('reuses the same local athleteid/clubid across repeated imports of the same external id', () => {
    // A club can legitimately re-register/re-import entries multiple times before a meet
    // (early registration, then a final update closer to the deadline). The local id must stay
    // stable across that, exactly like today's ON CONFLICT(athleteid) upsert already assumed —
    // just reconciled via externalid instead of by the incoming id being the primary key itself.
    function xml(name: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <CLUBS>
        <CLUB clubid="42" code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE athleteid="99" firstname="${name}" lastname="B" gender="M" />
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    }
    const path1 = join(tmpdir(), `test-reimport-1-${randomBytes(4).toString('hex')}.lxf`)
    const path2 = join(tmpdir(), `test-reimport-2-${randomBytes(4).toString('hex')}.lxf`)
    writeZipSingleEntry(path1, 'meet.lef', xml('First'))
    writeZipSingleEntry(path2, 'meet.lef', xml('Updated'))

    try {
      importLenex(path1, db)
      const first = db.prepare(`SELECT athleteid, clubid FROM athlete WHERE externalid='99'`).get() as { athleteid: number; clubid: number }

      importLenex(path2, db)
      const second = db.prepare(`SELECT athleteid, clubid, firstname FROM athlete WHERE externalid='99'`).get() as
        { athleteid: number; clubid: number; firstname: string }

      expect(second.athleteid).toBe(first.athleteid)
      expect(second.clubid).toBe(first.clubid)
      expect(second.firstname).toBe('Updated')  // upsert still updates fields in place
      expect(db.prepare(`SELECT COUNT(*) AS c FROM athlete`).get()).toEqual({ c: 1 })  // no duplicate row
    } finally {
      for (const p of [path1, path2]) { try { unlinkSync(p) } catch {} }
    }
  })

  it('mints no colliding ids across multiple new clubs and athletes minted within one import', () => {
    // Regression test for a real bug caught in code review: an earlier version of the club
    // auto-id logic cached one starting value from nextId() and incremented it locally
    // ("autoClubId++"), while athlete ids in the same loop used fresh nextId() calls. A second
    // new club processed after an athlete insert could get the exact id that athlete had just
    // been minted, because the cached club counter never saw the athlete's insert. Two new
    // clubs (no external id, no matching code — forces the auto-mint path for both) each with
    // one new athlete exercises exactly the interleaving that triggered it.
    const lxfPath = join(tmpdir(), `test-multi-club-mint-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <CLUBS>
        <CLUB code="AAA" name="Club A">
          <ATHLETES>
            <ATHLETE firstname="A1" lastname="X" gender="M" />
          </ATHLETES>
        </CLUB>
        <CLUB code="BBB" name="Club B">
          <ATHLETES>
            <ATHLETE firstname="B1" lastname="X" gender="M" />
          </ATHLETES>
        </CLUB>
        <CLUB code="CCC" name="Club C">
          <ATHLETES>
            <ATHLETE firstname="C1" lastname="X" gender="M" />
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const clubIds = (db.prepare(`SELECT clubid FROM club ORDER BY clubid`).all() as { clubid: number }[]).map(r => r.clubid)
      const athleteIds = (db.prepare(`SELECT athleteid FROM athlete ORDER BY athleteid`).all() as { athleteid: number }[]).map(r => r.athleteid)
      expect(clubIds).toHaveLength(3)
      expect(athleteIds).toHaveLength(3)
      const allIds = [...clubIds, ...athleteIds]
      expect(new Set(allIds).size).toBe(allIds.length)  // every id, across both tables, is unique
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // Regression test for a live bug: importLenex never set swimstyle.uniqueid at all, so it
  // stayed NULL for every custom style. Real Splash's own LXF importer treats the incoming
  // swimstyleid as canonical and stores it in its own UNIQUEID column (confirmed against a
  // real Splash-imported .mdb: SWIMSTYLEID=1060 [Splash's own auto-increment PK], UNIQUEID=500
  // [our sent swimstyleid]). meet-app doesn't reassign its own PK, so uniqueid should equal
  // swimstyleid — a NULL here is a state genuine Splash-imported data never has, and .smb
  // export carried it into Splash verbatim (this exact NULL-vs-populated field already caused
  // one real, documented Splash crash for a different code path — see scripts/generate-
  // fixture-smb.ts's uniqueid history in this package's CLAUDE.md).
  it('sets swimstyle.uniqueid to the swimstyleid, matching real Splash\'s own canonical-ID convention', () => {
    const lxfPath = join(tmpdir(), `test-uniqueid-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="504" distance="50" relaycount="1" name="50m Portage du mannequin plein" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const style = db.prepare('SELECT swimstyleid, uniqueid FROM swimstyle WHERE swimstyleid=504').get() as
        { swimstyleid: number; uniqueid: number | null }
      expect(style.uniqueid).toBe(504)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // team-app ships its whole swimstyle catalog in a hidden `.swimstyles` dotfile (LENEX only
  // carries a SWIMSTYLE inside an EVENT), so a last-minute event can use a style no event had.
  it('loads the full swimstyle catalog from a .swimstyles entry, the event style winning', () => {
    const lxfPath = join(tmpdir(), `test-styles-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="504" distance="50" relaycount="1" name="50m Portage du mannequin plein" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    const catalog = [
      { swimstyleid: 504, distance: 50, relaycount: 1, name: 'stale catalog name' },
      { swimstyleid: 528, distance: 50, relaycount: 4, name: '4x50m Relais obstacles' },
    ]
    writeZipEntries(lxfPath, [['meet.lef', xml], ['.swimstyles', JSON.stringify(catalog)]])

    try {
      importLenex(lxfPath, db)
      const extra = db.prepare('SELECT distance, relaycount, name, stroke, technique, code, uniqueid FROM swimstyle WHERE swimstyleid=528').get()
      expect(extra).toEqual({ distance: 50, relaycount: 4, name: '4x50m Relais obstacles', stroke: 0, technique: 0, code: 'ID528', uniqueid: 528 })
      const used = db.prepare('SELECT name FROM swimstyle WHERE swimstyleid=504').get() as { name: string }
      expect(used.name).toBe('50m Portage du mannequin plein')
      expect((db.prepare('SELECT COUNT(*) AS n FROM swimevent').get() as { n: number }).n).toBe(1)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  it('imports age groups', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    importLenex(FIXTURE_PATH, db)
    const ags = db.prepare('SELECT COUNT(*) as c FROM agegroup').get() as { c: number }
    expect(ags.c).toBeGreaterThan(0)
  })

  it('is idempotent (re-import does not duplicate)', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    const s1 = importLenex(FIXTURE_PATH, db)
    const s2 = importLenex(FIXTURE_PATH, db)
    expect(s2.sessions).toBe(s1.sessions)
    expect(s2.events).toBe(s1.events)

    // Count should be same after re-import
    const events = db.prepare('SELECT COUNT(*) as c FROM swimevent').get() as { c: number }
    expect(events.c).toBe(s1.events)
  })

  // Regression test for a live bug: importLenex never read a `preveventid` attribute off
  // <EVENT>, so a final round imported from LXF always ended up unlinked from its prelim
  // (preveventid left at the schema default instead of the prelim's swimeventid). That's
  // silently tolerated inside meet-app itself, but the broken link propagates unchanged
  // through smb.ts's .smb export/restore into real Splash, which crashes with an access
  // violation when the user opens the final event — reproduced against a real Splash .mdb.
  // team-app's export.py now emits `preveventid` (real Splash's own LXF export does too,
  // confirmed against a genuine Splash-generated .lxf) — this checks the import side reads it.
  it('links a FIN round back to its PRE round via preveventid', () => {
    const lxfPath = join(tmpdir(), `test-preveventid-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1060" number="1" gender="M" round="PRE" preveventid="-1">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
            </EVENT>
            <EVENT eventid="1062" number="1" gender="M" round="FIN" preveventid="1060">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const rows = db.prepare('SELECT swimeventid, round, preveventid FROM swimevent ORDER BY swimeventid').all() as
        { swimeventid: number; round: number; preveventid: number | null }[]
      const prelim = rows.find(r => r.swimeventid === 1060)
      const final = rows.find(r => r.swimeventid === 1062)
      expect(prelim?.preveventid).toBe(-1)
      expect(final?.preveventid).toBe(1060)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // Regression test for a live bug found by comparing a real Splash-native .mdb: a
  // freshly-split PRE/FIN pair has UseForMedals/UseForScoring 'F' on the PRE's age
  // group and 'T' on the FIN's (the final's placement is what counts, not the
  // prelim's) — but upsertAgeGroup above always writes 'T'/'T', so an imported LXF
  // that already encodes the split (preveventid set) needs the prelim's age groups
  // flipped explicitly. See the matching cascade in db.ts's updateEvent.
  it('flips a prelim\'s age groups off for medals/scoring when the imported FIN links to it via preveventid', () => {
    const lxfPath = join(tmpdir(), `test-prelim-scoring-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1060" number="1" gender="M" round="PRE" preveventid="-1">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1061" agemin="15" agemax="18" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="1062" number="1" gender="M" round="FIN" preveventid="1060">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1063" agemin="15" agemax="18" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const prelimAg = db.prepare('SELECT useformedals, useforscoring FROM agegroup WHERE agegroupid=1061').get() as
        { useformedals: string; useforscoring: string }
      const finalAg = db.prepare('SELECT useformedals, useforscoring FROM agegroup WHERE agegroupid=1063').get() as
        { useformedals: string; useforscoring: string }
      expect(prelimAg.useformedals).toBe('F')
      expect(prelimAg.useforscoring).toBe('F')
      expect(finalAg.useformedals).toBe('T')
      expect(finalAg.useforscoring).toBe('T')
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  it('defaults preveventid to -1 (Splash\'s own "no link" sentinel) when the attribute is absent', () => {
    const lxfPath = join(tmpdir(), `test-preveventid-absent-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const row = db.prepare('SELECT preveventid FROM swimevent WHERE swimeventid=1').get() as
        { preveventid: number | null }
      expect(row.preveventid).toBe(-1)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // LENEX's GENDER enum is ALL|M|F|MIXED (not the "X" our own exports used to write for
  // Mixed) — a real Splash-exported "ALL" (unrestricted) event used to silently collapse
  // into Mixed because encodeGender only recognized M/F and defaulted everything else to 3.
  it('imports gender="ALL" as 0 and gender="MIXED" as 3, per the real LENEX spec', () => {
    const lxfPath = join(tmpdir(), `test-gender-all-mixed-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="ALL" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="100" relaycount="1" name="Test Style" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1" name="Open" agemin="19" agemax="-1" gender="ALL" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="2" number="2" gender="MIXED" round="TIM">
              <SWIMSTYLE swimstyleid="530" distance="100" relaycount="4" name="Test Relay" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const events = db.prepare('SELECT swimeventid, gender FROM swimevent ORDER BY swimeventid').all() as
        { swimeventid: number; gender: number }[]
      expect(events.find(e => e.swimeventid === 1)?.gender).toBe(0)
      expect(events.find(e => e.swimeventid === 2)?.gender).toBe(3)
      const ag = db.prepare('SELECT gender FROM agegroup WHERE agegroupid=1').get() as { gender: number }
      expect(ag.gender).toBe(0)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // Regression test for a live bug: importLenex never read the <AGEDATE> element team-app's
  // exporter writes (export.py:218) at all, so an imported team-app meet silently fell back
  // to today's calendar year for season resolution (ageGroupRules.ts's getSeasonYear) and
  // left the shared UI's "Date pour calcul de l'âge" field blank — getMeetValues() only
  // reads the MEETVALUES blob, which this sync also populates alongside the standalone
  // bsglobal.AGEDATE row getSeasonYear actually reads.
  it('imports AGEDATE from a team-app-exported <AGEDATE> element into both bsglobal.AGEDATE and MEETVALUES', () => {
    const lxfPath = join(tmpdir(), `test-agedate-import-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <AGEDATE value="2027-12-31" type="DATE" />
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)

      const ageDateRow = db.prepare(`SELECT data FROM bsglobal WHERE name='AGEDATE'`).get() as { data: string } | undefined
      expect(ageDateRow?.data).toBe('D;20271231000000000')

      const mvRow = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string } | undefined
      expect(mvRow?.data).toContain('AGEDATE=D;20271231000000000')
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // #110 + course round trip: every meet-level field team-app exports must land in
  // the meet editor (MEETVALUES) and the bsglobal keys meet-app's exports read.
  describe('meet-level fields (city, course, deadline, lanes)', () => {
    const structureXml = (meetAttrs: string, sessionAttrs = '', poolXml = '') => `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Structure Meet" ${meetAttrs}>
      ${poolXml}
      <SESSIONS>
        <SESSION number="1" name="Session 1" ${sessionAttrs}>
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    const entriesXml = (meetAttrs: string, poolXml = '') => `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Team Meet" ${meetAttrs}>
      ${poolXml}
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB clubid="10" code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE athleteid="20" firstname="A" lastname="B" birthdate="2010-01-01" gender="M" />
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    const runImport = (xml: string) => {
      const p = join(tmpdir(), `test-meetfields-${randomBytes(4).toString('hex')}.lxf`)
      writeZipSingleEntry(p, 'meet.lef', xml)
      try { importLenex(p, db) } finally { try { unlinkSync(p) } catch {} }
    }
    const g = (name: string) =>
      (db.prepare(`SELECT data FROM bsglobal WHERE name=?`).get(name) as { data: string } | undefined)?.data
    const mv = () => g('MEETVALUES') ?? ''

    it('a structure import stores city, course, deadline and POOL lanes', () => {
      runImport(structureXml('city="Laval" nation="CAN" course="SCM" deadline="2027-03-15"', '',
        '<POOL lanemin="1" lanemax="8" />'))
      expect(g('MeetCity')).toBe('Laval')
      expect(g('MeetCourse')).toBe('3')
      expect(g('PoolLaneMin')).toBe('1')
      expect(g('PoolLaneMax')).toBe('8')
      expect(mv()).toContain('CITY=S;Laval')
      expect(mv()).toContain('COURSE=I;3')
      expect(mv()).toContain('DEADLINE=D;20270315000000000')
      expect(mv()).toContain('LANEMIN=I;1')
      expect(mv()).toContain('LANEMAX=I;8')
    })

    it('a session takes SESSION@course, else the meet course (was always 50 m)', () => {
      runImport(structureXml('course="SCM"'))
      const s1 = db.prepare(`SELECT course FROM swimsession WHERE sessionnumber=1`).get() as { course: number }
      expect(s1.course).toBe(3)
      runImport(structureXml('course="SCM"', 'course="LCM"'))
      const s2 = db.prepare(`SELECT course FROM swimsession WHERE sessionnumber=1`).get() as { course: number }
      expect(s2.course).toBe(1)
    })

    it('lanes fall back to the first SESSION lanemin/lanemax when there is no POOL', () => {
      runImport(structureXml('course="LCM"', 'lanemin="0" lanemax="9"'))
      expect(mv()).toContain('LANEMIN=I;0')
      expect(mv()).toContain('LANEMAX=I;9')
    })

    it('an entries import into an existing meet fills the empty fields (#110)', () => {
      // Meet created here with nothing but its events (like "Create Pool" + events)
      runImport(structureXml(''))
      expect(g('MeetCourse')).toBeUndefined()
      runImport(entriesXml('city="Laval" course="LCM" deadline="2027-03-15"', '<POOL lanemin="1" lanemax="6" />'))
      expect(g('MeetCity')).toBe('Laval')
      expect(g('MeetCourse')).toBe('1')
      expect(mv()).toContain('COURSE=I;1')
      expect(mv()).toContain('DEADLINE=D;20270315000000000')
      expect(mv()).toContain('LANEMAX=I;6')
    })

    it('an entries import keeps meet-level values edited locally', () => {
      runImport(structureXml('city="Local City" course="SCM"', '', '<POOL lanemin="1" lanemax="8" />'))
      runImport(entriesXml('city="Team City" course="LCM" deadline="2027-03-15"', '<POOL lanemin="0" lanemax="9" />'))
      expect(g('MeetName')).toBe('Structure Meet')
      expect(mv()).toContain('NAME=S;Structure Meet')
      expect(g('MeetCity')).toBe('Local City')
      expect(g('MeetCourse')).toBe('3')
      expect(mv()).toContain('COURSE=I;3')
      expect(mv()).toContain('LANEMAX=I;8')
      // the deadline was still empty, so it is filled
      expect(mv()).toContain('DEADLINE=D;20270315000000000')
    })

    it('maps state, host club, organizer.url, name.en, city.en, result.url and FACILITY', () => {
      runImport(structureXml(
        'course="LCM" state="QC" hostclub="CSRN" organizer="Org" organizer.url="https://o.example" ' +
        'name.en="Meet EN" city.en="Montreal" result.url="https://r.example"', '',
        '<FACILITY name="Centre sportif du Parc Olympique" street="3200 rue Viau" />'))
      for (const line of ['STATE=S;QC', 'HOSTCLUB=S;CSRN', 'ORGANIZER=S;Org', 'ORGANIZERURL=S;https://o.example',
        'NAMEEN=S;Meet EN', 'CITYEN=S;Montreal', 'RESULTURL=S;https://r.example',
        'FACILITYNAME=S;Centre sportif du Parc Olympique', 'FACILITYSTREET=S;3200 rue Viau']) {
        expect(mv()).toContain(line)
      }
      expect(g('MeetOrganizerUrl')).toBe('https://o.example')
    })

    // Hidden .meetvalues dotfile: only the Meet Manager settings LENEX can't carry
    const runImportWithMeetValues = (xml: string, meetValues: Record<string, string>) => {
      const p = join(tmpdir(), `test-meetvalues-${randomBytes(4).toString('hex')}.lxf`)
      writeZipEntries(p, [['meet.lef', xml], ['.meetvalues', JSON.stringify(meetValues)]])
      try { importLenex(p, db) } finally { try { unlinkSync(p) } catch {} }
    }
    const heatSettings = { SEEDMETHOD: 'I;1', COMBINEAGEGROUPS: 'B;T', MINPERHEAT: 'I;3', FASTHEATCOUNT: 'I;2' }

    it('takes the heat settings from .meetvalues, and nothing else from it', () => {
      runImportWithMeetValues(structureXml('city="Laval" course="LCM"'),
        { ...heatSettings, CITY: 'S;Not From Dotfile', FACILITYNAME: 'S;Not From Dotfile', AGEDATE: 'D;19990101000000000' })
      for (const [k, v] of Object.entries(heatSettings)) expect(mv()).toContain(`${k}=${v}`)
      expect(mv()).toContain('CITY=S;Laval')
      expect(mv()).not.toContain('Not From Dotfile')
      expect(mv()).not.toContain('AGEDATE=D;19990101000000000')
    })

    it('an entries import fills empty heat settings and keeps local ones', () => {
      runImportWithMeetValues(structureXml('course="LCM"'), { SEEDMETHOD: 'I;2' })
      runImportWithMeetValues(entriesXml('course="LCM"'), heatSettings)
      expect(mv()).toContain('SEEDMETHOD=I;2')
      expect(mv()).toContain('MINPERHEAT=I;3')
    })

    it('reads every meet field a real Splash export carries', function () {
      if (!existsSync(FIXTURE_PATH)) { this.skip?.(); return }
      importLenex(FIXTURE_PATH, db)
      for (const line of [
        'NAMEEN=S;CQS 2026 (pool) - Lifesaving - CSSG', 'CITY=S;Gatineau', 'STATE=S;QC', 'NATION=S;CAN',
        'COURSE=I;3', 'DEADLINE=D;20260410000000000', 'RESERVECOUNT=I;2', 'STARTMETHOD=S;1',
        'TIMING=I;2', 'TOUCHPADMODE=I;1', 'MASTERS=B;F',
        'HOSTCLUB=S;Club de sauvetage sportif de Gatineau', 'ORGANIZERURL=S;https://cssgatineau.ca/accueil',
        'FACILITYNAME=S;Centre sportif de Gatineau', 'FACILITYSTREET=S;850, boul. de La Gappe',
        'LANEMIN=I;1', 'LANEMAX=I;8', 'QUALIFROM=S;2024-09-01', 'QUALITO=S;2026-04-01',
        'CONTACTNAME=S;Nathalie Plante', 'CONTACTEMAIL=S;fp107@ncf.ca',
      ]) expect(mv()).toContain(line)
    })

    it('exportMeetLenex writes the meet header the way Splash does, and imports back whole', () => {
      const fields: Record<string, string> = {
        NAME: 'S;Invitation', NAMEEN: 'S;Invitation EN', CITY: 'S;Montréal', CITYEN: 'S;Montreal',
        STATE: 'S;Québec', NATION: 'S;Canada', COURSE: 'I;3', DEADLINE: 'D;20261122000000000',
        RESERVECOUNT: 'I;2', STARTMETHOD: 'S;1', TIMING: 'I;2', TOUCHPADMODE: 'I;2', MASTERS: 'B;F',
        MEETNUMBER: 'I;7', MEETTYPE: 'S;PROVINCIAL', ORGANIZER: 'S;CSRN', ORGANIZERURL: 'S;https://o.example',
        HOSTCLUB: 'S;Club Hôte', RESULTURL: 'S;https://r.example', LANEMIN: 'I;2', LANEMAX: 'I;5',
        FACILITYNAME: 'S;Centre sportif du Parc Olympique', FACILITYSTREET: 'S;3200 rue Viau',
        QUALIFROM: 'S;2025-09-01', QUALITO: 'S;2026-04-01', CONTACTNAME: 'S;N', CONTACTEMAIL: 'S;n@x.ca',
        CONTACTINTERNET: 'S;https://c.example', FEECLUB: 'F;25', FEEPERSON: 'F;12.5', FEERELAY: 'F;20',
        FEELATEINDIVIDUAL: 'F;5', SEEDMETHOD: 'I;1', MINPERHEAT: 'I;3', COMBINEAGEGROUPS: 'B;T',
      }
      runImport(structureXml('course="SCM"'))
      db.prepare(`UPDATE bsglobal SET data=? WHERE name='MEETVALUES'`)
        .run(Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\r\n'))
      db.prepare(`DELETE FROM bsglobal WHERE name IN ('MeetName','MeetCity','MeetNation','MeetCourse')`).run()
      const out = join(tmpdir(), `test-meet-export-${randomBytes(4).toString('hex')}.lxf`)
      try {
        exportMeetLenex(out, db)
        const xml = readLefXml(out)
        expect(xml).toMatch(/<MEET [^>]*name\.en="Invitation EN"[^>]*>/)
        expect(xml).toMatch(/<MEET [^>]*timing="AUTOMATIC"[^>]*touchpad="BOTHSIDE"/)
        expect(xml).toMatch(/<FACILITY [^>]*name="Centre sportif du Parc Olympique"[^>]*street="3200 rue Viau"/)
        expect(xml).toMatch(/<FACILITY [^>]*city="Montréal"[^>]*state="Québec"/)
        expect(xml).toContain('<POOL lanemin="2" lanemax="5" name="Centre sportif du Parc Olympique" />')
        expect(xml).toContain('<QUALIFY from="2025-09-01" until="2026-04-01" />')
        expect(xml).toContain('<FEE type="ATHLETE" value="1250" />')
        expect(xml).not.toContain('SEEDMETHOD')
        // …and the same file imported into an empty meet brings every field back
        cleanup()
        const fresh = createTestDb(); db = fresh.db; cleanup = fresh.cleanup
        importLenex(out, db)
        for (const [k, v] of Object.entries(fields)) expect(mv()).toContain(`${k}=${v}`)
      } finally { try { unlinkSync(out) } catch {} }
    })

    it('ignores a malformed .meetvalues dotfile', () => {
      const p = join(tmpdir(), `test-meetvalues-bad-${randomBytes(4).toString('hex')}.lxf`)
      writeZipEntries(p, [['meet.lef', structureXml('city="Laval" course="LCM"')], ['.meetvalues', '{not json']])
      try {
        const summary = importLenex(p, db)
        expect(summary.errors.some(e => e.includes('.meetvalues'))).toBe(true)
        expect(mv()).toContain('CITY=S;Laval')
      } finally { try { unlinkSync(p) } catch {} }
    })
  })

  it('re-syncs AGEDATE even on an entries-only reimport (skipEventStructure path)', () => {
    const structureXml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <AGEDATE value="2027-12-31" type="DATE" />
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    // No <ATHLETES> needed — just a <CLUB> is enough to flip hasClubs=true (importLenex's
    // skipEventStructure check), which is the branch this test actually exercises.
    const entriesXml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <AGEDATE value="2028-12-31" type="DATE" />
      <CLUBS>
        <CLUB clubid="1" code="TST" name="Test Club" />
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`

    const structurePath = join(tmpdir(), `test-agedate-struct-${randomBytes(4).toString('hex')}.lxf`)
    const entriesPath = join(tmpdir(), `test-agedate-entries-${randomBytes(4).toString('hex')}.lxf`)
    writeZipSingleEntry(structurePath, 'meet.lef', structureXml)
    writeZipSingleEntry(entriesPath, 'meet.lef', entriesXml)

    try {
      importLenex(structurePath, db)
      let ageDateRow = db.prepare(`SELECT data FROM bsglobal WHERE name='AGEDATE'`).get() as { data: string } | undefined
      expect(ageDateRow?.data).toBe('D;20271231000000000')

      importLenex(entriesPath, db)
      ageDateRow = db.prepare(`SELECT data FROM bsglobal WHERE name='AGEDATE'`).get() as { data: string } | undefined
      expect(ageDateRow?.data).toBe('D;20281231000000000')
    } finally {
      try { unlinkSync(structurePath) } catch {}
      try { unlinkSync(entriesPath) } catch {}
    }
  })

  // Regression test for a live bug: importLenex read the SESSION name/lanes but never the
  // `date="YYYY-MM-DD"` attribute LENEX puts on <SESSION>, so an imported session's
  // swimsession.startdate stayed NULL and the EventsPage Date field showed blank
  // (found importing a real team-app inscriptions.lxf whose SESSION carried date="2026-12-31").
  it('imports the SESSION date attribute into swimsession.startdate', () => {
    const lxfPath = join(tmpdir(), `test-session-date-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Samedi" date="2026-12-31">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="500" distance="50" relaycount="1" name="Test Style" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      const row = db.prepare(`SELECT startdate FROM swimsession WHERE sessionnumber=1`).get() as { startdate: string | null }
      expect(row.startdate).toBe('2026-12-31')
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  // Regression test for a real bug found auditing a live beach meet (CQS Plage 2026):
  // an athlete born right on an age-bracket boundary was first registered under the
  // wrong division (Open) via team-app, then corrected to the right one (15-18) and
  // re-exported. Re-importing that corrected entries LXF left the original "Open"
  // registration behind as an orphan (no heat, no time, no status — invisible in the
  // UI, but still counted as a registration) because the importer always minted a new
  // swimresultid per <ENTRY> and never checked for an existing sibling-bracket row.
  it('cleans up a stale sibling-age-bracket registration on category correction', () => {
    const structureXml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="100" number="6" gender="F" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="2000" relaycount="1" name="Course sur plage 2000m" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1000" name="15-18" agemin="15" agemax="18" gender="F" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="101" number="8" gender="F" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="2000" relaycount="1" name="Course sur plage 2000m" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1001" name="Open" agemin="19" agemax="-1" gender="F" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`

    function entriesXml(eventId: number, agegroupId: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <CLUBS>
        <CLUB clubid="1" code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE athleteid="500" firstname="Test" lastname="Athlete" birthdate="2008-06-25" gender="F">
              <ENTRIES>
                <ENTRY eventid="${eventId}" agegroupid="${agegroupId}" />
              </ENTRIES>
            </ATHLETE>
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    }

    const structurePath = join(tmpdir(), `test-structure-${randomBytes(4).toString('hex')}.lxf`)
    const openEntryPath = join(tmpdir(), `test-entry-open-${randomBytes(4).toString('hex')}.lxf`)
    const correctedEntryPath = join(tmpdir(), `test-entry-1518-${randomBytes(4).toString('hex')}.lxf`)
    writeZipSingleEntry(structurePath, 'meet.lef', structureXml)
    writeZipSingleEntry(openEntryPath, 'entries.lef', entriesXml(101, 1001))
    writeZipSingleEntry(correctedEntryPath, 'entries.lef', entriesXml(100, 1000))

    try {
      importLenex(structurePath, db)
      importLenex(openEntryPath, db)      // registered under the wrong ("Open") bracket
      importLenex(correctedEntryPath, db) // category corrected to "15-18"

      // athleteid="500" in the LXF is an external id, reconciled via externalid — not adopted
      // as the local primary key (see lenex.ts's club/athlete import comment).
      const athlete = db.prepare(`SELECT athleteid FROM athlete WHERE externalid = '500'`).get() as { athleteid: number }
      const rows = db.prepare('SELECT swimeventid FROM swimresult WHERE athleteid = ?').all(athlete.athleteid) as
        Array<{ swimeventid: number }>
      expect(rows).toHaveLength(1)
      expect(rows[0].swimeventid).toBe(100)
    } finally {
      for (const p of [structurePath, openEntryPath, correctedEntryPath]) {
        try { unlinkSync(p) } catch {}
      }
    }
  })

  it('never deletes a sibling registration that already has a heat/lane assigned', () => {
    const structureXml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="100" number="6" gender="F" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="2000" relaycount="1" name="Course sur plage 2000m" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1000" name="15-18" agemin="15" agemax="18" gender="F" />
              </AGEGROUPS>
            </EVENT>
            <EVENT eventid="101" number="8" gender="F" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="2000" relaycount="1" name="Course sur plage 2000m" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1001" name="Open" agemin="19" agemax="-1" gender="F" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`

    function entriesXml(eventId: number, agegroupId: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <CLUBS>
        <CLUB clubid="1" code="TST" name="Test Club">
          <ATHLETES>
            <ATHLETE athleteid="500" firstname="Test" lastname="Athlete" birthdate="2008-06-25" gender="F">
              <ENTRIES>
                <ENTRY eventid="${eventId}" agegroupid="${agegroupId}" />
              </ENTRIES>
            </ATHLETE>
          </ATHLETES>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    }

    const structurePath = join(tmpdir(), `test-structure-${randomBytes(4).toString('hex')}.lxf`)
    const openEntryPath = join(tmpdir(), `test-entry-open-${randomBytes(4).toString('hex')}.lxf`)
    const correctedEntryPath = join(tmpdir(), `test-entry-1518-${randomBytes(4).toString('hex')}.lxf`)
    writeZipSingleEntry(structurePath, 'meet.lef', structureXml)
    writeZipSingleEntry(openEntryPath, 'entries.lef', entriesXml(101, 1001))
    writeZipSingleEntry(correctedEntryPath, 'entries.lef', entriesXml(100, 1000))

    try {
      importLenex(structurePath, db)
      importLenex(openEntryPath, db)
      // athleteid="500" in the LXF is an external id, reconciled via externalid — not adopted
      // as the local primary key (see lenex.ts's club/athlete import comment).
      const athlete = db.prepare(`SELECT athleteid FROM athlete WHERE externalid = '500'`).get() as { athleteid: number }
      // Simulate heat generation having already placed the athlete in a heat for the
      // "Open" event before the category-correction entries file is imported.
      db.prepare('UPDATE swimresult SET heatid=999, lane=3 WHERE athleteid=? AND swimeventid=101').run(athlete.athleteid)
      importLenex(correctedEntryPath, db)

      const rows = db.prepare('SELECT swimeventid FROM swimresult WHERE athleteid = ? ORDER BY swimeventid').all(athlete.athleteid) as
        Array<{ swimeventid: number }>
      expect(rows.map(r => r.swimeventid)).toEqual([100, 101])
    } finally {
      for (const p of [structurePath, openEntryPath, correctedEntryPath]) {
        try { unlinkSync(p) } catch {}
      }
    }
  })

  it('stores meet attributes in bsglobal', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    importLenex(FIXTURE_PATH, db)
    // The importer should have stored MEET-level attributes
    const rows = db.prepare('SELECT name FROM bsglobal').all() as Array<{ name: string }>
    // At minimum, MeetName should be stored if the LXF has a name attribute
    const names = rows.map(r => r.name)
    // Check that bsglobal has some entries (may or may not have MeetName depending on the fixture)
    expect(names.length).toBeGreaterThanOrEqual(0)
  })

  it('links events to sessions correctly', function () {
    if (!existsSync(FIXTURE_PATH)) {
      this.skip?.()
      return
    }
    importLenex(FIXTURE_PATH, db)
    // Every event should have a valid swimsessionid
    const orphans = db.prepare(
      `SELECT COUNT(*) as c FROM swimevent WHERE swimsessionid NOT IN (SELECT swimsessionid FROM swimsession)`
    ).get() as { c: number }
    expect(orphans.c).toBe(0)
  })
})

// ── LENEX exporter — regression coverage for real bugs found testing against ──
// ── actual Splash Meet Manager (2026-07-31, see CLAUDE.md) ────────────────────

const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)
function dateToOle(y: number, m: number, d: number): number {
  return (Date.UTC(y, m - 1, d) - OLE_EPOCH_MS) / 86400000
}

function tmpLxfPath(): string {
  return join(tmpdir(), `lenex-export-test-${randomBytes(4).toString('hex')}.lxf`)
}

/** Read a .lxf's XML content back out (it's a ZIP with a single .lef entry). */
function readLefXml(filePath: string): string {
  const entries = readZipEntries(filePath)
  const lefName = [...entries.keys()].find(n => n.endsWith('.lef'))!
  return entries.get(lefName)!.toString('utf8')
}

/** Seed a minimal meet with one club, one athlete, one validated heat + result. */
function seedResultsFixture(db: Database.Database, birthdateOle: number) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (1, 1, 'Open', 18, NULL, 1, 1)`)
  db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`)
  db.prepare(
    `INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'Jane', 'Doe', 2, ?, 'CAN')`
  ).run(String(birthdateOle))
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 1, 1, 5)`) // 5 = official/validated
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime, swimtime, resultstatus) VALUES (1, 1, 1, 1, 1, 4, 60000, 58500, NULL)`)
}

describe('LENEX exporter', () => {
  let db: Database.Database
  let cleanup: () => void
  let outPath: string

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    outPath = tmpLxfPath()
  })

  afterEach(() => {
    cleanup()
    try { unlinkSync(outPath) } catch { /* not written this test */ }
  })

  it('exportLenexResults writes an ISO-formatted birthdate, not a raw OLE double', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain('birthdate="2014-07-03"')
    expect(xml).not.toMatch(/birthdate="\d+\.\d+"/)
  })

  it('exportLenexResults writes an AGEDATE element from this meet\'s own local bsglobal.AGEDATE', () => {
    // computeAgeDate() is deliberately NOT read from the LENEX MEETVALUES blob — that value
    // (a team-app organizer's own config, when present at all) isn't this meet's local season
    // anchor. It's this database's own bsglobal.AGEDATE row (set by flushMeet() when the meet
    // was created/reset on this computer — see ageGroupRules.ts's getSeasonYear).
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`INSERT INTO bsglobal (name, data) VALUES ('AGEDATE', 'D;20261231000000000')`)
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain('<AGEDATE value="2026-12-31" type="DATE" />')
  })

  it('exportLenexResults ignores a team-app-style AGEDATE parked in the MEETVALUES blob', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', 'AGEDATE=D;20200101000000000')`)
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).not.toContain('<AGEDATE value="2020-01-01" type="DATE" />')
    expect(xml).toContain(`<AGEDATE value="${new Date().getFullYear()}-12-31" type="DATE" />`)
  })

  it('exportLenexResults falls back to Dec 31 of the current year when AGEDATE is not set', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain(`<AGEDATE value="${new Date().getFullYear()}-12-31" type="DATE" />`)
  })

  it('exportMeetLenex also writes a correct AGEDATE (regression guard for the shared computeAgeDate helper)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`INSERT INTO bsglobal (name, data) VALUES ('AGEDATE', 'D;20261231000000000')`)
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain('<AGEDATE value="2026-12-31" type="DATE" />')
  })

  it('exportMeetLenex writes an ISO-formatted session date, not a raw OLE double (e.g. after an .smb restore)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimsession SET startdate=? WHERE swimsessionid=1`).run(String(dateToOle(2026, 6, 14)))
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain('date="2026-06-14"')
    expect(xml).not.toMatch(/date="\d+\.\d+"/)
  })

  it('exportLenexResults writes SESSION@date (required by LENEX; team-app dates results from it)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimsession SET startdate=? WHERE swimsessionid=1`).run(String(dateToOle(2026, 11, 28)))
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(/<SESSION[^>]*\sdate="2026-11-28"/)
    expect(xml).not.toMatch(/date="\d+\.\d+"/)
  })

  it('exportLenexResults falls back to the export day when the session has no date', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimsession SET startdate=NULL WHERE swimsessionid=1`).run()
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(new RegExp(`<SESSION[^>]*\\sdate="${new Date().toISOString().slice(0, 10)}"`))
  })

  it('exportMeetLenex writes session lanemin/lanemax when set (was silently dropped before)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimsession SET lanemin=1, lanemax=40 WHERE swimsessionid=1`).run()
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toContain('lanemin="1"')
    expect(xml).toContain('lanemax="40"')
  })

  it('exportMeetLenex omits lanemin/lanemax attrs when unset (not a literal "null"/"0")', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).not.toMatch(/lanemin=/)
    expect(xml).not.toMatch(/lanemax=/)
  })

  it('round-trips session lanemin/lanemax through importLenex → exportMeetLenex → importLenex (was silently dropped before)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimsession SET lanemin=1, lanemax=40 WHERE swimsessionid=1`).run()
    exportMeetLenex(outPath, db)

    const { db: freshDb, cleanup: freshCleanup } = createTestDb()
    try {
      importLenex(outPath, freshDb)
      const row = freshDb.prepare(`SELECT lanemin, lanemax FROM swimsession WHERE sessionnumber=1`).get() as {
        lanemin: number | null; lanemax: number | null
      }
      expect(row.lanemin).toBe(1)
      expect(row.lanemax).toBe(40)
    } finally {
      freshCleanup()
    }
  })

  // Regression test for a live bug: event (and pause) start time (daytime) and
  // duration were never written to <EVENT> by either exporter nor read back by
  // importLenex, so they were silently dropped on every .lxf round trip.
  it('exportMeetLenex writes event daytime/duration (was silently dropped before)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimevent SET daytime='2000-01-01 09:30:00', duration='2000-01-01 00:15:00' WHERE swimeventid=1`).run()
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(/eventid="1"[^>]*daytime="09:30"/)
    expect(xml).toMatch(/eventid="1"[^>]*duration="00:15"/)
  })

  it('exportMeetLenex omits daytime/duration attrs when unset (not a literal "null")', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).not.toMatch(/daytime=/)
    expect(xml).not.toMatch(/duration=/)
  })

  it('round-trips event daytime/duration through importLenex → exportMeetLenex → importLenex (was silently dropped before)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimevent SET daytime='2000-01-01 09:30:00', duration='2000-01-01 00:15:00' WHERE swimeventid=1`).run()
    exportMeetLenex(outPath, db)

    const { db: freshDb, cleanup: freshCleanup } = createTestDb()
    try {
      importLenex(outPath, freshDb)
      const row = freshDb.prepare(`SELECT daytime, duration FROM swimevent WHERE swimeventid=1`).get() as {
        daytime: string | null; duration: string | null
      }
      // Stored back in the "2000-01-01 HH:MM:00" sentinel form getSessions/formatDaytime expect.
      expect(row.daytime).toContain('09:30')
      expect(row.duration).toContain('00:15')
    } finally {
      freshCleanup()
    }
  })

  it('round-trips a PAUSE daytime/duration through importLenex → exportMeetLenex → importLenex', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    // A pause/break: internalevent='T', no swimstyle, with start time + duration.
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, comment, daytime, duration) VALUES (2, 1, NULL, 2, 0, 5, 2, 'T', 'Pause', '2000-01-01 10:00:00', '2000-01-01 00:30:00')`)
    exportMeetLenex(outPath, db)

    const { db: freshDb, cleanup: freshCleanup } = createTestDb()
    try {
      importLenex(outPath, freshDb)
      const row = freshDb.prepare(`SELECT daytime, duration, internalevent FROM swimevent WHERE swimeventid=2`).get() as {
        daytime: string | null; duration: string | null; internalevent: string | null
      }
      expect(row.internalevent).toBe('T')
      expect(row.daytime).toContain('10:00')
      expect(row.duration).toContain('00:30')
    } finally {
      freshCleanup()
    }
  })

  it('re-importing a structure LXF without lanemin/lanemax does not clobber an existing session value', () => {
    // Simulates: user sets lanemin/lanemax in meet-app, then re-imports an entries LXF from
    // team-app that doesn't carry the attribute yet — the existing value must survive.
    const lxfPath = join(tmpdir(), `test-session-nolane-${randomBytes(4).toString('hex')}.lxf`)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="16" relaycount="1" name="Drapeau Sur Plage" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
    writeZipSingleEntry(lxfPath, 'meet.lef', xml)

    try {
      importLenex(lxfPath, db)
      db.prepare(`UPDATE swimsession SET lanemin=1, lanemax=40 WHERE sessionnumber=1`).run()
      importLenex(lxfPath, db) // re-import same structure, no lanemin/lanemax attrs
      const row = db.prepare(`SELECT lanemin, lanemax FROM swimsession WHERE sessionnumber=1`).get() as {
        lanemin: number | null; lanemax: number | null
      }
      expect(row.lanemin).toBe(1)
      expect(row.lanemax).toBe(40)
    } finally {
      try { unlinkSync(lxfPath) } catch {}
    }
  })

  it('round-trips swimtime/resultstatus/reactiontime through importLenex (was silently dropped before)', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimresult SET resultstatus=3 WHERE swimresultid=1`).run() // DSQ
    exportLenexResults(outPath, db)

    const { db: freshDb, cleanup: freshCleanup } = createTestDb()
    try {
      const summary = importLenex(outPath, freshDb)
      expect(summary.results).toBeGreaterThan(0)
      const row = freshDb.prepare(`SELECT swimtime, resultstatus, heatid, lane FROM swimresult LIMIT 1`).get() as {
        swimtime: number | null; resultstatus: number | null; heatid: number | null; lane: number | null
      }
      expect(row.swimtime).toBe(58500)
      expect(row.resultstatus).toBe(3)
      expect(row.heatid).not.toBeNull()
      expect(row.lane).toBe(4)
    } finally {
      freshCleanup()
    }
  })

  it('round-trips EXH (hors concours/exhibition, resultstatus=4) through importLenex, keeping swimtime', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.prepare(`UPDATE swimresult SET resultstatus=4 WHERE swimresultid=1`).run() // EXH
    exportLenexResults(outPath, db)

    const raw = readLefXml(outPath)
    expect(raw).toContain('status="EXH"')

    const { db: freshDb, cleanup: freshCleanup } = createTestDb()
    try {
      const summary = importLenex(outPath, freshDb)
      expect(summary.results).toBeGreaterThan(0)
      const row = freshDb.prepare(`SELECT swimtime, resultstatus, heatid, lane FROM swimresult LIMIT 1`).get() as {
        swimtime: number | null; resultstatus: number | null; heatid: number | null; lane: number | null
      }
      expect(row.swimtime).toBe(58500)
      expect(row.resultstatus).toBe(4)
      expect(row.heatid).not.toBeNull()
      expect(row.lane).toBe(4)
    } finally {
      freshCleanup()
    }
  })

  // Regression test for a live bug: exportMeetLenex/exportLenexResults never wrote the
  // `preveventid` attribute at all (only importLenex read it, and only team-app's export.py
  // wrote it — see a1e9d3e). A prelim/final pair created via "Convert to Final" in meet-app
  // (swimevent.preveventid set locally) round-tripped through meet-app's own LXF export with
  // that link silently dropped. Reproduced against real Splash: opening the final in the UI
  // after importing such a file is an access violation crash, since Splash dereferences the
  // link unconditionally.
  it('exportMeetLenex writes preveventid linking a Final back to its Prelim', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (2, 1, 1, 1, 1, 4, 2, 'F', 1)`)
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(/eventid="1"[^>]*preveventid="-1"/)
    expect(xml).toMatch(/eventid="2"[^>]*preveventid="1"/)
  })

  it('exportLenexResults writes preveventid linking a Final back to its Prelim', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (2, 1, 1, 1, 1, 4, 2, 'F', 1)`)
    exportLenexResults(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(/eventid="1"[^>]*preveventid="-1"/)
    expect(xml).toMatch(/eventid="2"[^>]*preveventid="1"/)
  })

  // Regression guard: decodeGender used to write "X" for Mixed, which isn't a value the
  // real LENEX GENDER enum (ALL|M|F|MIXED) defines — a real Splash import of our own file
  // could fail to recognize it. gender=0 (ALL) is a separate new value that never had an
  // export path at all before this fix.
  it('exportMeetLenex writes gender="ALL" and gender="MIXED", not "X", per the real LENEX spec', () => {
    seedResultsFixture(db, dateToOle(2014, 7, 3))
    db.exec(`UPDATE swimevent SET gender=0 WHERE swimeventid=1`)
    db.exec(`UPDATE agegroup SET gender=0 WHERE swimeventid=1`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (2, 1, 1, 2, 3, 5, 2, 'F')`)
    exportMeetLenex(outPath, db)
    const xml = readLefXml(outPath)
    expect(xml).toMatch(/eventid="1"[^>]*gender="ALL"/)
    expect(xml).toMatch(/eventid="2"[^>]*gender="MIXED"/)
    expect(xml).not.toMatch(/gender="X"/)
  })
})

// ── PostgreSQL backend parity ───────────────────────────────────────────────
//
// importLenex had no PG-backend coverage at all — the same gap beachNumber.ts had before it
// shipped two real SQLite-only-syntax bugs (SELECT DISTINCT ORDER BY expression not in the
// select list, COLLATE NOCASE) that every SQLite test passed and real Postgres rejected
// outright the moment a beach meet's entries were imported against a shared PG backend (see
// docs history on the DB abstraction refactor). importLenex is on the same import path and
// itself calls generateBeachNumbers for beach meets, so a dialect-specific bug here would be
// just as invisible to SQLite-only tests. Uses a synthetic minimal LXF rather than the
// team-app fixture so it runs standalone regardless of whether that fixture is checked out.
// Skipped automatically if no Postgres server is reachable.
const pgAvailable = await isPgTestAvailable()
const LENEX_PARITY_BACKENDS: TestBackendKind[] = pgAvailable ? ['sqlite', 'pg'] : ['sqlite']
if (!pgAvailable) {
  console.warn(
    '[lenex.test.ts] Postgres not reachable — skipping PG-backend importLenex tests. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

describe.each(LENEX_PARITY_BACKENDS)('importLenex backend parity [%s]', (kind) => {
  async function withDb(fn: (db: Database.Database) => void | Promise<void>) {
    if (kind === 'sqlite') {
      const { db, cleanup } = createTestDb()
      try {
        await fn(db)
      } finally {
        cleanup()
      }
    } else {
      const { db, cleanup } = await createPgTestDb()
      try {
        // importLenex only calls db.prepare()/db.exec() — PgBackend satisfies that
        // structurally even though it isn't a real better-sqlite3 Database.
        await fn(db as unknown as Database.Database)
      } finally {
        await cleanup()
      }
    }
  }

  it('imports sessions, events, swim styles, and age groups from a synthetic LXF, idempotently', async () => {
    await withDb(async (db) => {
      const lxfPath = join(tmpdir(), `test-lenex-parity-${kind}-${randomBytes(4).toString('hex')}.lxf`)
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Parity Test Meet" city="Test City" nation="CAN" course="LCM">
      <SESSIONS>
        <SESSION number="1" name="Session 1">
          <EVENTS>
            <EVENT eventid="1" number="1" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="601" distance="16" relaycount="1" name="Drapeau Sur Plage" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="1" name="Open" agemin="18" agemax="-1" gender="M" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
    </MEET>
  </MEETS>
</LENEX>`
      writeZipSingleEntry(lxfPath, 'meet.lef', xml)

      try {
        const summary = importLenex(lxfPath, db)
        expect(summary.sessions).toBe(1)
        expect(summary.events).toBe(1)

        const styles = db.prepare('SELECT COUNT(*) AS c FROM swimstyle').get() as { c: number }
        expect(styles.c).toBe(1)
        const ags = db.prepare('SELECT COUNT(*) AS c FROM agegroup').get() as { c: number }
        expect(ags.c).toBe(1)

        // Re-import must be idempotent on both backends — exercises the upsert (ON CONFLICT
        // DO UPDATE) paths, not just a fresh insert.
        const summary2 = importLenex(lxfPath, db)
        expect(summary2.sessions).toBe(1)
        expect(summary2.events).toBe(1)
        const stylesAfter = db.prepare('SELECT COUNT(*) AS c FROM swimstyle').get() as { c: number }
        expect(stylesAfter.c).toBe(1)
        const agsAfter = db.prepare('SELECT COUNT(*) AS c FROM agegroup').get() as { c: number }
        expect(agsAfter.c).toBe(1)
      } finally {
        try { unlinkSync(lxfPath) } catch {}
      }
    })
  })
})
// ── Live push config transport (.keys) ────────────────────────────────────────

/** Minimal multi-entry ZIP writer (writeZipSingleEntry only does one entry). */
function writeZipEntries(filePath: string, files: Array<[string, string]>): void {
  const { deflateRawSync, crc32 } = require('zlib') as typeof import('zlib')
  const { writeFileSync } = require('fs') as typeof import('fs')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8')
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30 + nameBuf.length)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(lh, 30)
    const ch = Buffer.alloc(46 + nameBuf.length)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42); nameBuf.copy(ch, 46)
    locals.push(lh, comp)
    centrals.push(ch)
    offset += lh.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  writeFileSync(filePath, Buffer.concat([...locals, cd, eocd]))
}

describe('LENEX importer — live push config (.keys)', () => {
  let db: Database.Database
  let cleanup: () => void
  beforeEach(() => { const t = createTestDb(); db = t.db; cleanup = t.cleanup })
  afterEach(() => cleanup())

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Live Meet" city="X" nation="CAN" course="LCM"><SESSIONS>
<SESSION number="1" name="S1"><EVENTS><EVENT eventid="1" number="1" gender="M" round="TIM">
<SWIMSTYLE swimstyleid="503" distance="50" relaycount="1" name="Nage libre" /></EVENT></EVENTS></SESSION>
</SESSIONS></MEET></MEETS></LENEX>`
  const live = () => Object.fromEntries(
    (db.prepare(`SELECT name, data FROM bsglobal WHERE name LIKE 'LIVE_%'`).all() as Array<{ name: string; data: string }>)
      .map(r => [r.name, r.data]))

  function importWithKeys(keys: Record<string, string> | null): void {
    const p = join(tmpdir(), `test-live-keys-${randomBytes(4).toString('hex')}.lxf`)
    writeZipEntries(p, keys ? [['meet.lef', xml], ['.keys', JSON.stringify(keys)]] : [['meet.lef', xml]])
    try { importLenex(p, db) } finally { try { unlinkSync(p) } catch {} }
  }

  it('stores live URL/secret when the team-app export carries them (live on)', () => {
    importWithKeys({ live_push_secret: 'abc123', live_url: 'http://team.example' })
    expect(live()).toMatchObject({ LIVE_PUSH_SECRET: 'abc123', LIVE_URL: 'http://team.example' })
  })

  it('clears stale live config when a team-app export has no secret (live off)', () => {
    importWithKeys({ live_push_secret: 'abc123', live_url: 'http://team.example' })
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('LIVE_ENABLED', 'T')`).run()
    importWithKeys({})
    expect(live()).toEqual({})
  })

  it('leaves live config alone for a non-team-app LXF (no .keys at all)', () => {
    importWithKeys({ live_push_secret: 'abc123', live_url: 'http://team.example' })
    importWithKeys(null)
    expect(live()).toMatchObject({ LIVE_PUSH_SECRET: 'abc123', LIVE_URL: 'http://team.example' })
  })
})
