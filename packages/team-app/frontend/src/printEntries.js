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

import { headers } from './api'

// Opens the printable entries report (GET /api/print/entries) in a new tab.
// The endpoint needs the PIN header, so fetch it here and write the HTML into
// a tab opened synchronously (keeps popup blockers happy). The page has its
// own Print button — no automatic print dialog. The backend scopes it to the
// caller: every club for admin/organizer, only their own club for a coach.
// `section`: 'all' | 'individual' | 'relays'. Throws on failure.
export async function openPrintEntries(lang, section = 'all') {
  const w = window.open('', '_blank')
  try {
    const res = await fetch(`/api/print/entries?lang=${lang}&section=${section}`, { headers: headers() })
    if (!res.ok) throw new Error(`${res.status}`)
    const html = await res.text()
    if (!w) throw new Error(lang === 'fr' ? 'Fenêtre bloquée par le navigateur' : 'Popup blocked by the browser')
    w.document.open(); w.document.write(html); w.document.close()
    w.focus()
  } catch (e) {
    if (w) w.close()
    throw e
  }
}
