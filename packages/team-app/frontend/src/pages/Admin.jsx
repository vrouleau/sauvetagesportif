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
  const { t, lang } = useLang()

  useEffect(() => { loadStatus(); loadClubs(); loadOrganizer() }, [])

  async function loadStatus() { const r = await api.get('/status'); setStatus(r.data) }
  async function loadClubs() { const r = await api.get('/clubs'); setClubs(r.data) }
  async function loadOrganizer() { const r = await api.get('/admin/organizer'); setOrganizer(r.data) }

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
        build: {BUILD_TIMESTAMP}
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
