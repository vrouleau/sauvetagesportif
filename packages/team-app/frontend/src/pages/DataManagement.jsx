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
  const [meets, setMeets] = useState([])
  const [mdbUploading, setMdbUploading] = useState(false)
  const [smbUploading, setSmbUploading] = useState(false)

  useEffect(() => { loadClubs(); loadStyles(); loadMeets() }, [])

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

  async function loadMeets() {
    try {
      const r = await api.get('/admin/historical-meets')
      setMeets(r.data)
    } catch { /* ignore if endpoint not available */ }
  }

  async function deleteMeet(id, name) {
    const label = lang === 'fr'
      ? `Supprimer "${name}" et toutes ses données ? Irréversible.`
      : `Delete "${name}" and all its data? This cannot be undone.`
    if (!confirm(label)) return
    try {
      await api.delete(`/admin/historical-meets/${id}`)
      setMsg(lang === 'fr' ? 'Compétition supprimée' : 'Meet deleted')
      loadMeets()
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  async function importMdb(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setMdbUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await api.post('/admin/import-mdb', form)
      const t = r.data.tables
      setMsg(lang === 'fr'
        ? `Importé: ${t.MEETS} compétitions, ${t.MEMBERS} athlètes, ${t.RESULTS} résultats`
        : `Imported: ${t.MEETS} meets, ${t.MEMBERS} members, ${t.RESULTS} results`)
      loadMeets()
    } catch (err) { setMsg(err.response?.data?.detail || err.message || 'Error') }
    finally { setMdbUploading(false); e.target.value = '' }
  }

  async function importSmb(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setSmbUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await api.post('/admin/import-meet-results', form)
      setMsg(lang === 'fr'
        ? `Importé: "${r.data.meet_name}" — ${r.data.members} athlètes, ${r.data.results} résultats`
        : `Imported: "${r.data.meet_name}" — ${r.data.members} members, ${r.data.results} results`)
      loadMeets()
    } catch (err) { setMsg(err.response?.data?.detail || err.message || 'Error') }
    finally { setSmbUploading(false); e.target.value = '' }
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
    try {
      const merges = pendingStyles.map(([f, to]) => ({ from_uid: Number(f), to_uid: Number(to) }))
      // Preview first
      const preview = await api.post('/data-management/merge-styles', { merges, preview: true })
      const changes = preview.data.changes || []
      if (!changes.length) {
        setMsg(lang === 'fr' ? 'Aucun changement à effectuer' : 'No changes to make')
        return
      }
      const lines = changes.map(c =>
        `• ${c.from_name} (${c.from_uid}) → ${c.to_name} (${c.to_uid}): ${c.results_affected} résultat(s), ${c.events_affected} épreuve(s)`
      ).join('\n')
      const label = lang === 'fr'
        ? `Fusionner ${changes.length} style(s) ?\n\n${lines}\n\nCette action est irréversible.`
        : `Merge ${changes.length} style(s)?\n\n${lines}\n\nThis cannot be undone.`
      if (!confirm(label)) return
      // Execute
      const r = await api.post('/data-management/merge-styles', { merges })
      setMsg(lang === 'fr' ? `${r.data.merged_count} ligne(s) fusionnée(s)` : `${r.data.merged_count} row(s) merged`)
      loadStyles()
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        <span className="text-xs font-semibold text-gray-700">{t.data_management}</span>
        <div className="flex-1" />
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
        {/* Historical Meets */}
        <div className="border border-gray-300 rounded bg-white">
          <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-gray-700">
                {lang === 'fr' ? 'Compétitions historiques' : 'Historical Meets'}
              </span>
            </div>
            <label className={`px-3 py-1 text-xs rounded cursor-pointer ${mdbUploading ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700'} text-white`}>
              {mdbUploading
                ? (lang === 'fr' ? 'Import…' : 'Importing…')
                : (lang === 'fr' ? 'Importer Team.mdb' : 'Import Team.mdb')}
              <input type="file" accept=".mdb" className="hidden" onChange={importMdb} disabled={mdbUploading} />
            </label>
            <label className={`px-3 py-1 text-xs rounded cursor-pointer ${smbUploading ? 'bg-gray-400' : 'bg-purple-600 hover:bg-purple-700'} text-white ml-2`}>
              {smbUploading
                ? (lang === 'fr' ? 'Import…' : 'Importing…')
                : (lang === 'fr' ? 'Importer résultats .smb' : 'Import results .smb')}
              <input type="file" accept=".smb" className="hidden" onChange={importSmb} disabled={smbUploading} />
            </label>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium">{lang === 'fr' ? 'Nom' : 'Name'}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-24">{lang === 'fr' ? 'Lieu' : 'Location'}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-24">{lang === 'fr' ? 'Date' : 'Date'}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-center font-medium w-8">R</th>
                  <th className="px-2 py-1 border-b border-gray-300 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {meets.map(m => (
                  <tr key={m.id} className="border-b border-gray-200 hover:bg-blue-50">
                    <td className="px-2 py-0.5">{m.name}</td>
                    <td className="px-2 py-0.5 text-gray-600">{m.place || '—'}</td>
                    <td className="px-2 py-0.5 text-gray-600 font-mono">
                      {m.mindate ? m.mindate.slice(0, 10) : '—'}
                    </td>
                    <td className="px-2 py-0.5 text-center">
                      {m.has_results && <span className="text-green-700 font-bold">R</span>}
                    </td>
                    <td className="px-2 py-0.5 text-right">
                      <button
                        onClick={() => deleteMeet(m.id, m.name)}
                        className="text-red-500 hover:text-red-700 text-xs"
                      >✕</button>
                    </td>
                  </tr>
                ))}
                {meets.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-3 text-center text-gray-400">
                    {lang === 'fr' ? 'Aucune compétition importée' : 'No meets imported'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
