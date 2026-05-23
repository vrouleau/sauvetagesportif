import { useState, useEffect, useCallback, useRef } from 'react'
import { useLang } from '@shared/context/LangContext'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbApi = () => (window as any).api?.db

interface FinalEvent {
  eventId: number
  eventNumber: number
  eventName: string
  gender: 'M' | 'F' | 'X'
  sessionId: number
  sessionNumber: number
  sessionName: string
  prelimEventId: number
  laneCount: number
  heatCount: number
  finalOrder: number
  qualByPlace: number | null
  counts: Record<string, number>
}

interface FinalCandidate {
  swimresultId: number
  athleteId: number
  lastName: string
  firstName: string
  clubCode: string
  ageGroupName: string
  prelimTime: string | null
  prelimTimeMs: number | null
  prelimRank: number
  resultStatus: 'DNS' | 'DNF' | 'DSQ' | null
  qualCode: string | null
  noAdvance: boolean
  finalFix: boolean
}

const HEAT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function getQualLabel(code: string, lang: string): string {
  if (code === 'R') return lang === 'en' ? 'Reserve' : 'Réserve'
  if (code === 'W') return lang === 'en' ? 'Withdrawn' : 'Retiré'
  if (code.length === 1 && code >= 'A' && code <= 'Z') return `Final ${code}`
  return code
}

