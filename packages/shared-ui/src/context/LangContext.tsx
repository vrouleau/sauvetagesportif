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

import { createContext, useContext, useState, useEffect } from 'react'
import { translations, type Lang, type T } from '../i18n'

interface LangContextType {
  lang: Lang
  setLang: (l: Lang) => void
  t: T
}

const LangContext = createContext<LangContextType>({
  lang: 'fr',
  setLang: () => {},
  t: translations.fr,
})

export function LangProvider({ children, initialLang }: { children: React.ReactNode; initialLang?: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang ?? 'fr')

  useEffect(() => {
    if (initialLang && initialLang !== lang) setLang(initialLang)
  }, [initialLang])

  return (
    <LangContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() {
  return useContext(LangContext)
}