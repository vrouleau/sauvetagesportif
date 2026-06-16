import React, { useState, useRef, useEffect, useCallback } from 'react'
import { type HeatListEvent, type HeatListSession, type Heat, type LaneEntry } from '../data/mockData'
import { useLang } from '@shared/context/LangContext'

interface HeatState {
  [heatId: number]: LaneEntry[]
}

interface QuantumResultEntry {
  lane: number
  swimtime: string
  reactiontime: number
  status: string
  splits: Array<{ distance: number; swimtime: string }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const quantumApi = () => (window as any).api?.quantum
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbApi = () => (window as any).api?.db

// ── DSQ Searchable Dropdown ───────────────────────────────────────────────────

function DsqSearchDropdown({ items, value, onChange, disabled, eventType }: {
  items: Array<{ dsqitemid: number; code: string; name: string; options?: string }>
  value: number | null
  onChange: (id: number | null) => void
  disabled: boolean
  eventType?: 'INDIVIDUAL' | 'RELAY'
}) {
  if (disabled || !items || items.length === 0) {
    return <select className="flex-1 border border-gray-300 px-1 py-0.5 bg-gray-100 text-xs rounded h-6" disabled />
  }

  // Filter items by event type (INDIVIDUAL or RELAY) based on the options field
  const filteredItems = eventType
    ? items.filter(d => !d.options || d.options.includes(eventType))
    : items

  return (
    <select
      className="flex-1 border border-gray-300 px-1 py-0.5 bg-white text-xs rounded h-6"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">— Sélectionner un code DQ —</option>
      {filteredItems.map(d => (
        <option key={d.dsqitemid} value={d.dsqitemid}>
          {d.code} — {d.name.length > 80 ? d.name.slice(0, 80) + '…' : d.name}
        </option>
      ))}
    </select>
  )
}

// ── HeatsPage ─────────────────────────────────────────────────────────────────

export default function HeatsPage({ refreshKey = 0, meetType = 'POOL' }: { refreshKey?: number; meetType?: string }) {
  const { t, lang } = useLang()
  const isBeach = meetType === 'BEACH'

  const [sessions, setSessions] = useState<HeatListSession[]>([])
  const [heatData, setHeatData] = useState<HeatState>({})
  const [loading, setLoading] = useState(true)

  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set())
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set())
  const [selectedHeatId, setSelectedHeatId] = useState<number | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const [editingLane, setEditingLane] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [selectedLane, setSelectedLane] = useState<number | null>(null)
  const [dsqCode, setDsqCode] = useState('')
  const [dsqReason, setDsqReason] = useState('')
  const [dsqItems, setDsqItems] = useState<Array<{ dsqitemid: number; code: string; name: string; options?: string }>>([])
  const [dsqOverrideId, setDsqOverrideId] = useState<number | null>(null)
  const [dsqOverrideLane, setDsqOverrideLane] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Quantum state
  const [quantumFolder, setQuantumFolder] = useState('C:\\quantum')
  const [quantumConnected, setQuantumConnected] = useState(false)
  const [quantumVersion, setQuantumVersion] = useState('')
  const [generating, setGenerating] = useState(false)
  const selectedHeatIdRef = useRef(selectedHeatId)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; lane: number; entry: LaneEntry | null } | null>(null)

  // Late entry dialog state
  const [lateEntryDialog, setLateEntryDialog] = useState<{ lane: number } | null>(null)
  const [lateSearchQuery, setLateSearchQuery] = useState('')
  const [athletes, setAthletes] = useState<Array<{ id: number; lastName: string; firstName: string; clubCode: string; clubName: string; nation: string; entryTime: string | undefined }>>([])

  // Drag state
  const [dragSource, setDragSource] = useState<{ heatId: number; lane: number; entry: LaneEntry } | null>(null)
  const [dragOverLane, setDragOverLane] = useState<number | null>(null)
  const dragHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Derived flat list of all events (for Quantum schedule)
  const heatListEvents: HeatListEvent[] = sessions.flatMap(s => s.events)

  // ── Load data from DB ──────────────────────────────────────────────────────

  useEffect(() => {
    setLoading(true)
    const api = dbApi()
    if (!api) { setLoading(false); return }
    api.getHeatListSessions().then((sess: HeatListSession[]) => {
      setSessions(sess)
      const state: HeatState = {}
      sess.forEach((s) => s.events.forEach((ev) => ev.heats.forEach((h) => { state[h.id] = h.entries.map((e) => ({ ...e })) })))
      setHeatData(state)
      // Start with all sessions collapsed by default
      setExpandedSessions(new Set())
      setLoading(false)
    }).catch(() => setLoading(false))
    // Load DSQ catalog
    api.getDsqItems?.().then((items: any[]) => setDsqItems(items || [])).catch(() => {})
  }, [refreshKey])

  // ── Refs sync ──────────────────────────────────────────────────────────────

  useEffect(() => { if (editingLane !== null && inputRef.current) { inputRef.current.focus(); inputRef.current.select() } }, [editingLane])
  useEffect(() => { selectedHeatIdRef.current = selectedHeatId }, [selectedHeatId])

  // ── Quantum events ─────────────────────────────────────────────────────────

  const persistResult = useCallback((heatId: number, lane: number, entry: LaneEntry) => {
    if (!entry.swimresultId) return
    const api = dbApi()
    if (!api) return
    api.saveResult(
      entry.swimresultId,
      entry.finalTime,
      null,
      entry.status ?? null,
      entry.splitTimes,
    ).catch(console.error)
  }, [])

  useEffect(() => {
    const api = quantumApi()
    if (!api) return

    api.onConnected((version: string) => {
      setQuantumConnected(true)
      setQuantumVersion(version.replace('VERSION;', ''))
    })

    api.onResult((result: { heatId: number; results: QuantumResultEntry[] }) => {
      const hid = result.heatId || selectedHeatIdRef.current
      if (!hid) return
      setHeatData((prev) => {
        const lanes = (prev[hid] ?? []).map((e) => {
          const r = result.results.find((x) => x.lane === e.lane)
          if (!r) return e
          const splitTimes: Record<number, string> = {}
          r.splits.forEach((s) => { splitTimes[s.distance] = s.swimtime })
          const updated: LaneEntry = {
            ...e,
            finalTime: r.swimtime || undefined,
            status: (r.status || null) as LaneEntry['status'],
            splitTimes,
          }
          // Save to DB immediately
          if (e.swimresultId) {
            dbApi()?.saveResult(
              e.swimresultId,
              updated.finalTime,
              r.reactiontime,
              updated.status ?? null,
              updated.splitTimes,
            ).catch(console.error)
          }
          return updated
        })
        return { ...prev, [hid]: lanes }
      })
    })

    return () => {
      api.removeAllListeners('quantum:connected')
      api.removeAllListeners('quantum:result')
      api.removeAllListeners('quantum:heat-status')
    }
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────────

  const allHeats: { event: HeatListEvent; heat: Heat; session: HeatListSession }[] = []
  sessions.forEach((s) => s.events.forEach((ev) => ev.heats.forEach((h) => allHeats.push({ event: ev, heat: h, session: s }))))
  const selectedPair = allHeats.find((p) => p.heat.id === selectedHeatId)
  const selectedEvent = selectedPair?.event
  const selectedSession = selectedPair?.session
  const entries = selectedHeatId !== null ? (heatData[selectedHeatId] ?? []) : []

  // Build full lane list (laneMin to laneMax) with entries or empty slots
  const laneMin = selectedSession?.laneMin ?? 1
  const laneMax = selectedSession?.laneMax ?? 8
  const allLanes: Array<{ lane: number; entry: LaneEntry | null }> = []
  for (let l = laneMin; l <= laneMax; l++) {
    const entry = entries.find((e) => e.lane === l) ?? null
    allLanes.push({ lane: l, entry })
  }

  const ranked = [...entries]
    .filter((e) => e.finalTime && e.status !== 'DNS' && e.status !== 'DNF' && e.status !== 'DSQ')
    .sort((a, b) => parseTimeSecs(a.finalTime!) - parseTimeSecs(b.finalTime!))
  const rankOf = (lane: number) => {
    const idx = ranked.findIndex((e) => e.lane === lane)
    return idx >= 0 ? idx + 1 : null
  }

  function parseTimeSecs(t: string): number {
    if (!t) return Infinity
    const parts = t.split(':')
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
    if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
    return parseFloat(parts[0])
  }

  function formatTimeDisplay(time: string | undefined, status?: string | null): string {
    if (status === 'DNS') return 'DNS'
    if (status === 'DNF') return 'DNF'
    if (status === 'DSQ') return 'DSQ'
    if (!time) return ''
    return time
  }

  // ── Time parsing helpers ───────────────────────────────────────────────────
  // Accepts:
  //   "1:32.45" → as-is
  //   "45.00" → as-is
  //   "4500" → "45.00"
  //   "13245" → "1:32.45"
  //   "1:32.06 1:31.82" or "1:32.06,1:31.82" → average → "1:31.94"

  function parseSingleTime(raw: string): string | null {
    const s = raw.trim()
    if (!s) return null

    // Normalize: treat "1:42:98" as "1:42.98" (user may use : instead of . for centiseconds)
    let normalized = s
    const colonCount = (s.match(/:/g) || []).length
    if (colonCount === 2) {
      // Replace last colon with dot: "1:42:98" → "1:42.98"
      const lastColon = s.lastIndexOf(':')
      normalized = s.substring(0, lastColon) + '.' + s.substring(lastColon + 1)
    }

    // Already formatted: contains ":" or "."
    if (normalized.includes(':') || normalized.includes('.')) {
      // Validate and normalize format
      const m1 = normalized.match(/^(\d{1,2}):(\d{1,2})\.(\d{1,2})$/) // M:SS.cc
      if (m1) {
        const [, min, sec, cs] = m1
        return `${parseInt(min)}:${sec.padStart(2, '0')}.${cs.padEnd(2, '0').slice(0, 2)}`
      }
      const m2 = normalized.match(/^(\d{1,2}):(\d{1,2})$/) // M:SS
      if (m2) {
        const [, min, sec] = m2
        return `${parseInt(min)}:${sec.padStart(2, '0')}.00`
      }
      const m3 = normalized.match(/^(\d{1,3})\.(\d{1,2})$/) // SS.cc
      if (m3) {
        const [, sec, cs] = m3
        const s2 = parseInt(sec)
        const min = Math.floor(s2 / 60)
        const rem = s2 % 60
        if (min > 0) return `${min}:${String(rem).padStart(2, '0')}.${cs.padEnd(2, '0').slice(0, 2)}`
        return `${rem}.${cs.padEnd(2, '0').slice(0, 2)}`
      }
      // Fallback: return as-is if it looks reasonable
      return normalized
    }

    // Pure integer: interpret based on magnitude
    // < 100: treat as whole seconds (e.g. "35" → 35.00)
    // >= 100: interpret digit positions as [M...]SS CC (e.g. "135" → 1.35, "14567" → 1:45.67)
    const n = parseInt(s, 10)
    if (isNaN(n) || n <= 0) return null

    if (n < 100) {
      // Whole seconds
      const min = Math.floor(n / 60)
      const sec = n % 60
      if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.00`
      return `${sec}.00`
    }

    const cs = n % 100
    const rest = Math.floor(n / 100)
    const sec = rest % 100
    const min = Math.floor(rest / 100)

    if (sec >= 60) {
      // If seconds >= 60, reinterpret: carry into minutes
      const totalSec = min * 100 + sec  // treat as raw seconds
      const realMin = Math.floor(totalSec / 60)
      const realSec = totalSec % 60
      return `${realMin}:${String(realSec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
    }

    if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
    return `${sec}.${String(cs).padStart(2, '0')}`
  }

  function timeToCs(t: string): number {
    // Convert "M:SS.cc" or "SS.cc" to centiseconds
    const parts = t.split(':')
    let secs: number
    if (parts.length === 2) {
      const [minStr, rest] = parts
      secs = parseInt(minStr, 10) * 60 + parseFloat(rest)
    } else {
      secs = parseFloat(parts[0])
    }
    return Math.round(secs * 100)
  }

  function csToTime(cs: number): string {
    const totalCs = Math.round(cs)
    const centis = totalCs % 100
    const totalSec = Math.floor(totalCs / 100)
    const sec = totalSec % 60
    const min = Math.floor(totalSec / 60)
    if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
    return `${sec}.${String(centis).padStart(2, '0')}`
  }

  function parseTimeInput(raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed) return null

    // Beach mode: validate as integer position (1, 2, 3, ...)
    if (isBeach) {
      const n = parseInt(trimmed, 10)
      if (isNaN(n) || n < 1 || String(n) !== trimmed) return null
      return String(n)
    }

    // Split by spaces or commas to detect multiple times
    const parts = trimmed.split(/[\s,]+/).filter(Boolean)

    if (parts.length === 1) {
      return parseSingleTime(parts[0])
    }

    // Multiple times: parse each, average them
    const parsed: string[] = []
    for (const p of parts) {
      const t = parseSingleTime(p)
      if (t) parsed.push(t)
    }
    if (parsed.length === 0) return null
    if (parsed.length === 1) return parsed[0]

    // Average in centiseconds
    const totalCs = parsed.reduce((sum, t) => sum + timeToCs(t), 0)
    const avgCs = totalCs / parsed.length
    return csToTime(avgCs)
  }

  // ── Edit handlers ──────────────────────────────────────────────────────────

  function startEdit(lane: number) {
    if (isSelectedHeatValidated) return
    const entry = entries.find((e) => e.lane === lane)
    if (!entry) return
    setSelectedLane(lane)
    setEditingLane(lane)

    if (isBeach) {
      // Pre-fill with next available position if cell is empty
      if (!entry.finalTime) {
        const usedPositions = entries
          .filter(e => e.finalTime && !e.status)
          .map(e => parseInt(e.finalTime!, 10))
          .filter(n => !isNaN(n))
        const nextPos = usedPositions.length > 0 ? Math.max(...usedPositions) + 1 : 1
        setEditValue(String(nextPos))
      } else {
        setEditValue(entry.finalTime)
      }
    } else {
      setEditValue(entry.finalTime ?? '')
    }
  }

  function saveEdit(lane: number) {
    const parsed = parseTimeInput(editValue)

    // Beach validation: swap on duplicate, no gaps in final sequence
    if (isBeach && parsed) {
      const pos = parseInt(parsed, 10)
      const currentEntry = entries.find(e => e.lane === lane)
      const hadPosition = currentEntry?.finalTime && !currentEntry?.status
      const otherEntries = entries.filter(e => e.lane !== lane && e.finalTime && !e.status)
      const otherPositions = otherEntries.map(e => ({ lane: e.lane, pos: parseInt(e.finalTime!, 10) })).filter(p => !isNaN(p.pos))

      // Max allowed = number of athletes that will have a position after this edit
      const totalWithPosition = otherPositions.length + 1 // others + this one
      if (pos > totalWithPosition) {
        setEditingLane(null)
        return
      }

      // Duplicate? Swap positions
      const conflict = otherPositions.find(p => p.pos === pos)
      if (conflict) {
        const currentEntry = entries.find(e => e.lane === lane)
        const currentPos = currentEntry?.finalTime ?? null
        // Swap: give the conflicting athlete our old position (or clear if we had none)
        setHeatData((prev) => {
          if (selectedHeatId === null) return prev
          const updated = (prev[selectedHeatId] ?? []).map((e) => {
            if (e.lane === lane) {
              const next: LaneEntry = { ...e, finalTime: parsed || undefined, status: null }
              if (next.swimresultId) {
                dbApi()?.saveResult(next.swimresultId, next.finalTime, null, null, next.splitTimes).catch(console.error)
              }
              return next
            }
            if (e.lane === conflict.lane) {
              const next: LaneEntry = { ...e, finalTime: currentPos || undefined, status: null }
              if (next.swimresultId) {
                dbApi()?.saveResult(next.swimresultId, next.finalTime, null, null, next.splitTimes).catch(console.error)
              }
              return next
            }
            return e
          })
          return { ...prev, [selectedHeatId]: updated }
        })
        setEditingLane(null)
        return
      }
    }

    setHeatData((prev) => {
      if (selectedHeatId === null) return prev
      const updated = (prev[selectedHeatId] ?? []).map((e) => {
        if (e.lane !== lane) return e
        const next: LaneEntry = { ...e, finalTime: parsed || undefined, status: null }
        // Persist to DB
        if (next.swimresultId) {
          dbApi()?.saveResult(next.swimresultId, next.finalTime, null, null, next.splitTimes).catch(console.error)
        }
        return next
      })
      return { ...prev, [selectedHeatId]: updated }
    })
    setEditingLane(null)
  }

  function handleKeyDown(e: React.KeyboardEvent, lane: number, maxLane: number) {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      saveEdit(lane)
      const next = lane < maxLane ? lane + 1 : lane
      setSelectedLane(next)
      setEditingLane(next)
      const nextEntry = entries.find((en) => en.lane === next)
      setEditValue(nextEntry?.finalTime ?? '')
    }
    if (e.key === 'Escape') setEditingLane(null)
  }

  function setStatus(lane: number, status: 'DNS' | 'DNF' | 'DSQ' | null) {
    setHeatData((prev) => {
      if (selectedHeatId === null) return prev
      const updated = (prev[selectedHeatId] ?? []).map((e) => {
        if (e.lane !== lane) return e
        const next: LaneEntry = { ...e, status, finalTime: status ? undefined : e.finalTime }
        if (next.swimresultId) {
          const dsqId = status === 'DSQ' ? selectedDsqItemId : null
          dbApi()?.saveResult(next.swimresultId, next.finalTime, null, next.status ?? null, next.splitTimes, dsqId).catch(console.error)
        }
        return next
      })
      return { ...prev, [selectedHeatId]: updated }
    })
  }

  function toggleSession(id: number) {
    setExpandedSessions((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleEvent(id: number) {
    setExpandedEvents((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Context menu handlers ──────────────────────────────────────────────────

  function handleContextMenu(e: React.MouseEvent, lane: number, entry: LaneEntry | null) {
    if (isSelectedHeatValidated) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, lane, entry })
  }

  function closeContextMenu() {
    setContextMenu(null)
  }

  async function handleRemoveFromHeat() {
    if (!contextMenu?.entry?.swimresultId || selectedHeatId === null) return
    const api = dbApi()
    if (!api) return
    await api.removeFromHeat(contextMenu.entry.swimresultId)
    // Update local state: remove entry from this lane
    setHeatData((prev) => {
      const updated = (prev[selectedHeatId] ?? []).filter((e) => e.lane !== contextMenu.lane)
      return { ...prev, [selectedHeatId]: updated }
    })
    closeContextMenu()
  }

  function handleAddLateEntry() {
    if (!contextMenu || selectedHeatId === null || !selectedEvent) return
    setLateEntryDialog({ lane: contextMenu.lane })
    // Load athletes not already seeded in this event
    dbApi()?.getAvailableAthletesForEvent(selectedEvent.id).then((aths: typeof athletes) => setAthletes(aths ?? []))
    closeContextMenu()
  }

  async function confirmLateEntry(athleteId: number) {
    if (!lateEntryDialog || selectedHeatId === null || !selectedEvent) return
    const api = dbApi()
    if (!api) return
    const ath = athletes.find((a) => a.id === athleteId)
    const result = await api.addLateEntry(athleteId, selectedEvent.id, selectedHeatId, lateEntryDialog.lane, null)
    if (result?.ok && ath) {
      const newEntry: LaneEntry = {
        swimresultId: result.swimresultId,
        lane: lateEntryDialog.lane,
        athleteId: ath.id,
        lastName: ath.lastName,
        firstName: ath.firstName,
        birthYear: 2000,
        nation: ath.nation ?? '',
        clubCode: ath.clubCode ?? '',
        clubName: ath.clubName ?? '',
        category: '',
        entryTime: ath.entryTime ?? 'NT',
      }
      setHeatData((prev) => ({
        ...prev,
        [selectedHeatId!]: [...(prev[selectedHeatId!] ?? []), newEntry],
      }))
    }
    setLateEntryDialog(null)
    setLateSearchQuery('')
  }

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, heatId: number, lane: number, entry: LaneEntry) {
    if (isSelectedHeatValidated) return
    setDragSource({ heatId, lane, entry })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `${heatId}:${lane}`)
  }

  function handleDragOver(e: React.DragEvent, lane: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverLane(lane)
  }

  function handleDragLeave() {
    setDragOverLane(null)
  }

  const dragHoverHeatRef = useRef<number | null>(null)

  function handleHeatRowDragOver(e: React.DragEvent, heatId: number) {
    if (!dragSource) return
    if (dragSource.heatId === heatId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Only start timer if this is a new heat we're hovering
    if (dragHoverHeatRef.current !== heatId) {
      dragHoverHeatRef.current = heatId
      if (dragHoverTimerRef.current) clearTimeout(dragHoverTimerRef.current)
      dragHoverTimerRef.current = setTimeout(() => {
        setSelectedHeatId(heatId)
        setSelectedEventId(null)
        setSelectedSessionId(null)
        setEditingLane(null)
      }, 500)
    }
  }

  function handleHeatRowDragLeave(e: React.DragEvent, heatId: number) {
    // Only cancel if we truly left the row (not entering a child element)
    const related = e.relatedTarget as HTMLElement | null
    const current = e.currentTarget as HTMLElement
    if (related && current.contains(related)) return
    if (dragHoverHeatRef.current === heatId) {
      dragHoverHeatRef.current = null
      if (dragHoverTimerRef.current) clearTimeout(dragHoverTimerRef.current)
    }
  }

  async function handleDrop(e: React.DragEvent, targetHeatId: number, targetLane: number, targetEntry: LaneEntry | null) {
    e.preventDefault()
    setDragOverLane(null)
    if (!dragSource) return
    const api = dbApi()
    if (!api) return

    const { heatId: srcHeatId, lane: srcLane, entry: srcEntry } = dragSource

    // Don't drop on self
    if (srcHeatId === targetHeatId && srcLane === targetLane) {
      setDragSource(null)
      return
    }

    if (targetEntry) {
      // Swap two entries
      await api.swapLanes(
        srcEntry.swimresultId, srcHeatId, srcLane,
        targetEntry.swimresultId, targetHeatId, targetLane
      )
      // Update local state
      setHeatData((prev) => {
        const next = { ...prev }
        // Update source heat
        next[srcHeatId] = (next[srcHeatId] ?? []).map((e) =>
          e.swimresultId === srcEntry.swimresultId ? { ...targetEntry, lane: srcLane } : e
        )
        // Update target heat
        if (srcHeatId === targetHeatId) {
          next[targetHeatId] = next[targetHeatId].map((e) =>
            e.swimresultId === targetEntry.swimresultId ? { ...srcEntry, lane: targetLane } : e
          )
        } else {
          next[targetHeatId] = (next[targetHeatId] ?? []).map((e) =>
            e.swimresultId === targetEntry.swimresultId ? { ...srcEntry, lane: targetLane } : e
          )
        }
        return next
      })
    } else {
      // Move to empty lane
      await api.assignToHeatLane(srcEntry.swimresultId, targetHeatId, targetLane)
      setHeatData((prev) => {
        const next = { ...prev }
        // Remove from source heat
        next[srcHeatId] = (next[srcHeatId] ?? []).filter((e) => e.swimresultId !== srcEntry.swimresultId)
        // Add to target heat
        next[targetHeatId] = [...(next[targetHeatId] ?? []), { ...srcEntry, lane: targetLane }]
        return next
      })
    }
    setDragSource(null)
  }

  function handleDragEnd() {
    setDragSource(null)
    setDragOverLane(null)
    dragHoverHeatRef.current = null
    if (dragHoverTimerRef.current) clearTimeout(dragHoverTimerRef.current)
  }

  // ── Generate heats handler ──────────────────────────────────────────────────

  const [generateMenuOpen, setGenerateMenuOpen] = useState(false)

  async function handleGenerateHeats(scope: 'all' | 'session' | 'event') {
    setGenerateMenuOpen(false)
    let confirmMsg = t.heats.generateHeatsConfirm
    let eventId: number | undefined
    let sessionId: number | undefined

    if (scope === 'event') {
      const evId = selectedEventId || selectedEvent?.id
      if (!evId) return
      eventId = evId
    } else if (scope === 'session') {
      const sessId = selectedSessionId || selectedSession?.id
      if (!sessId) return
      sessionId = sessId
    }

    if (!window.confirm(confirmMsg)) return
    setGenerating(true)
    try {
      const api = dbApi()
      if (!api) return
      const result = await api.generateHeats(eventId, sessionId)
      // Reload heat data
      const sess = await api.getHeatListSessions() as HeatListSession[]
      setSessions(sess)
      const state: HeatState = {}
      sess.forEach((s) => s.events.forEach((ev) => ev.heats.forEach((h) => { state[h.id] = h.entries.map((e) => ({ ...e })) })))
      setHeatData(state)
      setSelectedHeatId(null)
      window.alert(t.heats.generateHeatsSuccess(result.heatsCreated, result.entriesAssigned))
    } catch (e) {
      console.error('Generate heats failed:', e)
    } finally {
      setGenerating(false)
    }
  }

  // ── Print timing sheets handler ────────────────────────────────────────────

  async function handlePrintTimingSheets() {
    const api = (window as any).api?.timing
    const reportApi = (window as any).api?.report
    if (!api || !reportApi) return

    // Determine which session to print for
    const sessionId = selectedSession?.id ?? sessions[0]?.id
    if (!sessionId) {
      window.alert('Aucune session disponible.')
      return
    }

    const result = await api.generateSheets(sessionId)
    if (!result.ok) {
      window.alert(`Erreur: ${result.error}`)
      return
    }

    // Use the existing report print/preview flow
    await reportApi.print(result.html, { line1: '', line2: '', today: '' })
  }

  // ── Quantum handlers ───────────────────────────────────────────────────────

  function handleConnectQuantum() {
    const api = quantumApi()
    if (!api || !quantumFolder.trim()) return
    api.configure(quantumFolder.trim())
    const schedule = heatListEvents
      .filter((ev) => !ev.isAdmin)
      .map((ev, i) => ({
        eventId: ev.id,
        eventNumber: ev.number,
        gender: ev.gender,
        distance: ev.distance,
        order: i + 1,
        round: ev.phase === 'Eliminatoire' ? 'PRE' : 'FIN',
        status: ev.heats.length > 0 ? 'SEEDED' : undefined,
        daytime: ev.scheduledTime,
        swimstyleName: ev.nameEn,
        heats: ev.heats.map((h, hi) => ({
          heatId: h.id,
          heatNumber: h.number,
          heatName: `Série ${h.number}`,
          heatOrder: hi + 1,
          entries: (heatData[h.id] ?? h.entries).map((e) => ({
            lane: e.lane,
            athleteId: e.athleteId,
            lastName: e.lastName,
            firstName: e.firstName,
            birthdate: `${e.birthYear}-01-01`,
            gender: ev.gender,
            nation: e.nation,
            clubCode: e.clubCode,
            clubName: e.clubName,
            entryTime: e.entryTime,
          })),
        })),
      }))
    api.setSchedule(schedule)
  }

  function handleSendToQuantum() {
    if (!selectedPair || !selectedEvent) return
    const api = quantumApi()
    if (!api) return
    const currentEntries = (heatData[selectedHeatId!] ?? []).map((e) => ({
      lane: e.lane,
      athleteId: e.athleteId,
      lastName: e.lastName,
      firstName: e.firstName,
      birthdate: `${e.birthYear}-01-01`,
      gender: selectedEvent.gender,
      nation: e.nation,
      clubCode: e.clubCode,
      clubName: e.clubName,
      entryTime: e.entryTime,
    }))
    api.activateHeat({
      eventId: selectedEvent.id,
      eventNumber: selectedEvent.number,
      heatId: selectedPair.heat.id,
      heatNumber: selectedPair.heat.number,
      gender: selectedEvent.gender,
      distance: selectedEvent.distance,
      round: selectedEvent.phase === 'Eliminatoire' ? 'PRE' : 'FIN',
      swimstyleName: selectedEvent.nameEn,
      entries: currentEntries,
    })
  }

  const heatStatus = () => {
    const hasAll = entries.every((e) => e.finalTime || e.status)
    if (hasAll && entries.length > 0) return t.heats.statusLabel.completed
    const hasAny = entries.some((e) => e.finalTime)
    return hasAny ? t.heats.statusLabel.inProgress : t.heats.statusLabel.assigned
  }

  const selectedEntry = entries.find((e) => e.lane === selectedLane)
  const maxLane = laneMax

  // Derive DSQ item ID from entry data (or user override for current lane)
  const selectedDsqItemId = (dsqOverrideLane === selectedLane && dsqOverrideId !== null)
    ? dsqOverrideId
    : (selectedEntry?.dsqItemId ?? null)

  // ── Validation helpers ─────────────────────────────────────────────────────

  // Determine if the currently selected heat is validated (locked)
  const isSelectedHeatValidated = selectedPair?.heat.status === 'validated'

  async function handleValidate() {
    const api = dbApi()
    if (!api) return
    if (selectedHeatId) {
      await api.validateHeat(selectedHeatId)
    } else if (selectedEventId || selectedEvent?.id) {
      await api.validateEvent(selectedEventId || selectedEvent!.id)
    } else if (selectedSessionId) {
      await api.validateSession(selectedSessionId)
    } else {
      return
    }
    // Reload
    const sess = await api.getHeatListSessions() as HeatListSession[]
    setSessions(sess)
    const state: HeatState = {}
    sess.forEach((s) => s.events.forEach((ev) => ev.heats.forEach((h) => { state[h.id] = h.entries.map((e) => ({ ...e })) })))
    setHeatData(state)
  }

  async function handleInvalidate() {
    const api = dbApi()
    if (!api) return
    if (selectedHeatId) {
      await api.invalidateHeat(selectedHeatId)
    } else if (selectedEventId || selectedEvent?.id) {
      await api.invalidateEvent(selectedEventId || selectedEvent!.id)
    } else if (selectedSessionId) {
      await api.invalidateSession(selectedSessionId)
    } else {
      return
    }
    // Reload
    const sess = await api.getHeatListSessions() as HeatListSession[]
    setSessions(sess)
    const state: HeatState = {}
    sess.forEach((s) => s.events.forEach((ev) => ev.heats.forEach((h) => { state[h.id] = h.entries.map((e) => ({ ...e })) })))
    setHeatData(state)
  }

  // ── Announcement helpers (Call to Marshall / Call to Scratch) ────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveApi = () => (window as any).api?.live

  // Call to Marshall: event selected, has heats with entries, no times recorded, not validated
  const canCallToMarshall = (() => {
    if (!selectedEvent) return false
    const eventHeats = selectedEvent.heats
    if (eventHeats.length === 0) return false
    // Must have entries (athletes assigned)
    const hasEntries = eventHeats.some(h => h.entries.length > 0)
    if (!hasEntries) return false
    // No times recorded yet
    const hasAnyTime = eventHeats.some(h => h.entries.some(e => e.finalTime))
    if (hasAnyTime) return false
    // Not validated
    const allValidated = eventHeats.every(h => h.status === 'validated')
    if (allValidated) return false
    return true
  })()

  // Call to Scratch: event is a Finale, heats are empty (not generated yet)
  const canCallToScratch = (() => {
    if (!selectedEvent) return false
    if (selectedEvent.phase !== 'Finale') return false
    // Heats not generated (no heats or all heats are empty)
    const hasHeatsWithEntries = selectedEvent.heats.some(h => h.entries.length > 0)
    if (hasHeatsWithEntries) return false
    return true
  })()

  function handleCallToMarshall() {
    const api = liveApi()
    if (!api || !selectedEvent) return
    const eventName = lang === 'fr' ? selectedEvent.nameFr : selectedEvent.nameEn
    api.announce({
      type: 'call_to_marshall',
      event_id: selectedEvent.id,
      event_number: selectedEvent.number,
      event_name: eventName || selectedEvent.nameFr,
      gender: selectedEvent.gender,
    })
  }

  function handleCallToScratch() {
    const api = liveApi()
    if (!api || !selectedEvent) return
    const eventName = lang === 'fr' ? selectedEvent.nameFr : selectedEvent.nameEn
    api.announce({
      type: 'call_to_scratch',
      event_id: selectedEvent.id,
      event_number: selectedEvent.number,
      event_name: eventName || selectedEvent.nameFr,
      gender: selectedEvent.gender,
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full text-xs">
      {/* ── Top toolbar ── */}
      <div className="flex items-center h-8 bg-gray-100 border-b border-gray-300 px-2 gap-3 shrink-0">
        <label className="flex items-center gap-1 text-gray-600">
          {t.heats.eventNo}:
          <input
            type="number"
            className="w-14 border border-gray-400 px-1 py-0.5 text-center bg-white"
            value={selectedEventId ?? ''}
            onChange={(e) => setSelectedEventId(Number(e.target.value))}
          />
          <button className="border border-gray-400 px-1 bg-white hover:bg-gray-50">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </label>
        <label className="flex items-center gap-1 text-gray-600">
          {t.heats.heatNo}:
          <input
            type="number"
            className="w-14 border border-gray-400 px-1 py-0.5 text-center bg-white"
            value={selectedPair ? selectedPair.heat.number : ''}
            readOnly
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleValidate}
            disabled={!selectedHeatId && !selectedEventId && !selectedSessionId}
            className="border border-gray-400 bg-white hover:bg-green-50 disabled:opacity-50 disabled:cursor-default px-2 py-0.5 text-xs font-medium text-green-700"
            title="Valider"
          >
            <svg className="w-3 h-3 inline mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            Valider
          </button>
          <button
            onClick={handleInvalidate}
            disabled={!selectedHeatId && !selectedEventId && !selectedSessionId}
            className="border border-gray-400 bg-white hover:bg-yellow-50 disabled:opacity-50 disabled:cursor-default px-2 py-0.5 text-xs font-medium text-yellow-700"
            title="Invalider"
          >
            <svg className="w-3 h-3 inline mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Invalider
          </button>
          <div className="w-px h-4 bg-gray-300" />
          <div className="relative">
            <button
              onClick={() => setGenerateMenuOpen(!generateMenuOpen)}
              disabled={generating}
              className="border border-gray-400 bg-white hover:bg-blue-50 disabled:opacity-50 disabled:cursor-default px-2 py-0.5 text-xs font-medium text-blue-700"
            >
              {generating ? '…' : t.heats.generateHeats} ▾
            </button>
            {generateMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setGenerateMenuOpen(false)} />
                <div className="absolute top-full left-0 mt-0.5 bg-white border border-gray-300 shadow-lg z-50 text-xs w-48">
                  <button
                    onClick={() => handleGenerateHeats('all')}
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50"
                  >
                    {lang === 'fr' ? 'Toutes les épreuves' : 'All events'}
                  </button>
                  <button
                    onClick={() => handleGenerateHeats('session')}
                    disabled={!selectedSessionId && !selectedSession}
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-default"
                  >
                    {lang === 'fr' ? 'Session sélectionnée' : 'Selected session'}
                  </button>
                  <button
                    onClick={() => handleGenerateHeats('event')}
                    disabled={!selectedEventId && !selectedEvent}
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-default"
                  >
                    {lang === 'fr' ? 'Épreuve sélectionnée' : 'Selected event'}
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={handlePrintTimingSheets}
            className="border border-gray-400 bg-white hover:bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700"
            title="Imprimer les fiches de chronométrage pour la session"
          >
            🖨 Fiches chrono
          </button>
          {/* Call to Marshall — event selected, no times, not validated */}
          {selectedEvent && canCallToMarshall && (
            <button
              onClick={handleCallToMarshall}
              className="border border-orange-400 bg-orange-50 hover:bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700"
              title={lang === 'fr' ? 'Envoyer un appel au maréchal aux entraîneurs' : 'Send call to marshall to coaches'}
            >
              📢 {lang === 'fr' ? 'Maréchal' : 'Marshall'}
            </button>
          )}
          {/* Call to Scratch — final event, prelims done, heats not generated */}
          {selectedEvent && canCallToScratch && (
            <button
              onClick={handleCallToScratch}
              className="border border-pink-400 bg-pink-50 hover:bg-pink-100 px-2 py-0.5 text-xs font-medium text-pink-700"
              title={lang === 'fr' ? 'Envoyer un appel aux scratches aux entraîneurs' : 'Send call to scratch to coaches'}
            >
              ✂️ {lang === 'fr' ? 'Scratches' : 'Scratches'}
            </button>
          )}
          <span className="text-gray-500">{t.heats.timingSystems}</span>
          <span className={`w-2 h-2 rounded-full ${quantumConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
        </div>
      </div>

      {/* ── Quantum toolbar ── */}
      <div className="flex items-center h-7 bg-blue-950 border-b border-blue-900 px-2 gap-2 shrink-0 text-blue-100">
        <span className="text-blue-300 font-mono text-2xs tracking-wider">QUANTUM</span>
        <span
          title={quantumConnected ? quantumVersion : 'Disconnected'}
          className={`w-2 h-2 rounded-full shrink-0 ${quantumConnected ? 'bg-green-400' : 'bg-gray-500'}`}
        />
        <input
          className="border border-blue-700 bg-blue-900 text-blue-100 placeholder-blue-500 px-1 py-0 text-xs w-52 font-mono"
          value={quantumFolder}
          onChange={(e) => setQuantumFolder(e.target.value)}
          placeholder="Quantum folder path…"
          onKeyDown={(e) => { if (e.key === 'Enter') handleConnectQuantum() }}
        />
        <button
          onClick={handleConnectQuantum}
          className="border border-blue-600 bg-blue-800 hover:bg-blue-700 px-2 py-0 text-xs"
        >
          Connect
        </button>
        <div className="w-px h-4 bg-blue-700 mx-1" />
        <button
          onClick={handleSendToQuantum}
          disabled={!selectedPair || !quantumConnected || isSelectedHeatValidated}
          className="border border-blue-600 bg-blue-800 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-default px-2 py-0 text-xs font-medium"
        >
          → Quantum
        </button>
        {quantumConnected && (
          <span className="text-blue-400 text-2xs ml-1 truncate">{quantumVersion}</span>
        )}
      </div>

      {/* ── Session + Event + heat list (top ~40%) ── */}
      <div className="overflow-y-auto border-b border-gray-400 bg-white" style={{ flex: '0 0 38%' }}>
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-400 py-8">Loading…</div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-100 border-b border-gray-300">
                <th className="text-left px-2 py-0.5 font-medium text-gray-600 w-6" />
                <th className="text-left px-2 py-0.5 font-medium text-gray-600">{t.heats.listColumns.event}</th>
                <th className="text-left px-2 py-0.5 font-medium text-gray-600 w-16">{t.heats.listColumns.heatNum}</th>
                <th className="text-left px-2 py-0.5 font-medium text-gray-600 w-28">{t.heats.listColumns.datePhase}</th>
                <th className="text-center px-1 py-0.5 font-medium text-gray-600 w-6">✓</th>
                <th className="text-left px-2 py-0.5 font-medium text-gray-600 w-14">{t.heats.listColumns.time}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const sessExpanded = expandedSessions.has(session.id)
                return (
                  <React.Fragment key={`s-${session.id}`}>
                    {/* Session row */}
                    <tr
                      className="border-b border-gray-200 cursor-pointer select-none bg-gray-50 hover:bg-gray-100 font-medium"
                      onClick={() => { setSelectedSessionId(session.id); setSelectedEventId(null); toggleSession(session.id) }}
                    >
                      <td className="px-2 py-0.5">
                        <span className="text-gray-500">{sessExpanded ? '▼' : '▶'}</span>
                      </td>
                      <td className="px-2 py-0.5" colSpan={2}>
                        <span className="text-gray-400 mr-1">
                          <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
                            <rect x="3" y="4" width="14" height="13" rx="1" />
                            <path d="M7 2v4M13 2v4M3 9h14" stroke="white" strokeWidth="1.5" fill="none" />
                          </svg>
                        </span>
                        {session.number} - {session.name}
                      </td>
                      <td className="px-2 py-0.5" />
                      <td className="px-1 py-0.5 text-center">
                        {session.events.filter((e) => !e.isAdmin).length > 0 &&
                         session.events.filter((e) => !e.isAdmin).every((e) => e.heats.length > 0 && e.heats.every((h) => h.status === 'validated')) && (
                          <span className="text-green-600" title="Session validée">✓</span>
                        )}
                        {session.events.filter((e) => !e.isAdmin).length > 0 &&
                         !session.events.filter((e) => !e.isAdmin).every((e) => e.heats.length > 0 && e.heats.every((h) => h.status === 'validated')) &&
                         session.events.filter((e) => !e.isAdmin).some((e) => e.heats.some((h) => h.status === 'validated' || h.status === 'completed' || (heatData[h.id] ?? []).some((en) => en.finalTime || en.status))) && (
                          <span className="text-yellow-500" title="En cours">📌</span>
                        )}
                      </td>
                      <td className="px-2 py-0.5 text-right">{session.time ?? ''}</td>
                    </tr>

                    {/* Events under session */}
                    {sessExpanded && session.events.map((ev) => {
                      const isEvExpanded = expandedEvents.has(ev.id)
                      return (
                        <React.Fragment key={`e-${ev.id}`}>
                          <tr
                            className={`border-b border-gray-100 cursor-pointer select-none ${
                              ev.isAdmin ? 'text-gray-500 italic' : 'hover:bg-blue-50'
                            } ${selectedEventId === ev.id && !ev.isAdmin ? 'bg-blue-50 font-medium' : ''}`}
                            onClick={() => {
                              if (!ev.isAdmin) {
                                setSelectedEventId(ev.id)
                                setSelectedSessionId(null)
                                setSelectedHeatId(null)
                                if (ev.heats.length > 0) toggleEvent(ev.id)
                              }
                            }}
                          >
                            <td className="px-2 py-0.5 pl-6">
                              {!ev.isAdmin && ev.heats.length > 0 && (
                                <span className="text-gray-400">{isEvExpanded ? '▼' : '▶'}</span>
                              )}
                            </td>
                            <td className="px-2 py-0.5 pl-4">
                              {ev.isAdmin ? (
                                <span>
                                  <svg className="w-3 h-3 inline mr-1 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 3v5l3 3-1.5 1.5L8 11V5h2z" />
                                  </svg>
                                  {ev.nameFr}
                                </span>
                              ) : (
                                <span>
                                  <span className="font-medium">{ev.number}.</span>{' '}
                                  {t.heats.genderLabel(ev.gender ?? '')},{' '}
                                  {ev.distance}m {ev.nameFr}/{ev.nameEn}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-0.5" />
                            <td className="px-2 py-0.5 text-gray-500">
                              {ev.isAdmin ? 'Pause' : ev.phase}
                            </td>
                            <td className="px-1 py-0.5 text-center">
                              {!ev.isAdmin && ev.heats.length > 0 && ev.heats.every((h) => h.status === 'validated') && (
                                <span className="text-green-600" title="Validé">✓</span>
                              )}
                              {!ev.isAdmin && ev.heats.length > 0 && !ev.heats.every((h) => h.status === 'validated') && ev.heats.some((h) => h.status === 'completed' || (heatData[h.id] ?? []).some((e) => e.finalTime || e.status)) && (
                                <span className="text-yellow-500" title="En attente de validation">📌</span>
                              )}
                            </td>
                            <td className="px-2 py-0.5 text-right">{ev.scheduledTime ?? ''}</td>
                          </tr>

                          {/* Heats under event */}
                          {isEvExpanded && ev.heats.map((heat) => {
                            const isHeatSelected = heat.id === selectedHeatId
                            const heatEntries = heatData[heat.id] ?? []
                            const done = heatEntries.filter((e) => e.finalTime || e.status).length
                            return (
                              <tr
                                key={`h-${heat.id}`}
                                className={`border-b border-gray-100 cursor-pointer select-none ${
                                  isHeatSelected ? 'bg-blue-600 text-white' : dragSource && dragSource.heatId !== heat.id ? 'bg-gray-50 hover:bg-green-100' : 'bg-gray-50 hover:bg-blue-100'
                                }`}
                                onClick={() => { setSelectedHeatId(heat.id); setSelectedEventId(null); setSelectedSessionId(null); setEditingLane(null) }}
                                onDragOver={(e) => handleHeatRowDragOver(e, heat.id)}
                                onDragLeave={(e) => handleHeatRowDragLeave(e, heat.id)}
                              >
                                <td className="px-2 py-0.5 pl-10">
                                  <svg className="w-3 h-3 inline text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                                    <rect x="4" y="4" width="12" height="12" rx="1" />
                                  </svg>
                                </td>
                                <td className="px-2 py-0.5 pl-8">{t.heats.heatLabel} {heat.number}</td>
                                <td className="px-2 py-0.5 text-center">
                                  <span className={isHeatSelected ? 'text-blue-100' : 'text-gray-500'}>{heat.number}</span>
                                </td>
                                <td className="px-2 py-0.5">
                                  {done > 0 && (
                                    <span className={`text-2xs ${isHeatSelected ? 'text-blue-200' : 'text-gray-400'}`}>
                                      {done}/{heatEntries.length}
                                    </span>
                                  )}
                                </td>
                                <td className="px-1 py-0.5 text-center">
                                  {heat.status === 'validated' && (
                                    <span className={isHeatSelected ? 'text-green-200' : 'text-green-600'} title="Validé">✓</span>
                                  )}
                                  {heat.status !== 'validated' && done > 0 && (
                                    <span className={isHeatSelected ? 'text-yellow-200' : 'text-yellow-500'} title="Complété">📌</span>
                                  )}
                                </td>
                                <td />
                              </tr>
                            )
                          })}
                        </React.Fragment>
                      )
                    })}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Heat detail (bottom ~60%) ── */}
      <div className="flex flex-col" style={{ flex: '1 1 0', minHeight: 0 }}>
        {selectedPair ? (
          <>
            {/* Heat header */}
            <div className="flex items-center justify-between px-3 py-1 bg-gray-50 border-b border-gray-300 shrink-0">
              <div>
                <span className="font-semibold text-gray-800">
                  {selectedEvent!.number}. {t.heats.genderLabel(selectedEvent!.gender ?? '')},{' '}
                  {selectedEvent!.distance}m {selectedEvent!.nameFr}/{selectedEvent!.nameEn},{' '}
                  {selectedEvent!.phase}
                </span>
                <span className="ml-3 text-gray-500">
                  {t.heats.heatLabel} {selectedPair.heat.number}. {heatStatus()}
                </span>
                {isSelectedHeatValidated && (
                  <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 border border-green-300 rounded text-2xs font-medium">
                    🔒 Validé
                  </span>
                )}
              </div>
              <span className="text-gray-400">{t.heats.sessionLabel} 1</span>
            </div>

            {/* Athlete grid */}
            <div className="overflow-auto flex-1">
              <table className="w-full border-collapse heat-table">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-100 border-b border-gray-400 text-gray-600">
                    <th className="px-2 py-0.5 text-center w-8 font-medium border-r border-gray-300">{isBeach ? '#' : t.heats.columns.lane}</th>
                    <th className="px-2 py-0.5 text-left font-medium border-r border-gray-300 min-w-[160px]">{t.heats.columns.name}</th>
                    <th className="px-2 py-0.5 text-center w-10 font-medium border-r border-gray-300">{t.heats.columns.nation}</th>
                    <th className="px-2 py-0.5 text-center w-14 font-medium border-r border-gray-300">{t.heats.columns.clubCode}</th>
                    <th className="px-2 py-0.5 text-left font-medium border-r border-gray-300 min-w-[150px]">{t.heats.columns.clubName}</th>
                    <th className="px-2 py-0.5 text-center w-14 font-medium border-r border-gray-300">{t.heats.columns.category}</th>
                    {!isBeach && <th className="px-2 py-0.5 text-center w-20 font-medium border-r border-gray-300">{selectedEvent?.phase === 'Finale' ? t.heats.columns.prelimTime : t.heats.columns.seedTime}</th>}
                    {!isBeach && <th className="px-2 py-0.5 text-center w-24 font-medium border-r border-gray-300">{t.heats.columns.splitTime}</th>}
                    <th className="px-2 py-0.5 text-center w-24 font-medium border-r border-gray-300 bg-blue-50">{isBeach ? 'Position' : t.heats.columns.finalTime}</th>
                    {!isBeach && <th className="px-2 py-0.5 text-center w-8 font-medium border-r border-gray-300">{t.heats.columns.rank}</th>}
                    <th className="px-2 py-0.5 text-center w-16 font-medium">{t.heats.columns.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {allLanes.map(({ lane, entry }) => {
                    const isSelected = lane === selectedLane
                    const isEmpty = !entry
                    const isDragOver = dragOverLane === lane

                    if (isEmpty) {
                      return (
                        <tr
                          key={lane}
                          className={`border-b border-gray-200 cursor-pointer select-none ${isDragOver ? 'bg-blue-200 ring-2 ring-blue-400 ring-inset' : isSelected ? 'bg-blue-100' : 'bg-gray-50 hover:bg-blue-50'}`}
                          onClick={() => setSelectedLane(lane)}
                          onContextMenu={(e) => handleContextMenu(e, lane, null)}
                          onDragOver={(e) => handleDragOver(e, lane)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, selectedHeatId!, lane, null)}
                        >
                          <td className={`px-2 text-center font-mono font-bold border-r border-gray-200 ${isSelected ? 'text-blue-700' : 'text-gray-300'}`}>
                            {lane}
                          </td>
                          <td className="px-2 border-r border-gray-200 text-gray-300 italic" colSpan={10}>
                          </td>
                        </tr>
                      )
                    }

                    const isEditing = lane === editingLane
                    const isDsq = entry.status === 'DSQ'
                    const isDns = entry.status === 'DNS'
                    const isDnf = entry.status === 'DNF'
                    const hasTime = !!entry.finalTime && !entry.status
                    const rank = rankOf(lane)

                    const rowBg = isDragOver
                      ? 'bg-blue-200 ring-2 ring-blue-400 ring-inset'
                      : isDsq
                      ? 'bg-red-50'
                      : isDns
                      ? 'bg-gray-50 text-gray-400'
                      : isSelected
                      ? 'bg-blue-100'
                      : hasTime
                      ? 'bg-green-50'
                      : 'bg-white hover:bg-blue-50'

                    return (
                      <tr
                        key={lane}
                        className={`border-b border-gray-200 cursor-pointer select-none ${rowBg}`}
                        draggable
                        onClick={() => setSelectedLane(lane)}
                        onDoubleClick={() => startEdit(lane)}
                        onContextMenu={(e) => handleContextMenu(e, lane, entry)}
                        onDragStart={(e) => handleDragStart(e, selectedHeatId!, lane, entry)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleDragOver(e, lane)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, selectedHeatId!, lane, entry)}
                      >
                        <td className={`px-2 text-center font-mono font-bold border-r border-gray-200 ${isSelected ? 'text-blue-700' : 'text-gray-500'}`}>
                          {lane}
                        </td>
                        <td className="px-2 border-r border-gray-200 font-medium">
                          {(() => {
                            if (isBeach && entry.relayMembers && entry.relayMembers.length > 0) {
                              // Relay event in beach mode (req 8.1–8.5)
                              const occupiedMembers = entry.relayMembers.filter(m => m.lastName)
                              // Build team name: custom team name or members' last names joined by "/"
                              const teamName = entry.relayTeamName || occupiedMembers.map(m => m.lastName).join('/')
                              // Build combined beach number string: use "??" for members without a number
                              const beachNumberStr = occupiedMembers.map(m => m.beachNumber || '??').join('/')
                              return beachNumberStr ? `${teamName} - ${beachNumberStr}` : teamName
                            }
                            // Individual event or pool mode
                            return `${entry.lastName}, ${entry.firstName}${isBeach && entry.beachNumber ? ` - ${entry.beachNumber}` : ''}`
                          })()}
                        </td>
                        <td className={`px-2 text-center border-r border-gray-200 ${isSelected ? 'text-gray-600' : 'text-gray-500'}`}>
                          {String(entry.birthYear).slice(-2)}
                        </td>
                        <td className={`px-2 text-center border-r border-gray-200 font-mono ${isSelected ? 'text-gray-600' : 'text-gray-500'}`}>
                          {entry.clubCode}
                        </td>
                        <td className="px-2 border-r border-gray-200">{entry.clubName}</td>
                        <td className={`px-2 text-center border-r border-gray-200 ${isSelected ? 'text-gray-700' : 'text-gray-600'}`}>
                          {entry.category}
                        </td>
                        {!isBeach && (
                          <td className={`px-2 text-center font-mono border-r border-gray-200 ${isSelected ? 'text-gray-600' : 'text-gray-500'}`}>
                            {entry.entryTime ?? 'NT'}
                          </td>
                        )}
                        {!isBeach && (
                          <td className={`px-2 text-center font-mono border-r border-gray-200 ${isSelected ? 'text-gray-500' : 'text-gray-400'}`}>
                            {entry.splitTimes ? Object.values(entry.splitTimes)[0] ?? '—' : '—'}
                          </td>
                        )}
                        {/* Final time / Position — editable */}
                        <td
                          className={`px-1 text-center font-mono border-r border-gray-200 ${isSelected && !isEditing ? 'bg-blue-200' : 'bg-blue-50'}`}
                          onClick={(e) => { e.stopPropagation(); startEdit(lane) }}
                        >
                          {isEditing ? (
                            <input
                              ref={inputRef}
                              className="time-input w-20"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => handleKeyDown(e, lane, maxLane)}
                              onBlur={() => saveEdit(lane)}
                              placeholder={isBeach ? '#' : 'M:SS.hh'}
                            />
                          ) : (
                            <span
                              className={
                                hasTime
                                  ? 'text-green-700 font-semibold'
                                  : isDsq
                                  ? 'text-red-600 font-semibold'
                                  : isDns || isDnf
                                  ? 'text-gray-500'
                                  : ''
                              }
                            >
                              {formatTimeDisplay(entry.finalTime, entry.status) || (isSelected ? '|' : '')}
                            </span>
                          )}
                        </td>
                        {!isBeach && (
                          <td className={`px-2 text-center font-bold border-r border-gray-200 ${rank === 1 ? 'text-yellow-600' : 'text-gray-600'}`}>
                            {rank ?? ''}
                          </td>
                        )}
                        <td className="px-1 text-center">
                          <select
                            className={`text-xs border border-gray-300 rounded px-1 ${isSelected ? 'bg-blue-100 border-blue-300' : 'bg-white'}`}
                            value={entry.status ?? ''}
                            onChange={(e) => {
                              const val = e.target.value as 'DNS' | 'DNF' | 'DSQ' | ''
                              setSelectedLane(lane)
                              setStatus(lane, val || null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value=""></option>
                            <option value="DNS">DNS</option>
                            <option value="DNF">DNF</option>
                            <option value="DSQ">DSQ</option>
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Bottom bar: splits + DSQ ── */}
            <div className="flex border-t border-gray-400 bg-gray-50 shrink-0" style={{ minHeight: 80 }}>
              {/* Splits */}
              <div className="border-r border-gray-300 p-2 w-52">
                <table className="text-xs w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="px-1 text-left font-medium text-gray-500 w-12">{t.heats.splitCols.distance}</th>
                      <th className="px-1 text-center font-medium text-gray-500 w-20">{t.heats.splitCols.time}</th>
                      <th className="px-1 text-center font-medium text-gray-500 w-16">{t.heats.splitCols.delta}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[50, 100].map((d) => {
                      const splitTime = selectedEntry?.splitTimes?.[d]
                      return (
                        <tr key={d} className="border-b border-gray-100">
                          <td className="px-1 py-0.5 text-gray-500">{d}m</td>
                          <td className="px-1 py-0.5 text-center font-mono">{splitTime ?? '—'}</td>
                          <td className="px-1 py-0.5 text-center font-mono text-gray-400">—</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* DSQ panel */}
              <div className="flex-1 p-2">
                <div className="grid grid-cols-1 gap-y-1">
                  <div className="flex items-center gap-2">
                    <label className="text-gray-600 w-24 shrink-0">{t.heats.dsq.reason}:</label>
                    <DsqSearchDropdown
                      items={dsqItems}
                      value={selectedDsqItemId}
                      onChange={(id) => {
                        setDsqOverrideId(id)
                        setDsqOverrideLane(selectedLane)
                        const item = dsqItems.find(d => d.dsqitemid === id)
                        setDsqCode(item?.code || '')
                        setDsqReason(item?.name || '')
                      }}
                      disabled={selectedEntry?.status !== 'DSQ'}
                      eventType={(selectedEvent?.relaycount ?? 1) > 1 ? 'RELAY' : 'INDIVIDUAL'}
                    />
                  </div>
                  {(() => {
                    const reason = dsqItems.find(d => d.dsqitemid === selectedDsqItemId)?.name || dsqReason
                    return reason ? (
                      <div className="ml-26 pl-24 text-xs text-gray-600 leading-tight max-h-12 overflow-y-auto">
                        {reason}
                      </div>
                    ) : null
                  })()}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400">
            {loading ? 'Loading…' : t.heats.noHeatSelected}
          </div>
        )}
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={closeContextMenu}
          onContextMenu={(e) => { e.preventDefault(); closeContextMenu() }}
        >
          <div
            className="absolute bg-white border border-gray-300 shadow-lg rounded py-1 text-xs min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.entry ? (
              <button
                className="w-full text-left px-3 py-1 hover:bg-red-50 text-red-700"
                onClick={handleRemoveFromHeat}
              >
                Retirer de la série
              </button>
            ) : (
              <button
                className="w-full text-left px-3 py-1 hover:bg-blue-50 text-blue-700"
                onClick={handleAddLateEntry}
              >
                Ajouter inscription tardive…
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Late entry dialog ── */}
      {lateEntryDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded shadow-xl w-96 max-h-[400px] flex flex-col">
            <div className="px-4 py-2 border-b border-gray-200 font-medium text-sm">
              Ajouter inscription tardive — DC {lateEntryDialog.lane}
            </div>
            <div className="px-4 py-2">
              <input
                autoFocus
                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                placeholder="Rechercher un athlète…"
                value={lateSearchQuery}
                onChange={(e) => setLateSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {athletes
                .filter((a) => {
                  if (!lateSearchQuery) return true
                  const q = lateSearchQuery.toLowerCase()
                  return a.lastName.toLowerCase().includes(q) || a.firstName.toLowerCase().includes(q) || (a.clubCode ?? '').toLowerCase().includes(q) || (a.clubName ?? '').toLowerCase().includes(q)
                })
                .slice(0, 50)
                .map((a) => (
                  <button
                    key={a.id}
                    className="w-full text-left px-2 py-1 text-xs hover:bg-blue-50 rounded flex justify-between"
                    onClick={() => confirmLateEntry(a.id)}
                  >
                    <span className="font-medium">{a.lastName}, {a.firstName}</span>
                    <span className="text-gray-400">{a.clubName || a.clubCode} {a.entryTime ?? 'NT'}</span>
                  </button>
                ))}
            </div>
            <div className="px-4 py-2 border-t border-gray-200 text-right">
              <button
                className="text-xs px-3 py-1 border border-gray-300 rounded hover:bg-gray-100"
                onClick={() => { setLateEntryDialog(null); setLateSearchQuery('') }}
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
