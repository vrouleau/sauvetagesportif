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

import { Component, type ReactNode } from 'react'
import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import RelayEntryPage from '@shared/pages/RelayEntryPage'
import { registrationApiElectron } from '../registrationApiElectron'

class RelayErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-red-600 text-xs">
          <p className="font-bold mb-2">Relay page error:</p>
          <pre className="whitespace-pre-wrap">{this.state.error.message}</pre>
          <pre className="whitespace-pre-wrap text-gray-500 mt-2">{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Wrapper that provides the shared RelayEntryPage
 * within the meet-app's tab-based navigation.
 * Supplies the Electron-based RegistrationAPI and admin role.
 */
export default function RelayEntryPageWrapper({ refreshKey = 0 }: { refreshKey?: number }) {
  return (
    <RelayErrorBoundary>
      <RegistrationApiProvider api={registrationApiElectron}>
        <RelayEntryPage
          key={refreshKey}
          role="admin"
          refreshKey={refreshKey}
        />
      </RegistrationApiProvider>
    </RelayErrorBoundary>
  )
}