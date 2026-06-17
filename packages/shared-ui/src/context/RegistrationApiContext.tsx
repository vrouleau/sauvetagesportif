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