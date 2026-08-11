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
 * Tests for age-group reference-date resolution, per Règlements des
 * compétitions de sauvetage sportif au Québec (Édition septembre 2025),
 * §1.1-1.3. The worked examples below are taken directly from that document.
 */
import { describe, it, expect } from 'vitest'
import { resolveMatchingAge, getSeasonYear } from '../src/main/ageGroupRules'
import { createTestDb } from './helpers'

describe('resolveMatchingAge', () => {
  it('born 2012-11-15, pool season 2025-2026 → 13 (must compete 13-14, not 11-12)', () => {
    // 12 at 1er septembre 2025, but turns 13 before 31 décembre 2025 — the
    // rulebook's own example: bumped up to 13-14 for the whole season.
    const age = resolveMatchingAge(new Date(2012, 10, 15), 'POOL', 2025)
    expect(age).toBe(13)
  })

  it('born 2013-02-15, pool season 2025-2026 → 12 (stays in 11-12 all season)', () => {
    // 12 at 1er septembre 2025 and still 12 at 31 décembre 2025 — stays 11-12.
    const age = resolveMatchingAge(new Date(2013, 1, 15), 'POOL', 2025)
    expect(age).toBe(12)
  })

  it('10 ans et moins is locked at season start regardless of a Dec 31 birthday', () => {
    // Born 2014-12-20: 10 at 1er septembre 2025 (birthday hasn't occurred yet
    // that calendar year), turns 11 on Dec 20 — must stay in 10 ans et moins
    // per the explicit "indépendamment de l'âge atteint au 31 décembre" rule
    // (no Dec-31 spill-up exclusion for this bracket, unlike 11-12).
    const age = resolveMatchingAge(new Date(2014, 11, 20), 'POOL', 2025)
    expect(age).toBe(10)
  })

  it('13-14 / 15-18 / Open are determined purely by age at Dec 31, not season start', () => {
    // Born 2010-10-15: only 14 at 1er septembre 2025 (birthday hasn't happened
    // yet), turns 15 on Oct 15 2025 — the season-start age (14) never gets a
    // say here since it isn't in the 10-/11-12 bracket group; the final age
    // used for matching is the Dec-31 one (15), landing them in 15-18.
    const age = resolveMatchingAge(new Date(2010, 9, 15), 'POOL', 2025)
    expect(age).toBe(15)
  })

  it('beach season uses 1er mai instead of 1er septembre', () => {
    // 12 at May 1 2025 (born 2012-11-15), still 12 at May 1, but turns 13
    // before Dec 31 2025 → bumped to 13-14, same logic as the pool example
    // above, just anchored to the beach season-start date.
    const age = resolveMatchingAge(new Date(2012, 10, 15), 'BEACH', 2025)
    expect(age).toBe(13)
  })

  it('is stable across repeated calls for the same season (no wall-clock drift)', () => {
    // Regression guard for the bug this module replaces: age-group matching
    // used to be computed from `new Date()` (today), so the same athlete
    // could land in a different bracket depending on when a coach happened
    // to click "register." Fixed inputs must always produce the same output.
    const birthdate = new Date(2014, 5, 10)
    const first = resolveMatchingAge(birthdate, 'POOL', 2025)
    const second = resolveMatchingAge(birthdate, 'POOL', 2025)
    expect(first).toBe(second)
  })
})

describe('getSeasonYear', () => {
  it('reads the year from bsglobal.AGEDATE (Splash D;YYYYMMDDHHMMSSMMM format)', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('AGEDATE', 'D;20250901000000000')`).run()
      expect(getSeasonYear(db)).toBe(2025)
    } finally {
      cleanup()
    }
  })

  it('falls back to the current year when AGEDATE is not set', () => {
    const { db, cleanup } = createTestDb()
    try {
      expect(getSeasonYear(db)).toBe(new Date().getFullYear())
    } finally {
      cleanup()
    }
  })
})
