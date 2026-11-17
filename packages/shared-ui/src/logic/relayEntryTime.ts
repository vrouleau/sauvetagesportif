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


// Suggested entry time for a pool relay team.
//
// Every member of a past relay team is credited with that team's total time, so
// each member has a "relay best time" per style/course (computed server-side,
// team-app). A new team's suggested entry time is the average of the best times
// of the members who have one; members without one are ignored. Centiseconds
// are the finest unit an entry time carries, so the average is rounded to 10 ms.

import type { RelayTeamMember } from '../data/api'

export function suggestRelayEntryTime(members: RelayTeamMember[]): number | null {
  const times = members
    .filter(m => m.athleteId != null)
    .map(m => m.relayBestTimeMs)
    .filter((t): t is number => t != null && t > 0)
  if (times.length === 0) return null
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  return Math.round(avg / 10) * 10
}

/**
 * New entry time to save after a team's members changed, or `undefined` to leave
 * it alone. The suggestion follows the members only while the coach hasn't typed
 * a time: the stored time is empty, or still equals the suggestion for the
 * previous composition. A typed value never matches, so it is kept.
 */
export function entryTimeAfterMemberChange(
  previousMembers: RelayTeamMember[],
  previousEntryTimeMs: number | null | undefined,
  newMembers: RelayTeamMember[],
): number | null | undefined {
  const current = previousEntryTimeMs || null
  if (current != null && current !== suggestRelayEntryTime(previousMembers)) return undefined
  const next = suggestRelayEntryTime(newMembers)
  return next === current ? undefined : next
}
