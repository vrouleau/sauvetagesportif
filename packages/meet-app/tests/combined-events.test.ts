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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTestDb, createPgTestDb, isPgTestAvailable, resetTestDb,
  type TestBackendKind,
} from './helpers'
import type { DbBackend } from '../src/main/dbBackend'
import type { CategoryConfig } from '../src/main/combinedEvents'

// See heat-generation.test.ts for why connectionManager needs mocking here:
// db.ts's inClause() reads the *global* isPgConnected() state, and the real
// connectionManager.ts imports Electron's app/safeStorage which don't exist
// under plain Vitest/Node.
const { pgState } = vi.hoisted(() => ({ pgState: { connected: false } }))
vi.mock('../src/main/connectionManager', () => ({
  isPgConnected: () => pgState.connected,
  getDb: () => { throw new Error('getLocalDb() should not be called — tests inject db explicitly') },
  closeDb: () => {},
}))

const {
  queryEventsWithAgeGroups, findMatchingEvents, regenerateCombinedEvents, resolveToFinal,
} = await import('../src/main/combinedEvents')
const { getCombinedResults, getPointStandings } = await import('../src/main/db')

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-combined-events')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

const pgAvailable = await isPgTestAvailable()
const BACKENDS: TestBackendKind[] = pgAvailable ? ['sqlite', 'pg'] : ['sqlite']
if (!pgAvailable) {
  console.warn(
    '[combined-events.test.ts] Postgres not reachable — skipping PG-backend tests. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

/**
 * Reproduces the "Résultat combiné" grouping bug: a single swimeventid hosting
 * two age groups (e.g. 11-12 and 19+) must be split by agegroupid so that each
 * combined-events category only pulls the results for its own age bracket,
 * not every age group swimming under that event.
 */
function seedSharedEvent(db: DbBackend) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  // One swimevent shared by two age groups (11-12 girls, 19+ women)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '11-12F', 11, 12, 2, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 1, '19+F', 19, -1, 2, 2)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Junior', 'Athlete', 2, '2014-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'Senior', 'Athlete', 2, '2000-01-01')`)

  // Junior athlete swims under the 11-12 age group, senior under 19+ — same swimeventid
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (1, 1, 1, 10, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime) VALUES (2, 2, 1, 20, 32000)`)
}

/**
 * Reproduces the real-world bug (found by comparing against a live Splash
 * .mdb for an actual competition): when an event has been split into a Prelim
 * + Final pair, combined-events point totals must come from the FINAL's
 * placements, not the prelim's heat times. Splash's own combined-events XML
 * always references the prelim's event id as the stable "event slot" (the
 * final doesn't exist until someone converts the event), but the points
 * Splash actually prints are computed from the final's results whenever one
 * exists — verified athlete-by-athlete against CanadienMai2026_S40.mdb.
 */
function seedPrelimFinalPair(db: DbBackend) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)

  // Prelim: no preveventid (the stable "event slot" Splash's XML references)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (100, 1, 1, 5, 1, 1, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (101, 100, '19+M', 19, -1, 1, 1)`)

  // Final: preveventid links back to the prelim
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (200, 1, 1, 5, 1, 4, 2, 'F', 100)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (201, 200, '19+M', 19, 99, 1, 1)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'TST', 'Test Club')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'A', 'Athlete', 1, '2000-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 1, 'B', 'Athlete', 1, '2000-01-01')`)

  // One official (racestatus=5) heat per event, since getCombinedResults joins swimresult -> heat
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (100, 100, 1, 5)`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (200, 200, 1, 5)`)

  // Athlete 1 is slower in the prelim (2nd) but wins the final (1st) — the
  // point total must reflect the final placement, not the prelim's.
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (1, 1, 100, 101, 100, 32000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (2, 2, 100, 101, 100, 30000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (3, 1, 200, 201, 200, 29000)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (4, 2, 200, 201, 200, 31000)`)
}

/**
 * Two clubs, same category (19+ women): one has only an individual result, the other only
 * a relay result. Used to verify getCombinedResults (per-athlete "Résultat combiné") stays
 * individual-only while getPointStandings (club "Classement aux points") scores both —
 * confirmed against a real Splash report (2026-08, CQS Plage 2026) that club-level point
 * standings include relay placements, unlike the per-athlete combined report.
 */
function seedIndividualAndRelay(db: DbBackend) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (2, 100, 'Freestyle Relay', 4)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)

  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '19+F', 19, -1, 2, 1)`)

  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (2, 1, 2, 2, 2, 2, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 2, '19+F', 19, -1, 2, 1)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'IND', 'Individual Club')`)
  db.exec(`INSERT INTO club (clubid, code, name) VALUES (2, 'REL', 'Relay Club')`)

  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'Solo', 'Swimmer', 2, '2000-01-01')`)

  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (100, 1, 1, 5)`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (200, 2, 1, 5)`)

  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime) VALUES (1, 1, 1, 10, 100, 30000)`)
  db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, agegroupid, heatid, swimtime, resultstatus) VALUES (1, 2, 2, 20, 200, 28000, 0)`)
}

