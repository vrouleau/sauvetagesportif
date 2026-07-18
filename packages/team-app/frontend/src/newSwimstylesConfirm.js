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

// Shared handling for the "new_swimstyles" 409 response — every LXF upload
// endpoint (meet structure, entries, historical, results) can return this
// when the file references swimstyle ids not yet in the local catalog.

/** Returns the {code, message, styles} payload if `err` (thrown by api.js)
 *  is a new_swimstyles 409, otherwise null. */
export function newSwimstylesDetail(err) {
  const d = err?.detail
  return (d && typeof d === 'object' && d.code === 'new_swimstyles') ? d : null
}

/** Shows a confirm() dialog listing the new style ids; returns true if the
 *  user wants to proceed anyway. */
export function confirmNewSwimstyles(detail, lang) {
  const lines = detail.styles
    .map(s => `  • ${s.id} — ${s.name}${s.distance ? ` (${s.distance}m)` : ''}`)
    .join('\n')
  const msg = lang === 'fr'
    ? `${detail.message}\n\n${lines}\n\nVoulez-vous quand même importer ?`
    : `${detail.message}\n\n${lines}\n\nDo you want to import anyway?`
  return confirm(msg)
}
