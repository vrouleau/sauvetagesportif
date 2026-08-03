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

// Cross-language drift test for the SERC weighted-total formula.
//
// computeSercTotal() (sercScoring.js) and compute_serc_total()
// (backend/app/routers/serc.py) implement the identical formula in JS and
// Python — can't share a module across that boundary, so both are tested
// against the same fixture (tests/fixtures/serc_scoring.json).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeSercTotal } from './sercScoring.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(__dirname, '../../tests/fixtures/serc_scoring.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('computeSercTotal (fixture-driven)', () => {
  for (const c of fixture.cases) {
    it(c.note, () => {
      const factors = {
        overall: c.overallFactors,
        bystander: c.bystanderFactors,
        victims: c.victimFactors,
      }
      const result = computeSercTotal(c.scores, factors, c.hasBystander, c.numVictims)
      expect(result).toBeCloseTo(c.expectedTotal, 2)
    })
  }
})