/**
 * Règlements Québec §4.4.2.1: at CQS, 16 finalists split into Finale A
 * (ranks 1-8, guaranteed) and Finale B (ranks 9-16), regardless of raw time —
 * a B-finalist can swim faster than an A-finalist and still ranks behind
 * them. autoQualify() writes 'A'/'B' to swimresult.qualcode (individual) or
 * relay.qualcode (relay) for exactly this grouping; two athletes/teams per
 * final here is enough to prove the ordering without needing real lane
 * capacity.
 */
function seedFinaleAB(db: DbBackend) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (1, 100, 'Freestyle', 1)`)
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount) VALUES (2, 100, 'Freestyle Relay', 4)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)

  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (1, 1, 1, 1, 2, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (10, 1, '19+F', 19, -1, 2, 1)`)

  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, sortcode, internalevent) VALUES (2, 1, 2, 2, 2, 2, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (20, 2, '19+F', 19, -1, 2, 1)`)

  db.exec(`INSERT INTO club (clubid, code, name) VALUES (1, 'AAA', 'A Club')`)
  db.exec(`INSERT INTO club (clubid, code, name) VALUES (2, 'BBB', 'B Club')`)

  // Individual: Finale A athlete is slower (32000ms) than the Finale B one
  // (20000ms), but must still outrank them.
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (1, 1, 'A', 'Finalist', 2, '2000-01-01')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate) VALUES (2, 2, 'B', 'Finalist', 2, '2000-01-01')`)
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (100, 1, 1, 5)`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime, qualcode) VALUES (1, 1, 1, 10, 100, 32000, 'A')`)
  db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, swimtime, qualcode) VALUES (2, 2, 1, 10, 100, 20000, 'B')`)

  // Relay: same setup, same clubs.
  db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (200, 2, 1, 5)`)
  db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, agegroupid, heatid, swimtime, resultstatus, qualcode) VALUES (1, 1, 2, 20, 200, 33000, 0, 'A')`)
  db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, agegroupid, heatid, swimtime, resultstatus, qualcode) VALUES (2, 2, 2, 20, 200, 21000, 0, 'B')`)
}

const cat1112: CategoryConfig = {
  ageMin: 11, ageMax: 12, gender: 2,
  name: 'Cumulatif 11-12 ans - filles',
  pointsForPlaces: '20,18,16,14',
  sortbyresfirst: 'F', finalusetype: '2', isSpecialNoEvents: false,
}

const cat19plus: CategoryConfig = {
  ageMin: 19, ageMax: -1, gender: 2,
  name: 'Cumulatif 19 ans et plus - dames',
  pointsForPlaces: '20,18,16,14',
  sortbyresfirst: 'F', finalusetype: '2', isSpecialNoEvents: false,
}

