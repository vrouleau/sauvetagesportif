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

import type { AthleteListItem } from '../data/api'

/**
 * Filters athletes across all clubs by a case-insensitive substring match
 * on their full name (first_name + ' ' + last_name).
 *
 * Returns the filtered map (only clubs with matching athletes) and a set of
 * club IDs that should be auto-expanded in the cascade tree.
 */
export function filterAthletes(
  athletesByClub: Map<number, AthleteListItem[]>,
  filterText: string
): { filtered: Map<number, AthleteListItem[]>; autoExpandClubs: Set<number> } {
  if (!filterText) {
    return { filtered: athletesByClub, autoExpandClubs: new Set() }
  }

  const needle = filterText.toLowerCase()
  const filtered = new Map<number, AthleteListItem[]>()
  const autoExpandClubs = new Set<number>()

  for (const [clubId, athletes] of athletesByClub) {
    const matching = athletes.filter(
      (a) => `${a.first_name} ${a.last_name}`.toLowerCase().includes(needle)
    )
    if (matching.length > 0) {
      filtered.set(clubId, matching)
      autoExpandClubs.add(clubId)
    }
  }

  return { filtered, autoExpandClubs }
}

/**
 * Determines which clubs should be visually expanded in the cascade tree.
 *
 * When a filter is active, auto-expanded clubs (those with matching athletes)
 * override the manual expansion state. When no filter is active, the manual
 * expansion state is used.
 */
export function computeVisibleExpansion(
  expandedClubs: Set<number>,
  autoExpandClubs: Set<number>,
  filterText: string
): Set<number> {
  if (filterText) {
    return autoExpandClubs
  }
  return expandedClubs
}