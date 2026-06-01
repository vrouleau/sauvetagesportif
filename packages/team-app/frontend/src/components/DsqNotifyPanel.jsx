/**
 * DSQ Notification Panel — PIN entry + subscription status.
 *
 * Shown on the live results page. Coaches enter their team PIN to
 * subscribe to push notifications for DSQ events affecting their athletes.
 */
import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import {
  isPushSupported,
  getStoredPin,
  subscribeToPush,
  unsubscribeFromPush,
  autoResubscribe,
} from '../pushNotifications'

export default function DsqNotifyPanel({ onClubChange }) {
  const { lang } = useLang()
  const [pin, setPin] = useState('')
  const [subscribed, setSubscribed] = useState(false)
  const [clubName, setClubName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const supported = isPushSupported()

  // Auto-resubscribe on mount if PIN is stored
  useEffect(() => {
    if (!supported) return
    const stored = getStoredPin()
    if (stored) {
      setPin(stored)
      autoResubscribe().then((name) => {
        if (name) {
          setSubscribed(true)
          setClubName(name)
          onClubChange?.(name)
          localStorage.setItem('dsq_notify_club', name)
        }
      })
    }
  }, [supported])

  async function handleSubscribe(e) {
    e.preventDefault()
    if (!pin.trim()) return
    setError('')
    setLoading(true)

    const result = await subscribeToPush(pin.trim())
    setLoading(false)

    if (result.ok) {
      setSubscribed(true)
      setClubName(result.club_name || '')
      setExpanded(false)
      onClubChange?.(result.club_name || '')
      localStorage.setItem('dsq_notify_club', result.club_name || '')
    } else {
      setError(result.error || 'Error')
    }
  }

  async function handleUnsubscribe() {
    await unsubscribeFromPush()
    setSubscribed(false)
    setClubName('')
    setPin('')
    onClubChange?.('')
    localStorage.removeItem('dsq_notify_club')
  }

  if (!supported) return null

  // Collapsed state — just a small bell icon
  if (!expanded && !subscribed) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded hover:bg-amber-100 transition-colors"
        title={lang === 'fr' ? 'Notifications DSQ' : 'DSQ Notifications'}
      >
        <span>🔔</span>
        <span className="hidden sm:inline">{lang === 'fr' ? 'Alertes DSQ' : 'DSQ Alerts'}</span>
      </button>
    )
  }

  // Subscribed state
  if (subscribed) {
    return (
      <div className="flex items-center gap-2 text-xs bg-green-50 text-green-700 px-2 py-1 rounded">
        <span>🔔</span>
        <span className="font-medium">{clubName}</span>
        <button
          onClick={handleUnsubscribe}
          className="text-green-500 hover:text-red-500 ml-1"
          title={lang === 'fr' ? 'Désactiver' : 'Disable'}
        >
          ✕
        </button>
      </div>
    )
  }

  // Expanded — PIN entry form
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-amber-800">
          🔔 {lang === 'fr' ? 'Alertes DSQ' : 'DSQ Alerts'}
        </span>
        <button
          onClick={() => setExpanded(false)}
          className="text-amber-400 hover:text-amber-600 text-lg leading-none"
        >
          ✕
        </button>
      </div>
      <p className="text-xs text-amber-700 mb-2">
        {lang === 'fr'
          ? 'Entrez votre NIP d\'équipe pour recevoir une notification mobile lors d\'un DSQ.'
          : 'Enter your team PIN to receive a mobile notification on DSQ.'}
      </p>
      <form onSubmit={handleSubscribe} className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          className="w-20 px-2 py-1 border rounded text-center text-sm"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !pin.trim()}
          className="px-3 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50"
        >
          {loading ? '…' : (lang === 'fr' ? 'Activer' : 'Enable')}
        </button>
      </form>
      {error && (
        <p className="text-xs text-red-600 mt-1">{error}</p>
      )}
    </div>
  )
}
