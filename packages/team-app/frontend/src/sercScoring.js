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
 * SERC weighted-total formula: sum of raw_score * factor across
 * overall/bystander/victim sections, plus a flat "rough handling" add per
 * section, rounded to 2 decimals.
 *
 * `scores` is `{section: {field: value}}` (the shape the judge-scoring grid
 * keeps per team). Mirrors compute_serc_total() in
 * backend/app/routers/serc.py — Python, can't share this module across the
 * language boundary, so both are kept in sync via the fixture in
 * tests/fixtures/serc_scoring.json (see docs/SHARED_LOGIC_CONSOLIDATION_PLAN.md).
 */
export function computeSercTotal(scores, factors, hasBystander, numVictims) {
  const of = factors?.overall || {}
  const bf = factors?.bystander || {}
  const vfs = factors?.victims || []
  let total = 0

  const overall = scores.overall || {}
  for (const f of ['assessment', 'control', 'communication', 'search', 'teamwork'])
    total += (overall[f] || 0) * (of[f] || 1)
  total += overall.rough || 0

  if (hasBystander) {
    const bystander = scores.bystander || {}
    for (const f of ['approach', 'info', 'directions', 'monitoring', 'encouragement'])
      total += (bystander[f] || 0) * (bf[f] || 1)
    total += bystander.rough || 0
  }

  for (let i = 0; i < numVictims; i++) {
    const victim = scores[`victim_${i}`] || {}
    const vf = vfs[i] || {}
    for (const f of ['approach', 'rescue', 'control', 'landing', 'care'])
      total += (victim[f] || 0) * (vf[f] || 1)
    total += victim.rough || 0
  }

  return Math.round(total * 100) / 100
}
