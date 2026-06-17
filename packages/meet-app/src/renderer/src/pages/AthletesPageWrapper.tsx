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

import { useState } from 'react'
import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import AthletesListPage from '@shared/pages/AthletesListPage'
import RegistrationPage from '@shared/pages/RegistrationPage'
import { registrationApiElectron } from '../registrationApiElectron'

/**
 * Wrapper that provides the shared AthletesListPage + RegistrationPage
 * within the meet-app's tab-based navigation (no router).
 */
export default function AthletesPageWrapper({ refreshKey = 0 }: { refreshKey?: number }) {
  const [selectedAthleteId, setSelectedAthleteId] = useState<number | null>(null)

  return (
    <RegistrationApiProvider api={registrationApiElectron}>
      {selectedAthleteId === null ? (
        <AthletesListPage
          key={refreshKey}
          role="admin"
          onNavigateToRegistration={(id) => setSelectedAthleteId(id)}
        />
      ) : (
        <RegistrationPage
          key={selectedAthleteId}
          athleteId={selectedAthleteId}
          onNavigateBack={() => setSelectedAthleteId(null)}
        />
      )}
    </RegistrationApiProvider>
  )
}