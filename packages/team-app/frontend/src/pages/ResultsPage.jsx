import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useLang } from '../i18n'
import DsqNotifyPanel from '../components/DsqNotifyPanel'
import DsqToast, { useDsqAlerts } from '../components/DsqToast'

function formatTime(ms) {
  if (!ms) return ''
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return min > 0
    ? `${min}:${sec.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
    : `${sec}.${cs.toString().padStart(2, '0')}`
}

function GenderBadge({ gender }) {
  if (!gender) return null
  const colors = { M: 'bg-blue-100 text-blue-700', F: 'bg-pink-100 text-pink-700', X: 'bg-purple-100 text-purple-700' }
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${colors[gender] || ''}`}>{gender}</span>
}

// ── Live View ─────────────────────────────────────────────────────────────────

function LiveView({ status }) {
  const { t, lang } = useLang()
  const [events, setEvents] = useState([])
  const [searchParams] = useSearchParams()
  const [selectedEvent, setSelectedEvent] = useState(() => {
    const p = searchParams.get('event')
    return p ? parseInt(p, 10) : null
  })
  const [results, setResults] = useState(null)
  const [loadingResults, setLoadingResults] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false)
  const wsRef = useRef(null)
  const [subscribedClub, setSubscribedClub] = useState('')
  const [announcements, setAnnouncements] = useState([])

  // DSQ toast alerts
  const { alerts: dsqAlerts, dismissAlert, processResults } = useDsqAlerts(subscribedClub)

  // Detect if user is organizer/admin (PIN stored in localStorage)
  const pin = localStorage.getItem('pin')
  const role = localStorage.getItem('role')
  const canFinalize = role === 'admin' || role === 'organizer'

  // Track subscribed club name for in-page DSQ alerts
  useEffect(() => {
    setSubscribedClub(localStorage.getItem('dsq_notify_club') || '')
  }, [])

  // Fetch events list (and load results for deep-linked event)
  useEffect(() => {
    fetch('/api/live/events').then(r => r.json()).then(data => {
      setEvents(data)
      if (selectedEvent) fetchResults(selectedEvent)
    }).catch(console.error)
  }, [])

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/live/ws`)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'result' || msg.type === 'status' || msg.type === 'events_updated' || msg.type === 'startlist') {
          // Refresh events list
          fetch('/api/live/events').then(r => r.json()).then(setEvents).catch(() => {})
          // Refresh selected event results if affected
          if (selectedEvent && msg.event_id === selectedEvent) {
            fetchResults(selectedEvent)
          }
          if (selectedEvent && msg.events && msg.events.includes(selectedEvent)) {
            fetchResults(selectedEvent)
          }
          // In-page DSQ alerts (from broadcast payload)
          if (msg.type === 'result' && msg.dsq && subscribedClub) {
            processResults(msg.dsq)
          }
        }
        if (msg.type === 'meet_finalized') {
          // Reload page to switch to historical view
          window.location.reload()
        }
        if (msg.type === 'announcement') {
          const ann = {
            id: Date.now(),
            type: msg.announcement_type,
            event_number: msg.event_number,
            event_name: msg.event_name,
            gender: msg.gender,
          }
          setAnnouncements(prev => [ann, ...prev.slice(0, 4)])
          // Auto-dismiss after 30 seconds
          setTimeout(() => {
            setAnnouncements(prev => prev.filter(a => a.id !== ann.id))
          }, 30000)
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      // Reconnect after 3s
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }
      }, 3000)
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [selectedEvent, subscribedClub, processResults])

  const fetchResults = useCallback((eventId) => {
    setLoadingResults(true)
    fetch(`/api/live/results/${eventId}`)
      .then(r => r.json())
      .then(data => { setResults(data); setLoadingResults(false) })
      .catch(() => setLoadingResults(false))
  }, [])

  function handleSelectEvent(eventId) {
    setSelectedEvent(eventId)
    fetchResults(eventId)
  }

  async function handleFinalize() {
    setFinalizing(true)
    try {
      const res = await fetch('/api/live/finalize', {
        method: 'POST',
        headers: { 'X-Club-Pin': pin || '' },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.detail || `Error ${res.status}`)
      } else {
        const data = await res.json()
        alert(lang === 'fr'
          ? `Meet finalisé — ${data.results_archived} résultats archivés.`
          : `Meet finalized — ${data.results_archived} results archived.`)
        window.location.reload()
      }
    } catch (e) {
      alert(e.message)
    } finally {
      setFinalizing(false)
      setShowFinalizeConfirm(false)
    }
  }

  // Compute stats for finalization dialog
  const totalHeats = events.reduce((sum, ev) => sum + (ev.total_heats || 0), 0)
  const officialHeats = events.reduce((sum, ev) => sum + (ev.official_heats || 0), 0)

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* DSQ Toast notifications */}
      <DsqToast dsqAlerts={dsqAlerts} onDismiss={dismissAlert} />

      {/* Finalization confirmation dialog */}
      {showFinalizeConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full">
            <h3 className="text-lg font-bold mb-2">
              {lang === 'fr' ? 'Finaliser le meet ?' : 'Finalize meet?'}
            </h3>
            <p className="text-sm text-gray-600 mb-3">
              {lang === 'fr'
                ? 'Les résultats seront archivés et le meet sera réinitialisé pour le prochain cycle.'
                : 'Results will be archived and the meet will be reset for the next cycle.'}
            </p>
            <div className="text-sm mb-4 bg-gray-50 rounded p-2">
              <p>{lang === 'fr' ? 'Séries officielles' : 'Official heats'}: <b>{officialHeats}/{totalHeats}</b></p>
              {officialHeats < totalHeats && (
                <p className="text-amber-600 text-xs mt-1">
                  ⚠️ {lang === 'fr'
                    ? `${totalHeats - officialHeats} série(s) non officielles`
                    : `${totalHeats - officialHeats} heat(s) not official`}
                </p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowFinalizeConfirm(false)}
                className="px-3 py-1.5 text-sm rounded border hover:bg-gray-50"
                disabled={finalizing}
              >
                {lang === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={handleFinalize}
                disabled={finalizing}
                className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {finalizing ? '…' : (lang === 'fr' ? 'Finaliser' : 'Finalize')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Event list (sidebar on desktop, top on mobile) */}
      <div className="md:w-80 md:border-r border-b md:border-b-0 overflow-y-auto bg-white">
        <div className="p-3 border-b bg-green-50">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-sm font-medium text-green-800">
              {lang === 'fr' ? 'En direct' : 'Live'}
            </span>
            {canFinalize && (
              <button
                onClick={() => setShowFinalizeConfirm(true)}
                className="ml-auto text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded hover:bg-red-200"
              >
                {lang === 'fr' ? 'Finaliser' : 'Finalize'}
              </button>
            )}
          </div>
          <p className="text-xs text-green-700 mt-1">{status.meet_name}</p>
          <div className="mt-2">
            <DsqNotifyPanel onClubChange={setSubscribedClub} />
          </div>
        </div>

        <div className="divide-y">
          {/* Announcements banner */}
          {announcements.length > 0 && (
            <div className="divide-y divide-orange-200">
              {announcements.map(ann => (
                <div
                  key={ann.id}
                  className={`px-3 py-2 text-xs flex items-center gap-2 ${
                    ann.type === 'call_to_marshall'
                      ? 'bg-orange-50 text-orange-800'
                      : 'bg-pink-50 text-pink-800'
                  }`}
                >
                  <span>{ann.type === 'call_to_marshall' ? '📢' : '✂️'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {ann.type === 'call_to_marshall'
                        ? (lang === 'fr' ? 'Appel au maréchal' : 'Call to Marshall')
                        : (lang === 'fr' ? 'Appel aux scratches' : 'Call to Scratch')}
                    </p>
                    <p className="truncate opacity-80">
                      {lang === 'fr' ? 'Épr.' : 'Ev.'} {ann.event_number} — {ann.event_name}
                    </p>
                  </div>
                  <button
                    onClick={() => setAnnouncements(prev => prev.filter(a => a.id !== ann.id))}
                    className="opacity-50 hover:opacity-100"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          {events.map(ev => (
            <button
              key={ev.event_id}
              onClick={() => handleSelectEvent(ev.event_id)}
              className={`w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors ${
                selectedEvent === ev.event_id ? 'bg-blue-50 border-l-2 border-blue-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">{ev.event_number}.</span>
                <span className="text-sm font-medium flex-1 truncate">{ev.event_name}</span>
                <GenderBadge gender={ev.gender} />
              </div>
              <div className="flex items-center gap-2 mt-1 ml-8">
                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: ev.total_heats > 0 ? `${(ev.completed_heats / ev.total_heats) * 100}%` : '0%' }}
                  />
                </div>
                <span className="text-xs text-gray-500">
                  {ev.completed_heats}/{ev.total_heats}
                </span>
                {ev.official_heats === ev.total_heats && ev.total_heats > 0 && (
                  <span className="text-xs text-green-600 font-medium">✓</span>
                )}
              </div>
            </button>
          ))}
          {events.length === 0 && (
            <p className="p-4 text-sm text-gray-500 text-center">
              {lang === 'fr' ? 'En attente des épreuves…' : 'Waiting for events…'}
            </p>
          )}
        </div>
      </div>

      {/* Results panel */}
      <div className="flex-1 overflow-y-auto p-4">
        {!selectedEvent && (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {lang === 'fr' ? 'Sélectionnez une épreuve' : 'Select an event'}
          </div>
        )}

        {selectedEvent && loadingResults && (
          <div className="flex items-center justify-center h-32">
            <span className="text-sm text-gray-500">…</span>
          </div>
        )}

        {selectedEvent && results && (
          <div>
            {Object.entries(results.heats || {})
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([heatNum, entries]) => (
                <div key={heatNum} className="mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-medium text-gray-700">
                      {lang === 'fr' ? 'Série' : 'Heat'} {heatNum}
                    </h3>
                    {entries[0]?.is_official && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                        {lang === 'fr' ? 'Officiel' : 'Official'}
                      </span>
                    )}
                  </div>
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b">
                        <th className="text-left py-1 w-8">#</th>
                        <th className="text-left py-1 w-8">{lang === 'fr' ? 'Coul.' : 'Ln'}</th>
                        <th className="text-left py-1">{lang === 'fr' ? 'Athlète' : 'Athlete'}</th>
                        <th className="text-left py-1">{lang === 'fr' ? 'Club' : 'Club'}</th>
                        <th className="text-right py-1">{lang === 'fr' ? 'Temps' : 'Time'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry, idx) => (
                        <tr
                          key={`${heatNum}-${entry.lane}`}
                          className={`border-b border-gray-100 ${
                            entry.is_official ? '' : 'italic text-gray-500'
                          }`}
                        >
                          <td className="py-1 text-xs text-gray-400">{idx + 1}</td>
                          <td className="py-1 text-xs">{entry.lane}</td>
                          <td className="py-1 font-medium">{entry.athlete_name}</td>
                          <td className="py-1 text-gray-600">{entry.club_name}</td>
                          <td className="py-1 text-right font-mono">
                            {entry.status
                              ? <span className="text-red-600" title={entry.dsq_reason || ''}>{entry.status}{entry.dsq_reason ? ' ⓘ' : ''}</span>
                              : formatTime(entry.swimtime_ms)
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

            {Object.keys(results.heats || {}).length === 0 && (
              <StartListView eventId={selectedEvent} lang={lang} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Start List View (shown when no results yet) ──────────────────────────────

function StartListView({ eventId, lang }) {
  const [startlist, setStartlist] = useState(null)

  useEffect(() => {
    fetch(`/api/live/startlist/${eventId}`)
      .then(r => r.json())
      .then(setStartlist)
      .catch(() => setStartlist(null))
  }, [eventId])

  if (!startlist || Object.keys(startlist.heats || {}).length === 0) {
    return (
      <p className="text-sm text-gray-500 text-center mt-8">
        {lang === 'fr' ? 'En attente des séries…' : 'Waiting for heats…'}
      </p>
    )
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        {lang === 'fr' ? 'Liste de départ' : 'Start List'}
      </p>
      {Object.entries(startlist.heats)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([heatNum, entries]) => (
          <div key={heatNum} className="mb-4">
            <h3 className="text-sm font-medium text-gray-700 mb-1">
              {lang === 'fr' ? 'Série' : 'Heat'} {heatNum}
            </h3>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-xs text-gray-500 border-b">
                  <th className="text-left py-1 w-8">{lang === 'fr' ? 'Coul.' : 'Ln'}</th>
                  <th className="text-left py-1">{lang === 'fr' ? 'Athlète' : 'Athlete'}</th>
                  <th className="text-left py-1">{lang === 'fr' ? 'Club' : 'Club'}</th>
                  <th className="text-right py-1">{lang === 'fr' ? 'Inscr.' : 'Entry'}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={`${heatNum}-${entry.lane}`} className="border-b border-gray-100">
                    <td className="py-1 text-xs">{entry.lane}</td>
                    <td className="py-1 font-medium">{entry.athlete_name}</td>
                    <td className="py-1 text-gray-600">{entry.club_name}</td>
                    <td className="py-1 text-right font-mono text-gray-500">
                      {formatTime(entry.entry_time_ms) || 'NT'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  )
}

// ── Historical View ───────────────────────────────────────────────────────────

function HistoricalView() {
  const { lang } = useLang()
  const [meets, setMeets] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/results/meets')
      .then(r => { if (r.ok) return r.json(); throw new Error('Not found') })
      .then(setMeets)
      .catch(() => setMeets([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-center text-sm text-gray-500">…</div>

  if (meets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <p className="text-gray-500 text-sm">
          {lang === 'fr'
            ? 'Aucune compétition en cours ou archivée.'
            : 'No active or archived competitions.'}
        </p>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-lg font-medium mb-4">
        {lang === 'fr' ? 'Compétitions passées' : 'Past Competitions'}
      </h2>
      <div className="space-y-2">
        {meets.map(meet => (
          <div key={meet.id} className="bg-white rounded-lg border p-3">
            <p className="font-medium">{meet.name}</p>
            {meet.place && <p className="text-xs text-gray-500">{meet.place}</p>}
            {meet.date && <p className="text-xs text-gray-400">{meet.date}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Results Page ─────────────────────────────────────────────────────────

export default function ResultsPage() {
  const { t, lang, toggle } = useLang()
  const [liveStatus, setLiveStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/live/status')
      .then(r => r.json())
      .then(setLiveStatus)
      .catch(() => setLiveStatus({ active: false }))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-gray-500">…</p></div>
  }

  const isLive = liveStatus?.active

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold">
            {lang === 'fr' ? 'Résultats' : 'Results'}
          </h1>
          {isLive && (
            <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {lang === 'fr' ? 'En direct' : 'Live'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
          <Link to="/" className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300">
            {lang === 'fr' ? 'Retour' : 'Back'}
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isLive ? <LiveView status={liveStatus} /> : <HistoricalView />}
      </div>
    </div>
  )
}
