import { createContext, useContext, type ReactNode } from 'react'
import type { MeetAPI } from '../data/api'

const ApiContext = createContext<MeetAPI | null>(null)

export function ApiProvider({ api, children }: { api: MeetAPI; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): MeetAPI {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useApi must be used within an ApiProvider')
  return api
}
