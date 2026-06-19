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

import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import api from '../api'
import { BUILD_TIMESTAMP } from '../buildInfo'

export default function Admin() {
  const [status, setStatus] = useState(null)
  const [clubs, setClubs] = useState([])
  const [selectedClubId, setSelectedClubId] = useState('')
  const [organizer, setOrganizer] = useState(null)
  const [newClubName, setNewClubName] = useState('')
  const [newClubCode, setNewClubCode] = useState('')
  const [newClubEmail, setNewClubEmail] = useState('')
  const [msg, setMsg] = useState('')
  const [geminiFreeKey, setGeminiFreeKey] = useState('')
  const [geminiPaidKey, setGeminiPaidKey] = useState('')
  const [geminiHasFree, setGeminiHasFree] = useState(false)
  const [geminiHasPaid, setGeminiHasPaid] = useState(false)
  const { t, lang } = useLang()

  useEffect(() => { loadStatus(); loadClubs(); loadOrganizer(); loadGeminiKeys() }, [])

  async function loadStatus() { const r = await api.get('/status'); setStatus(r.data) }
  async function loadClubs() { const r = await api.get('/clubs'); setClubs(r.data) }
  async function loadOrganizer() { const r = await api.get('/admin/organizer'); setOrganizer(r.data) }
  async function loadGeminiKeys() {
    try {
      const r = await api.get('/admin/gemini-keys')
      setGeminiFreeKey(r.data.freeKey || '')
      setGeminiPaidKey(r.data.paidKey || '')
      setGeminiHasFree(r.data.hasFreeKey)
      setGeminiHasPaid(r.data.hasPaidKey)
    } catch { /* not admin or endpoint not available */ }
  }

  async function uploadEntries(e) {
    const file = e.target.files[0]
    if (!file) return
    const fdPreview = new FormData()
    fdPreview.append('file', file)
    let preview
    try {
      const r = await api.post('/upload/preview', fdPreview)
      preview = r.data
    } catch (err) {
      setMsg('Cannot read file: ' + (err.detail || err.message))
      e.target.value = ''
      return
    }
    const prompt = t.confirm_upload_lenex
      .replace('%clubs_total%', preview.clubs_in_file)
      .replace('%athletes_total%', preview.athletes_in_file)
      .replace('%clubs%', preview.clubs_new)
      .replace('%athletes%', preview.athletes_new)
    if (!confirm(prompt)) { e.target.value = ''; return }
    const fd = new FormData()
    fd.append('file', file)
    setMsg('Uploading entries...')
    const r = await api.post('/upload/entries', fd)
    const d = r.data
    setMsg(`Done: ${d.clubs_added} clubs, ${d.athletes_added} athletes, ${d.athletes_created || 0} new from results, ${d.times_updated} best times`)
    e.target.value = ''
    loadStatus(); loadClubs()
  }

  async function addClub() {
    if (!newClubName.trim() || !newClubCode.trim()) return
    try {
      await api.post('/clubs', { name: newClubName.trim(), code: newClubCode.trim() || undefined, email: newClubEmail.trim() || undefined })
      setNewClubName(''); setNewClubCode(''); setNewClubEmail('')
      loadClubs(); loadStatus()
      setMsg(lang === 'fr' ? 'Club ajouté' : 'Club added')
    } catch (e) { setMsg(e.detail || e.message || 'Error') }
  }

  async function deleteClub(club) {
    const message = club.athlete_count > 0
      ? t.confirm_delete_club_with_athletes.replace('%name%', club.name).replace('%n%', club.athlete_count)
      : t.confirm_delete_club.replace('%name%', club.name)
    if (!confirm(message)) return
    try {
      await api.delete(`/clubs/${club.id}`)
      loadClubs(); loadStatus()
      setMsg(`${club.name} ${lang === 'fr' ? 'supprimé' : 'deleted'}`)
    } catch (e) { setMsg(e.detail || e.message || 'Error') }
  }

  async function updateEmail(club, email) {
    await api.put(`/clubs/${club.id}`, { email })
    loadClubs()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0 flex-wrap">
        {status && (
          <span className="text-xs text-gray-600">
            {status.clubs} clubs · {status.athletes} athletes · {status.events} events · {status.registrations} reg. · {status.best_times} BT
          </span>
        )}
        <div className="flex-1" />
        {organizer?.club_name && (
          <span className="text-xs text-purple-700">
            {t.currently_organized_by} <strong>{organizer.club_name}</strong>
          </span>
        )}
        {msg && <span className="text-xs text-green-700">{msg}</span>}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Upload Lenex */}
        <Section title={t.upload_lxf} desc={t.upload_lxf_desc}>
          <input type="file" accept=".lxf" onChange={uploadEntries}
            className="file:border file:border-gray-300 file:rounded file:px-2 file:py-0.5 file:text-xs file:bg-white file:cursor-pointer text-xs" />
        </Section>

        {/* Upload SMB */}
        <Section title={t.upload_smb} desc={t.upload_smb_desc}>
          <input type="file" accept=".smb" onChange={async (e) => {
            const file = e.target.files[0]
            if (!file) return
            if (!confirm(t.confirm_upload_smb)) { e.target.value = ''; return }
            const fd = new FormData()
            fd.append('file', file)
            setMsg(lang === 'fr' ? 'Importation du .smb…' : 'Importing .smb...')
            try {
              const r = await api.post('/upload/meet-smb', fd)
              const d = r.data
              setMsg(`Done: ${d.events_loaded} events, ${d.styles_loaded} styles, ${d.agegroups_loaded} age groups`)
              loadStatus()
              window.dispatchEvent(new Event('meet-changed'))
            } catch (err) {
              setMsg(err.response?.data?.detail || err.message || 'Error')
            }
            e.target.value = ''
          }}
            className="file:border file:border-gray-300 file:rounded file:px-2 file:py-0.5 file:text-xs file:bg-white file:cursor-pointer text-xs" />
        </Section>

        {/* Download Meet (.smb) */}
        <Section title={t.export_meet_smb} desc={t.export_meet_smb_desc}>
          <button onClick={async () => {
            setMsg(lang === 'fr' ? 'Génération…' : 'Generating...')
            try {
              const res = await fetch('/api/export/meet-smb', {
                headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' }
              })
              if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: res.statusText }))
                setMsg(err.detail || 'Error')
                return
              }
              const blob = await res.blob()
              // Extract filename from Content-Disposition header
              const cd = res.headers.get('Content-Disposition') || ''
              const fnMatch = cd.match(/filename=([^;]+)/)
              const filename = fnMatch ? fnMatch[1].trim() : 'meet.smb'
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = filename; a.click()
              URL.revokeObjectURL(url)
              setMsg(lang === 'fr' ? '✓ Téléchargé' : '✓ Downloaded')
            } catch (err) { setMsg(err.message || 'Error') }
          }} className="px-3 py-1 bg-teal-600 text-white text-xs rounded hover:bg-teal-700">
            {t.export_meet_smb}
          </button>
        </Section>

        {/* Change Admin PIN */}
        <Section title={t.change_admin_pin}>
          <form onSubmit={async e => {
            e.preventDefault()
            const newPin = e.target.pin.value
            if (newPin.length < 4) { setMsg('PIN must be at least 4 characters'); return }
            await api.post('/admin/change-pin', { pin: newPin })
            localStorage.setItem('pin', newPin)
            setMsg('Admin PIN changed.')
            e.target.reset()
          }} className="flex gap-2 items-center">
            <input name="pin" type="text" placeholder="New PIN"
              className="border border-gray-300 px-2 py-0.5 rounded text-xs w-28" required />
            <button type="submit" className="px-3 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-800">Change</button>
          </form>
        </Section>

        {/* Gemini API Keys */}
        <Section title="Clés API Gemini (OCR)" desc="Clés pour la reconnaissance automatique des temps manuscrits. Obtenir sur aistudio.google.com/apikey">
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-600 block mb-0.5">Clé gratuite (free tier)</label>
              <div className="flex gap-2 items-center">
                <input type="text" placeholder="AIza..."
                  value={geminiFreeKey}
                  onChange={e => setGeminiFreeKey(e.target.value)}
                  onFocus={() => { if (geminiFreeKey.startsWith('***')) setGeminiFreeKey('') }}
                  className="border border-gray-300 px-2 py-0.5 rounded text-xs font-mono flex-1" />
                {geminiHasFree && <span className="text-green-600 text-xs">✓</span>}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-600 block mb-0.5">Clé payante (paid tier) — optionnelle</label>
              <div className="flex gap-2 items-center">
                <input type="text" placeholder="AIza..."
                  value={geminiPaidKey}
                  onChange={e => setGeminiPaidKey(e.target.value)}
                  onFocus={() => { if (geminiPaidKey.startsWith('***')) setGeminiPaidKey('') }}
                  className="border border-gray-300 px-2 py-0.5 rounded text-xs font-mono flex-1" />
                {geminiHasPaid && <span className="text-green-600 text-xs">✓</span>}
              </div>
            </div>
            <button onClick={async () => {
              const payload = {}
              if (!geminiFreeKey.startsWith('***')) payload.freeKey = geminiFreeKey
              if (!geminiPaidKey.startsWith('***')) payload.paidKey = geminiPaidKey
              await api.post('/admin/gemini-keys', payload)
              setMsg('Clés Gemini sauvegardées')
              loadGeminiKeys()
            }} className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">
              Sauvegarder les clés
            </button>
          </div>
        </Section>

        {/* Regenerate PINs */}
        <Section title={t.regen_pins} desc={t.regen_pins_desc}>
          <button onClick={async () => {
            if (!confirm('Regenerate ALL club PINs?')) return
            const r = await api.post('/clubs/regenerate-pins', {})
            setMsg(`Regenerated PINs for ${r.data.regenerated} clubs`)
            loadStatus()
          }} className="px-3 py-1 bg-orange-600 text-white text-xs rounded hover:bg-orange-700">
            Regenerate PINs
          </button>
        </Section>

        {/* Flush Meet */}
        <Section title={t.flush_meet} desc={t.flush_meet_desc}>
          <button onClick={async () => {
            if (!confirm(t.confirm_flush_meet)) return
            const r = await api.delete('/registrations')
            setMsg(`${t.flush_meet}: ${r.data.deleted} registrations deleted`)
            loadStatus(); loadOrganizer()
          }} className="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700">
            {t.flush_meet}
          </button>
        </Section>

        {/* Set Organizer */}
        <Section title={t.set_organizer_title}>
          {organizer?.club_id && (
            <div className="flex items-center gap-2 mb-2">
              <button className="px-3 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
                onClick={async () => {
                  try {
                    await api.post(`/clubs/${organizer.club_id}/send-pin`, { lang })
                    setMsg(`${t.send_invitation}: ${organizer.club_name} ✓`)
                    loadClubs()
                  } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
                }}>
                {t.send_invitation} → {organizer.club_name}
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <select className="border border-gray-300 px-2 py-0.5 rounded text-xs"
              value={selectedClubId} onChange={e => setSelectedClubId(e.target.value)}>
              <option value="">{lang === 'fr' ? '— Choisir —' : '— Select —'}</option>
              {clubs.map(club => <option key={club.id} value={club.id}>{club.name}</option>)}
            </select>
            {selectedClubId && (
              <button className="px-3 py-1 bg-purple-600 text-white text-xs rounded hover:bg-purple-700"
                onClick={async () => {
                  const club = clubs.find(c => String(c.id) === String(selectedClubId))
                  try {
                    await api.post('/admin/set-organizer', { club_id: Number(selectedClubId) })
                    setMsg(`${club?.name} ${t.set_as_organizer_done}`)
                    loadOrganizer()
                  } catch (e) { setMsg(e.detail || e.message || 'Error') }
                }}>
                {t.set_as_organizer}
              </button>
            )}
          </div>
        </Section>

        {/* Database Backup */}
        <BackupSection />

        {/* Historical Meets */}
        <HistoricalMeetsSection />

        {/* Club Manager */}
        <div className="border border-gray-300 rounded bg-white">
          <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">{t.club_manager}</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium">{t.club}</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium">Code</th>
                  <th className="px-2 py-1 border-b border-gray-300 text-left font-medium">Email</th>
                  <th className="px-2 py-1 border-b border-gray-300 w-14"></th>
                </tr>
              </thead>
              <tbody>
                {clubs.map(c => (
                  <tr key={c.id} className="border-b border-gray-200 hover:bg-blue-50">
                    <td className="px-2 py-0.5">
                      {c.name} <span className="text-gray-400">({c.athlete_count}, PIN: {c.pin || '—'})</span>
                    </td>
                    <td className="px-2 py-0.5 text-gray-500">{c.code || '—'}</td>
                    <td className="px-2 py-0.5">
                      <input type="email" className="border border-gray-300 px-1 py-0.5 rounded text-xs w-full"
                        defaultValue={c.email}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                        onBlur={e => { if (e.target.value !== c.email) updateEmail(c, e.target.value) }}
                        placeholder="email@example.com" />
                    </td>
                    <td className="px-2 py-0.5 text-center">
                      <button onClick={() => deleteClub(c)} className="text-red-500 hover:underline">{t.delete}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-gray-200 flex gap-2 items-center">
            <input type="text" className="border border-gray-300 px-2 py-0.5 rounded text-xs flex-1" placeholder={t.club_name_placeholder}
              value={newClubName} onChange={e => setNewClubName(e.target.value)} />
            <input type="text" className="border border-gray-300 px-2 py-0.5 rounded text-xs w-20" placeholder="Code"
              value={newClubCode} onChange={e => setNewClubCode(e.target.value)} />
            <input type="email" className="border border-gray-300 px-2 py-0.5 rounded text-xs flex-1" placeholder="Email"
              value={newClubEmail} onChange={e => setNewClubEmail(e.target.value)} />
            <button onClick={addClub} className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700">
              {t.add}
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-3 py-1 border-t border-gray-300 bg-gray-50 text-center text-xs text-gray-400 shrink-0">
        v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'} · build: {BUILD_TIMESTAMP}
      </div>
    </div>
  )
}

function Section({ title, desc, children }) {
  return (
    <div className="border border-gray-300 rounded bg-white">
      <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300">
        <span className="text-xs font-semibold text-gray-700">{title}</span>
        {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
      </div>
      <div className="px-3 py-2">
        {children}
      </div>
    </div>
  )
}

function HistoricalMeetsSection() {
  const [meets, setMeets] = useState([])
  const [mdbUploading, setMdbUploading] = useState(false)
  const [smbUploading, setSmbUploading] = useState(false)
  const [lxfUploading, setLxfUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const { lang } = useLang()

  useEffect(() => { loadMeets() }, [])

  async function loadMeets() {
    try {
      const r = await api.get('/admin/historical-meets')
      setMeets(r.data)
    } catch {}
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

  async function importLxf(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setLxfUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await api.post('/admin/import-historical', form)
      if (r.data.warning || r.data.needs_force) {
        setMsg(r.data.warning)
      } else {
        const d = r.data
        const report = lang === 'fr'
          ? `✅ Import terminé: "${d.meet_name}" (${d.meet_date || '?'})\n\n` +
            `• Résultats importés: ${d.results_imported}\n` +
            `• Épreuves: ${d.events_created}\n` +
            `• Athlètes trouvés: ${d.athletes_matched}\n` +
            `• Athlètes créés: ${d.athletes_created}\n` +
            `• Clubs: ${d.clubs_matched} (${d.clubs_created} nouveaux)`
          : `✅ Import complete: "${d.meet_name}" (${d.meet_date || '?'})\n\n` +
            `• Results imported: ${d.results_imported}\n` +
            `• Events: ${d.events_created}\n` +
            `• Athletes matched: ${d.athletes_matched}\n` +
            `• Athletes created: ${d.athletes_created}\n` +
            `• Clubs: ${d.clubs_matched} (${d.clubs_created} new)`
        alert(report)
        setMsg(lang === 'fr'
          ? `Importé: "${d.meet_name}" — ${d.results_imported} résultats`
          : `Imported: "${d.meet_name}" — ${d.results_imported} results`)
      }
      loadMeets()
    } catch (err) {
      const detail = err.response?.data?.detail || err.message || 'Error'
      if (err.response?.status === 409) {
        const forceLabel = lang === 'fr'
          ? `${detail}\n\nVoulez-vous forcer l'importation ?`
          : `${detail}\n\nDo you want to force the import?`
        if (confirm(forceLabel)) {
          try {
            const form2 = new FormData()
            form2.append('file', file)
            const r2 = await api.post('/admin/import-historical?force=true', form2)
            const d2 = r2.data
            const report2 = lang === 'fr'
              ? `✅ Import forcé: "${d2.meet_name}"\n\n• Résultats: ${d2.results_imported}\n• Athlètes: ${d2.athletes_matched} (${d2.athletes_created} créés)\n• Épreuves: ${d2.events_created}`
              : `✅ Forced import: "${d2.meet_name}"\n\n• Results: ${d2.results_imported}\n• Athletes: ${d2.athletes_matched} (${d2.athletes_created} created)\n• Events: ${d2.events_created}`
            alert(report2)
            setMsg(lang === 'fr'
              ? `Importé: "${d2.meet_name}" — ${d2.results_imported} résultats`
              : `Imported: "${d2.meet_name}" — ${d2.results_imported} results`)
            loadMeets()
          } catch (err2) { setMsg(err2.response?.data?.detail || err2.message || 'Error') }
        } else {
          setMsg('')
        }
      } else {
        setMsg(detail)
      }
    }
    finally { setLxfUploading(false); e.target.value = '' }
  }

  return (
    <div className="border border-gray-300 rounded bg-white">
      <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300 flex items-center justify-between flex-wrap gap-2">
        <div>
          <span className="text-xs font-semibold text-gray-700">
            {lang === 'fr' ? 'Compétitions historiques' : 'Historical Meets'}
          </span>
          {msg && <span className="ml-3 text-xs text-green-700">{msg}</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className={`px-3 py-1 text-xs rounded cursor-pointer ${mdbUploading ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700'} text-white`}>
            {mdbUploading ? (lang === 'fr' ? 'Import…' : 'Importing…') : (lang === 'fr' ? 'Importer Team.mdb' : 'Import Team.mdb')}
            <input type="file" accept=".mdb" className="hidden" onChange={importMdb} disabled={mdbUploading} />
          </label>
          <label className={`px-3 py-1 text-xs rounded cursor-pointer ${smbUploading ? 'bg-gray-400' : 'bg-purple-600 hover:bg-purple-700'} text-white`}>
            {smbUploading ? (lang === 'fr' ? 'Import…' : 'Importing…') : (lang === 'fr' ? 'Importer résultats .smb' : 'Import results .smb')}
            <input type="file" accept=".smb" className="hidden" onChange={importSmb} disabled={smbUploading} />
          </label>
          <label className={`px-3 py-1 text-xs rounded cursor-pointer ${lxfUploading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'} text-white`}>
            {lxfUploading ? (lang === 'fr' ? 'Import…' : 'Importing…') : (lang === 'fr' ? 'Importer résultats .lxf' : 'Import results .lxf')}
            <input type="file" accept=".lxf" className="hidden" onChange={importLxf} disabled={lxfUploading} />
          </label>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              <th className="px-2 py-1 border-b border-gray-300 text-left font-medium">{lang === 'fr' ? 'Nom' : 'Name'}</th>
              <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-24">{lang === 'fr' ? 'Lieu' : 'Location'}</th>
              <th className="px-2 py-1 border-b border-gray-300 text-left font-medium w-24">Date</th>
              <th className="px-2 py-1 border-b border-gray-300 text-center font-medium w-8">R</th>
              <th className="px-2 py-1 border-b border-gray-300 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {meets.map(m => (
              <tr key={m.id} className="border-b border-gray-200 hover:bg-blue-50">
                <td className="px-2 py-0.5">{m.name}</td>
                <td className="px-2 py-0.5 text-gray-600">{m.city || m.place || '—'}</td>
                <td className="px-2 py-0.5 text-gray-600 font-mono">
                  {m.date || (m.mindate ? m.mindate.slice(0, 10) : '—')}
                </td>
                <td className="px-2 py-0.5 text-center">
                  {(m.resultCount > 0 || m.has_results) && <span className="text-green-700 font-bold">R</span>}
                </td>
                <td className="px-2 py-0.5 text-right">
                  <button onClick={() => deleteMeet(m.id, m.name)} className="text-red-500 hover:text-red-700 text-xs">✕</button>
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
  )
}

function BackupSection() {
  const [backups, setBackups] = useState([])
  const [config, setConfig] = useState({ interval_days: 1, max_count: 7 })
  const [msg, setMsg] = useState('')
  const { lang } = useLang()

  useEffect(() => { loadBackups(); loadConfig() }, [])

  async function loadBackups() {
    try {
      const r = await api.get('/admin/backups')
      setBackups(r.data)
    } catch {}
  }

  async function loadConfig() {
    try {
      const r = await api.get('/admin/backup-config')
      setConfig(r.data)
    } catch {}
  }

  async function saveConfig() {
    try {
      await api.put('/admin/backup-config', config)
      setMsg(lang === 'fr' ? 'Configuration sauvegardée' : 'Config saved')
    } catch (e) { setMsg(e.message || 'Error') }
  }

  async function createBackup() {
    setMsg(lang === 'fr' ? 'Création...' : 'Creating...')
    try {
      const r = await api.post('/admin/backups/create', {})
      setMsg(lang === 'fr' ? `Backup créé: ${r.data.filename}` : `Backup created: ${r.data.filename}`)
      loadBackups()
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  async function downloadBackup(filename) {
    const res = await fetch(`/api/admin/backups/${filename}`, {
      headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' }
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  async function deleteBackup(filename) {
    if (!confirm(lang === 'fr' ? `Supprimer ${filename} ?` : `Delete ${filename}?`)) return
    try {
      await api.delete(`/admin/backups/${filename}`)
      loadBackups()
    } catch (e) { setMsg(e.message || 'Error') }
  }

  async function restoreBackup(e) {
    const file = e.target.files[0]
    if (!file) return
    const label = lang === 'fr'
      ? 'Restaurer cette sauvegarde ? Toutes les données actuelles seront écrasées.'
      : 'Restore this backup? All current data will be overwritten.'
    if (!confirm(label)) { e.target.value = ''; return }
    setMsg(lang === 'fr' ? 'Restauration...' : 'Restoring...')
    const fd = new FormData()
    fd.append('file', file)
    try {
      await api.post('/admin/restore-db', fd)
      setMsg(lang === 'fr' ? '✓ Base restaurée' : '✓ Database restored')
      e.target.value = ''
    } catch (err) { setMsg(err.response?.data?.detail || err.message || 'Error') }
  }

  return (
    <div className="border border-gray-300 rounded bg-white">
      <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-300">
        <span className="text-xs font-semibold text-gray-700">
          {lang === 'fr' ? 'Sauvegarde de la base de données' : 'Database Backup'}
        </span>
        <p className="text-xs text-gray-500 mt-0.5">
          {lang === 'fr'
            ? 'Sauvegarde et restauration PostgreSQL. Les sauvegardes automatiques sont créées selon la configuration.'
            : 'PostgreSQL backup and restore. Auto-backups are created based on the configuration below.'}
        </p>
      </div>
      <div className="px-3 py-2 space-y-3">
        {/* Manual actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={createBackup}
            className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">
            {lang === 'fr' ? 'Créer une sauvegarde' : 'Create Backup'}
          </button>
          <label className="px-3 py-1 bg-orange-600 text-white text-xs rounded hover:bg-orange-700 cursor-pointer">
            {lang === 'fr' ? 'Restaurer (.db/.sql)' : 'Restore (.db/.sql)'}
            <input type="file" accept=".sql,.db" className="hidden" onChange={restoreBackup} />
          </label>
          {msg && <span className="text-xs text-green-700">{msg}</span>}
        </div>

        {/* Auto-backup config */}
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-600">{lang === 'fr' ? 'Auto-backup:' : 'Auto-backup:'}</span>
          <label className="flex items-center gap-1">
            {lang === 'fr' ? 'chaque' : 'every'}
            <input type="number" min="1" max="30" value={config.interval_days}
              onChange={e => setConfig(c => ({ ...c, interval_days: parseInt(e.target.value) || 1 }))}
              className="w-12 border border-gray-300 rounded px-1 py-0.5 text-xs text-center" />
            {lang === 'fr' ? 'jour(s)' : 'day(s)'}
          </label>
          <label className="flex items-center gap-1">
            {lang === 'fr' ? 'garder' : 'keep'}
            <input type="number" min="1" max="30" value={config.max_count}
              onChange={e => setConfig(c => ({ ...c, max_count: parseInt(e.target.value) || 7 }))}
              className="w-12 border border-gray-300 rounded px-1 py-0.5 text-xs text-center" />
            {lang === 'fr' ? 'copies' : 'copies'}
          </label>
          <button onClick={saveConfig}
            className="px-2 py-0.5 bg-gray-600 text-white text-xs rounded hover:bg-gray-700">
            {lang === 'fr' ? 'Sauver' : 'Save'}
          </button>
        </div>

        {/* Backup list */}
        {backups.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1 font-medium text-gray-600">{lang === 'fr' ? 'Fichier' : 'File'}</th>
                <th className="text-right py-1 font-medium text-gray-600">{lang === 'fr' ? 'Taille' : 'Size'}</th>
                <th className="text-right py-1 font-medium text-gray-600">Date</th>
                <th className="text-right py-1 font-medium text-gray-600"></th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.filename} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1">{b.filename}</td>
                  <td className="py-1 text-right text-gray-500">{b.size_mb} MB</td>
                  <td className="py-1 text-right text-gray-500">{b.date?.slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-1 text-right">
                    <button onClick={() => downloadBackup(b.filename)}
                      className="text-blue-600 hover:underline mr-2">↓</button>
                    <button onClick={() => deleteBackup(b.filename)}
                      className="text-red-500 hover:underline">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
