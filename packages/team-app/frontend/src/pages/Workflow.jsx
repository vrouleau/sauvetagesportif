import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLang } from '../i18n'

const DOCS = [
  { id: 'team-admin', label_fr: 'Administrateur', label_en: 'Administrator' },
  { id: 'team-organizer', label_fr: 'Organisateur', label_en: 'Organizer' },
  { id: 'team-coach', label_fr: 'Responsable d\'équipe', label_en: 'Coach' },
]

export default function Workflow() {
  const { lang } = useLang()
  const [content, setContent] = useState('')
  const [activeDoc, setActiveDoc] = useState('team-admin')

  useEffect(() => {
    fetch(`/docs/${activeDoc}_${lang}.md`)
      .then(r => {
        if (!r.ok) throw new Error('Not found')
        return r.text()
      })
      .then(setContent)
      .catch(() => setContent(lang === 'fr' ? 'Impossible de charger le guide.' : 'Could not load guide.'))
  }, [lang, activeDoc])

  // Handle internal doc links (e.g., "team-organizer" or "team-coach")
  function handleLinkClick(e) {
    const href = e.target?.closest('a')?.getAttribute('href')
    if (href && DOCS.some(d => d.id === href)) {
      e.preventDefault()
      setActiveDoc(href)
      window.scrollTo(0, 0)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      {/* Doc navigation tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {DOCS.map(doc => (
          <button
            key={doc.id}
            onClick={() => setActiveDoc(doc.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
              activeDoc === doc.id
                ? 'bg-white border border-b-white border-gray-200 -mb-px text-blue-700'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            {lang === 'fr' ? doc.label_fr : doc.label_en}
          </button>
        ))}
      </div>

      {/* Markdown content */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div onClick={handleLinkClick} className="prose prose-sm max-w-none
        [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-6
        [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6
        [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4
        [&_p]:mb-3 [&_p]:leading-relaxed
        [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3
        [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3
        [&_li]:mb-1
        [&_blockquote]:border-l-4 [&_blockquote]:border-blue-300 [&_blockquote]:pl-4 [&_blockquote]:text-gray-600 [&_blockquote]:my-3
        [&_hr]:border-gray-200 [&_hr]:my-6
        [&_table]:w-full [&_table]:border-collapse [&_table]:mb-4 [&_table]:text-sm
        [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-100 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left
        [&_td]:border [&_td]:border-gray-300 [&_td]:px-3 [&_td]:py-2
        [&_img]:rounded [&_img]:shadow [&_img]:max-w-full [&_img]:my-4
        [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono
        [&_strong]:font-semibold
        [&_a]:text-blue-600 [&_a]:underline [&_a]:cursor-pointer
      ">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  )
}
