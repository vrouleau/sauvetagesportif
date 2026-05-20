import { createContext, useContext, type ReactNode } from 'react'
import type { RegistrationAPI } from '../data/api'

const RegistrationApiContext = createContext<RegistrationAPI | null>(null)

export function RegistrationApiProvider({ api, children }: { api: RegistrationAPI; children: ReactNode }) {
  return <RegistrationApiContext.Provider value={api}>{children}</RegistrationApiContext.Provider>
}

export function useRegistrationApi(): RegistrationAPI {
  const api = useContext(RegistrationApiContext)
  if (!api) throw new Error('useRegistrationApi must be used within a RegistrationApiProvider')
  return api
}
