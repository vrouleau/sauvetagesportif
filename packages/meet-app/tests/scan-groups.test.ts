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
import {
  sortScans, buildGroups, groupKeyOf, groupTitle, itemLabel, scanListKey, UNRESOLVED,
  type GroupableScan, type EventLabelLite,
} from '../src/renderer/src/scanGroups'

let nextId = 1
function scan(over: Partial<GroupableScan> & { e?: number; u?: number; h?: number; l?: number }): GroupableScan {
  const { e = 0, u = 0, h = 0, l = 0, ...rest } = over
  return {
    scanId: nextId++, eventNumber: e, swimEventId: u, heatNumber: h, lane: l,
    barcodeRaw: u > 0 ? `E${e}-U${u}-H${h}-L${l}` : 'BLANK-X', status: 'unprocessed',
    recognizedTime1: null, recognizedTime2: null, ...rest,
  }
}

const labels = new Map<number, EventLabelLite>([
  [2, { swimEventId: 2, eventNumber: 2, round: 1, eventName: '200 m Nage avec obstacles' }],
  [4054, { swimEventId: 4054, eventNumber: 7, round: 1, eventName: '100 m Portage Mannequin' }],
  // event 9 has a prelim and a final sharing the number
  [90, { swimEventId: 90, eventNumber: 9, round: 2, eventName: '50 m Libre' }],
  [91, { swimEventId: 91, eventNumber: 9, round: 9, eventName: '50 m Libre' }],
])

describe('sortScans', () => {
  it('orders by event, then heat, then lane, whatever the scan order', () => {
    const list = [
      scan({ e: 7, u: 4054, h: 3, l: 1 }), scan({ e: 2, u: 2, h: 7, l: 2 }),
      scan({ e: 7, u: 4054, h: 1, l: 4 }), scan({ e: 2, u: 2, h: 1, l: 5 }),
      scan({ e: 7, u: 4054, h: 1, l: 2 }),
    ]
    expect(sortScans(list).map((s) => `${s.eventNumber}-${s.heatNumber}-${s.lane}`))
      .toEqual(['2-1-5', '2-7-2', '7-1-2', '7-1-4', '7-3-1'])
  })

  it('puts blank sheets that still need an identity first, oldest first, and keeps resolved blanks in their event', () => {
    const a = scan({ e: 7, u: 4054, h: 1, l: 1 })
    const unresolvedLate = scan({})
    const resolvedBlank = scan({ e: 2, u: 2, h: 3, l: 3, barcodeRaw: 'BLANK-AB12-01' })
    const unresolvedEarly = scan({ e: 5, h: 2, l: 2 }) // read by Gemini but no matching entry yet
    unresolvedEarly.scanId = 0
    const sorted = sortScans([a, unresolvedLate, resolvedBlank, unresolvedEarly])
    expect(sorted.map((s) => groupKeyOf(s))).toEqual([UNRESOLVED, UNRESOLVED, 'u2', 'u4054'])
    expect(sorted[0]).toBe(unresolvedEarly)
  })

  it('does not mutate its input', () => {
    const list = [scan({ e: 7, u: 4054, h: 2, l: 1 }), scan({ e: 2, u: 2, h: 1, l: 1 })]
    const copy = [...list]
    sortScans(list)
    expect(list).toEqual(copy)
  })
})

describe('buildGroups', () => {
  it('makes one group per event with validated / total and indexes into the sorted list', () => {
    const sorted = sortScans([
      scan({ e: 2, u: 2, h: 1, l: 2, status: 'validated' }),
      scan({ e: 2, u: 2, h: 7, l: 2 }),
      scan({ e: 7, u: 4054, h: 1, l: 2, status: 'validated' }),
      scan({ e: 7, u: 4054, h: 1, l: 3, status: 'validated' }),
      scan({}),
    ])
    const groups = buildGroups(sorted, labels)
    expect(groups.map((g) => [g.title, g.validated, g.items.length])).toEqual([
      ['Fiches vierges à identifier', 0, 1],
      ['Épr. 2 · 200 m Nage avec obstacles', 1, 2],
      ['Épr. 7 · 100 m Portage Mannequin', 2, 2],
    ])
    // indexes are positions in the flat list, so ← / → and "Suiv" match what is displayed
    expect(groups.flatMap((g) => g.items.map((i) => i.index))).toEqual([0, 1, 2, 3, 4])
    for (const g of groups) for (const { scan: s, index } of g.items) expect(sorted[index]).toBe(s)
  })

  it('separates a prelim and its final that share the event number, and names the round', () => {
    const sorted = sortScans([scan({ e: 9, u: 91, h: 1, l: 1 }), scan({ e: 9, u: 90, h: 1, l: 1 }), scan({ e: 9, u: 90, h: 2, l: 1 })])
    const groups = buildGroups(sorted, labels)
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([
      ['Épr. 9 · 50 m Libre (Préliminaire)', 2],
      ['Épr. 9 · 50 m Libre (Finale)', 1],
    ])
  })

  it('still works before the event names have loaded', () => {
    const groups = buildGroups(sortScans([scan({ e: 7, u: 4054, h: 1, l: 1 })]), new Map())
    expect(groups[0].title).toBe('Épr. 7')
    expect(groupTitle({ swimEventId: 0, eventNumber: 0 }, new Map())).toBe('Fiches vierges à identifier')
  })

  it('handles an empty list', () => {
    expect(buildGroups([], labels)).toEqual([])
  })
})

describe('itemLabel', () => {
  it('shows heat and lane (the event is in the group title); blank sheets are marked', () => {
    expect(itemLabel(scan({ e: 7, u: 4054, h: 4, l: 1 }))).toBe('Série 4 · Couloir 1')
    expect(itemLabel(scan({ e: 2, u: 2, h: 7, l: 2, barcodeRaw: 'BLANK-RPDJ-03' }))).toBe('Série 7 · Couloir 2 · vierge')
    expect(itemLabel(scan({ e: 5, h: 2, l: 2 }))).toBe('Vierge · E5-S2-C2')
    expect(itemLabel(scan({}))).toBe('Vierge · ?')
  })
})

describe('scanListKey', () => {
  it('changes when a status, a recognised time or an identity changes, not otherwise', () => {
    const a = scan({ e: 7, u: 4054, h: 1, l: 1 })
    const k = scanListKey([a])
    expect(scanListKey([{ ...a }])).toBe(k)
    expect(scanListKey([{ ...a, status: 'recognized' }])).not.toBe(k)
    expect(scanListKey([{ ...a, recognizedTime2: '0:42.38' }])).not.toBe(k)
    expect(scanListKey([{ ...a, swimEventId: 2 }])).not.toBe(k)
  })
})
