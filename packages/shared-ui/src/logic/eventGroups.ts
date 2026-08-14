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

import type { Session, CompetitionEvent, AgeGroup } from '../data/api'

/**
 * A "Finale directe" is a single event. A Prelim/Final split is two distinct
 * `swimevent` rows (linked via prevEventId) that together represent one
 * competition slot for a swim style — an age group living in one is really
 * "in" both, via its own separate agegroup row on each side (createAgeGroup
 * copies the prelim's brackets onto the final when the split happens). This
 * groups events into those slots so a move can act on the whole slot instead
 * of a single event.
 */
export interface EventGroup {
  /** Eliminatoire+Finale (in that order) for a split event, or a single event otherwise. */
  events: CompetitionEvent[]
  /** The event used to represent this group in a target-picker (Eliminatoire, or the only event). */
  rootEvent: CompetitionEvent
  sessionNumber: number
}

export function buildEventGroups(sessions: Session[]): EventGroup[] {
  const allEvents = sessions.flatMap((s) => s.events.map((event) => ({ event, sessionNumber: s.number })))
  const byId = new Map(allEvents.map(({ event }) => [event.id, event]))
  const seen = new Set<number>()
  const groups: EventGroup[] = []

  for (const { event, sessionNumber } of allEvents) {
    if (event.isAdmin || seen.has(event.id)) continue

    let events: CompetitionEvent[]
    if (event.phase === 'Eliminatoire') {
      const final = allEvents.find(({ event: e }) => e.prevEventId === event.id)?.event
      events = final ? [event, final] : [event]
    } else if (event.phase === 'Finale' && event.prevEventId != null) {
      const prelim = byId.get(event.prevEventId)
      events = prelim ? [prelim, event] : [event]
    } else {
      events = [event]
    }

    events.forEach((e) => seen.add(e.id))
    const rootEvent = events.find((e) => e.phase !== 'Finale') ?? events[0]
    groups.push({ events, rootEvent, sessionNumber })
  }

  return groups
}

export function findEventGroup(groups: EventGroup[], eventId: number): EventGroup | undefined {
  return groups.find((g) => g.events.some((e) => e.id === eventId))
}

/** Two groups are the same "shape" when they have the same set of phases — a plain Finale directe only matches another plain Finale directe, a Prelim+Final pair only matches another Prelim+Final pair. */
export function sameShape(a: EventGroup, b: EventGroup): boolean {
  if (a.events.length !== b.events.length) return false
  return a.events.every((e) => b.events.some((be) => be.phase === e.phase))
}

/** Finds the age group in `event` that represents the same age bracket as `group` (matched by age range + gender, not id — prelim and final each own a separate agegroup row for the same bracket). */
export function findSiblingAgeGroup(event: CompetitionEvent, group: AgeGroup): AgeGroup | undefined {
  return event.ageGroups.find((g) => g.minAge === group.minAge && g.maxAge === group.maxAge && g.gender === group.gender)
}
