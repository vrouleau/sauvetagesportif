import { createContext, useContext, useState } from 'react'
import { translations, type Lang, type T } from './i18n'

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

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>('fr')
  return (
    <LangContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() {
  return useContext(LangContext)
}
