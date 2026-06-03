import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import IndividualEntryPage from '@shared/pages/IndividualEntryPage'
import { registrationApiElectron } from '../registrationApiElectron'

/**
 * Wrapper that provides the shared IndividualEntryPage
 * within the meet-app's tab-based navigation.
 * Supplies the Electron-based RegistrationAPI and admin role.
 */
export default function IndividualEntryPageWrapper({
  refreshKey = 0,
  onImportLxf,
  onExportLxf,
}: {
  refreshKey?: number
  onImportLxf?: () => void
  onExportLxf?: () => void
}) {
  return (
    <RegistrationApiProvider api={registrationApiElectron}>
      <IndividualEntryPage
        key={refreshKey}
        role="admin"
        refreshKey={refreshKey}
        onImportLxf={onImportLxf}
        onExportLxf={onExportLxf}
      />
    </RegistrationApiProvider>
  )
}
