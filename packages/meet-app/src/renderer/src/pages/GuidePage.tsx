import { useState, useEffect } from 'react'
import { useLang } from '@shared/context/LangContext'

interface GuidePageProps {
  guideType: 'pool' | 'beach'
  onClose: () => void
}

export default function GuidePage({ guideType, onClose }: GuidePageProps) {
  const { lang } = useLang()
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const file = `meet-${guideType}_${lang}.md`
    fetch(`./docs/${file}`)
      .then(r => {
        if (!r.ok) throw new Error('Not found')
        return r.text()
      })
      .then(md => {
        setHtml(markdownToHtml(md))
        setLoading(false)
      })
      .catch(() => {
        setHtml(`<p class="text-red-500">${lang === 'fr' ? 'Impossible de charger le guide.' : 'Could not load guide.'}</p>`)
        setLoading(false)
      })
  }, [guideType, lang])

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center h-10 bg-gray-800 text-white px-4 shrink-0">
        <span className="font-semibold text-sm">
          {guideType === 'pool'
            ? (lang === 'fr' ? 'Guide — Compétition piscine' : 'Guide — Pool Competition')
            : (lang === 'fr' ? 'Guide — Compétition plage' : 'Guide — Beach Competition')
          }
        </span>
        <button
          onClick={onClose}
          className="ml-auto px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
        >
          {lang === 'fr' ? 'Fermer' : 'Close'}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="text-gray-500 italic">
            {lang === 'fr' ? 'Chargement…' : 'Loading…'}
          </div>
        ) : (
          <div
            className="max-w-4xl mx-auto prose prose-sm max-w-none
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
            "
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Minimal markdown-to-HTML converter (no external dependency).
 * Handles: headings, paragraphs, bold, italic, code, links, images,
 * unordered/ordered lists, blockquotes, tables, horizontal rules.
 */
function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList: 'ul' | 'ol' | null = null
  let inTable = false
  let inBlockquote = false

  function inline(text: string): string {
    return text
      // images
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
      // links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  }

  function closeList() {
    if (inList) { out.push(`</${inList}>`); inList = null }
  }
  function closeTable() {
    if (inTable) { out.push('</tbody></table>'); inTable = false }
  }
  function closeBlockquote() {
    if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList(); closeTable(); closeBlockquote()
      out.push('<hr />')
      continue
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      closeList(); closeTable(); closeBlockquote()
      const level = hMatch[1].length
      out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`)
      continue
    }

    // Table row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      closeList(); closeBlockquote()
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim())
      // Skip separator row
      if (cells.every(c => /^[-:]+$/.test(c))) continue
      if (!inTable) {
        inTable = true
        out.push('<table><thead><tr>')
        cells.forEach(c => out.push(`<th>${inline(c)}</th>`))
        out.push('</tr></thead><tbody>')
        // Skip the separator line that follows
        continue
      }
      out.push('<tr>')
      cells.forEach(c => out.push(`<td>${inline(c)}</td>`))
      out.push('</tr>')
      continue
    } else {
      closeTable()
    }

    // Blockquote
    if (line.trim().startsWith('> ')) {
      closeList(); closeTable()
      if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true }
      out.push(`<p>${inline(line.trim().slice(2))}</p>`)
      continue
    } else {
      closeBlockquote()
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      closeTable(); closeBlockquote()
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul' }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      closeTable(); closeBlockquote()
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol' }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`)
      continue
    }

    closeList()

    // Empty line
    if (line.trim() === '') continue

    // Paragraph
    out.push(`<p>${inline(line)}</p>`)
  }

  closeList(); closeTable(); closeBlockquote()
  return out.join('\n')
}
