import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import InscriptionPage from '@shared/pages/InscriptionPage'
import { registrationApiElectron } from '../registrationApiElectron'

/**
 * Wrapper that provides the shared InscriptionPage (cascade tree layout)
 * within the meet-app's tab-based navigation.
 * Supplies the Electron-based RegistrationAPI and admin role.
 */
export default function InscriptionPageWrapper({ refreshKey = 0, onImportLenex }: { refreshKey?: number, onImportLenex?: () => void }) {
  return (
    <RegistrationApiProvider api={registrationApiElectron}>
      <InscriptionPage
        key={refreshKey}
        role="admin"
        refreshKey={refreshKey}
        onImportLenex={onImportLenex}
      />
    </RegistrationApiProvider>
  )
}
