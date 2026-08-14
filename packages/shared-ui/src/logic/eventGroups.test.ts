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
import type { Session, CompetitionEvent, AgeGroup } from '../data/api'
import { buildEventGroups, findEventGroup, sameShape, findSiblingAgeGroup } from './eventGroups'

function ag(id: number, minAge: number, maxAge: number | null, gender = 'F'): AgeGroup {
  return {
    id, number: id, name: `${minAge}-${maxAge ?? '+'}`, minAge, maxAge, gender,
    numHeats: 1, ranking: '', countForMedalStats: true, usedForCombined: true,
    alwaysSwimPrelims: false, advanceByTime: true, laneOrderInFinals: '',
  }
}

function ev(id: number, phase: CompetitionEvent['phase'], opts: Partial<CompetitionEvent> = {}): CompetitionEvent {
  return {
    id, sessionId: 1, number: id, nameFr: `Event ${id}`, nameEn: `Event ${id}`,
    gender: 'ALL', distance: 50, phase, swimstyleId: 500, ageGroups: [],
    ...opts,
  }
}

describe('buildEventGroups', () => {
  it('groups a standalone Finale directe as its own singleton group', () => {
    const sessions: Session[] = [{ id: 1, number: 1, events: [ev(1, 'Finale directe')] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].events.map((e) => e.id)).toEqual([1])
    expect(groups[0].rootEvent.id).toBe(1)
  })

  it('groups a linked Eliminatoire+Finale pair into one group, prelim first', () => {
    const prelim = ev(1, 'Eliminatoire')
    const final = ev(2, 'Finale', { prevEventId: 1 })
    const sessions: Session[] = [{ id: 1, number: 1, events: [prelim, final] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].events.map((e) => e.id)).toEqual([1, 2])
    expect(groups[0].rootEvent.id).toBe(1)
  })

  it('does not double-count the final when iterating after its prelim', () => {
    const prelim = ev(1, 'Eliminatoire')
    const final = ev(2, 'Finale', { prevEventId: 1 })
    const other = ev(3, 'Finale directe', { swimstyleId: 501 })
    const sessions: Session[] = [{ id: 1, number: 1, events: [prelim, final, other] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(groups).toHaveLength(2)
  })

  it('skips admin (pause) events', () => {
    const pause = ev(9, 'Finale directe', { isAdmin: true })
    const real = ev(1, 'Finale directe')
    const sessions: Session[] = [{ id: 1, number: 1, events: [pause, real] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].rootEvent.id).toBe(1)
  })
})

describe('findEventGroup', () => {
  it('finds the group containing either half of a split pair', () => {
    const prelim = ev(1, 'Eliminatoire')
    const final = ev(2, 'Finale', { prevEventId: 1 })
    const sessions: Session[] = [{ id: 1, number: 1, events: [prelim, final] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(findEventGroup(groups, 1)).toBe(groups[0])
    expect(findEventGroup(groups, 2)).toBe(groups[0])
  })
})

describe('sameShape', () => {
  it('matches two singleton groups', () => {
    const sessions: Session[] = [{ id: 1, number: 1, events: [ev(1, 'Finale directe'), ev(2, 'Finale directe')] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(sameShape(groups[0], groups[1])).toBe(true)
  })

  it('rejects a singleton against a Prelim+Final pair', () => {
    const solo = ev(1, 'Finale directe')
    const prelim = ev(2, 'Eliminatoire')
    const final = ev(3, 'Finale', { prevEventId: 2 })
    const sessions: Session[] = [{ id: 1, number: 1, events: [solo, prelim, final] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    const soloGroup = findEventGroup(groups, 1)!
    const pairGroup = findEventGroup(groups, 2)!
    expect(sameShape(soloGroup, pairGroup)).toBe(false)
  })

  it('matches two Prelim+Final pairs', () => {
    const p1 = ev(1, 'Eliminatoire')
    const f1 = ev(2, 'Finale', { prevEventId: 1 })
    const p2 = ev(3, 'Eliminatoire')
    const f2 = ev(4, 'Finale', { prevEventId: 3 })
    const sessions: Session[] = [{ id: 1, number: 1, events: [p1, f1, p2, f2] } as unknown as Session]
    const groups = buildEventGroups(sessions)
    expect(sameShape(findEventGroup(groups, 1)!, findEventGroup(groups, 3)!)).toBe(true)
  })
})

describe('findSiblingAgeGroup', () => {
  it('matches by age range and gender, not id or name', () => {
    const target = ag(20, 15, 18, 'F')
    const event = ev(2, 'Finale', { ageGroups: [ag(99, 15, 18, 'F'), ag(98, 19, null, 'F')] })
    const sibling = findSiblingAgeGroup(event, target)
    expect(sibling?.id).toBe(99)
  })

  it('returns undefined when no matching bracket exists', () => {
    const target = ag(20, 15, 18, 'F')
    const event = ev(2, 'Finale', { ageGroups: [ag(98, 19, null, 'F')] })
    expect(findSiblingAgeGroup(event, target)).toBeUndefined()
  })
})
