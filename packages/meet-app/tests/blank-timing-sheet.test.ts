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
import type Database from 'better-sqlite3'
import { createTestDb, seedMeet } from './helpers'
import {
  isBlankScan, makeBlankBarcode, parseChronoTimes, parseBlankSheetResponse,
  findBlankSheetCandidates, pickBlankSheetTarget,
} from '../src/main/blankTimingSheet'
import { generateBlankTimingSheetsHtml, generateTimingSheetsHtml, buildTimingSheetPages } from '../src/main/timingSheets'
import { decodeBarcode } from '../src/main/timingBarcode'

describe('Blank scan id', () => {
  it('is recognised and never decodes as a barcode', () => {
    const raw = makeBlankBarcode(1700000000000)
    expect(raw).toBe('BLANK-1700000000000')
    expect(isBlankScan(raw)).toBe(true)
    expect(isBlankScan('E5-U1496-H2-L3')).toBe(false)
    expect(decodeBarcode(raw)).toBeNull()
  })
})

describe('Gemini response parsing', () => {
  it('parses chrono times (barcoded strips — unchanged behaviour)', () => {
    expect(parseChronoTimes('C1:1:23.45\nC2:1:24.02')).toEqual({ time1: '1:23.45', time2: '1:24.02', confidence: 0.95 })
    expect(parseChronoTimes('C1:unclear\nC2:1:24.02').confidence).toBe(0.3)
    expect(parseChronoTimes('times are 0:31.10 and 0:31.22')).toMatchObject({ time1: '0:31.10', time2: '0:31.22' })
  })

  it('parses a blank sheet reading', () => {
    const r = parseBlankSheetResponse('E:12\nH:3\nL:5\nC1:1:23.45\nC2:1:24.02')
    expect(r).toEqual({ eventNumber: 12, heatNumber: 3, lane: 5, time1: '1:23.45', time2: '1:24.02', confidence: 0.95 })
  })

  it('tolerates spacing / case and unreadable identity', () => {
    const r = parseBlankSheetResponse(' e : 7 \nH:unclear\nl=4\nC1:0:45.10\nC2:0:45.20')
    expect(r.eventNumber).toBe(7)
    expect(r.heatNumber).toBe(0)
    expect(r.lane).toBe(4)
    expect(r.time1).toBe('0:45.10')
    expect(r.confidence).toBe(0.3) // identity incomplete → low confidence even with clean times
  })

  it('does not confuse C1/C2 lines with E/H/L', () => {
    const r = parseBlankSheetResponse('C1:1:02.33\nC2:1:02.40\nE:2\nH:1\nL:6')
    expect(r).toMatchObject({ eventNumber: 2, heatNumber: 1, lane: 6, time1: '1:02.33', time2: '1:02.40' })
  })
})

describe('Blank sheet target resolution', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    ;({ db, cleanup } = createTestDb())
    seedMeet(db)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (2, 1, 'Jane', 'Roe', 2, '2001-02-02', 'CAN')`)
    // Event 1 (id 1, TIM): heat 1, Doe in lane 3
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber) VALUES (10, 1, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, swimeventid, athleteid, heatid, lane) VALUES (100, 1, 1, 10, 3)`)
  })
  afterEach(() => cleanup())

  it('finds the athlete seeded at event/heat/lane', () => {
    const c = findBlankSheetCandidates(db, 1, 1, 3)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ swimEventId: 1, eventNumber: 1, heatNumber: 1, lane: 3, entryLabel: 'Doe, John', clubCode: 'TST', hasTime: false })
    expect(c[0].eventName).toBe('100m Freestyle')
    expect(pickBlankSheetTarget(c)?.swimEventId).toBe(1)
  })

  it('returns nothing for an empty lane or unreadable identity', () => {
    expect(findBlankSheetCandidates(db, 1, 1, 4)).toEqual([])
    expect(findBlankSheetCandidates(db, 1, 2, 3)).toEqual([])
    expect(findBlankSheetCandidates(db, 0, 1, 3)).toEqual([])
    expect(pickBlankSheetTarget([])).toBeNull()
  })

  it('finds relay teams too', () => {
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber) VALUES (20, 2, 1)`)
    db.exec(`INSERT INTO relay (relayid, clubid, swimeventid, heatid, lane, name) VALUES (500, 1, 2, 20, 2, 'TST A')`)
    const c = findBlankSheetCandidates(db, 2, 1, 2)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ swimEventId: 2, entryLabel: 'TST A', clubCode: 'TST' })
  })

  it('prelim + final sharing an event number: picks the round without a time', () => {
    // Make event 1 a prelim with a time, and add its final (same event number)
    db.exec(`UPDATE swimevent SET round = 1 WHERE swimeventid = 1`)
    db.exec(`UPDATE swimresult SET swimtime = 61230 WHERE swimresultid = 100`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent, preveventid) VALUES (4, 1, 1, 1, 1, 4, 3, 'F', 1)`)
    db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber) VALUES (30, 4, 1)`)
    db.exec(`INSERT INTO swimresult (swimresultid, swimeventid, athleteid, heatid, lane) VALUES (101, 4, 2, 30, 3)`)

    const c = findBlankSheetCandidates(db, 1, 1, 3)
    expect(c.map((x) => x.swimEventId)).toEqual([1, 4]) // ordered by round: PRE, FIN
    expect(pickBlankSheetTarget(c)?.swimEventId).toBe(4)
    expect(pickBlankSheetTarget(c)?.entryLabel).toBe('Roe, Jane')

    // Both open → ambiguous, operator decides
    db.exec(`UPDATE swimresult SET swimtime = 0 WHERE swimresultid = 100`)
    expect(pickBlankSheetTarget(findBlankSheetCandidates(db, 1, 1, 3))).toBeNull()
  })
})

describe('Blank timing sheet HTML', () => {
  it('has underlined event/heat/lane and chrono fields, and no barcode', () => {
    const html = generateBlankTimingSheetsHtml()
    expect((html.match(/class="strip"/g) ?? []).length).toBe(3)
    expect((html.match(/class="id-line"/g) ?? []).length).toBe(9)
    expect(html).toContain('Épreuve')
    expect(html).toContain('Série')
    expect(html).toContain('Couloir')
    expect(html).toContain('FICHE VIERGE')
    expect((html.match(/Chrono 1/g) ?? []).length).toBe(3)
    expect((html.match(/class="time-line /g) ?? []).length).toBe(3 * 2 * 3) // 3 strips × 2 chronos × M/SS/HH
    expect(html).not.toContain('digit-box')
    expect(html).not.toContain('<svg')
  })

  it('repeats pages and clamps the count', () => {
    const count = (n: number) => (generateBlankTimingSheetsHtml(n).match(/class="page"/g) ?? []).length
    expect(count(3)).toBe(3)
    expect(count(0)).toBe(1)
    expect(count(500)).toBe(50)
  })

  it('barcoded sheets still render barcode + the shared chrono rows', () => {
    const pages = buildTimingSheetPages(1496, 5, '100m Freestyle', 2, [3, 4], undefined, new Map([[3, 'Doe, John']]))
    const html = generateTimingSheetsHtml(pages)
    expect(html).toContain('E5-U1496-H2-L3')
    expect(html).toContain('<svg')
    expect((html.match(/class="time-line /g) ?? []).length).toBe(2 * 2 * 3)
    expect(html).not.toContain('FICHE VIERGE')
  })
})