describe.each(BACKENDS)('combinedEvents [%s]', (kind) => {
  let db: DbBackend
  let dropPgDb: (() => Promise<void>) | undefined
  let cleanupSqlite: (() => void) | undefined

  beforeAll(async () => {
    pgState.connected = kind === 'pg'
    if (kind === 'pg') {
      const h = await createPgTestDb()
      db = h.db
      dropPgDb = h.cleanup
    }
  })

  afterAll(async () => {
    if (kind === 'pg' && dropPgDb) await dropPgDb()
    pgState.connected = false
  })

  beforeEach(() => {
    if (kind === 'sqlite') {
      const t = createTestDb()
      db = t.db as unknown as DbBackend
      cleanupSqlite = t.cleanup
    } else {
      resetTestDb(db)
    }
  })

  afterEach(() => {
    if (kind === 'sqlite') cleanupSqlite?.()
  })

  describe('age-group scoping', () => {
    it('findMatchingEvents keeps distinct agegroupIds for the same swimeventid', () => {
      seedSharedEvent(db)
      const events = queryEventsWithAgeGroups(db)

      const matched1112 = findMatchingEvents(events, cat1112)
      const matched19plus = findMatchingEvents(events, cat19plus)

      expect(matched1112).toEqual([{ eventId: 1, agegroupId: 10 }])
      expect(matched19plus).toEqual([{ eventId: 1, agegroupId: 20 }])
    })

    it('regenerateCombinedEvents emits agegroupid on each EVENT so categories do not merge', () => {
      seedSharedEvent(db)
      regenerateCombinedEvents(db)

      const row = db.prepare(`SELECT data FROM bsglobal WHERE name = 'COMBINEDEVENTS'`).get() as { data: string }
      expect(row.data).toContain('eventid="1" agegroupid="10"')
      expect(row.data).toContain('eventid="1" agegroupid="20"')
    })
  })

  describe('prelim/final resolution', () => {
    it('resolveToFinal resolves a prelim event+agegroup to its final counterpart', () => {
      seedPrelimFinalPair(db)
      expect(resolveToFinal(db, 100, 101)).toEqual({ eventId: 200, agegroupId: 201 })
    })

    it('resolveToFinal falls back to the prelim when no final exists', () => {
      seedSharedEvent(db)
      expect(resolveToFinal(db, 1, 10)).toEqual({ eventId: 1, agegroupId: 10 })
    })

    it('getCombinedResults scores off the FINAL placement, not the prelim heat time', () => {
      seedPrelimFinalPair(db)
      // Select the PRELIM event (id 100) — the row a user actually ticks in the report tree
      const categories = getCombinedResults([100], db)
      const cat = categories.find(c => c.name.includes('19 ans et plus') && c.name.includes('hommes'))
      expect(cat).toBeDefined()
      // Athlete 1 was 2nd in the prelim (32000ms, slower) but 1st in the final (29000ms) —
      // combined-events points must reflect the final placement.
      expect(cat!.athletes[0].firstName).toBe('A')
      expect(cat!.athletes[0].totalPoints).toBeGreaterThan(cat!.athletes[1].totalPoints)
    })
  })

  describe('relay handling', () => {
    it('queryEventsWithAgeGroups excludes relay events (relaycount > 1)', () => {
      seedIndividualAndRelay(db)
      const events = queryEventsWithAgeGroups(db)
      expect(events.map(e => e.swimeventid)).toEqual([1])
    })

    it('getCombinedResults (per-athlete "Résultat combiné") never awards points from a relay result', () => {
      seedIndividualAndRelay(db)
      const categories = getCombinedResults([1, 2], db)
      const cat = categories.find(c => c.name.includes('19 ans et plus') && c.name.includes('dames'))
      expect(cat).toBeDefined()
      expect(cat!.athletes.map(a => a.clubName)).toEqual(['IND'])
    })

    it('getPointStandings (club "Classement aux points") awards points from BOTH individual and relay results', () => {
      seedIndividualAndRelay(db)
      const { clubs } = getPointStandings([1, 2], db)
      const byCode = new Map(clubs.map(c => [c.clubCode, c.totalPoints]))
      expect(byCode.get('IND')).toBeGreaterThan(0)
      expect(byCode.get('REL')).toBeGreaterThan(0)
    })
  })

  describe('Finale A/B qualification ordering (§4.4.2.1)', () => {
    it('getCombinedResults ranks the Finale A athlete ahead of a faster Finale B athlete', () => {
      seedFinaleAB(db)
      const categories = getCombinedResults([1], db)
      const cat = categories.find(c => c.name.includes('19 ans et plus') && c.name.includes('dames'))
      expect(cat).toBeDefined()
      // Athlete 1 (Finale A, 32000ms) must outrank athlete 2 (Finale B,
      // 20000ms — the faster raw time) despite losing on time.
      expect(cat!.athletes[0].firstName).toBe('A')
      expect(cat!.athletes[0].totalPoints).toBeGreaterThan(cat!.athletes[1].totalPoints)
    })

    it('getPointStandings awards the Finale A club more points than the faster Finale B club (individual)', () => {
      seedFinaleAB(db)
      const { clubs } = getPointStandings([1], db)
      const byCode = new Map(clubs.map(c => [c.clubCode, c.totalPoints]))
      expect(byCode.get('AAA')).toBeGreaterThan(byCode.get('BBB') ?? 0)
    })

    it('getPointStandings applies the same Finale A/B ordering to relay results', () => {
      seedFinaleAB(db)
      const { clubs } = getPointStandings([2], db)
      const byCode = new Map(clubs.map(c => [c.clubCode, c.totalPoints]))
      // Club A's relay (Finale A, 33000ms) must outscore Club B's (Finale B,
      // 21000ms — the faster raw time).
      expect(byCode.get('AAA')).toBeGreaterThan(byCode.get('BBB') ?? 0)
    })

    it('falls back to pure time ordering when qualcode is unset (no A/B split in use)', () => {
      // The vast majority of meets never call autoQualify/seedFinals, so
      // qualcode is NULL on every row — confirm the fix is a no-op there via
      // the existing prelim/final fixture, which never sets qualcode and
      // still ranks the faster final time first.
      seedPrelimFinalPair(db)
      const categories = getCombinedResults([100], db)
      const cat = categories.find(c => c.name.includes('19 ans et plus') && c.name.includes('hommes'))
      expect(cat!.athletes[0].firstName).toBe('A') // 29000ms in the final, still fastest
    })
  })
})
