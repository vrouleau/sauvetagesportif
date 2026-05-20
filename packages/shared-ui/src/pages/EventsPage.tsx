import { useState, useEffect, useCallback, useRef, type ReactNode, type CSSProperties, type MouseEvent } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Session, CompetitionEvent, AgeGroup, SwimStyle } from '../data/api'
import { useApi } from '../context/ApiContext'
import { useLang } from '../context/LangContext'

type SelectedItem =
  | { type: 'competition' }
  | { type: 'session'; session: Session }
  | { type: 'event'; event: CompetitionEvent; session: Session }
  | { type: 'agegroup'; group: AgeGroup; event: CompetitionEvent }

interface ContextMenuState {
  x: number
  y: number
  target: SelectedItem
}

// ─── Inline Prompt Dialog (replaces window.prompt which is broken in Electron) ─

interface PromptState {
  title: string
  defaultValue: string
  resolve: (value: string | null) => void
}

function usePromptDialog() {
  const [state, setState] = useState<PromptState | null>(null)

  const prompt = useCallback((title: string, defaultValue = ''): Promise<string | null> => {
    return new Promise((resolve) => {
      setState({ title, defaultValue, resolve })
    })
  }, [])

  const handleConfirm = useCallback((value: string) => {
    state?.resolve(value)
    setState(null)
  }, [state])

  const handleCancel = useCallback(() => {
    state?.resolve(null)
    setState(null)
  }, [state])

  return { prompt, promptState: state, handleConfirm, handleCancel }
}

function PromptDialog({
  state,
  onConfirm,
  onCancel,
}: {
  state: PromptState
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(state.defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(state.defaultValue)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [state])

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded shadow-xl border border-gray-300 p-4 min-w-[320px]">
        <p className="text-sm font-medium mb-3">{state.title}</p>
        <input
          ref={inputRef}
          type="text"
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3 focus:outline-none focus:border-blue-500"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value)
            if (e.key === 'Escape') onCancel()
          }}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
            onClick={onCancel}
          >
            Annuler
          </button>
          <button
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            onClick={() => onConfirm(value)}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

