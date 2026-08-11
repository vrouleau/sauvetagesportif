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

import api from './api'

/**
 * Shared meet-selection helper — used by both Login.jsx (first login) and
 * main.jsx's meet-switcher dropdown (later switches), so both go through
 * the same localStorage write path. Role is per-(club, meet), so switching
 * meets always re-derives 'role' from that meet's entry in 'meets'.
 */
export function selectMeet(meetId) {
  const meets = JSON.parse(localStorage.getItem('meets') || '[]')
  const meet = meets.find(m => String(m.meet_id) === String(meetId))
  localStorage.setItem('meet_id', String(meetId))
  localStorage.setItem('role', meet ? meet.role : '')
  return meet
}

/**
 * Re-fetch meets[] without a fresh login — needed after the admin
 * dashboard creates a meet, since the session's meets[] was only ever
 * populated at login time. Keeps the currently selected meet_id if it's
 * still in the refreshed list, else falls back to the first meet.
 * Dispatches 'auth-changed' so main.jsx's AppInner can update its auth
 * state (same pattern as the existing 'meet-changed' event).
 */
export async function refreshAuth() {
  const pin = localStorage.getItem('pin')
  if (!pin) return null
  const r = await api.post('/auth', { pin })
  localStorage.setItem('meets', JSON.stringify(r.data.meets || []))
  const meets = r.data.meets || []
  const currentId = localStorage.getItem('meet_id')
  const stillValid = meets.some(m => String(m.meet_id) === String(currentId))
  const meetId = stillValid ? currentId : (meets[0]?.meet_id ?? '')
  selectMeet(meetId)
  window.dispatchEvent(new Event('auth-changed'))
  return { ...r.data, meet_id: meetId }
}
