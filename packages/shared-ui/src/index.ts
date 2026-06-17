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

// Data layer
export type { MeetAPI, Session, CompetitionEvent, AgeGroup, SwimStyle, Athlete, SessionUpdate } from './data/api'
export type { RegistrationAPI, Club, AthleteListItem, RegistrationData, RegistrationStyle, RegistrationCategory, RelayTeamMember, RelayTeam, RelayEventGroup, RelayAgeCategory, RelayPageData, EligibleAthlete } from './data/api'

// Context
export { ApiProvider, useApi } from './context/ApiContext'
export { LangProvider, useLang } from './context/LangContext'
export { RegistrationApiProvider, useRegistrationApi } from './context/RegistrationApiContext'

// Pages
export { default as EventsPage } from './pages/EventsPage'
export { default as AthletesListPage } from './pages/AthletesListPage'
export { default as RegistrationPage } from './pages/RegistrationPage'
export { default as InscriptionPage } from './pages/InscriptionPage'
export { default as IndividualEntryPage } from './pages/IndividualEntryPage'
export { default as RelayEntryPage } from './pages/RelayEntryPage'

// Components
export { default as CascadeTree } from './components/CascadeTree'
export { default as AthleteDetailPanel } from './components/AthleteDetailPanel'
export { default as RegistrationPanel } from './components/RegistrationPanel'
export { default as AddAthleteDialog } from './components/AddAthleteDialog'

// Utilities
export { filterAthletes, computeVisibleExpansion } from './utils/filterAthletes'

// i18n
export { translations, type Lang, type T } from './i18n'