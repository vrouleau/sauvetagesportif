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
