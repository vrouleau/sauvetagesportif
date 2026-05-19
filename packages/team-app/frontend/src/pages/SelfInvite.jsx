import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router'
import { useLang } from '../i18n'

const TURNSTILE_SITE_KEY = window.__TURNSTILE_SITE_KEY__ || ''

export default function SelfInvite() {
  const { t, lang, toggle } = useLang()
  const [clubs, setClubs] = useState([])
  const [meetName, setMeetName] = useState('')
  const [closed, setClosed] = useState(false)
  const [selectedClubId, setSelectedClubId] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [organizerEmail, setOrganizerEmail] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const turnstileRef = useRef(null)
  const widgetId = useRef(null)

  useEffect(() => {
    fetch('/api/self-invite/clubs')
      .then(r => r.json())
      .then(data => setClubs(data))
      .catch(() => setError('Failed to load clubs'))
    fetch('/api/meet-info')
      .then(r => r.json())
      .then(data => {
        setMeetName(data.meet_name || '')
        if (data.closure_date && new Date(data.closure_date) < new Date()) setClosed(true)
      })
      .catch(() => {})
  }, [])

  // Load Turnstile script
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return
    if (document.getElementById('cf-turnstile-script')) return
    const s = document.createElement('script')
    s.id = 'cf-turnstile-script'
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    document.head.appendChild(s)
  }, [])

  // Render widget once script is loaded and container is mounted
  const renderWidget = useCallback(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return
    if (widgetId.current != null) return
    if (!window.turnstile) {
      setTimeout(renderWidget, 200)
      return
    }
    widgetId.current = window.turnstile.render(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: token => setCaptchaToken(token),
      'expired-callback': () => setCaptchaToken(''),
    })
  }, [])

  useEffect(() => {
    if (TURNSTILE_SITE_KEY) renderWidget()
  }, [renderWidget, clubs])

  async function handleSend() {
    if (!selectedClubId || !email.trim()) return
    setSending(true)
    setMsg('')
    setError('')
    setOrganizerEmail('')
    try {
      const res = await fetch('/api/self-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ club_id: Number(selectedClubId), email: email.trim(), lang, captcha_token: captchaToken }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const detail = data.detail || ''
        if (detail.startsWith('email_mismatch|')) {
          const orgEmail = detail.split('|')[1] || ''
          setOrganizerEmail(orgEmail)
          setError(t.self_invite_email_mismatch)
        } else {
          throw new Error(detail || `Error ${res.status}`)
        }
        return
      }
      setMsg(t.self_invite_sent)
    } catch (e) {
      setError(e.message || 'Error')
    } finally {
      setSending(false)
      if (TURNSTILE_SITE_KEY && window.turnstile && widgetId.current != null) {
        window.turnstile.reset(widgetId.current)
        setCaptchaToken('')
      }
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-md p-6 w-full max-w-sm">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-xl font-bold text-balance">{t.self_invite_title}</h1>
          <button onClick={toggle} className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
        </div>
        {meetName && <p className="text-sm text-gray-600 mb-4 font-medium text-pretty">{meetName}</p>}

        {closed && (
          <p className="text-red-600 text-sm font-medium">{t.self_invite_closed}</p>
        )}

        {!closed && clubs.length === 0 && !error && (
          <p className="text-gray-500 text-sm">{t.self_invite_no_clubs}</p>
        )}

        {!closed && clubs.length > 0 && (
          <>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t.self_invite_select_club}
              </label>
              <select
                value={selectedClubId}
                onChange={e => { setSelectedClubId(e.target.value); setMsg(''); setError(''); setOrganizerEmail('') }}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">—</option>
                {clubs.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t.self_invite_email_label}
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t.self_invite_email_placeholder}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            <button
              onClick={handleSend}
              disabled={!selectedClubId || !email.trim() || sending || (TURNSTILE_SITE_KEY && !captchaToken)}
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-600/85 disabled:opacity-50 text-sm font-medium"
            >
              {sending ? '…' : t.self_invite_send_btn}
            </button>

            {TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="mt-3 flex justify-center" />}
          </>
        )}

        {msg && <p className="mt-3 text-green-700 text-sm">{msg}</p>}
        {error && (
          <div className="mt-3">
            <p className="text-red-600 text-sm">{error}</p>
            {organizerEmail && (
              <p className="text-sm text-gray-700 mt-1">
                {t.self_invite_contact_organizer}{' '}
                <a href={`mailto:${organizerEmail}`} className="text-blue-600 underline">{organizerEmail}</a>
              </p>
            )}
          </div>
        )}

        <div className="mt-4 text-center">
          <Link to="/" className="text-xs text-gray-500 hover:underline">{t.self_invite_back}</Link>
        </div>
      </div>
    </div>
  )
}
