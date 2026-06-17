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

/**
 * EventsPage — thin wrapper that provides the Electron IPC adapter
 * to the shared EventsPage component from @shared.
 */
import { ApiProvider } from '@shared/context/ApiContext'
import SharedEventsPage from '@shared/pages/EventsPage'
import { meetApiElectron } from '../meetApiElectron'

export default function EventsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  return (
    <ApiProvider api={meetApiElectron}>
      <SharedEventsPage refreshKey={refreshKey} />
    </ApiProvider>
  )
}