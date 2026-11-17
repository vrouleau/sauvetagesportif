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

// Known swimstyle id series guard (config/swimstyle-ranges.json) — mirrors
// packages/team-app/tests/unit/test_swimstyle_check.py.

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { styleMeetType, findSwimstyleIssues } from '../src/main/swimstyleRanges'
import { checkLenexSwimstyles, checkLenexSwimstylesXml } from '../src/main/lenex'

const CONFIG = join(__dirname, '../../../config')

function lef(events: string): string {
  return `<?xml version="1.0"?><LENEX><MEETS><MEET name="T"><SESSIONS><SESSION number="1"><EVENTS>${events}</EVENTS></SESSION></SESSIONS></MEET></MEETS></LENEX>`
}
const ev = (id: number, styleAttrs: string) =>
  `<EVENT eventid="${id}" number="${id}"><SWIMSTYLE ${styleAttrs} /></EVENT>`

describe('swimstyle ranges', () => {
  it('classifies range boundaries', () => {
    expect(styleMeetType(499)).toBeNull()
    expect(styleMeetType(500)).toBe('POOL')
    expect(styleMeetType(531)).toBe('POOL')
    expect(styleMeetType(532)).toBeNull()
    expect(styleMeetType(600)).toBeNull()
    expect(styleMeetType(601)).toBe('BEACH')
    expect(styleMeetType(624)).toBe('BEACH')
    expect(styleMeetType(625)).toBeNull()
    expect(styleMeetType(0)).toBeNull()
  })

  it('reports out-of-range ids once, sorted, ignoring placeholders', () => {
    const r = findSwimstyleIssues([
      { id: 540, name: 'Old relay' }, { id: 501, name: 'ok' },
      { id: 538, name: 'Old medley' }, { id: 540, name: 'Old relay' }, { id: 0, name: '' },
    ])
    expect(r.outOfRange).toEqual([{ id: 538, name: 'Old medley' }, { id: 540, name: 'Old relay' }])
    expect(r.mixed).toBe(false)
  })

  it('flags pool + beach in one structure as mixed', () => {
    expect(findSwimstyleIssues([{ id: 501, name: '' }, { id: 601, name: '' }]).mixed).toBe(true)
    // an out-of-range id is neither type
    expect(findSwimstyleIssues([{ id: 501, name: '' }, { id: 999, name: '' }]).mixed).toBe(false)
  })
})

describe('checkLenexSwimstyles', () => {
  it('reads EVENT/SWIMSTYLE ids and skips ID0 pause placeholders', () => {
    const r = checkLenexSwimstylesXml(lef(
      ev(1, 'swimstyleid="501" name="ok"') +
      ev(2, 'swimstyleid="777" code="ID0" stroke="UNKNOWN"') +
      ev(3, 'swimstyleid="538" name="4 x 50 m - Relais Medley"'),
    ))
    expect(r.outOfRange).toEqual([{ id: 538, name: '4 x 50 m - Relais Medley' }])
    expect(r.mixed).toBe(false)
  })

  it('detects a mixed pool/beach file', () => {
    const r = checkLenexSwimstylesXml(lef(ev(1, 'swimstyleid="501"') + ev(2, 'swimstyleid="610"')))
    expect(r.mixed).toBe(true)
  })

  it.each(['template_pool.lxf', 'template_beach.lxf'])('shipped %s passes cleanly', (file) => {
    const r = checkLenexSwimstyles(join(CONFIG, file))
    expect(r.outOfRange).toEqual([])
    expect(r.mixed).toBe(false)
  })
})
