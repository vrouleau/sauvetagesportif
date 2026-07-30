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

/**
 * Tests for the relay team age-group composition rule (docs/RELAY_TEAM_RULES.md):
 * a team is anchored to the event's own age category — members must be from that
 * exact category or the single adjacent-younger one (swim-up), and at least 1
 * member must match the exact category.
 *
 * These mirror the pure logic in src/main/index.ts's `isAgeCodeAllowedOnTeam`,
 * `wouldMissNativeAnchor`, `getEventNativeAgeCode` and `getRelayAgeCategoryOrder`
 * (not imported directly — index.ts bootstraps the Electron app on load, which
 * isn't safe under vitest — so the algorithm is duplicated here, same pattern
 * used for the frontend's property tests).
 */

import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers'

function buildAgeCode(agemin: number | null, agemax: number | null): string {
  const min = agemin ?? 0
  if (agemax == null || agemax < 0 || agemax >= 99) return `${min}+`
  return `${min}-${agemax}`
}

function getRelayAgeCategoryOrder(db: import('better-sqlite3').Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT ag.agemin, ag.agemax
    FROM agegroup ag
    JOIN swimevent e ON ag.swimeventid = e.swimeventid
    JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE ss.relaycount > 1
  `).all() as Array<{ agemin: number | null; agemax: number | null }>
  const codes = new Set(rows.map(r => buildAgeCode(r.agemin, r.agemax)))
  return Array.from(codes).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
}

function getEventNativeAgeCode(db: import('better-sqlite3').Database, swimeventid: number): string | null {
  const rows = db.prepare(`SELECT DISTINCT agemin, agemax FROM agegroup WHERE swimeventid = ?`)
    .all(swimeventid) as Array<{ agemin: number | null; agemax: number | null }>
  const codes = new Set(rows.map(r => buildAgeCode(r.agemin, r.agemax)))
  return codes.size === 1 ? Array.from(codes)[0] : null
}

function isAgeCodeAllowedOnTeam(candidateCode: string, nativeCode: string, order: string[]): boolean {
  if (candidateCode === nativeCode) return true
  const ni = order.indexOf(nativeCode)
  const ci = order.indexOf(candidateCode)
  if (ni === -1 || ci === -1) return true
  return ci === ni - 1
}

function wouldMissNativeAnchor(
  otherAssignedCodes: string[],
  candidateCode: string,
  nativeCode: string,
  remainingAfterThis: number
): boolean {
  if (remainingAfterThis > 0) return false
  return !otherAssignedCodes.includes(nativeCode) && candidateCode !== nativeCode
}

describe('relay age-group composition — pure anchor logic', () => {
  const order = ['0-10', '11-12', '13-14', '15-18', '19+']

  it('the exact native category is always allowed', () => {
    expect(isAgeCodeAllowedOnTeam('15-18', '15-18', order)).toBe(true)
  })

  it('the single adjacent-younger category is allowed (swim-up)', () => {
    expect(isAgeCodeAllowedOnTeam('13-14', '15-18', order)).toBe(true)
  })

  it('the adjacent-older category is NOT allowed (no swim-down)', () => {
    expect(isAgeCodeAllowedOnTeam('19+', '15-18', order)).toBe(false)
  })

  it('a category 2+ steps younger (skipping one) is not allowed', () => {
    expect(isAgeCodeAllowedOnTeam('11-12', '15-18', order)).toBe(false)
  })

  it('unknown codes (not in the order list) are never blocked', () => {
    expect(isAgeCodeAllowedOnTeam('Masters', '15-18', order)).toBe(true)
  })

  it('missing the native anchor is only blocked on the last remaining position', () => {
    // 2 positions already filled with swim-up members, 1 more slot after this one:
    // still possible to add a native member later, so don't block yet
    expect(wouldMissNativeAnchor(['13-14', '13-14'], '13-14', '15-18', 1)).toBe(false)
    // last remaining position, and neither existing nor candidate is native → blocked
    expect(wouldMissNativeAnchor(['13-14', '13-14'], '13-14', '15-18', 0)).toBe(true)
    // last remaining position, but the candidate itself is native → fine
    expect(wouldMissNativeAnchor(['13-14', '13-14'], '15-18', '15-18', 0)).toBe(false)
    // last remaining position, an earlier member is already native → fine
    expect(wouldMissNativeAnchor(['15-18', '13-14'], '13-14', '15-18', 0)).toBe(false)
  })
})

describe('relay age-group composition — native code derived from a real meet DB', () => {
  it('resolves the native code when an event has exactly one age category', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (1, 34, 15, 18)`)

      expect(getEventNativeAgeCode(db, 34)).toBe('15-18')
    } finally {
      cleanup()
    }
  })

  it('returns null (ambiguous) when an event has 2+ distinct age categories', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (1, 34, 15, 18)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (2, 34, 19, 99)`)

      expect(getEventNativeAgeCode(db, 34)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('returns null when the event has no age categories at all', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)

      expect(getEventNativeAgeCode(db, 34)).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe('relay age-group composition — order derived from a real meet DB', () => {
  it('sorts distinct relay age categories youngest to oldest, regardless of insertion order', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      // Insert events out of age order to prove the helper sorts, not just passes through
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (35, 1, 530, 35, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (36, 1, 530, 36, 1)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (1, 34, 19, 99)`)   // "19+"
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (2, 35, 0, 10)`)    // "0-10"
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (3, 36, 13, 14)`)   // "13-14"

      const order = getRelayAgeCategoryOrder(db)
      expect(order).toEqual(['0-10', '13-14', '19+'])
    } finally {
      cleanup()
    }
  })

  it('deduplicates identical age categories shared by multiple relay events', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (35, 1, 530, 35, 1)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (1, 34, 15, 18)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (2, 35, 15, 18)`)

      const order = getRelayAgeCategoryOrder(db)
      expect(order).toEqual(['15-18'])
    } finally {
      cleanup()
    }
  })

  it('ignores age groups belonging to individual (non-relay) events', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (501, '50m Freestyle', 1)`)
      db.exec(`INSERT INTO swimstyle (swimstyleid, name, relaycount) VALUES (530, '4x50 Medley Relay', 4)`)
      db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber) VALUES (1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (1, 1, 501, 1, 1)`)
      db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender) VALUES (34, 1, 530, 34, 1)`)
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (1, 1, 11, 12)`)   // individual — excluded
      db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, agemin, agemax) VALUES (2, 34, 15, 18)`)  // relay — included

      const order = getRelayAgeCategoryOrder(db)
      expect(order).toEqual(['15-18'])
    } finally {
      cleanup()
    }
  })
})
