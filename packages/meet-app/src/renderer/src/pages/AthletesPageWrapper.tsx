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
