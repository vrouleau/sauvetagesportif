import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import api from '../api'

export default function DataManagement() {
  const { t, lang } = useLang()
  const [clubs, setClubs] = useState([])
  const [styles, setStyles] = useState([])
  const [clubMap, setClubMap] = useState({})
  const [styleMap, setStyleMap] = useState({})
  const [msg, setMsg] = useState('')

  useEffect(() => { loadClubs(); loadStyles() }, [])

  async function loadClubs() {
    const r = await api.get('/clubs')
    setClubs(r.data)
    setClubMap(Object.fromEntries(r.data.map(c => [c.id, c.id])))
  }

  async function loadStyles() {
    const r = await api.get('/data-management/styles')
    setStyles(r.data)
    setStyleMap(Object.fromEntries(r.data.map(s => [s.uid, s.uid])))
  }

  const pendingClubs = Object.entries(clubMap).filter(([f, t]) => Number(f) !== Number(t))
  const pendingStyles = Object.entries(styleMap).filter(([f, t]) => Number(f) !== Number(t))

  async function resolveClubs() {
    if (!pendingClubs.length) return
    const label = lang === 'fr'
      ? `Fusionner ${pendingClubs.length} club(s) ? Cette action est irréversible.`
      : `Merge ${pendingClubs.length} club(s)? This cannot be undone.`
    if (!confirm(label)) return
    try {
      const merges = pendingClubs.map(([f, to]) => ({ from_id: Number(f), to_id: Number(to) }))
      const r = await api.post('/data-management/merge-clubs', { merges })
      setMsg(lang === 'fr' ? `${r.data.merged} club(s) fusionné(s)` : `${r.data.merged} club(s) merged`)
      loadClubs()
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  async function resolveStyles() {
    if (!pendingStyles.length) return
    const label = lang === 'fr'
      ? `Fusionner ${pendingStyles.length} style(s) ? Cette action est irréversible.`
      : `Merge ${pendingStyles.length} style(s)? This cannot be undone.`
    if (!confirm(label)) return
    try {
      const merges = pendingStyles.map(([f, to]) => ({ from_uid: Number(f), to_uid: Number(to) }))
      const r = await api.post('/data-management/merge-styles', { merges })
      setMsg(lang === 'fr' ? `${r.data.merged_rows} ligne(s) fusionnée(s)` : `${r.data.merged_rows} row(s) merged`)
      loadStyles()
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  function exportEntries() {
    fetch('/api/export/entries', { headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' } })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob() })
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = 'entries.lxf'; a.click()
        URL.revokeObjectURL(url)
      })
      .catch(e => setMsg(e.message || 'Error'))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        <span className="text-xs font-semibold text-gray-700">{t.data_management}</span>
        <div className="flex-1" />
        <button onClick={exportEntries} className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">
          {t.download_entries_lxf}
        </button>
        {msg && <span className="text-xs text-green-700">{msg}</span>}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Club merging */}
        <div className="border border-gray-300 rounded bg-white">
          <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-700">{t.merge_clubs}</span>
              <p className="text-xs text-gray-500">{t.merge_clubs_desc}</p>
            </div>
            <button onClick={resolveClubs} disabled={!pendingClubs.length}
              className="px-3 py-1 bg-orange-600 text-white text-xs rounded hover:bg-orange-700 disabled:opacity-50">
              {t.resolve}{pendingClubs.length > 0 ? ` (${pendingClubs.length})` : ''}
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-1/2">{t.from_col}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-1/2">{t.to_col}</th>
                </tr>
              </thead>
              <tbody>
                {clubs.map(c => {
                  const toId = clubMap[c.id] ?? c.id
                  const changed = Number(toId) !== c.id
                  return (
                    <tr key={c.id} className={`border-b border-gray-200 ${changed ? 'bg-yellow-50' : 'hover:bg-blue-50'}`}>
                      <td className="px-2 py-0.5">{c.name}</td>
                      <td className="px-2 py-0.5">
                        <select className="border border-gray-300 rounded px-1 py-0.5 w-full text-xs"
                          value={toId}
                          onChange={e => setClubMap(prev => ({ ...prev, [c.id]: Number(e.target.value) }))}>
                          {clubs.map(target => (
                            <option key={target.id} value={target.id}>{target.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
                {clubs.length === 0 && (
                  <tr><td colSpan={2} className="px-2 py-3 text-center text-gray-400">
                    {lang === 'fr' ? 'Aucun club' : 'No clubs'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Style merging */}
        <div className="border border-gray-300 rounded bg-white">
          <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-700">{t.merge_styles}</span>
              <p className="text-xs text-gray-500">{t.merge_styles_desc}</p>
            </div>
            <button onClick={resolveStyles} disabled={!pendingStyles.length}
              className="px-3 py-1 bg-orange-600 text-white text-xs rounded hover:bg-orange-700 disabled:opacity-50">
              {t.resolve}{pendingStyles.length > 0 ? ` (${pendingStyles.length})` : ''}
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-1/2">{t.from_col}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-1/2">{t.to_col}</th>
                </tr>
              </thead>
              <tbody>
                {styles.map(s => {
                  const toUid = styleMap[s.uid] ?? s.uid
                  const changed = Number(toUid) !== s.uid
                  return (
                    <tr key={s.uid} className={`border-b border-gray-200 ${changed ? 'bg-yellow-50' : 'hover:bg-blue-50'}`}>
                      <td className="px-2 py-0.5 font-mono">ID{s.uid}{s.name ? ` — ${s.name}` : ''}</td>
                      <td className="px-2 py-0.5">
                        <select className="border border-gray-300 rounded px-1 py-0.5 w-full text-xs font-mono"
                          value={toUid}
                          onChange={e => setStyleMap(prev => ({ ...prev, [s.uid]: Number(e.target.value) }))}>
                          {styles.map(target => (
                            <option key={target.uid} value={target.uid}>
                              ID{target.uid}{target.name ? ` — ${target.name}` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
                {styles.length === 0 && (
                  <tr><td colSpan={2} className="px-2 py-3 text-center text-gray-400">
                    {lang === 'fr' ? 'Aucun style' : 'No styles'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Export */}
        <div className="border border-gray-300 rounded bg-white">
          <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300">
            <span className="text-xs font-semibold text-gray-700">{t.export_entries}</span>
            <p className="text-xs text-gray-500">{t.export_entries_desc}</p>
          </div>
          <div className="px-3 py-2">
            <button onClick={exportEntries} className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">
              {t.download_entries_lxf}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
