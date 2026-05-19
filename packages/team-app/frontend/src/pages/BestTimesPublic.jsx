import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router'
import { useLang } from '../i18n'

const TURNSTILE_SITE_KEY = window.__TURNSTILE_SITE_KEY__ || ''

function formatTime(ms) {
  if (!ms) return ''
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return min > 0
    ? `${min}:${sec.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
    : `${sec}.${cs.toString().padStart(2, '0')}`
}

export default function BestTimesPublic() {
  const { t, lang, toggle } = useLang()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [needsCaptcha] = useState(!!TURNSTILE_SITE_KEY)
  const [verified, setVerified] = useState(!TURNSTILE_SITE_KEY)
  const turnstileRef = useRef(null)
  const widgetId = useRef(null)

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

  const renderWidget = useCallback(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return
    if (widgetId.current != null) return
    if (!window.turnstile) { setTimeout(renderWidget, 200); return }
    widgetId.current = window.turnstile.render(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: token => setCaptchaToken(token),
      'expired-callback': () => setCaptchaToken(''),
    })
  }, [])

  useEffect(() => { if (TURNSTILE_SITE_KEY) renderWidget() }, [renderWidget])

  // Auto-fetch when no captcha needed
  useEffect(() => { if (!TURNSTILE_SITE_KEY) fetchData('') }, [])

  async function fetchData(token) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/best-times-public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captcha_token: token }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Error ${res.status}`)
      setData(await res.json())
      setVerified(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit() {
    if (!captchaToken) return
    fetchData(captchaToken)
  }

  // CAPTCHA gate
  if (needsCaptcha && !verified) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-md p-6 w-full max-w-sm text-center">
          <div className="flex justify-between items-center mb-4">
            <h1 className="text-xl font-bold">{t.best_times_title}</h1>
            <button onClick={toggle} className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">
              {lang === 'fr' ? 'EN' : 'FR'}
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-4">{t.best_times_captcha_prompt}</p>
          <div ref={turnstileRef} className="flex justify-center mb-4" />
          <button
            onClick={handleSubmit}
            disabled={!captchaToken || loading}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-600/85 disabled:opacity-50 text-sm font-medium"
          >
            {loading ? '…' : t.best_times_view_btn}
          </button>
          {error && <p className="mt-3 text-red-600 text-sm">{error}</p>}
          <div className="mt-4">
            <Link to="/" className="text-xs text-gray-500 hover:underline">{t.self_invite_back}</Link>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p>Loading…</p></div>
  if (error) return <div className="min-h-screen flex items-center justify-center"><p className="text-red-600">{error}</p></div>
  if (!data) return null

  const { styles, clubs, course } = data

  return (
    <div className="best-times-print p-4">
      <div className="print:hidden flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">{t.best_times_title}</h1>
        <div className="flex gap-2">
          <button onClick={toggle} className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
          <button onClick={() => window.print()} className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-600/85">
            {t.best_times_print}
          </button>
          <Link to="/" className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">{t.self_invite_back}</Link>
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-2 print:mb-1">{t.best_times_course}: {course}</p>

      <table className="w-full text-xs border-collapse border border-gray-300">
        <thead>
          <tr>
            <th className="border border-gray-300 px-1 py-1 bg-gray-100 text-left sticky left-0">{t.best_times_athlete}</th>
            {styles.map(s => (
              <th key={s.uid} className="border border-gray-300 px-1 py-1 bg-gray-100">
                <span className="best-times-header">{s.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clubs.map(club => (
            <>{/* Fragment with key on first row */}
              <tr key={`club-${club.name}`}>
                <td colSpan={styles.length + 1} className="border border-gray-300 px-1 py-1 bg-blue-50 font-bold">
                  {club.name}
                </td>
              </tr>
              {club.athletes.map((ath, i) => (
                <tr key={`${club.name}-${i}`}>
                  <td className="border border-gray-300 px-1 py-0.5 whitespace-nowrap">{ath.name}</td>
                  {styles.map(s => {
                    const lcm = ath.times[`${s.uid}_LCM`]
                    const scm = ath.times[`${s.uid}_SCM`]
                    const val = course === 'SCM' ? (scm || lcm) : (lcm || scm)
                    return <td key={s.uid} className="border border-gray-300 px-1 py-0.5 text-center font-mono">{formatTime(val)}</td>
                  })}
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}
