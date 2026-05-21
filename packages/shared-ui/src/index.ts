// Data layer
export type { MeetAPI, Session, CompetitionEvent, AgeGroup, SwimStyle, Athlete, SessionUpdate } from './data/api'
export type { RegistrationAPI, Club, AthleteListItem, RegistrationData, RegistrationStyle, RegistrationCategory } from './data/api'

// Context
export { ApiProvider, useApi } from './context/ApiContext'
export { LangProvider, useLang } from './context/LangContext'
export { RegistrationApiProvider, useRegistrationApi } from './context/RegistrationApiContext'

// Pages
export { default as EventsPage } from './pages/EventsPage'
export { default as AthletesListPage } from './pages/AthletesListPage'
export { default as RegistrationPage } from './pages/RegistrationPage'
export { default as InscriptionPage } from './pages/InscriptionPage'

// Components
export { default as CascadeTree } from './components/CascadeTree'
export { default as AthleteDetailPanel } from './components/AthleteDetailPanel'
export { default as RegistrationPanel } from './components/RegistrationPanel'
export { default as AddAthleteDialog } from './components/AddAthleteDialog'

// Utilities
export { filterAthletes, computeVisibleExpansion } from './utils/filterAthletes'

// i18n
export { translations, type Lang, type T } from './i18n'
