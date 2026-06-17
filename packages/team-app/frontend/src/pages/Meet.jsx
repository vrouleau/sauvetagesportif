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

import { useState, useEffect, useRef } from 'react'
import { useLang } from '../i18n'
import api from '../api'

export default function Meet() {
  const { t, lang } = useLang()
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const fileRef = useRef(null)

  useEffect(() => { loadMeetInfo() }, [])

  function loadMeetInfo() {
    api.get('/meet-info')
      .then(r => { setInfo(r.data); setLoading(false) })
      .catch(() => setLoading(false))
  }

  async function handleImportMeet(e) {
    const file = e.target.files[0]
    if (!file) return
    if (info?.filename && !confirm(t.confirm_replace_meet)) {
      e.target.value = ''
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    setMsg(lang === 'fr' ? 'Importation...' : 'Importing...')
    try {
      const r = await api.post('/upload/meet', fd)
      setMsg(`${r.data.events_loaded} ${t.events} — ${t.import_meet_success}`)
      loadMeetInfo()
    } catch (err) {
      setMsg(err.response?.data?.detail || err.message || 'Error')
    }
    e.target.value = ''
  }

  async function handleExportMeet() {
    try {
      const res = await fetch('/api/export/meet-lxf', {
        headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' }
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'meet.lxf'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { setMsg(e.message || 'Error') }
  }

  if (loading) return <div className="p-4 text-xs text-gray-400">Chargement…</div>

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        <span className="text-xs font-semibold text-gray-700">{t.meet}</span>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept=".lxf" className="hidden" onChange={handleImportMeet} />
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
        >
          {t.import_meet}
        </button>
        <button
          onClick={handleExportMeet}
          disabled={!info?.filename}
          className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50"
        >
          {t.export_meet}
        </button>
        {msg && <span className="text-xs text-green-700 ml-2">{msg}</span>}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {(!info || !info.meet_name) ? (
          <div className="p-6 text-sm text-gray-500">{t.no_meet}</div>
        ) : (
          <div className="text-xs">
            <div className="flex border-b border-gray-200 bg-gray-50">
              <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">
                {t.meet_designation || 'Désignation'}
              </div>
              <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">
                {t.meet_value || 'Valeur'}
              </div>
            </div>

            <table className="w-full border-collapse">
              <tbody>
                <SectionHeader title={t.meet_general || 'Général'} />
                <Row label={t.meet_name_label || 'Nom'} value={info.meet_name} />
                <Row label={t.meet_events_label || 'Épreuves'} value={info.events} />
                <Row label={t.meet_course_label || 'Bassin'} value={courseLabel(info.course)} />
                <Row label={t.meet_masters_label || 'Nages Maîtres'} value={info.masters ? '✓' : '—'} />
                <Row label={t.meet_uploaded_label || 'Téléversé'} value={info.uploaded_at || '—'} />
                <Row label={t.meet_filename_label || 'Fichier'} value={info.filename || '—'} />

                <SectionHeader title={t.meet_closure || 'Inscription'} />
                <Row label={t.closure_date_label} value={info.closure_date || '—'} />

                {info.meet_fees && Object.keys(info.meet_fees).length > 0 && (
                  <>
                    <SectionHeader title={t.fee_summary} />
                    {info.meet_fees.fee_athlete != null && (
                      <Row label={t.fee_per_athlete} value={`${info.meet_fees.fee_athlete} ${info.currency}`} />
                    )}
                    {info.meet_fees.fee_relay != null && (
                      <Row label={t.fee_per_relay} value={`${info.meet_fees.fee_relay} ${info.currency}`} />
                    )}
                    {info.meet_fees.fee_team != null && (
                      <Row label={t.fee_per_team} value={`${info.meet_fees.fee_team} ${info.currency}`} />
                    )}
                  </>
                )}

                {info.event_fees && info.event_fees.length > 0 && (
                  <>
                    <SectionHeader title={t.fee_per_event} />
                    {info.event_fees.filter(e => e.fee_cents > 0).map((e, i) => (
                      <Row
                        key={i}
                        label={`#${e.event_number} ${e.style_name}`}
                        value={`${(e.fee_cents / 100).toFixed(2)} ${info.currency}`}
                      />
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function courseLabel(course) {
  if (course === 'LCM' || course === '1') return 'Bassin 50m (LCM)'
  if (course === 'SCM' || course === '3') return 'Bassin 25m (SCM)'
  if (course === 'SCY' || course === '2') return 'Bassin 25yd (SCY)'
  return course || '—'
}

function SectionHeader({ title }) {
  return (
    <tr>
      <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
        {title}
      </td>
    </tr>
  )
}

function Row({ label, value }) {
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50">
      <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
      <td className="px-2 py-0.5">{value ?? '—'}</td>
    </tr>
  )
}