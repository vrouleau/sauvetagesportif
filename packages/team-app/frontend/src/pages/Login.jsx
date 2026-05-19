import { useState, useEffect } from 'react'
import { Link } from 'react-router'
import { useLang } from '../i18n'
import api from '../api'

export default function Login({ onLogin }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [closed, setClosed] = useState(false)
  const { t, lang, toggle } = useLang()

  useEffect(() => {
    fetch('/api/meet-info')
      .then(r => r.json())
      .then(data => {
        if (data.closure_date && new Date(data.closure_date) < new Date()) setClosed(true)
      })
      .catch(() => {})
  }, [])

  async function submit(e) {
    e.preventDefault()
    setError('')
    try {
      const r = await api.post('/auth', { pin })
      localStorage.setItem('pin', pin)
      localStorage.setItem('role', r.data.role)
      localStorage.setItem('club_id', r.data.club_id || '')
      localStorage.setItem('club_name', r.data.club_name)
      onLogin(r.data)
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
          {!closed && (
            <div className="mt-4 text-center">
              <Link to="/self-invite" className="text-xs text-gray-500 hover:underline">
                {t.self_invite_title}
              </Link>
              <span className="mx-2 text-gray-300">·</span>
              <a href="/best-times" target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:underline">
                {t.best_times_link}
              </a>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
