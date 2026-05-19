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