export default function EventsPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useLang()
  const api = useApi()
  const [localSessions, setLocalSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set())
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<SelectedItem>({ type: 'competition' })
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [meetName, setMeetName] = useState<string>('')
  const [poolSize, setPoolSize] = useState<number>(50)
  const { prompt, promptState, handleConfirm, handleCancel } = usePromptDialog()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const activeId = Number(String(active.id).replace('event-', ''))
    const overId = Number(String(over.id).replace('event-', ''))

    // Find which session contains each event
    let sourceSession: Session | undefined
    let targetSession: Session | undefined
    for (const s of localSessions) {
      if (s.events.some(e => e.id === activeId)) sourceSession = s
      if (s.events.some(e => e.id === overId)) targetSession = s
    }
    if (!sourceSession || !targetSession) return

    // Reorder within the target session
    const targetEvents = [...targetSession.events]
    const sourceEvents = sourceSession.id === targetSession.id ? targetEvents : [...sourceSession.events]

    const activeIdx = sourceEvents.findIndex(e => e.id === activeId)
    const overIdx = targetEvents.findIndex(e => e.id === overId)
    if (activeIdx < 0 || overIdx < 0) return

    // Remove from source
    const [moved] = sourceEvents.splice(activeIdx, 1)

    // Insert into target
    if (sourceSession.id === targetSession.id) {
      // Same session: already removed, insert at new position
      const insertIdx = overIdx > activeIdx ? overIdx - 1 : overIdx
      sourceEvents.splice(insertIdx < 0 ? 0 : insertIdx, 0, moved)
      // Update sortcodes
      const updates = sourceEvents.map((e, i) => ({ eventId: e.id, sessionId: sourceSession!.id, sortcode: i + 1 }))
      setLocalSessions(prev => prev.map(s => s.id === sourceSession!.id ? { ...s, events: sourceEvents } : s))
      api.reorderEvents(updates)
    } else {
      // Cross-session move
      targetEvents.splice(overIdx, 0, moved)
      const srcUpdates = sourceEvents.map((e, i) => ({ eventId: e.id, sessionId: sourceSession!.id, sortcode: i + 1 }))
      const tgtUpdates = targetEvents.map((e, i) => ({ eventId: e.id, sessionId: targetSession!.id, sortcode: i + 1 }))
      setLocalSessions(prev => prev.map(s => {
        if (s.id === sourceSession!.id) return { ...s, events: sourceEvents }
        if (s.id === targetSession!.id) return { ...s, events: targetEvents }
        return s
      }))
      api.reorderEvents([...srcUpdates, ...tgtUpdates])
    }
  }

  useEffect(() => {
    setLoading(true)
    api.getSessions().then((sessions) => {
      setLocalSessions(sessions)

      const defaultExpandedSessions = new Set<number>()
      const defaultExpandedEvents = new Set<number>()
      for (const session of sessions) {
        for (const event of session.events) {
          if (event.ageGroups.length > 0) {
            defaultExpandedSessions.add(session.id)
            defaultExpandedEvents.add(event.id)
          }
        }
      }
      setExpandedSessions(defaultExpandedSessions)
      setExpandedEvents(defaultExpandedEvents)

      setLoading(false)
    }).catch(() => setLoading(false))
    // Load meet name from config
    api.getMeetConfig().then((cfg) => {
      if (cfg?.NAME) setMeetName(cfg.NAME)
      // Derive pool size from COURSE config
      const course = cfg?.COURSE
      if (course === '3' || course === '2') setPoolSize(25)
      else setPoolSize(50)
    }).catch(() => {})
  }, [refreshKey])

  // Close context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  // 'd' keyboard shortcut for delete
  const handleDeleteRef = useRef(handleDelete)
  useEffect(() => { handleDeleteRef.current = handleDelete })
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'd') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      handleDeleteRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

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

  function openContextMenu(e: MouseEvent, target: SelectedItem) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, target })
    setSelected(target)
  }

  // ── Toolbar action handlers ──────────────────────────────────────────────────

  async function handleAddSession() {
    const name = await prompt(t.events.toolbar.addSession, 'Nouvelle session')
    if (name === null) return
    const newNum = Math.max(...localSessions.map((s) => s.number), 0) + 1
    let realId: number
    try {
      const result = await api.createSession(name, newNum)
      realId = result.id
    } catch {
      window.alert('Erreur lors de la création de la session')
      return
    }
    const newSession: Session = {
      id: realId,
      number: newNum,
      name,
      poolSize,
      events: [],
    }
    setLocalSessions((prev) => [...prev, newSession])
    setSelected({ type: 'session', session: newSession })
    setExpandedSessions((prev) => new Set([...prev, newSession.id]))
  }

  async function handleAddBreak() {
    const targetSession =
      selected.type === 'session'
        ? selected.session
        : selected.type === 'event'
        ? selected.session
        : null
    if (!targetSession) {
      return
    }
    const name = await prompt('Nom de la pause / Break name', 'Pause')
    if (name === null) return

    const allNums = localSessions.flatMap((s) => s.events.map((e) => e.number))
    const newNum = Math.max(...allNums, 0) + 1
    let realId: number
    try {
      const result = await api.createBreak(targetSession.id, newNum, name)
      realId = result.id
    } catch {
      window.alert('Erreur lors de la création de la pause')
      return
    }
    const newEvent: CompetitionEvent = {
      id: realId,
      sessionId: targetSession.id,
      number: newNum,
      nameFr: name,
      nameEn: name,
      gender: 'X',
      distance: 0,
      phase: 'Finale directe',
      isAdmin: true,
      ageGroups: [],
    }
    await insertEventAfterSelected(newEvent, targetSession)
    setSelected({ type: 'event', event: newEvent, session: targetSession })
    setExpandedSessions((prev) => new Set([...prev, targetSession.id]))
  }

  async function insertEventAfterSelected(newEvent: CompetitionEvent, targetSession: Session) {
    let updatedEvents: CompetitionEvent[] = []
    setLocalSessions((prev) =>
      prev.map((s) => {
        if (s.id !== targetSession.id) return s
        const events = [...s.events]
        const idx =
          selected.type === 'event'
            ? events.findIndex((e) => e.id === selected.event.id)
            : -1
        events.splice(idx + 1, 0, newEvent)
        updatedEvents = events
        return { ...s, events }
      })
    )
    if (updatedEvents.length > 0) {
      await api.reorderEvents(
        updatedEvents.map((e, i) => ({ eventId: e.id, sessionId: targetSession.id, sortcode: i + 1 }))
      )
    }
  }

  async function handleAddEventWithPhase(phase: 'Finale directe' | 'Eliminatoire' | 'Finale') {
    const targetSession =
      selected.type === 'session'
        ? selected.session
        : selected.type === 'event'
        ? selected.session
        : null
    if (!targetSession) return
    const allNums = localSessions.flatMap((s) => s.events.map((e) => e.number))
    const newNum = Math.max(...allNums, 0) + 1
    let realId: number
    try {
      const result = await api.createEvent(targetSession.id, newNum, 'M', 100, phase, 'Freestyle')
      realId = result.id
    } catch {
      window.alert("Erreur lors de la création de l'épreuve")
      return
    }
    const newEvent: CompetitionEvent = {
      id: realId,
      sessionId: targetSession.id,
      number: newNum,
      nameFr: 'Freestyle',
      nameEn: 'Freestyle',
      gender: 'M',
      distance: 100,
      phase,
      ageGroups: [],
    }
    await insertEventAfterSelected(newEvent, targetSession)
    setSelected({ type: 'event', event: newEvent, session: targetSession })
    setExpandedSessions((prev) => new Set([...prev, targetSession.id]))
  }

  async function handleAddAward() {
    const targetSession =
      selected.type === 'session'
        ? selected.session
        : selected.type === 'event'
        ? selected.session
        : null
    if (!targetSession) return
    const allNums = localSessions.flatMap((s) => s.events.map((e) => e.number))
    const newNum = Math.max(...allNums, 0) + 1
    let realId: number
    try {
      const result = await api.createBreak(targetSession.id, newNum, 'Remise des prix')
      realId = result.id
    } catch {
      window.alert('Erreur lors de la création de la remise de prix')
      return
    }
    const newEvent: CompetitionEvent = {
      id: realId,
      sessionId: targetSession.id,
      number: newNum,
      nameFr: 'Remise des prix',
      nameEn: 'Award ceremony',
      gender: 'X',
      distance: 0,
      phase: 'Finale directe',
      isAdmin: true,
      ageGroups: [],
    }
    await insertEventAfterSelected(newEvent, targetSession)
    setSelected({ type: 'event', event: newEvent, session: targetSession })
    setExpandedSessions((prev) => new Set([...prev, targetSession.id]))
  }

  async function handleAddCategoryPresets(presets: Array<{ name: string; minAge: number; maxAge: number | null }>) {
    const targetEvent =
      selected.type === 'event'
        ? selected.event
        : selected.type === 'agegroup'
        ? selected.event
        : null
    if (!targetEvent) return

    // Skip presets that already exist (same minAge, maxAge, gender)
    const toAdd = presets.filter(
      (p) =>
        !targetEvent.ageGroups.some(
          (g) => g.minAge === p.minAge && g.maxAge === p.maxAge && g.gender === targetEvent.gender
        )
    )
    if (toAdd.length === 0) return

    const newGroups: AgeGroup[] = []
    let baseNum = Math.max(...targetEvent.ageGroups.map((g) => g.number), 0)
    for (const { name, minAge, maxAge } of toAdd) {
      let realId: number
      try {
        const result = await api.createAgeGroup(targetEvent.id, name, minAge, maxAge, targetEvent.gender)
        realId = result.id
      } catch {
        window.alert('Erreur lors de la création de la catégorie')
        return
      }
      baseNum++
      newGroups.push({
        id: realId,
        number: baseNum,
        name,
        minAge,
        maxAge,
        gender: targetEvent.gender,
        numHeats: 1,
        ranking: t.events.defaultRanking,
        countForMedalStats: true,
        usedForCombined: false,
        alwaysSwimPrelims: true,
        advanceByTime: false,
        laneOrderInFinals: t.events.defaultRanking,
      })
    }

    const updatedEvent = { ...targetEvent, ageGroups: [...targetEvent.ageGroups, ...newGroups] }
    setLocalSessions((prev) =>
      prev.map((s) => ({
        ...s,
        events: s.events.map((e) => (e.id === targetEvent.id ? updatedEvent : e)),
      }))
    )
    setSelected({ type: 'agegroup', group: newGroups[newGroups.length - 1], event: updatedEvent })
    setExpandedEvents((prev) => new Set([...prev, targetEvent.id]))
  }

  async function handleAddCategory() {
    await handleAddCategoryPresets([{ name: 'Nouvelle catégorie', minAge: 0, maxAge: null }])
  }

  async function handleAddCategory1518Open() {
    await handleAddCategoryPresets([
      { name: '15-18', minAge: 15, maxAge: 18 },
      { name: '19+', minAge: 19, maxAge: null },
    ])
  }

  async function handleAddCategoryMaster() {
    await handleAddCategoryPresets([
      { name: '25-29', minAge: 25, maxAge: 29 },
      { name: '30-34', minAge: 30, maxAge: 34 },
      { name: '35-39', minAge: 35, maxAge: 39 },
      { name: '40-44', minAge: 40, maxAge: 44 },
      { name: '45-49', minAge: 45, maxAge: 49 },
      { name: '50-54', minAge: 50, maxAge: 54 },
      { name: '55-59', minAge: 55, maxAge: 59 },
      { name: '60-64', minAge: 60, maxAge: 64 },
      { name: '65-69', minAge: 65, maxAge: 69 },
      { name: '70-74', minAge: 70, maxAge: 74 },
      { name: '75+', minAge: 75, maxAge: null },
    ])
  }

  async function handleDelete() {
    if (selected.type === 'competition') return
    if (!window.confirm(t.events.toolbar.delete + '?')) return
    try {
      if (selected.type === 'session') {
        await api.deleteSession(selected.session.id)
        setLocalSessions((prev) => prev.filter((s) => s.id !== selected.session.id))
        setSelected({ type: 'competition' })
      } else if (selected.type === 'event') {
        const { session, event } = selected
        await api.deleteEvent(event.id)
        setLocalSessions((prev) =>
          prev.map((s) =>
            s.id === session.id ? { ...s, events: s.events.filter((e) => e.id !== event.id) } : s
          )
        )
        setSelected({ type: 'session', session })
      } else if (selected.type === 'agegroup') {
        const { event, group } = selected
        await api.deleteAgeGroup(group.id)
        const updatedEvent = { ...event, ageGroups: event.ageGroups.filter((g) => g.id !== group.id) }
        setLocalSessions((prev) =>
          prev.map((s) => ({
            ...s,
            events: s.events.map((e) => (e.id === event.id ? updatedEvent : e)),
          }))
        )
        const parentSession = localSessions.find((s) => s.events.some((e) => e.id === event.id))
        if (parentSession) setSelected({ type: 'event', event: updatedEvent, session: parentSession })
      }
    } catch {
      window.alert('Erreur lors de la suppression')
    }
  }

  async function handleUpdateSession(sessionId: number, data: Record<string, unknown>) {
    try {
      await api.updateSession(sessionId, data)
      // Map DB field names to local Session property names for state update
      const localUpdate: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(data)) {
        if (key === 'daytime') localUpdate.time = val as string | undefined
        else if (key === 'endtime') localUpdate.endTime = val as string | undefined
        else if (key === 'warmupfrom') localUpdate.warmupFrom = val as string | undefined
        else if (key === 'warmupuntil') localUpdate.warmupUntil = val as string | undefined
        else if (key === 'officialmeeting') localUpdate.officialMeeting = val as string | undefined
        else if (key === 'remarks') localUpdate.remarks = val as string | undefined
        else if (key === 'remarksjury') localUpdate.remarksJury = val as string | undefined
        else if (key === 'sessionnumber') localUpdate.number = val as number
        else if (key === 'course') {
          const c = val as number
          localUpdate.poolSize = c === 3 ? 25 : c === 2 ? 25 : 50
        }
        else if (key === 'lanemin') localUpdate.laneMin = val as number | undefined
        else if (key === 'lanemax') localUpdate.laneMax = val as number | undefined
        else if (key === 'maxentriesathlete') localUpdate.maxEntriesAthlete = val as number | undefined
        else if (key === 'maxentriesrelay') localUpdate.maxEntriesRelay = val as number | undefined
        else if (key === 'feeathlete') localUpdate.feeAthlete = val as number | undefined
        else if (key === 'timing') localUpdate.timing = val as number | undefined
        else if (key === 'touchpadmode') localUpdate.touchpadMode = val as number | undefined
        else if (key === 'roundtotenths') localUpdate.roundToTenths = val as boolean
        else localUpdate[key] = val
      }
      // Update local state
      setLocalSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...localUpdate } : s))
      )
      // Update selected if it's the same session
      if (selected.type === 'session' && selected.session.id === sessionId) {
        setSelected({ type: 'session', session: { ...selected.session, ...localUpdate } as Session })
      }
    } catch {
      // silently fail
    }
  }

  // Contextual toolbar button enable logic
  const canAddSession = selected.type === 'competition' || selected.type === 'session'
  const canAddEvent = selected.type === 'session' || selected.type === 'event'
  const canAddCategory = selected.type === 'event' || selected.type === 'agegroup'
  const canAddBreak = selected.type === 'session' || selected.type === 'event'
  const canDelete = selected.type !== 'competition'

  return (
    <div className="flex flex-col h-full">
      {/* ── Contextual toolbar ── */}
      <div className="flex items-center h-7 bg-gray-100 border-b border-gray-300 px-2 gap-1 shrink-0 text-xs select-none">
        <ToolbarBtn
          label={t.events.toolbar.addSession}
          enabled={canAddSession}
          onClick={handleAddSession}
        />
        <ToolbarBtn
          label={t.events.toolbar.addEvent}
          enabled={canAddEvent}
          onClick={() => handleAddEventWithPhase('Finale directe')}
        />
        <ToolbarBtn
          label={t.events.toolbar.addCategory}
          enabled={canAddCategory}
          onClick={handleAddCategory}
        />
        <ToolbarBtn
          label={t.events.toolbar.addBreak}
          enabled={canAddBreak}
          onClick={handleAddBreak}
        />
        <div className="w-px h-4 bg-gray-300 mx-1" />
        <ToolbarBtn
          label={t.events.toolbar.delete}
          enabled={canDelete}
          danger
          onClick={handleDelete}
        />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Left: tree ── */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="w-[480px] shrink-0 border-r border-gray-300 overflow-y-auto bg-white select-none text-xs">
          {/* Column headers */}
          <div className="flex items-center h-6 bg-gray-100 border-b border-gray-300 text-gray-500 font-medium px-2 sticky top-0 z-10">
            <span className="flex-1">{t.events.columns.name}</span>
            <span className="w-28 text-center">{t.events.columns.datePhase}</span>
            <span className="w-14 text-center">{t.events.columns.time}</span>
            <span className="w-14 text-center">{t.events.columns.pool}</span>
          </div>

          {/* Competition root */}
          <div
            className={`flex items-center h-6 px-1 cursor-pointer tree-node ${selected.type === 'competition' ? 'bg-blue-600 text-white' : ''}`}
            onClick={() => setSelected({ type: 'competition' })}
            onContextMenu={(e) => openContextMenu(e, { type: 'competition' })}
          >
            <span className="w-4 text-center text-gray-400 mr-1">
              <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
                <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-.293.707L13 10.414V17a1 1 0 01-.553.894l-4 2A1 1 0 017 19v-8.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
            </span>
            <span className="flex-1 font-semibold truncate">{meetName}</span>
            <span className="w-28" />
            <span className="w-14" />
            <span className="w-14 text-center">{t.events.poolUnit(poolSize)}</span>
          </div>

          {loading && (
            <div className="px-4 py-3 text-gray-400 text-xs italic">Chargement…</div>
          )}

          {/* Sessions */}
          {localSessions.map((session) => {
            const expanded = expandedSessions.has(session.id)
            const isSessionSelected = selected.type === 'session' && selected.session.id === session.id
            return (
              <div key={session.id}>
                <div
                  className={`flex items-center h-6 pl-4 cursor-pointer tree-node ${isSessionSelected ? 'bg-blue-600 text-white' : ''}`}
                  onClick={() => {
                    setSelected({ type: 'session', session })
                    if (session.events.length > 0) toggleSession(session.id)
                  }}
                  onContextMenu={(e) => openContextMenu(e, { type: 'session', session })}
                >
                  {session.events.length > 0 ? (
                    <span className="w-4 text-center mr-1 text-gray-500">{expanded ? '▼' : '▶'}</span>
                  ) : (
                    <span className="w-4 mr-1" />
                  )}
                  <span className="w-4 mr-1 text-blue-400">
                    <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
                      <rect x="3" y="4" width="14" height="13" rx="1" />
                      <path d="M7 2v4M13 2v4M3 9h14" stroke="white" strokeWidth="1.5" fill="none" />
                    </svg>
                  </span>
                  <span className="flex-1 truncate">
                    <span className="font-medium">{session.number}</span> - Session {session.number}{' '}
                    {session.name}
                  </span>
                  <span className="w-28" />
                  <span className="w-14 text-center">{session.time ?? ''}</span>
                  <span className="w-14 text-center">{t.events.poolUnit(session.poolSize)}</span>
                </div>

                {/* Events (sortable) */}
                {expanded && (
                  <SortableContext items={session.events.map(e => `event-${e.id}`)} strategy={verticalListSortingStrategy}>
                    {session.events.map((event) => (
                      <SortableEventItem
                        key={event.id}
                        event={event}
                        session={session}
                        isSelected={selected.type === 'event' && selected.event.id === event.id}
                        isExpanded={expandedEvents.has(event.id)}
                        selected={selected}
                        onSelect={() => setSelected({ type: 'event', event, session })}
                        onToggle={() => { if (event.ageGroups.length > 0) toggleEvent(event.id) }}
                        onContextMenu={(e) => openContextMenu(e, { type: 'event', event, session })}
                        onSelectGroup={(group) => setSelected({ type: 'agegroup', group, event })}
                        onContextMenuGroup={(e, group) => openContextMenu(e, { type: 'agegroup', group, event })}
                        t={t}
                      />
                    ))}
                  </SortableContext>
                )}
              </div>
            )
          })}
        </div>
        </DndContext>

        {/* ── Right: properties panel ── */}
        <div className="flex-1 overflow-y-auto bg-white">
          <PropertiesPanel selected={selected} onUpdateSession={handleUpdateSession} onMeetNameChange={setMeetName} />
        </div>
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          onClose={() => setContextMenu(null)}
          onAction={(action) => {
            setContextMenu(null)
            if (action === 'addSession') handleAddSession()
            else if (action === 'addDirectFinal') handleAddEventWithPhase('Finale directe')
            else if (action === 'addSemiFinal') handleAddEventWithPhase('Eliminatoire')
            else if (action === 'addFinal') handleAddEventWithPhase('Finale')
            else if (action === 'addMainHeat') handleAddEventWithPhase('Eliminatoire')
            else if (action === 'addSeparateHeats') handleAddEventWithPhase('Eliminatoire')
            else if (action === 'addTimeTrial') handleAddEventWithPhase('Finale directe')
            else if (action === 'addAward') handleAddAward()
            else if (action === 'addBreak') handleAddBreak()
            else if (action === 'addCategory') handleAddCategory()
            else if (action === 'addCategory10') handleAddCategoryPresets([{ name: '10-', minAge: 0, maxAge: 10 }])
            else if (action === 'addCategory1112') handleAddCategoryPresets([{ name: '11-12', minAge: 11, maxAge: 12 }])
            else if (action === 'addCategory1314') handleAddCategoryPresets([{ name: '13-14', minAge: 13, maxAge: 14 }])
            else if (action === 'addCategory1518Open') handleAddCategory1518Open()
            else if (action === 'addCategoryMaster') handleAddCategoryMaster()
            else if (action === 'delete') handleDelete()
          }}
        />
      )}

      {/* ── Prompt dialog ── */}
      {promptState && (
        <PromptDialog state={promptState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </div>
  )
}

// ─── Sortable Event Item ──────────────────────────────────────────────────────

function SortableEventItem({
  event, session, isSelected, isExpanded, selected, onSelect, onToggle, onContextMenu,
  onSelectGroup, onContextMenuGroup, t,
}: {
  event: CompetitionEvent
  session: Session
  isSelected: boolean
  isExpanded: boolean
  selected: SelectedItem
  onSelect: () => void
  onToggle: () => void
  onContextMenu: (e: MouseEvent) => void
  onSelectGroup: (group: AgeGroup) => void
  onContextMenuGroup: (e: MouseEvent, group: AgeGroup) => void
  t: ReturnType<typeof useLang>['t']
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `event-${event.id}`,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  if (event.isAdmin) {
    return (
      <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
        <div
          className={`flex items-center h-6 pl-10 cursor-grab tree-node ${isSelected ? 'bg-blue-600 text-white' : 'text-gray-500'}`}
          onClick={onSelect}
          onContextMenu={onContextMenu}
        >
          <span className="w-4 mr-1" />
          <span className="w-4 mr-1 text-gray-400">
            <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 3v5l3 3-1.5 1.5L8 11V5h2z" />
            </svg>
          </span>
          <span className="flex-1 truncate italic">{event.nameFr}</span>
          <span className="w-28 text-center text-xs">Pause</span>
          <span className="w-14 text-center">{event.scheduledTime ?? ''}</span>
          <span className="w-14" />
        </div>
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <div
        className={`flex items-center h-6 pl-10 cursor-grab tree-node ${isSelected ? 'bg-blue-600 text-white' : ''}`}
        onClick={() => { onSelect(); onToggle() }}
        onContextMenu={onContextMenu}
      >
        {event.ageGroups.length > 0 ? (
          <span className="w-4 text-center mr-1 text-gray-400">
            {isExpanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="w-4 mr-1" />
        )}
        <span className="w-4 mr-1 text-cyan-500">
          <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="7" />
          </svg>
        </span>
        <span className="flex-1 truncate">
          {event.number}. {
            event.ageGroups.length > 0 && event.ageGroups.every((g) => isYouthCategory(g.maxAge))
              ? t.events.youthGenderLabel(event.gender)
              : t.events.genderLabel(event.gender)
          },{' '}
          {event.distance}m {event.nameEn}
        </span>
        <span className="w-28 text-center text-gray-600">
          {t.events.phaseLabel(event.phase)}
        </span>
        <span className="w-14 text-center">{event.scheduledTime ?? ''}</span>
        <span className="w-14" />
      </div>

      {/* Age groups */}
      {isExpanded &&
        event.ageGroups.map((group) => {
          const isGroupSelected = selected.type === 'agegroup' && selected.group.id === group.id
          return (
            <div
              key={group.id}
              className={`flex items-center h-6 pl-16 cursor-pointer tree-node ${isGroupSelected ? 'bg-blue-600 text-white' : ''}`}
              onClick={() => onSelectGroup(group)}
              onContextMenu={(e) => onContextMenuGroup(e, group)}
            >
              <span className="w-4 mr-1" />
              <span className="w-4 mr-1 text-gray-400">
                <svg className="w-3 h-3 inline" fill="currentColor" viewBox="0 0 20 20">
                  <rect x="4" y="4" width="12" height="12" rx="1" />
                </svg>
              </span>
              <span className="flex-1 truncate">
                {group.number}. {ageRangeLabel(
                  group.minAge,
                  group.maxAge,
                  isYouthCategory(group.maxAge)
                    ? t.events.youthGenderLabel(group.gender)
                    : t.events.genderLabel(group.gender)
                )}
              </span>
              <span className="w-28" />
              <span className="w-14" />
              <span className="w-14" />
            </div>
          )
        })}
    </div>
  )
}

// ─── Toolbar Button ────────────────────────────────────────────────────────────

function ToolbarBtn({
  label,
  enabled,
  danger,
  onClick,
}: {
  label: string
  enabled: boolean
  danger?: boolean
  onClick?: () => void
}) {
  return (
    <button
      disabled={!enabled}
      onClick={onClick}
      className={`px-2 py-0.5 border rounded text-xs transition-colors ${
        enabled
          ? danger
            ? 'border-red-300 text-red-600 bg-white hover:bg-red-50'
            : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
          : 'border-gray-200 text-gray-300 bg-white cursor-not-allowed'
      }`}
    >
      {label}
    </button>
  )
}

// ─── Context Menu ──────────────────────────────────────────────────────────────

type MenuAction =
  | 'addSession'
  | 'addDirectFinal' | 'addSemiFinal' | 'addFinal'
  | 'addMainHeat' | 'addSeparateHeats' | 'addTimeTrial' | 'addAward'
  | 'addBreak'
  | 'addCategory' | 'addCategory10' | 'addCategory1112'
  | 'addCategory1314' | 'addCategory1518Open' | 'addCategoryMaster'
  | 'delete'

function ContextMenu({
  x,
  y,
  target,
  onClose,
  onAction,
}: {
  x: number
  y: number
  target: SelectedItem
  onClose: () => void
  onAction: (action: MenuAction) => void
}) {
  const { t } = useLang()

  const style: CSSProperties = {
    position: 'fixed',
    left: x,
    top: y,
    zIndex: 1000,
  }

  function item(label: string, disabled: boolean, action?: MenuAction): ReactNode {
    return (
      <button
        disabled={disabled}
        className={`w-full text-left px-4 py-1 text-xs whitespace-nowrap transition-colors ${
          disabled
            ? 'text-gray-300 cursor-default'
            : 'text-gray-700 hover:bg-blue-600 hover:text-white'
        }`}
        onClick={(e) => {
          e.stopPropagation()
          if (action) onAction(action)
          else onClose()
        }}
      >
        {label}
      </button>
    )
  }

  const isCompetition = target.type === 'competition'
  const isSession = target.type === 'session'
  const isEvent = target.type === 'event'
  const isAgeGroup = target.type === 'agegroup'

  const canAddEvent = isSession || isEvent
  const canAddCategory = isEvent || isAgeGroup

  return (
    <div
      style={style}
      className="bg-white border border-gray-300 shadow-xl py-1 min-w-[280px]"
      onClick={(e) => e.stopPropagation()}
    >
      {item(t.events.menu.addSession, !isCompetition && !isSession, 'addSession')}
      <div className="my-1 border-t border-gray-200" />
      {item(t.events.menu.addDirectFinal, !canAddEvent, 'addDirectFinal')}
      {item(t.events.menu.addSemiFinal, !canAddEvent, 'addSemiFinal')}
      {item(t.events.menu.addFinal, !canAddEvent, 'addFinal')}
      {item(t.events.menu.addMainHeat, !canAddEvent, 'addMainHeat')}
      {item(t.events.menu.addSeparateHeats, !canAddEvent, 'addSeparateHeats')}
      {item(t.events.menu.addTimeTrial, !canAddEvent, 'addTimeTrial')}
      {item(t.events.menu.addAward, !canAddEvent, 'addAward')}
      {item(t.events.menu.addBreak, !canAddEvent, 'addBreak')}
      <div className="my-1 border-t border-gray-200" />
      {item(t.events.menu.addCategory, !canAddCategory, 'addCategory')}
      {item(t.events.menu.addCategory10, !canAddCategory, 'addCategory10')}
      {item(t.events.menu.addCategory1112, !canAddCategory, 'addCategory1112')}
      {item(t.events.menu.addCategory1314, !canAddCategory, 'addCategory1314')}
      {item(t.events.menu.addCategory1518Open, !canAddCategory, 'addCategory1518Open')}
      {item(t.events.menu.addCategoryMaster, !canAddCategory, 'addCategoryMaster')}
      <div className="my-1 border-t border-gray-200" />
      {item(t.events.menu.delete, isCompetition, 'delete')}
    </div>
  )
}

// ─── Properties Panel ─────────────────────────────────────────────────────────

function PropertiesPanel({ selected, onUpdateSession, onMeetNameChange }: { selected: SelectedItem; onUpdateSession: (sessionId: number, data: Record<string, unknown>) => void; onMeetNameChange: (name: string) => void }) {
  if (selected.type === 'competition') {
    return <CompetitionPropertiesPanel onMeetNameChange={onMeetNameChange} />
  }

  if (selected.type === 'session') {
    const s = selected.session
    return <SessionPropertiesPanel session={s} onUpdate={(data) => onUpdateSession(s.id, data)} />
  }

  if (selected.type === 'event') {
    return <EventPropertiesPanel event={selected.event} />
  }

  // Age group
  const { group, event } = selected as { group: AgeGroup; event: CompetitionEvent }
  return <AgeGroupPropertiesPanel group={group} event={event} />
}

// ─── Age Group Properties Panel (editable) ───────────────────────────────────

function AgeGroupPropertiesPanel({ group, event }: { group: AgeGroup; event: CompetitionEvent }) {
  const { t } = useLang()
  const api = useApi()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [minAge, setMinAge] = useState(group.minAge)
  const [maxAge, setMaxAge] = useState<number | null>(group.maxAge)
  const [gender, setGender] = useState(group.gender)

  useEffect(() => {
    setMinAge(group.minAge)
    setMaxAge(group.maxAge)
    setGender(group.gender)
  }, [group.id, group.minAge, group.maxAge, group.gender])

  function toggleSection(title: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(title) ? next.delete(title) : next.add(title)
      return next
    })
  }

  function save(data: Record<string, unknown>) {
    api.updateAgeGroup(group.id, data)
  }

  const gLabel = t.events.genderLabel(event.gender)
  const headerTitle = `${t.events.props.general} - ${event.number}. ${gLabel}, ${event.distance}m ${event.nameEn} / ${event.nameFr}, ${t.events.phaseLabel(event.phase)}`

  const genderOptions = [
    { value: 'M', label: 'M', intVal: 1 },
    { value: 'F', label: 'F', intVal: 2 },
    { value: 'X', label: 'X', intVal: 3 },
  ]

  function SectionHeader({ title }: { title: string }) {
    const isCollapsed = collapsed.has(title)
    return (
      <tr className="cursor-pointer select-none" onClick={() => toggleSection(title)}>
        <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
          <span className="mr-1 text-gray-500">{isCollapsed ? '▶' : '▼'}</span>
          {title}
        </td>
      </tr>
    )
  }

  function Row({ label, value }: { label: string; value?: string | boolean | number | null }) {
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          {value === true ? (
            <span className="text-blue-600">✓</span>
          ) : value === false || value === null || value === undefined || value === '' ? (
            <span className="text-gray-300">—</span>
          ) : (
            String(value)
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="text-xs">
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0">
        <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
          <rect x="4" y="4" width="12" height="12" rx="1" />
        </svg>
        {headerTitle}
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.props.designation}</div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.props.value}</div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          {/* Général */}
          <SectionHeader title={t.events.props.general} />
          {!collapsed.has(t.events.props.general) && (
            <>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.props.ageFrom}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="number"
                    min={5}
                    max={99}
                    className="w-16 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={minAge}
                    onChange={(e) => {
                      const v = Math.max(5, Math.min(99, Number(e.target.value) || 5))
                      setMinAge(v)
                    }}
                    onBlur={() => save({ agemin: minAge })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.props.ageTo}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="number"
                    min={5}
                    max={99}
                    placeholder="et plus"
                    className="w-16 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={maxAge ?? ''}
                    onChange={(e) => {
                      if (e.target.value === '') { setMaxAge(null); return }
                      const v = Math.max(5, Math.min(99, Number(e.target.value) || 5))
                      setMaxAge(v)
                    }}
                    onBlur={() => save({ agemax: maxAge })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.props.gender}</td>
                <td className="px-2 py-0.5">
                  <select
                    className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={gender}
                    onChange={(e) => {
                      setGender(e.target.value)
                      const opt = genderOptions.find((o) => o.value === e.target.value)
                      save({ gender: opt?.intVal ?? 3 })
                    }}
                  >
                    {genderOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </td>
              </tr>
            </>
          )}

          {/* Filtres supplémentaires */}
          <SectionHeader title={t.events.props.additionalFilters} />
          {!collapsed.has(t.events.props.additionalFilters) && (
            <>
              <Row label={t.events.props.nationalityLimit} value={null} />
              <Row label={t.events.props.nationsOnly} value={t.events.allNations} />
              <Row label={t.events.props.clubsOnly} value={t.events.allClubs} />
              <Row label={t.events.props.athleteLevels} value={null} />
              <Row label={t.events.props.fastestTime} value={null} />
              <Row label={t.events.props.slowestTime} value={null} />
              <Row label={t.events.props.paranation} value={null} />
            </>
          )}

          {/* Complément */}
          <SectionHeader title={t.events.props.complement} />
          {!collapsed.has(t.events.props.complement) && (
            <>
              <Row label={t.events.props.ranking} value={group.ranking ?? t.events.defaultRanking} />
              <Row label={t.events.props.countForMedals} value={group.countForMedalStats} />
              <Row label={t.events.props.usedForCombined} value={group.usedForCombined} />
              <Row label={t.events.props.numHeats} value={group.numHeats} />
              <Row label={t.events.props.alwaysSwimPrelims} value={group.alwaysSwimPrelims} />
              <Row label={t.events.props.advanceByTime} value={group.advanceByTime} />
              <Row label={t.events.props.laneOrderFinals} value={group.laneOrderInFinals} />
            </>
          )}

          {/* Autre */}
          <SectionHeader title={t.events.props.other} />
          {!collapsed.has(t.events.props.other) && (
            <>
              <Row label={t.events.props.name} value={null} />
              <Row label={t.events.props.abbreviation} value={null} />
              <Row label={t.events.props.winnerComment} value={null} />
              <Row label={t.events.props.externalId} value={null} />
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

function isYouthCategory(maxAge: number | null): boolean {
  return maxAge !== null && maxAge <= 14
}

function ageRangeLabel(minAge: number, maxAge: number | null, genderLabel: string): string {
  const upper = maxAge == null || maxAge < 0 ? null : maxAge
  if (upper == null) return `${minAge} ans et plus, ${genderLabel}`
  return `${minAge} - ${upper} ans, ${genderLabel}`
}

// ─── Event Properties Panel (editable, Splash-style) ──────────────────────────

function EventPropertiesPanel({ event }: { event: CompetitionEvent }) {
  const { t } = useLang()
  const api = useApi()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [evNumber, setEvNumber] = useState(event.number)
  const [roundName, setRoundName] = useState(event.nameFr)
  const [evGender, setEvGender] = useState(event.gender)
  const [masters, setMasters] = useState(false)
  const [scheduledTime, setScheduledTime] = useState(event.scheduledTime ?? '')
  const [swimStyles, setSwimStyles] = useState<SwimStyle[]>([])
  const [selectedStyleId, setSelectedStyleId] = useState<number | null>(null)

  useEffect(() => {
    setEvNumber(event.number)
    setRoundName(event.nameFr)
    setEvGender(event.gender)
    setScheduledTime(event.scheduledTime ?? '')
    setSelectedStyleId(event.swimstyleId ?? null)
    // Load swim styles
    api.getSwimStyles().then((styles) => setSwimStyles(styles)).catch(() => {})
  }, [event.id])

  function save(data: Record<string, unknown>) {
    api.updateEvent(event.id, data)
  }

  function toggleSection(title: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(title) ? next.delete(title) : next.add(title)
      return next
    })
  }

  function SectionHeader({ title }: { title: string }) {
    const isCollapsed = collapsed.has(title)
    return (
      <tr className="cursor-pointer select-none" onClick={() => toggleSection(title)}>
        <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
          <span className="mr-1 text-gray-500">{isCollapsed ? '▶' : '▼'}</span>
          {title}
        </td>
      </tr>
    )
  }

  const genderOptions = [
    { value: 'M', label: 'M' },
    { value: 'F', label: 'F' },
    { value: 'X', label: 'X' },
  ]

  const gLabel = t.events.genderLabel(event.gender)
  const headerTitle = `${event.number}. ${gLabel}, ${event.distance}m ${event.nameFr} / ${event.nameEn}`

  return (
    <div className="text-xs">
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0">
        <svg className="w-4 h-4 mr-2 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M3 3h14v14H3z" />
        </svg>
        {headerTitle}
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.designationCol}</div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.valueCol}</div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          {/* Général */}
          <SectionHeader title={t.events.eventPanel.general} />
          {!collapsed.has(t.events.eventPanel.general) && (
            <>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.number}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="number"
                    className="w-16 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={evNumber}
                    onChange={(e) => setEvNumber(Number(e.target.value) || 0)}
                    onBlur={() => save({ number: evNumber })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.designation}</td>
                <td className="px-2 py-0.5">
                  <select
                    className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={selectedStyleId ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value)
                      setSelectedStyleId(id)
                      save({ swimstyleid: id })
                    }}
                  >
                    <option value="">—</option>
                    {swimStyles.map((s) => (
                      <option key={s.id} value={s.id}>{s.distance} m {s.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.gender}</td>
                <td className="px-2 py-0.5">
                  <select
                    className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={evGender}
                    onChange={(e) => {
                      const v = e.target.value as 'M' | 'F' | 'X'
                      setEvGender(v)
                      save({ gender: v === 'M' ? 1 : v === 'F' ? 2 : 3 })
                    }}
                  >
                    {genderOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.mastersSwim}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={masters}
                    onChange={(e) => { setMasters(e.target.checked); save({ masters: e.target.checked }) }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.externalId}</td>
                <td className="px-2 py-0.5 text-gray-500">{event.id}</td>
              </tr>
            </>
          )}

          {/* Horaire */}
          <SectionHeader title={t.events.eventPanel.schedule} />
          {!collapsed.has(t.events.eventPanel.schedule) && (
            <>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.startTime}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="time"
                    className="w-28 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    onBlur={() => save({ daytime: scheduledTime || null })}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.duration}</td>
                <td className="px-2 py-0.5 text-gray-500">—</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ─── Competition Properties Panel (editable, Splash-style) ───────────────────

function CompetitionPropertiesPanel({ onMeetNameChange }: { onMeetNameChange: (name: string) => void }) {
  const { t } = useLang()
  const api = useApi()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [meetValues, setMeetValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getMeetConfig().then((cfg) => {
      setMeetValues(cfg ?? {})
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  function toggleSection(title: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(title) ? next.delete(title) : next.add(title)
      return next
    })
  }

  function saveField(key: string, value: string, type: string = 'S') {
    api.setMeetConfig({ [key]: { type, value } })
    setMeetValues((prev) => ({ ...prev, [key]: value }))
    if (key === 'NAME') onMeetNameChange(value)
  }

  function SectionHeader({ title }: { title: string }) {
    const isCollapsed = collapsed.has(title)
    return (
      <tr className="cursor-pointer select-none" onClick={() => toggleSection(title)}>
        <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
          <span className="mr-1 text-gray-500">{isCollapsed ? '▶' : '▼'}</span>
          {title}
        </td>
      </tr>
    )
  }

  function TextFieldRow({ label, fieldKey }: { label: string; fieldKey: string }) {
    const [val, setVal] = useState(meetValues[fieldKey] ?? '')
    useEffect(() => { setVal(meetValues[fieldKey] ?? '') }, [meetValues[fieldKey]])
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="text"
            className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => saveField(fieldKey, val)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </td>
      </tr>
    )
  }

  function NumberFieldRow({ label, fieldKey }: { label: string; fieldKey: string }) {
    const [val, setVal] = useState(meetValues[fieldKey] ?? '')
    useEffect(() => { setVal(meetValues[fieldKey] ?? '') }, [meetValues[fieldKey]])
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="number"
            className="w-20 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => saveField(fieldKey, val, 'I')}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </td>
      </tr>
    )
  }

  function CheckFieldRow({ label, fieldKey }: { label: string; fieldKey: string }) {
    const checked = meetValues[fieldKey] === 'T' || meetValues[fieldKey] === '1'
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="checkbox"
            className="w-4 h-4"
            checked={checked}
            onChange={(e) => saveField(fieldKey, e.target.checked ? 'T' : 'F', 'B')}
          />
        </td>
      </tr>
    )
  }

  function SelectFieldRow({ label, fieldKey, options, type }: { label: string; fieldKey: string; options: { value: string; label: string }[]; type?: string }) {
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <select
            className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            value={meetValues[fieldKey] ?? ''}
            onChange={(e) => saveField(fieldKey, e.target.value, type ?? 'I')}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </td>
      </tr>
    )
  }

  if (loading) {
    return <div className="p-4 text-xs text-gray-400">Chargement…</div>
  }

  const courseOptions = [
    { value: '1', label: t.events.meetPanel.pool50m },
    { value: '2', label: t.events.meetPanel.pool25y },
    { value: '3', label: t.events.meetPanel.pool25m },
  ]
  const timingOptions = [
    { value: '0', label: t.events.meetPanel.timingManual },
    { value: '1', label: t.events.meetPanel.timingSemiAuto },
    { value: '2', label: t.events.meetPanel.timingAutomatic },
  ]
  const touchpadOptions = [
    { value: '0', label: t.events.meetPanel.touchNone },
    { value: '1', label: t.events.meetPanel.touchOneSide },
    { value: '2', label: t.events.meetPanel.touchBothSides },
  ]
  const ageCalcOptions = [
    { value: '0', label: t.events.meetPanel.ageByBirthYear },
    { value: '1', label: t.events.meetPanel.ageByExactDate },
  ]

  return (
    <div className="text-xs">
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0 z-10">
        <svg className="w-4 h-4 mr-2 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-.293.707L13 10.414V17a1 1 0 01-.553.894l-4 2A1 1 0 017 19v-8.586L3.293 6.707A1 1 0 013 6V4z" />
        </svg>
        Compétition
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.designationCol}</div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.valueCol}</div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          {/* Général */}
          <SectionHeader title={t.events.meetPanel.general} />
          {!collapsed.has(t.events.meetPanel.general) && (
            <>
              <TextFieldRow label={t.events.meetPanel.name} fieldKey="NAME" />
              <NumberFieldRow label={t.events.meetPanel.number} fieldKey="MEETNUMBER" />
              <TextFieldRow label={t.events.meetPanel.meetType} fieldKey="MEETTYPE" />
              <CheckFieldRow label={t.events.meetPanel.masters} fieldKey="MASTERS" />
            </>
          )}

          {/* Installation */}
          <SectionHeader title={t.events.meetPanel.installation} />
          {!collapsed.has(t.events.meetPanel.installation) && (
            <>
              <TextFieldRow label={t.events.meetPanel.poolName} fieldKey="FACILITYNAME" />
              <TextFieldRow label={t.events.meetPanel.street} fieldKey="FACILITYSTREET" />
              <TextFieldRow label={t.events.meetPanel.city} fieldKey="CITY" />
              <TextFieldRow label={t.events.meetPanel.state} fieldKey="STATE" />
              <TextFieldRow label={t.events.meetPanel.nation} fieldKey="NATION" />
            </>
          )}

          {/* International */}
          <SectionHeader title={t.events.meetPanel.international} />
          {!collapsed.has(t.events.meetPanel.international) && (
            <>
              <TextFieldRow label={t.events.meetPanel.nameEn} fieldKey="NAMEEN" />
              <TextFieldRow label={t.events.meetPanel.cityEn} fieldKey="CITYEN" />
            </>
          )}

          {/* Calcul et affichage de l'âge */}
          <SectionHeader title={t.events.meetPanel.ageCalc} />
          {!collapsed.has(t.events.meetPanel.ageCalc) && (
            <>
              <SelectFieldRow label={t.events.meetPanel.ageCalcType} fieldKey="AGECALCTYPE" options={ageCalcOptions} />
              <TextFieldRow label={t.events.meetPanel.ageDate} fieldKey="AGEDATE" />
              <TextFieldRow label={t.events.meetPanel.ageDisplay} fieldKey="AGEDISPLAY" />
            </>
          )}

          {/* Affichage et ordre des noms */}
          <SectionHeader title={t.events.meetPanel.nameDisplay} />
          {!collapsed.has(t.events.meetPanel.nameDisplay) && (
            <>
              <TextFieldRow label={t.events.meetPanel.nameOrder} fieldKey="NAMEOPTIONS" />
            </>
          )}

          {/* Installation compétition et chronométrage */}
          <SectionHeader title={t.events.meetPanel.timing} />
          {!collapsed.has(t.events.meetPanel.timing) && (
            <>
              <SelectFieldRow label={t.events.meetPanel.poolLength} fieldKey="COURSE" options={courseOptions} />
              <NumberFieldRow label={t.events.meetPanel.laneMin} fieldKey="LANEMIN" />
              <NumberFieldRow label={t.events.meetPanel.laneMax} fieldKey="LANEMAX" />
              <SelectFieldRow label={t.events.meetPanel.timingSystem} fieldKey="TIMING" options={timingOptions} />
              <SelectFieldRow label={t.events.meetPanel.touchpads} fieldKey="TOUCHPADMODE" options={touchpadOptions} />
              <CheckFieldRow label={t.events.meetPanel.roundToTenths} fieldKey="ROUNDTOTENTHS" />
            </>
          )}

          {/* Autres */}
          <SectionHeader title={t.events.meetPanel.others} />
          {!collapsed.has(t.events.meetPanel.others) && (
            <>
              <TextFieldRow label={t.events.meetPanel.startMethod} fieldKey="STARTMETHOD" />
              <NumberFieldRow label={t.events.meetPanel.reserveCount} fieldKey="RESERVECOUNT" />
              <TextFieldRow label={t.events.meetPanel.deadline} fieldKey="DEADLINE" />
            </>
          )}

          {/* Organisateur */}
          <SectionHeader title={t.events.meetPanel.organizer} />
          {!collapsed.has(t.events.meetPanel.organizer) && (
            <>
              <TextFieldRow label={t.events.meetPanel.organizerName} fieldKey="ORGANIZER" />
              <TextFieldRow label={t.events.meetPanel.hostClub} fieldKey="HOSTCLUB" />
              <TextFieldRow label={t.events.meetPanel.website} fieldKey="ORGANIZERURL" />
              <TextFieldRow label={t.events.meetPanel.resultUrl} fieldKey="RESULTURL" />
            </>
          )}

          {/* Lieu de contact */}
          <SectionHeader title={t.events.meetPanel.contact} />
          {!collapsed.has(t.events.meetPanel.contact) && (
            <>
              <TextFieldRow label={t.events.meetPanel.contactName} fieldKey="CONTACTNAME" />
              <TextFieldRow label={t.events.meetPanel.contactEmail} fieldKey="CONTACTEMAIL" />
              <TextFieldRow label={t.events.meetPanel.contactInternet} fieldKey="CONTACTINTERNET" />
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ─── Session Properties Panel (editable, matches Splash layout) ───────────────

function SessionPropertiesPanel({
  session,
  onUpdate,
}: {
  session: Session
  onUpdate: (data: Record<string, unknown>) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  function toggleSection(title: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(title) ? next.delete(title) : next.add(title)
      return next
    })
  }

  function SectionHeader({ title }: { title: string }) {
    const isCollapsed = collapsed.has(title)
    return (
      <tr className="cursor-pointer select-none" onClick={() => toggleSection(title)}>
        <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
          <span className="mr-1 text-gray-500">{isCollapsed ? '▶' : '▼'}</span>
          {title}
        </td>
      </tr>
    )
  }

  function TextRow({ label, value, field }: { label: string; value: string; field: string }) {
    if (collapsed.has(currentSection)) return null
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="text"
            className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            defaultValue={value}
            onBlur={(e) => {
              if (e.target.value !== value) onUpdate({ [field]: e.target.value || null })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </td>
      </tr>
    )
  }

  function NumberRow({ label, value, field }: { label: string; value: number | undefined; field: string }) {
    if (collapsed.has(currentSection)) return null
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="number"
            className="w-24 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            defaultValue={value ?? ''}
            onBlur={(e) => {
              const v = e.target.value ? Number(e.target.value) : null
              onUpdate({ [field]: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          />
        </td>
      </tr>
    )
  }

  function TimeRow({ label, value, field }: { label: string; value: string | undefined; field: string }) {
    if (collapsed.has(currentSection)) return null
    // Pad time to HH:MM format for <input type="time">
    const padded = value ? value.replace(/^(\d):/, '0$1:') : ''
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="time"
            className="w-28 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            defaultValue={padded}
            onBlur={(e) => {
              onUpdate({ [field]: e.target.value || null })
            }}
          />
        </td>
      </tr>
    )
  }

  function CheckRow({ label, value, field }: { label: string; value: boolean; field: string }) {
    if (collapsed.has(currentSection)) return null
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="checkbox"
            className="w-4 h-4"
            checked={value}
            onChange={(e) => onUpdate({ [field]: e.target.checked })}
          />
        </td>
      </tr>
    )
  }

  function SelectRow({ label, value, field, options }: { label: string; value: string | number | undefined; field: string; options: { value: string | number; label: string }[] }) {
    if (collapsed.has(currentSection)) return null
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <select
            className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            value={value ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value)
              onUpdate({ [field]: v })
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </td>
      </tr>
    )
  }

  function ReadOnlyRow({ label, value }: { label: string; value: string | number | undefined }) {
    if (collapsed.has(currentSection)) return null
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5 text-gray-500">{value ?? '—'}</td>
      </tr>
    )
  }

  let currentSection = ''

  const poolOptions = [
    { value: 1, label: 'Bassin 50m' },
    { value: 2, label: 'Bassin 25m (SCM)' },
    { value: 3, label: 'Bassin 25m (SCY)' },
  ]
  const timingOptions = [
    { value: '', label: '—' },
    { value: 0, label: 'Manuel' },
    { value: 1, label: 'Semi-automatique' },
    { value: 2, label: 'Automatique' },
  ]
  const touchpadOptions = [
    { value: '', label: '—' },
    { value: 0, label: 'Aucune' },
    { value: 1, label: "Seulement côté arrivée" },
    { value: 2, label: 'Les deux côtés' },
  ]

  const courseValue = session.poolSize === 50 ? 1 : 2

  return (
    <div className="text-xs">
      {/* Header */}
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0 z-10">
        <svg className="w-4 h-4 mr-2 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
          <rect x="3" y="4" width="14" height="13" rx="1" />
          <path d="M7 2v4M13 2v4M3 9h14" stroke="white" strokeWidth="1.5" fill="none" />
        </svg>
        Session
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">Désignation</div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">Valeur</div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          {/* Général */}
          {(() => { currentSection = 'Général'; return null })()}
          <SectionHeader title="Général" />
          <NumberRow label="Numéro" value={session.number} field="sessionnumber" />
          <TextRow label="Date" value={session.date ?? ''} field="date" />
          <TextRow label="Nom" value={session.name} field="name" />

          {/* Horaire */}
          {(() => { currentSection = 'Horaire (heure de début)'; return null })()}
          <SectionHeader title="Horaire (heure de début)" />
          <TimeRow label="Heure de départ première épreuve" value={session.time} field="daytime" />
          <TimeRow label="Temps de fin de la dernière épreuve" value={session.endTime} field="endtime" />
          <TimeRow label="Séance des chefs d'équipes" value={session.officialMeeting} field="officialmeeting" />
          <TimeRow label="Début de l'échauffement" value={session.warmupFrom} field="warmupfrom" />
          <TimeRow label="Fin de l'échauffement" value={session.warmupUntil} field="warmupuntil" />
          <TextRow label="Remarque" value={session.remarks ?? ''} field="remarks" />

          {/* Piscine et chronométrage */}
          {(() => { currentSection = 'Piscine et chronométrage'; return null })()}
          <SectionHeader title="Piscine et chronométrage" />
          <SelectRow label="Longueur du bassin" value={courseValue} field="course" options={poolOptions} />
          <NumberRow label="N° de la première ligne" value={session.laneMin} field="lanemin" />
          <NumberRow label="N° de la dernière ligne" value={session.laneMax} field="lanemax" />
          <SelectRow label="Installation de chronométrage" value={session.timing} field="timing" options={timingOptions} />
          <SelectRow label="Plaques de touches" value={session.touchpadMode} field="touchpadmode" options={touchpadOptions} />
          <CheckRow label="Résultats au dixième de secondes" value={session.roundToTenths ?? false} field="roundtotenths" />

          {/* Jury */}
          {(() => { currentSection = 'Jury'; return null })()}
          <SectionHeader title="Jury" />
          <TextRow label="Remarque" value={session.remarksJury ?? ''} field="remarksjury" />

          {/* Autres */}
          {(() => { currentSection = 'Autres'; return null })()}
          <SectionHeader title="Autres" />
          <NumberRow label="Nbre max. d'inscriptions par athlète" value={session.maxEntriesAthlete} field="maxentriesathlete" />
          <NumberRow label="Nbre max. d'inscriptions de relais par..." value={session.maxEntriesRelay} field="maxentriesrelay" />
          <NumberRow label="Frais d'inscription par session: par at..." value={session.feeAthlete} field="feeathlete" />
        </tbody>
      </table>
    </div>
  )
}
