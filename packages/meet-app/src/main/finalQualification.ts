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
 * Pure final-qualification rules (no database) — one age group at a time.
 *
 * Mirrors what Splash does when it computes the finals of an age group:
 *  - the fastest `slotsPerHeat` swimmers go to A, the next `slotsPerHeat` to B, … up to
 *    `heatCount` finals (the age group's own `heatcount`), then `reserveCount` reserves ('R');
 *  - swimmers with exactly the same time that straddle a boundary (e.g. two 45.00 for the
 *    last A place) are NOT split arbitrarily: both are left unqualified and flagged `tied`
 *    (Splash shows "?") until the organizer decides. Positions still follow the original
 *    ranking, so the other swimmers keep their final.
 */

export const FINAL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export interface QualificationPlanEntry {
  /** 'A'…'Z' | 'R' (reserve) | null (not qualified, or a tie that needs a decision) */
  code: string | null
  /** True when this swimmer's time is shared across a boundary — needs a manual decision */
  tied: boolean
}

/** Code of the swimmer ranked `index` (0-based) before looking at ties. */
function codeAt(index: number, slotsPerHeat: number, heatCount: number, reserveCount: number): string | null {
  if (slotsPerHeat <= 0) return null
  const heatIndex = Math.floor(index / slotsPerHeat)
  if (heatIndex < heatCount) return FINAL_LETTERS[heatIndex] ?? null
  if (index < heatCount * slotsPerHeat + reserveCount) return 'R'
  return null
}

/**
 * @param timesMs  Times of the age group's eligible swimmers, fastest first (null = no time,
 *                 never ties with anything).
 */
export function planQualification(
  timesMs: Array<number | null>,
  slotsPerHeat: number,
  heatCount: number,
  reserveCount = 2,
): QualificationPlanEntry[] {
  const plan: QualificationPlanEntry[] = timesMs.map((_, i) => ({
    code: codeAt(i, slotsPerHeat, heatCount, reserveCount),
    tied: false,
  }))

  let start = 0
  while (start < timesMs.length) {
    let end = start
    const t = timesMs[start]
    while (t != null && end + 1 < timesMs.length && timesMs[end + 1] === t) end++
    if (end > start) {
      const first = codeAt(start, slotsPerHeat, heatCount, reserveCount)
      const last = codeAt(end, slotsPerHeat, heatCount, reserveCount)
      if (first !== last) {
        for (let i = start; i <= end; i++) plan[i] = { code: null, tied: true }
      }
    }
    start = end + 1
  }
  return plan
}
