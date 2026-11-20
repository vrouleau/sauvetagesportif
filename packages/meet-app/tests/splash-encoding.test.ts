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
 * meet-app stores Splash's own encodings (Splash reads our rows directly on a shared Postgres
 * database). These are the small mappers between them and LENEX / the UI.
 */
import { describe, it, expect, vi } from 'vitest'

// db.ts imports Electron through connectionManager — not needed for these pure helpers
vi.mock('../src/main/connectionManager', () => ({
  getDb: () => { throw new Error('not used') }, isPgConnected: () => false, closeDb: () => {},
}))

import { ROUND, roundFromLenex, roundToLenex, roundFromPhase, phaseOfRound, roundFromRequest } from '../src/main/rounds'
import { dsqAppliesTo, SPLASH_DSQ_NO_OPTIONS } from '../src/main/dsqCodes'
import { COURSE, courseFromName, courseToName, courseFromRequest } from '../src/main/courses'
import { linkedPrelim, NO_PREV_EVENT, NO_AGE_LIMIT } from '../src/main/db'

describe('round codes (Splash RoundNames: 1 TIM, 2 PRE, 6 SEM, 9 FIN, 11 Break)', () => {
  it('uses Splash codes', () => {
    expect(ROUND).toEqual({ TIM: 1, PRE: 2, SEM: 6, FIN: 9, BREAK: 11 })
  })

  it('maps LENEX names both ways, unknown → timed final', () => {
    for (const name of ['TIM', 'PRE', 'SEM', 'FIN'] as const) expect(roundToLenex(roundFromLenex(name))).toBe(name)
    expect(roundFromLenex(undefined)).toBe(ROUND.TIM)
    expect(roundFromLenex('pre')).toBe(ROUND.PRE)
    expect(roundToLenex(ROUND.BREAK)).toBe('TIM')
  })

  it('maps UI phases both ways', () => {
    for (const p of ['Finale', 'Eliminatoire', 'Finale directe'] as const) expect(phaseOfRound(roundFromPhase(p))).toBe(p)
  })

  it('accepts a LENEX name or a code from the shared EventsPage', () => {
    expect(roundFromRequest('PRE')).toBe(2)
    expect(roundFromRequest('TIM')).toBe(1)
    expect(roundFromRequest(9)).toBe(9)
  })
})

describe('Splash "none" values', () => {
  it('stores -1, and reads -1 or NULL as no linked prelim', () => {
    expect(NO_PREV_EVENT).toBe(-1)
    expect(NO_AGE_LIMIT).toBe(-1)
    expect(linkedPrelim(-1)).toBeNull()
    expect(linkedPrelim(null)).toBeNull()
    expect(linkedPrelim(0)).toBeNull()
    expect(linkedPrelim(1234)).toBe(1234)
  })
})

describe('DSQ applies-to tag (ours, not in Splash\'s dsqitem.options)', () => {
  it('compacts dsq-codes.json options, defaulting to both', () => {
    expect(dsqAppliesTo('INDIVIDUAL,RELAY')).toBe('IR')
    expect(dsqAppliesTo('INDIVIDUAL')).toBe('I')
    expect(dsqAppliesTo('RELAY')).toBe('R')
    expect(dsqAppliesTo(undefined)).toBe('IR')
    expect(SPLASH_DSQ_NO_OPTIONS).toBe('00000')
  })
})

describe('course codes (Splash CourseNames: 1 LCM, 2 SCM, 3 SCY; beach meet 7)', () => {
  it('uses Splash codes — 25 m is 2, as in real Splash 25 m meets (CAEM 2026, CQS 2025)', () => {
    expect(COURSE).toEqual({ LCM: 1, SCM: 2, SCY: 3, BEACH: 7 })
  })

  it('maps names both ways; beach and unknown read as LCM', () => {
    for (const n of ['LCM', 'SCM', 'SCY'] as const) expect(courseToName(courseFromName(n))).toBe(n)
    expect(courseFromName('scm')).toBe(2)
    expect(courseFromName('OPEN')).toBeNull()
    expect(courseToName(COURSE.BEACH)).toBe('LCM')
    expect(courseToName('2')).toBe('SCM')
  })

  it('accepts a name from the shared editor, or a code', () => {
    expect(courseFromRequest('SCM')).toBe(2)
    expect(courseFromRequest('3')).toBe(3)
    expect(courseFromRequest(1)).toBe(1)
  })
})
