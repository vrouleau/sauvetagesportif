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
import { planQualification } from '../src/main/finalQualification'

const codes = (times: Array<number | null>, slots: number, heats: number, reserves = 2) =>
  planQualification(times, slots, heats, reserves).map((p) => p.code)

describe('planQualification', () => {
  // The 15-18 Final of the real Splash meet (4 lanes, heatcount 3, 2 reserves):
  // Splash showed A = 3 swimmers + the two tied at 45.00 left as "?", B = 46/48/49, C = 50-54, R = 55/56.
  const splashTimes = [41, 42, 42, 45, 45, 46, 48, 49, 50, 51, 53, 54, 55, 56, 57, 58].map((s) => s * 1000)

  it('matches Splash on the 15-18 final: A/B/C by 4 lanes, 2 reserves, tie at the A/B cutoff left open', () => {
    const plan = planQualification(splashTimes, 4, 3, 2)
    expect(plan.map((p) => p.code)).toEqual([
      'A', 'A', 'A', null, null, // ranks 4-5 both 45.00 → one A place + one B place → undecided
      'B', 'B', 'B',
      'C', 'C', 'C', 'C',
      'R', 'R',
      null, null,
    ])
    expect(plan.map((p) => p.tied)).toEqual([
      false, false, false, true, true, false, false, false, false, false, false, false, false, false, false, false,
    ])
  })

  it('a tie fully inside one final is not a tie', () => {
    // Two 42.00 both inside A (4 lanes): ranks 2-3
    expect(codes([41000, 42000, 42000, 43000, 44000], 4, 2)).toEqual(['A', 'A', 'A', 'A', 'B'])
  })

  it('flags a tie straddling the last reserve and the cutoff', () => {
    // 1 lane, 1 final, 2 reserves: ranks 3 and 4 tie, rank 3 = last reserve, rank 4 = out
    const plan = planQualification([40000, 41000, 42000, 42000, 43000], 1, 1, 2)
    expect(plan.map((p) => p.code)).toEqual(['A', 'R', null, null, null])
    expect(plan.map((p) => p.tied)).toEqual([false, false, true, true, false])
  })

  it('a heatcount of 1 gives one final plus reserves', () => {
    expect(codes([40000, 41000, 42000, 43000, 44000, 45000], 2, 1, 2)).toEqual(['A', 'A', 'R', 'R', null, null])
  })

  it('swimmers without a time never tie with each other', () => {
    const plan = planQualification([null, null], 1, 1, 1)
    expect(plan.map((p) => p.tied)).toEqual([false, false])
  })

  it('no rows → empty plan', () => {
    expect(planQualification([], 8, 2)).toEqual([])
  })
})