export default function FinalsPage({ refreshKey = 0, meetType = 'POOL' }: { refreshKey?: number; meetType?: string }) {
  const { lang } = useLang()
  const isBeach = meetType === 'BEACH'

  const [events, setEvents] = useState<FinalEvent[]>([])
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<FinalCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set())
  const [panelWidth, setPanelWidth] = useState(360)
  const dragging = useRef(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Load final events
  const loadEvents = useCallback(async () => {
    const api = dbApi()
    if (!api) return
    const evts = await api.getFinalEvents()
    setEvents(evts)
    // Auto-expand all sessions on first load
    setExpandedSessions(prev => {
      if (prev.size === 0) {
        return new Set(evts.map((e: FinalEvent) => e.sessionId))
      }
      return prev
    })
    setLoading(false)
  }, [])

  useEffect(() => { loadEvents() }, [loadEvents, refreshKey])

  // ── Resizable divider ────────────────────────────────────────────────────────

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return
      const newWidth = Math.max(200, Math.min(600, e.clientX))
      setPanelWidth(newWidth)
    }
    function onMouseUp() {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  function startDrag() {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function showStatus(msg: string) {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 4000)
  }

  // Load candidates when event is selected
  useEffect(() => {
    if (!selectedEventId) { setCandidates([]); return }
    const api = dbApi()
    if (!api) return
    api.getFinalCandidates(selectedEventId).then((c: FinalCandidate[]) => setCandidates(c))
  }, [selectedEventId, refreshKey])

  const selectedEvent = events.find(e => e.eventId === selectedEventId)

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleQualChange(athleteId: number, value: string) {
    if (!selectedEventId) return
    const api = dbApi()
    if (!api) return

    const qualCode: string | null = value === 'W' ? null : (value || null)
    const noAdvance = value === 'W'

    await api.setQualification(selectedEventId, athleteId, qualCode, noAdvance)

    // Refresh both candidates and event counts
    const [updatedCandidates, updatedEvents] = await Promise.all([
      api.getFinalCandidates(selectedEventId),
      api.getFinalEvents(),
    ])
    setCandidates(updatedCandidates)
    setEvents(updatedEvents)
  }

  async function handleAutoQualify() {
    if (!selectedEventId) return
    const api = dbApi()
    if (!api) return
    const result = await api.autoQualify(selectedEventId)
    const counts = (result.counts ?? {}) as Record<string, number>
    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    showStatus(lang === 'en' ? `Qualified ${total} athlete(s)` : `${total} athlète(s) qualifié(s)`)
    const [updatedCandidates, updatedEvents] = await Promise.all([
      api.getFinalCandidates(selectedEventId),
      api.getFinalEvents(),
    ])
    setCandidates(updatedCandidates)
    setEvents(updatedEvents)
  }

  async function handleClearSeeding() {
    if (!selectedEventId) return
    const api = dbApi()
    if (!api) return
    await api.clearFinalSeeding(selectedEventId)
    showStatus(lang === 'en' ? 'Seeding cleared' : 'Séries effacées')
    const updatedEvents = await api.getFinalEvents()
    setEvents(updatedEvents)
  }

  async function handleSeedFinals() {
    if (!selectedEventId) return
    const api = dbApi()
    if (!api) return
    const result = await api.seedFinals(selectedEventId)
    if (result.overflow > 0) {
      showStatus(
        lang === 'en'
          ? `⚠ ${result.heatsCreated} heat(s), ${result.assigned} assigned, ${result.overflow} overflow!`
          : `⚠ ${result.heatsCreated} série(s), ${result.assigned} assigné(s), ${result.overflow} en surplus!`
      )
    } else {
      showStatus(
        lang === 'en'
          ? `✓ ${result.heatsCreated} heat(s) created, ${result.assigned} athlete(s) assigned`
          : `✓ ${result.heatsCreated} série(s) créée(s), ${result.assigned} athlète(s) assigné(s)`
      )
    }
    const updatedEvents = await api.getFinalEvents()
    setEvents(updatedEvents)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="p-4 text-gray-500 text-xs italic">Chargement…</div>
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {lang === 'en' ? 'No final events found. Create events with round = Final.' : 'Aucune épreuve finale trouvée. Créez des épreuves avec phase = Finale.'}
      </div>
    )
  }

  const genderLabel = (g: string) =>
    lang === 'en'
      ? (g === 'M' ? 'Men' : g === 'F' ? 'Women' : 'Mixed')
      : (g === 'M' ? 'H' : g === 'F' ? 'F' : 'X')

  // Group events by session
  const sessionGroups = events.reduce<Map<number, { sessionNumber: number; sessionName: string; events: FinalEvent[] }>>((map, ev) => {
    if (!map.has(ev.sessionId)) {
      map.set(ev.sessionId, { sessionNumber: ev.sessionNumber, sessionName: ev.sessionName, events: [] })
    }
    map.get(ev.sessionId)!.events.push(ev)
    return map
  }, new Map())

  return (
    <div className="flex h-full">
      {/* Left panel: cascade tree */}
      <div style={{ width: panelWidth }} className="border-r border-gray-300 bg-gray-50 overflow-y-auto shrink-0 text-xs select-none">
        {[...sessionGroups.entries()].map(([sessionId, group]) => {
          const isExpanded = expandedSessions.has(sessionId)
          return (
            <div key={sessionId}>
              {/* Session node */}
              <div
                className="flex items-center h-6 px-2 cursor-pointer bg-gray-100 border-b border-gray-200 hover:bg-gray-200 font-semibold text-gray-700"
                onClick={() => setExpandedSessions(prev => {
                  const next = new Set(prev)
                  if (next.has(sessionId)) next.delete(sessionId)
                  else next.add(sessionId)
                  return next
                })}
              >
                <span className="w-4 text-center text-gray-400 mr-1">
                  {isExpanded ? '▼' : '▶'}
                </span>
                <span className="truncate">
                  S{group.sessionNumber} — {group.sessionName}
                </span>
              </div>

              {/* Event children */}
              {isExpanded && group.events.map(ev => {
                const isSelected = ev.eventId === selectedEventId
                const totalQualified = Object.values(ev.counts).reduce((s, n) => s + n, 0)
                const summary = totalQualified > 0
                  ? Object.entries(ev.counts)
                      .filter(([, n]) => n > 0)
                      .map(([code, n]) => `${n}${code}`)
                      .join('+')
                  : ''
                const hasOverflow = Object.entries(ev.counts).some(
                  ([code, n]) => code !== 'R' && code !== 'W' && n > ev.laneCount
                )

                return (
                  <div
                    key={ev.eventId}
                    onClick={() => setSelectedEventId(ev.eventId)}
                    className={`flex items-center h-6 pl-7 pr-2 cursor-pointer border-b border-gray-100 transition-colors ${
                      isSelected ? 'bg-blue-100 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="truncate flex-1">
                      {ev.eventNumber}. {ev.eventName} {genderLabel(ev.gender)}
                    </span>
                    {summary && (
                      <span className={`ml-1 font-mono shrink-0 ${hasOverflow ? 'text-red-600 font-bold' : 'text-green-700'}`}>
                        {summary}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Resizable divider */}
      <div
        onMouseDown={startDrag}
        className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
      />

      {/* Right panel: candidates table */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
          <button
            onClick={handleAutoQualify}
            disabled={!selectedEventId}
            className="px-3 py-1 text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed border border-blue-700"
          >
            {lang === 'en' ? 'Auto-qualify' : 'Auto-qualifier'}
          </button>
          <button
            onClick={handleClearSeeding}
            disabled={!selectedEventId}
            className="px-3 py-1 text-xs bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-400"
          >
            {lang === 'en' ? 'Clear Seeding' : 'Effacer séries'}
          </button>
          <button
            onClick={handleSeedFinals}
            disabled={!selectedEventId}
            className="px-3 py-1 text-xs bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed border border-green-700"
          >
            {lang === 'en' ? 'Seed Finals' : 'Générer séries finales'}
          </button>
          {selectedEvent && (
            <span className="ml-auto text-xs text-gray-500">
              {!isBeach && <>{selectedEvent.laneCount} {lang === 'en' ? 'lanes' : 'couloirs'}{' · '}</>}
              {selectedEvent.heatCount} {lang === 'en' ? 'heat(s)' : 'série(s)'}
              {' · '}
              {selectedEvent.finalOrder === 2
                ? (lang === 'en' ? 'Slow first (A last)' : 'Lent en premier (A dernier)')
                : (lang === 'en' ? 'Fast first (A first)' : 'Rapide en premier (A premier)')}
            </span>
          )}
          {statusMsg && (
            <span className={`ml-2 text-xs font-medium px-2 py-0.5 rounded ${
              statusMsg.startsWith('⚠') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
            }`}>
              {statusMsg}
            </span>
          )}
        </div>

        {/* Table */}
        {!selectedEventId ? (
          <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
            {lang === 'en' ? 'Select an event' : 'Sélectionnez une épreuve'}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-100 border-b-2 border-gray-300">
                <tr>
                  <th className="px-2 py-1 text-left w-8">#</th>
                  <th className="px-2 py-1 text-left">{lang === 'en' ? 'Athlete' : 'Athlète'}</th>
                  <th className="px-2 py-1 text-left w-16">{lang === 'en' ? 'Club' : 'Club'}</th>
                  <th className="px-2 py-1 text-left w-16">{lang === 'en' ? 'Cat.' : 'Cat.'}</th>
                  <th className="px-2 py-1 text-right w-20">{isBeach ? 'Pos.' : (lang === 'en' ? 'Prelim' : 'Élim.')}</th>
                  <th className="px-2 py-1 text-center w-12">{lang === 'en' ? 'Status' : 'Statut'}</th>
                  <th className="px-2 py-1 text-center w-28">{lang === 'en' ? 'Qualify' : 'Qualif.'}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const isDisabled = !!c.resultStatus
                  const currentVal = c.noAdvance ? 'W' : (c.qualCode ?? '')
                  const showSeparator = selectedEvent &&
                    !isDisabled && c.prelimRank > 0 &&
                    c.prelimRank % selectedEvent.laneCount === 0 &&
                    c.prelimRank <= selectedEvent.laneCount * selectedEvent.heatCount

                  return (
                    <tr
                      key={c.swimresultId}
                      className={`border-b border-gray-100 ${isDisabled ? 'opacity-40' : 'hover:bg-blue-50'} ${
                        showSeparator ? 'border-b-2 border-b-orange-300' : ''
                      }`}
                    >
                      <td className="px-2 py-1 text-gray-500 font-mono">
                        {c.prelimRank > 0 ? c.prelimRank : ''}
                      </td>
                      <td className="px-2 py-1 font-medium">
                        {c.lastName}, {c.firstName}
                      </td>
                      <td className="px-2 py-1 text-gray-600">{c.clubCode}</td>
                      <td className="px-2 py-1 text-gray-500">{c.ageGroupName}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {isBeach ? (c.prelimRank > 0 ? c.prelimRank : '—') : (c.prelimTime ?? 'NT')}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {c.resultStatus && (
                          <span className={`px-1 py-0.5 text-[10px] font-bold rounded ${
                            c.resultStatus === 'DSQ' ? 'bg-red-100 text-red-700' :
                            c.resultStatus === 'DNS' ? 'bg-gray-200 text-gray-600' :
                            'bg-orange-100 text-orange-700'
                          }`}>
                            {c.resultStatus}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-center">
                        <select
                          value={currentVal}
                          disabled={isDisabled}
                          onChange={(e) => handleQualChange(c.athleteId, e.target.value)}
                          className={`text-xs border border-gray-300 rounded px-1 py-0.5 w-full ${
                            isDisabled ? 'bg-gray-100 cursor-not-allowed' :
                            currentVal === 'R' ? 'bg-yellow-50 border-yellow-400' :
                            currentVal === 'W' ? 'bg-red-50 border-red-400' :
                            currentVal && currentVal >= 'A' && currentVal <= 'Z' ? 'bg-green-50 border-green-400' : ''
                          }`}
                        >
                          <option value="">—</option>
                          {selectedEvent && Array.from({ length: selectedEvent.heatCount }, (_, i) => {
                            const letter = HEAT_LETTERS[i]
                            return <option key={letter} value={letter}>{getQualLabel(letter, lang)}</option>
                          })}
                          <option value="R">{getQualLabel('R', lang)}</option>
                          <option value="W">{getQualLabel('W', lang)}</option>
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
