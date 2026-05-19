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
