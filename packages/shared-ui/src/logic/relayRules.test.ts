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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isAgeCodeAllowedOnTeam, wouldMissNativeAnchor } from './relayRules'

// Shared with team-app/backend/app/routers/api.py's _age_code_allowed_on_team /
// _would_miss_native_anchor (Python, can't share the module directly) — this
// fixture is iterated by both languages' test suites so drift becomes a test
// failure instead of a silent bug. See docs/SHARED_LOGIC_CONSOLIDATION_PLAN.md.
const fixturePath = join(__dirname, '../../../team-app/tests/fixtures/relay_age_rules.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  order: string[]
  isAgeCodeAllowedOnTeam: Array<{ candidateCode: string; nativeCode: string; expected: boolean; note: string }>
  wouldMissNativeAnchor: Array<{
    otherAssignedCodes: string[]
    candidateCode: string
    nativeCode: string
    remainingAfterThis: number
    expected: boolean
    note: string
  }>
}

describe('relayRules (cross-language fixture: relay_age_rules.json)', () => {
  describe('isAgeCodeAllowedOnTeam', () => {
    for (const c of fixture.isAgeCodeAllowedOnTeam) {
      it(`${c.candidateCode} on ${c.nativeCode} team → ${c.expected} (${c.note})`, () => {
        expect(isAgeCodeAllowedOnTeam(c.candidateCode, c.nativeCode, fixture.order)).toBe(c.expected)
      })
    }
  })

  describe('wouldMissNativeAnchor', () => {
    for (const c of fixture.wouldMissNativeAnchor) {
      it(`other=${JSON.stringify(c.otherAssignedCodes)} candidate=${c.candidateCode} native=${c.nativeCode} remaining=${c.remainingAfterThis} → ${c.expected} (${c.note})`, () => {
        expect(wouldMissNativeAnchor(c.otherAssignedCodes, c.candidateCode, c.nativeCode, c.remainingAfterThis)).toBe(c.expected)
      })
    }
  })
})
