import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers'
import { importLenex } from '../src/main/lenex'
import type Database from 'better-sqlite3'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

/**
 * Build a minimal LENEX .lef XML containing relay teams with positions.
 * This mirrors the structure produced by team-app's export.py.
 */
function buildRelayLxf(opts: {
  relayName?: string
  positionsInEntry?: boolean
  positionsInRelay?: boolean
} = {}): string {
  const { relayName, positionsInEntry = true, positionsInRelay = true } = opts

  const positions = `
              <RELAYPOSITIONS>
                <RELAYPOSITION number="1" athleteid="101" />
                <RELAYPOSITION number="2" athleteid="102" />
                <RELAYPOSITION number="3" athleteid="103" />
                <RELAYPOSITION number="4" athleteid="104" />
              </RELAYPOSITIONS>`

  return `<?xml version="1.0" encoding="utf-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="Relay Test Meet" city="TestCity" course="SCM">
      <AGEDATE value="2026-12-31" type="DATE" />
      <SESSIONS>
        <SESSION number="1" date="2026-06-15" course="SCM">
          <EVENTS>
            <EVENT eventid="10" number="10" gender="X" round="TIM">
              <SWIMSTYLE swimstyleid="530" distance="100" stroke="FREE" relaycount="4" name="4x25 Obstacles" />
              <AGEGROUPS>
                <AGEGROUP agegroupid="100" agemin="15" agemax="18" />
              </AGEGROUPS>
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB name="Test Club" code="TST" nation="CAN" clubid="1">
          <ATHLETES>
            <ATHLETE athleteid="101" firstname="Alice" lastname="Roy" gender="F" birthdate="2008-03-15" />
            <ATHLETE athleteid="102" firstname="Bob" lastname="Gagnon" gender="M" birthdate="2009-07-22" />
            <ATHLETE athleteid="103" firstname="Carol" lastname="Tremblay" gender="F" birthdate="2008-11-01" />
            <ATHLETE athleteid="104" firstname="David" lastname="Côté" gender="M" birthdate="2009-05-10" />
          </ATHLETES>
          <RELAYS>
            <RELAY number="1"${relayName ? ` name="${relayName}"` : ''} gender="X">
${positionsInRelay ? positions : ''}
              <ENTRIES>
                <ENTRY eventid="10" entrycourse="SCM" entrytime="00:01:45.00">
${positionsInEntry ? positions : ''}
                </ENTRY>
              </ENTRIES>
            </RELAY>
          </RELAYS>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
}

function writeTempLxf(xml: string): string {
  const dir = tmpdir()
  const filename = `relay-test-${randomBytes(4).toString('hex')}.lef`
  const path = join(dir, filename)
  writeFileSync(path, xml, 'utf-8')
  return path
}

describe('Relay import from LENEX', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it('imports relay team with name and event reference', () => {
    const lxf = buildRelayLxf({ relayName: 'Roy/Gagnon/Tremblay/Côté' })
    const path = writeTempLxf(lxf)
    try {
      const summary = importLenex(path, db)
      expect(summary.errors).toHaveLength(0)

      // Verify relay was created
      const relays = db.prepare('SELECT * FROM relay').all() as Array<{
        relayid: number; clubid: number; swimeventid: number; teamnumber: number
        name: string | null; gender: number; entrytime: number | null
      }>
      expect(relays).toHaveLength(1)
      expect(relays[0].swimeventid).toBe(10)
      expect(relays[0].teamnumber).toBe(1)
      expect(relays[0].name).toBe('Roy/Gagnon/Tremblay/Côté')
      expect(relays[0].entrytime).toBe(105000) // 1:45.00 = 105000ms
    } finally {
      try { unlinkSync(path) } catch {}
    }
  })

  it('imports relay positions from ENTRY child (meet-app export format)', () => {
    const lxf = buildRelayLxf({ positionsInRelay: false, positionsInEntry: true })
    const path = writeTempLxf(lxf)
    try {
      importLenex(path, db)

      const positions = db.prepare(
        'SELECT * FROM relayposition ORDER BY relaynumber'
      ).all() as Array<{ relayid: number; relaynumber: number; athleteid: number }>
      expect(positions).toHaveLength(4)
      expect(positions[0].athleteid).toBe(101)
      expect(positions[1].athleteid).toBe(102)
      expect(positions[2].athleteid).toBe(103)
      expect(positions[3].athleteid).toBe(104)
    } finally {
      try { unlinkSync(path) } catch {}
    }
  })

  it('imports relay without entry time (NT relay)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="NT Relay Test" course="SCM">
      <SESSIONS>
        <SESSION number="1" date="2026-06-15" course="SCM">
          <EVENTS>
            <EVENT eventid="20" number="20" gender="F" round="TIM">
              <SWIMSTYLE swimstyleid="531" distance="100" stroke="FREE" relaycount="4" name="4x25 Free" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB name="Club B" code="CLB" nation="CAN" clubid="2">
          <ATHLETES>
            <ATHLETE athleteid="201" firstname="Eve" lastname="Fortin" gender="F" birthdate="2010-01-01" />
            <ATHLETE athleteid="202" firstname="Fay" lastname="Leblanc" gender="F" birthdate="2010-02-02" />
            <ATHLETE athleteid="203" firstname="Gina" lastname="Martin" gender="F" birthdate="2010-03-03" />
            <ATHLETE athleteid="204" firstname="Hana" lastname="Nguyen" gender="F" birthdate="2010-04-04" />
          </ATHLETES>
          <RELAYS>
            <RELAY number="1" gender="F">
              <ENTRIES>
                <ENTRY eventid="20" entrycourse="SCM">
                  <RELAYPOSITIONS>
                    <RELAYPOSITION number="1" athleteid="201" />
                    <RELAYPOSITION number="2" athleteid="202" />
                    <RELAYPOSITION number="3" athleteid="203" />
                    <RELAYPOSITION number="4" athleteid="204" />
                  </RELAYPOSITIONS>
                </ENTRY>
              </ENTRIES>
            </RELAY>
          </RELAYS>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    const path = writeTempLxf(xml)
    try {
      const summary = importLenex(path, db)
      expect(summary.errors).toHaveLength(0)

      const relays = db.prepare('SELECT * FROM relay').all() as Array<{
        relayid: number; entrytime: number | null; swimeventid: number
      }>
      expect(relays).toHaveLength(1)
      expect(relays[0].swimeventid).toBe(20)
      expect(relays[0].entrytime).toBeNull()

      const positions = db.prepare('SELECT COUNT(*) as c FROM relayposition').get() as { c: number }
      expect(positions.c).toBe(4)
    } finally {
      try { unlinkSync(path) } catch {}
    }
  })

  it('skips relay with no eventid in ENTRY', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<LENEX version="3.0">
  <MEETS>
    <MEET name="No Event Relay" course="LCM">
      <SESSIONS>
        <SESSION number="1" date="2026-01-01" course="LCM">
          <EVENTS>
            <EVENT eventid="30" number="30" gender="M" round="TIM">
              <SWIMSTYLE swimstyleid="532" distance="200" stroke="FREE" relaycount="4" />
            </EVENT>
          </EVENTS>
        </SESSION>
      </SESSIONS>
      <CLUBS>
        <CLUB name="Club C" code="CLC" nation="CAN" clubid="3">
          <ATHLETES />
          <RELAYS>
            <RELAY number="1" gender="M">
              <ENTRIES>
                <ENTRY entrycourse="LCM" />
              </ENTRIES>
            </RELAY>
          </RELAYS>
        </CLUB>
      </CLUBS>
    </MEET>
  </MEETS>
</LENEX>`
    const path = writeTempLxf(xml)
    try {
      importLenex(path, db)

      // No relay should be created (eventid=0 is skipped)
      const relays = db.prepare('SELECT COUNT(*) as c FROM relay').get() as { c: number }
      expect(relays.c).toBe(0)
    } finally {
      try { unlinkSync(path) } catch {}
    }
  })
})
