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
import { Link } from 'react-router'
import { useLang } from '../i18n'
import api from '../api'
import { selectMeet } from '../authMeet'

// Registration status of one meet, as shown on the login screen.
// Deadline = end of that day in local time (a bare "YYYY-MM-DD" parses as
// midnight UTC, which would close the evening before in Quebec).
export function meetRegistrationStatus(meet, now = new Date()) {
  if (!meet.registration_open) return 'not_open'
  if (meet.closure_date && now > new Date(meet.closure_date + 'T23:59:59')) return 'deadline_passed'
  return 'open'
}

function formatDate(iso, lang) {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d)) return iso
  return d.toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function Login({ onLogin }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [meets, setMeets] = useState(null) // null = loading / unavailable
  const { t, lang, toggle } = useLang()

  useEffect(() => {
    fetch('/api/self-invite/meets')
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(data => setMeets(Array.isArray(data) ? data : []))
      .catch(() => setMeets(null))
  }, [])

  const anyOpen = (meets || []).some(m => meetRegistrationStatus(m) === 'open')

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      const r = await api.post('/auth', { pin })
      localStorage.setItem('pin', pin)
      localStorage.setItem('club_id', r.data.club_id || '')
      localStorage.setItem('club_name', r.data.club_name)
      localStorage.setItem('meets', JSON.stringify(r.data.meets || []))
      const meetId = r.data.meets?.[0]?.meet_id ?? ''
      selectMeet(meetId)
      onLogin({ ...r.data, meet_id: meetId })
    } catch {
      setError(t.invalid_pin)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white border border-gray-400 shadow-xl w-[340px] text-xs">
        {/* Dialog header */}
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold text-sm">{t.login_title}</span>
          <button type="button" onClick={toggle}
            className="px-2 py-0.5 rounded text-xs font-medium border border-gray-500 text-gray-300 hover:text-white hover:border-gray-300">
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
        </div>

        {/* Dialog body */}
        <form onSubmit={submit} className="p-6">
          <p className="text-gray-600 mb-4 text-center text-sm">{t.login_prompt}</p>
          <input type="text" maxLength={6} value={pin} onChange={e => setPin(e.target.value)}
                 className="border border-gray-300 p-3 rounded w-full text-center text-2xl tracking-widest mb-4 focus:border-blue-500 focus:outline-none"
                 placeholder="000000" autoFocus />
          {error && <p className="text-red-600 text-xs mb-3 text-center">{error}</p>}
          <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 border border-blue-700 rounded">
            {t.login_btn}
          </button>
          {/* Active meets and their registration status. Self-invite is
              offered per meet only while its registration is open; when none
              is, say so instead of silently hiding the link (coaches were
              left wondering where "Demander une invitation" went). */}
          {meets && (
            <div className="mt-5 border-t border-gray-200 pt-4" data-testid="login-meets">
              <p className="font-semibold text-gray-700 mb-2">{t.login_meets_title}</p>
              {meets.length === 0 ? (
                <p className="text-gray-500">{t.login_meets_none}</p>
              ) : (
                <ul className="space-y-2">
                  {meets.map(m => {
                    const status = meetRegistrationStatus(m)
                    const where = [formatDate(m.start_date, lang), m.place].filter(Boolean).join(' · ')
                    return (
                      <li key={m.meet_id} className="border border-gray-200 rounded p-2" data-status={status}>
                        <div className="font-medium text-gray-800 text-pretty">{m.name}</div>
                        {where && <div className="text-gray-500">{where}</div>}
                        <div className="mt-1 flex flex-col items-start gap-1">
                          {status === 'open' && (
                            <span className="text-green-700">
                              {m.closure_date
                                ? `${t.login_meet_open_until} ${formatDate(m.closure_date, lang)}`
                                : t.login_meet_open}
                            </span>
                          )}
                          {status === 'deadline_passed' && (
                            <span className="text-red-600">
                              {t.login_meet_deadline_passed} {formatDate(m.closure_date, lang)}
                            </span>
                          )}
                          {status === 'not_open' && (
                            <span className="text-gray-500">{t.login_meet_not_open}</span>
                          )}
                          {status === 'open' && (
                            <Link to={`/self-invite?meet=${m.meet_id}`}
                                  className="text-blue-600 font-medium hover:underline">
                              → 
                              {t.self_invite_title}
                            </Link>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {meets.length > 0 && !anyOpen && (
                <p className="mt-2 text-gray-600 text-pretty">{t.login_meets_no_open}</p>
              )}
            </div>
          )}

          <div className="mt-4 text-center">
            {/* Fallback if the meet list couldn't load: keep the old plain link. */}
            {meets === null && (
              <>
                <Link to="/self-invite" className="text-xs text-gray-500 hover:underline">
                  {t.self_invite_title}
                </Link>
                <span className="mx-2 text-gray-300">·</span>
              </>
            )}
            <a href="/results" target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:underline">
              {t.results_link}
            </a>
          </div>
          {window.__SUPPORT_EMAIL__ && (
            <div className="mt-3 text-center">
              <a href={`mailto:${window.__SUPPORT_EMAIL__}`} className="text-xs text-blue-500 hover:underline">
                {t.footer_get_help}
              </a>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}