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

// db.ts pulls in connectionManager (Electron); stub it like the other db-level tests do.
vi.mock('../src/main/connectionManager', () => ({
  isPgConnected: () => false,
  getDb: () => { throw new Error('getLocalDb() should not be called — tests inject db explicitly') },
  closeDb: () => {},
}))

const { autoQualify, seedFinals, clearFinalSeeding, getFinalCandidates, getFinalEvents } = await import('../src/main/db')

/**
 * The 15-18 / 19+ Final of the real Splash meet: a prelim (event 10) and its Final (event 11)
 * share the same two categories, session lanes are 2-5 (4 per final). Splash's own result for
 * 15-18 with heatcount 3: A = 3 swimmers + the two 45.00 left as "?", B = 3, C = 4, R = 2.
 */
describe('Final qualification is per age group', () => {
  let db: any
  let cleanup: () => void

  const PRELIM = 10
  const FINAL = 11
  const PRE_1518 = 100, PRE_19 = 101
  const FIN_1518 = 110, FIN_19 = 111

  const times1518 = [41, 42, 42, 45, 45, 46, 48, 49, 50, 51, 53, 54, 55, 56, 57, 58] // seconds
  const times19 = [44, 47, 52, 59]

  const athleteIds1518: number[] = []
  const athleteIds19: number[] = []

  beforeEach(() => {
    athleteIds1518.length = 0
    athleteIds19.length = 0
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    seedMeet(db)
    db.prepare('UPDATE swimsession SET lanemin=2, lanemax=5 WHERE swimsessionid=1').run()

    db.prepare(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid)
                VALUES (?, 1, 1, 6, 0, 2, 10, 'F', -1)`).run(PRELIM)
    db.prepare(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid)
                VALUES (?, 1, 1, 6, 0, 9, 11, 'F', ?)`).run(FINAL, PRELIM)
    const ag = (id: number, ev: number, name: string, min: number, max: number, heats: number, sort: number) =>
      db.prepare(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, heatcount, sortcode)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ev, name, min, max, heats, sort)
    ag(PRE_1518, PRELIM, '15-18', 15, 18, 1, 1)
    ag(PRE_19, PRELIM, '19+', 19, -1, 1, 2)
    ag(FIN_1518, FINAL, '15-18', 15, 18, 3, 1)  // three finals: A, B, C
    ag(FIN_19, FINAL, '19+', 19, -1, 2, 2)      // only A and B

    let athleteId = 100
    let resultId = 1000
    const addSwimmer = (agId: number, seconds: number, bucket: number[]) => {
      athleteId++
      bucket.push(athleteId)
      db.prepare(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation)
                  VALUES (?, 1, 'F', ?, 1, '2008-01-01', 'CAN')`).run(athleteId, `S${athleteId}`)
      db.prepare(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, swimtime)
                  VALUES (?, ?, ?, ?, ?)`).run(resultId++, athleteId, PRELIM, agId, seconds * 1000)
    }
    times1518.forEach(s => addSwimmer(PRE_1518, s, athleteIds1518))
    times19.forEach(s => addSwimmer(PRE_19, s, athleteIds19))
  })

  afterEach(() => cleanup())

  const qualOf = (athleteId: number): string | null =>
    (db.prepare(`SELECT qualcode FROM swimresult WHERE swimeventid=? AND athleteid=?`).get(FINAL, athleteId) as { qualcode: string | null } | undefined)?.qualcode ?? null

  it('ranks and qualifies each age group on its own, with its own number of finals', () => {
    const { counts, ties } = autoQualify(FINAL, db)

    // 15-18: A 3 + (2 tied, undecided), B 3, C 4, R 2 — and nothing borrowed from 19+
    expect(athleteIds1518.map(qualOf)).toEqual([
      'A', 'A', 'A', null, null, 'B', 'B', 'B', 'C', 'C', 'C', 'C', 'R', 'R', null, null,
    ])
    // 19+: heatcount 2 but only 4 swimmers → all in A (the fastest 19+ swimmer, 44, doesn't take a 15-18 place)
    expect(athleteIds19.map(qualOf)).toEqual(['A', 'A', 'A', 'A'])

    expect(ties).toBe(2)
    expect(counts).toEqual({ A: 7, B: 3, C: 4, R: 2 })
  })

  it('numbers candidates per age group and flags the tie', () => {
    const rows = getFinalCandidates(FINAL, db)
    const r1518 = rows.filter(r => r.ageGroupId === PRE_1518)
    const r19 = rows.filter(r => r.ageGroupId === PRE_19)

    expect(r1518.map(r => r.prelimRank)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    expect(r19.map(r => r.prelimRank)).toEqual([1, 2, 3, 4])
    expect(r1518.map(r => r.finalHeatCount)).toEqual(Array(16).fill(3))
    expect(r19.map(r => r.finalHeatCount)).toEqual([2, 2, 2, 2])
    expect(r1518.filter(r => r.tied).map(r => r.prelimRank)).toEqual([4, 5])
    expect(r19.some(r => r.tied)).toBe(false)
    // age group 15-18 listed before 19+
    expect(rows.slice(0, 16).every(r => r.ageGroupId === PRE_1518)).toBe(true)
  })

  it('re-running with a lower heatcount clears the stale C', () => {
    autoQualify(FINAL, db)
    db.prepare('UPDATE agegroup SET heatcount=2 WHERE agegroupid=?').run(FIN_1518)
    autoQualify(FINAL, db)
    // 4 lanes, 2 finals: A = ranks 1-4 (tie 4/5 now straddles A/B → undecided), B = 5-8, R = 9-10, rest out
    expect(athleteIds1518.map(qualOf)).toEqual([
      'A', 'A', 'A', null, null, 'B', 'B', 'B', 'R', 'R', null, null, null, null, null, null,
    ])
  })

  it('seeds separate A/B/C heats for each age group — an age group\'s A never mixes with another\'s', () => {
    autoQualify(FINAL, db)
    const res = seedFinals(FINAL, db)

    // 15-18: C, B, A (slow first) = 3 heats; 19+: A only = 1 heat
    expect(res.heatsCreated).toBe(4)
    expect(res.overflow).toBe(0)

    const heats = db.prepare(`SELECT heatid, heatnumber, finalcode FROM heat WHERE swimeventid=? ORDER BY heatnumber`).all(FINAL) as
      Array<{ heatid: number; heatnumber: number; finalcode: string }>
    expect(heats.map(h => h.finalcode)).toEqual(['C', 'B', 'A', 'A'])
    expect(heats.map(h => h.heatnumber)).toEqual([1, 2, 3, 4])

    const membersOf = (heatId: number) =>
      (db.prepare(`SELECT agegroupid FROM swimresult WHERE heatid=?`).all(heatId) as Array<{ agegroupid: number }>)
        .map(r => r.agegroupid)
    for (const h of heats) {
      expect(new Set(membersOf(h.heatid)).size).toBe(1)
    }
    expect(membersOf(heats[2].heatid)).toEqual([FIN_1518, FIN_1518, FIN_1518]) // 15-18 A: the 3 decided swimmers
    expect(membersOf(heats[3].heatid)).toEqual([FIN_19, FIN_19, FIN_19, FIN_19])
  })

  it('can qualify, seed and clear a single age group without touching the others', () => {
    autoQualify(FINAL, db, PRE_19)
    expect(athleteIds1518.map(qualOf)).toEqual(Array(16).fill(null)) // 15-18 untouched
    expect(athleteIds19.map(qualOf)).toEqual(['A', 'A', 'A', 'A'])

    autoQualify(FINAL, db, PRE_1518)
    seedFinals(FINAL, db, PRE_19)
    const heatsOf = () => db.prepare(`SELECT finalcode, heatnumber FROM heat WHERE swimeventid=? ORDER BY heatnumber`).all(FINAL) as
      Array<{ finalcode: string; heatnumber: number }>
    expect(heatsOf()).toEqual([{ finalcode: 'A', heatnumber: 1 }]) // 19+ only

    seedFinals(FINAL, db, PRE_1518)
    // 15-18 (C, B, A) sorts before 19+ (A) and everything is renumbered 1..4
    expect(heatsOf().map(h => h.finalcode)).toEqual(['C', 'B', 'A', 'A'])
    expect(heatsOf().map(h => h.heatnumber)).toEqual([1, 2, 3, 4])

    clearFinalSeeding(FINAL, db, PRE_19)
    expect(heatsOf().map(h => h.finalcode)).toEqual(['C', 'B', 'A']) // 15-18's three heats stay
    const seeded1518 = db.prepare(`SELECT COUNT(*) AS c FROM swimresult WHERE swimeventid=? AND heatid IS NOT NULL`).get(FINAL) as { c: number }
    expect(Number(seeded1518.c)).toBe(10) // 3 + 3 + 4
  })

  it('the final event list reports no overflow when each age group fits its lanes', () => {
    autoQualify(FINAL, db)
    const ev = getFinalEvents(db).find(e => e.eventId === FINAL)!
    expect(ev.heatCount).toBe(3) // the highest of the age groups
    expect(ev.hasOverflow).toBe(false) // A = 3 + 4 swimmers over two age groups, but 4 lanes each
  })
})
