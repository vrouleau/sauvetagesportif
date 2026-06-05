import { useState, useEffect, useCallback, useRef, type ReactNode, type CSSProperties, type MouseEvent } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
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
  const [multiSelectedGroups, setMultiSelectedGroups] = useState<Set<number>>(new Set())

  // Clear multi-selection when selecting non-agegroup items
  useEffect(() => {
    if (selected.type !== 'agegroup') setMultiSelectedGroups(new Set())
  }, [selected.type])

  const lastClickedGroupRef = useRef<{ eventId: number; groupId: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [meetName, setMeetName] = useState<string>('')
  const [poolSize, setPoolSize] = useState<number>(50)
  const { prompt, promptState, handleConfirm, handleCancel } = usePromptDialog()

  // Resizable left panel
  const [leftPanelWidth, setLeftPanelWidth] = useState(480)
  const draggingPanel = useRef(false)

  useEffect(() => {
    function onMouseMove(e: globalThis.MouseEvent) {
      if (!draggingPanel.current) return
      setLeftPanelWidth(Math.max(300, Math.min(900, e.clientX)))
    }
    function onMouseUp() {
      draggingPanel.current = false
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

  function startPanelDrag() {
    draggingPanel.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  // ── Drag-over session expansion (hover 500ms to expand collapsed session) ──
  const dragOverSessionRef = useRef<number | null>(null)
  const dragOverSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleDragOver(event: DragOverEvent) {
    const { over } = event
    if (!over) {
      // Left all droppables — cancel timer
      if (dragOverSessionTimerRef.current) clearTimeout(dragOverSessionTimerRef.current)
      dragOverSessionRef.current = null
      return
    }

    const overId = String(over.id)
    // Check if hovering over a session droppable
    if (overId.startsWith('session-')) {
      const sessionId = Number(overId.replace('session-', ''))
      if (dragOverSessionRef.current !== sessionId) {
        dragOverSessionRef.current = sessionId
        if (dragOverSessionTimerRef.current) clearTimeout(dragOverSessionTimerRef.current)
        dragOverSessionTimerRef.current = setTimeout(() => {
          setExpandedSessions((prev) => {
            const next = new Set(prev)
            next.add(sessionId)
            sessionStorage.setItem('eventsPage_expandedSessions', JSON.stringify([...next]))
            return next
          })
        }, 500)
      }
    } else {
      // Over an event item — cancel session timer
      if (dragOverSessionTimerRef.current) clearTimeout(dragOverSessionTimerRef.current)
      dragOverSessionRef.current = null
    }
  }

  function handleDragEndWrapper(event: DragEndEvent) {
    // Clean up hover timer
    if (dragOverSessionTimerRef.current) clearTimeout(dragOverSessionTimerRef.current)
    dragOverSessionRef.current = null
    handleDragEnd(event)
  }

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

      // Restore expanded state from sessionStorage, or start collapsed on first load
      const storedSessions = sessionStorage.getItem('eventsPage_expandedSessions')
      const storedEvents = sessionStorage.getItem('eventsPage_expandedEvents')

      if (storedSessions && storedEvents) {
        setExpandedSessions(new Set(JSON.parse(storedSessions)))
        setExpandedEvents(new Set(JSON.parse(storedEvents)))
      } else {
        // Start with all sessions/events collapsed by default
        setExpandedSessions(new Set())
        setExpandedEvents(new Set())
      }

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
      sessionStorage.setItem('eventsPage_expandedSessions', JSON.stringify([...next]))
      return next
    })
  }

  function toggleEvent(id: number) {
    setExpandedEvents((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      sessionStorage.setItem('eventsPage_expandedEvents', JSON.stringify([...next]))
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
      // Pass distance=0 and styleName='' to signal "pick for me" to the backend
      const result = await api.createEvent(targetSession.id, newNum, 'X', 0, phase, '')
      realId = result.id
    } catch {
      window.alert("Erreur lors de la création de l'épreuve")
      return
    }
    // Reload sessions to get the full event data (name from swimstyle)
    const updatedSessions = await api.getSessions()
    setLocalSessions(updatedSessions)
    // Find the newly created event and select it
    for (const s of updatedSessions) {
      const ev = s.events.find((e: CompetitionEvent) => e.id === realId)
      if (ev) {
        setSelected({ type: 'event', event: ev, session: s })
        setExpandedSessions((prev) => new Set([...prev, s.id]))
        break
      }
    }
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

    // Multi-delete age groups
    if (multiSelectedGroups.size > 0 && selected.type === 'agegroup') {
      const count = multiSelectedGroups.size
      if (!window.confirm(`${t.events.toolbar.delete} (${count})?`)) return
      try {
        const { event } = selected
        for (const groupId of multiSelectedGroups) {
          await api.deleteAgeGroup(groupId)
        }
        const updatedEvent = { ...event, ageGroups: event.ageGroups.filter((g) => !multiSelectedGroups.has(g.id)) }
        setLocalSessions((prev) =>
          prev.map((s) => ({
            ...s,
            events: s.events.map((e) => (e.id === event.id ? updatedEvent : e)),
          }))
        )
        setMultiSelectedGroups(new Set())
        const parentSession = localSessions.find((s) => s.events.some((e) => e.id === event.id))
        if (parentSession) setSelected({ type: 'event', event: updatedEvent, session: parentSession })
      } catch {
        window.alert('Erreur lors de la suppression')
      }
      return
    }

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

  async function handleImportMeet() {
    if (!api.importMeet) return
    const result = await api.importMeet()
    if (result.ok) {
      // Trigger reload by re-fetching sessions
      setLoading(true)
      api.getSessions().then((sessions) => {
        setLocalSessions(sessions)
        setLoading(false)
      }).catch(() => setLoading(false))
      api.getMeetConfig().then((cfg) => {
        if (cfg?.NAME) setMeetName(cfg.NAME)
        const course = cfg?.COURSE
        if (course === '3' || course === '2') setPoolSize(25)
        else setPoolSize(50)
      }).catch(() => {})
    } else if (result.error) {
      window.alert(result.error)
    }
  }

  async function handleExportMeet() {
    if (!api.exportMeet) return
    const result = await api.exportMeet()
    if (!result.ok && result.error) {
      window.alert(result.error)
    }
  }

  async function handleNewMeet(meetType: 'pool' | 'beach') {
    if (!api.createMeet) return
    if (!window.confirm(t.events.toolbar.confirmNewMeet)) return
    setLoading(true)
    try {
      const result = await api.createMeet(meetType)
      if (!result.ok) {
        if (result.error) window.alert(result.error)
        setLoading(false)
        return
      }
      const [sessions, cfg] = await Promise.all([api.getSessions(), api.getMeetConfig()])
      setLocalSessions(sessions)
      setSelected({ type: 'competition' })
      setExpandedSessions(new Set())
      setExpandedEvents(new Set())
      sessionStorage.removeItem('eventsPage_expandedSessions')
      sessionStorage.removeItem('eventsPage_expandedEvents')
      if (cfg?.NAME) setMeetName(cfg.NAME)
      const course = cfg?.COURSE
      setPoolSize((course === '3' || course === '2') ? 25 : 50)
    } catch {
      window.alert('Erreur lors de la création du meet')
    } finally {
      setLoading(false)
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
        else if (key === 'startdate') localUpdate.date = val as string | undefined
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

  async function handleUpdateEvent(eventId: number, sessionId: number, data: Record<string, unknown>) {
    try {
      await api.updateEvent(eventId, data)
      // Map DB field names to local CompetitionEvent property names
      const localUpdate: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(data)) {
        if (key === 'daytime') localUpdate.scheduledTime = val as string | undefined
        else if (key === 'duration') localUpdate.duration = val as string | undefined
        else if (key === 'roundname') { localUpdate.nameFr = val as string; localUpdate.nameEn = val as string }
        else if (key === 'comment') { localUpdate.nameFr = val as string; localUpdate.nameEn = val as string }
        else if (key === 'eventnumber') localUpdate.number = val as number
        else if (key === 'finalorder') localUpdate.finalOrder = val as number | null
        else if (key === 'swimstyleid') localUpdate.swimstyleId = val as number | null
        else if (key === 'maxentries') localUpdate.maxEntries = val as number | null
        else if (key === 'gender') {
          const g = val as number | string
          localUpdate.gender = typeof g === 'number' ? (g === 1 ? 'M' : g === 2 ? 'F' : 'X') : g
        }
      }

      // If swimstyle changed, reload to get the new event name from the DB
      if ('swimstyleid' in data) {
        // Find the style name from the loaded session data or swim styles
        const styleId = data.swimstyleid as number
        // Update the local event with the new swimstyle info
        const updatedSessions = await api.getSessions()
        setLocalSessions(updatedSessions)
        // Find and re-select the updated event
        for (const s of updatedSessions) {
          const ev = s.events.find((e: CompetitionEvent) => e.id === eventId)
          if (ev) {
            setSelected({ type: 'event', event: ev, session: s })
            break
          }
        }
        return
      }

      // Update local state
      setLocalSessions((prev) =>
        prev.map((s) => s.id === sessionId ? {
          ...s,
          events: s.events.map((e) => e.id === eventId ? { ...e, ...localUpdate } : e),
        } : s)
      )
      // Update selected if it's the same event
      if (selected.type === 'event' && selected.event.id === eventId) {
        setSelected({ type: 'event', event: { ...selected.event, ...localUpdate } as CompetitionEvent, session: selected.session })
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
        {(api.importMeet || api.exportMeet) && (
          <>
            <div className="w-px h-4 bg-gray-300 mx-1" />
            {api.importMeet && (
              <ToolbarBtn
                label={t.events.toolbar.importMeet}
                enabled={true}
                onClick={handleImportMeet}
              />
            )}
            {api.exportMeet && (
              <ToolbarBtn
                label={t.events.toolbar.exportMeet}
                enabled={localSessions.length > 0}
                onClick={handleExportMeet}
              />
            )}
          </>
        )}
        {api.createMeet && (
          <>
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <ToolbarBtn
              label={t.events.toolbar.newPoolMeet}
              enabled={true}
              danger
              onClick={() => handleNewMeet('pool')}
            />
            <ToolbarBtn
              label={t.events.toolbar.newBeachMeet}
              enabled={true}
              danger
              onClick={() => handleNewMeet('beach')}
            />
          </>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Left: tree ── */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEndWrapper} onDragOver={handleDragOver}>
        <div style={{ width: leftPanelWidth }} className="shrink-0 border-r border-gray-300 overflow-y-auto bg-white select-none text-xs">
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
          <SortableContext items={localSessions.flatMap(s => expandedSessions.has(s.id) ? s.events.map(e => `event-${e.id}`) : [])} strategy={verticalListSortingStrategy}>
          {localSessions.map((session) => {
            const expanded = expandedSessions.has(session.id)
            const isSessionSelected = selected.type === 'session' && selected.session.id === session.id
            return (
              <div key={session.id}>
                <DroppableSessionRow
                  session={session}
                  isSelected={isSessionSelected}
                  expanded={expanded}
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
                </DroppableSessionRow>

                {/* Events (sortable) */}
                {expanded && (
                    session.events.map((event) => (
                      <SortableEventItem
                        key={event.id}
                        event={event}
                        session={session}
                        isSelected={selected.type === 'event' && selected.event.id === event.id}
                        isExpanded={expandedEvents.has(event.id)}
                        selected={selected}
                        multiSelectedGroups={multiSelectedGroups}
                        onSelect={() => setSelected({ type: 'event', event, session })}
                        onToggle={() => { if (event.ageGroups.length > 0) toggleEvent(event.id) }}
                        onContextMenu={(e) => openContextMenu(e, { type: 'event', event, session })}
                        onSelectGroup={(group, e) => {
                          if (e.shiftKey && lastClickedGroupRef.current && lastClickedGroupRef.current.eventId === event.id) {
                            // Range select within the same event
                            const groups = event.ageGroups
                            const lastIdx = groups.findIndex(g => g.id === lastClickedGroupRef.current!.groupId)
                            const curIdx = groups.findIndex(g => g.id === group.id)
                            if (lastIdx >= 0 && curIdx >= 0) {
                              const from = Math.min(lastIdx, curIdx)
                              const to = Math.max(lastIdx, curIdx)
                              const rangeIds = groups.slice(from, to + 1).map(g => g.id)
                              setMultiSelectedGroups(new Set(rangeIds))
                              setSelected({ type: 'agegroup', group, event })
                            }
                          } else if (e.ctrlKey || e.metaKey) {
                            // Multi-select: toggle this group in the set
                            setMultiSelectedGroups((prev) => {
                              const next = new Set(prev)
                              if (next.has(group.id)) next.delete(group.id)
                              else next.add(group.id)
                              return next
                            })
                            setSelected({ type: 'agegroup', group, event })
                            lastClickedGroupRef.current = { eventId: event.id, groupId: group.id }
                          } else {
                            // Single select: clear multi-selection
                            setMultiSelectedGroups(new Set())
                            setSelected({ type: 'agegroup', group, event })
                            lastClickedGroupRef.current = { eventId: event.id, groupId: group.id }
                          }
                        }}
                        onContextMenuGroup={(e, group) => openContextMenu(e, { type: 'agegroup', group, event })}
                        t={t}
                      />
                    ))
                )}
              </div>
            )
          })}
          </SortableContext>
        </div>
        </DndContext>

        {/* Resizable divider */}
        <div
          onMouseDown={startPanelDrag}
          className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
        />

        {/* ── Right: properties panel ── */}
        <div className="flex-1 overflow-y-auto bg-white">
          <PropertiesPanel selected={selected} onUpdateSession={handleUpdateSession} onUpdateEvent={handleUpdateEvent} onMeetNameChange={setMeetName} />
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

// ─── Droppable Session Row (for drag-hover-to-expand) ─────────────────────────

function DroppableSessionRow({
  session,
  isSelected,
  expanded,
  onClick,
  onContextMenu,
  children,
}: {
  session: Session
  isSelected: boolean
  expanded: boolean
  onClick: () => void
  onContextMenu: (e: MouseEvent) => void
  children: ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: `session-${session.id}` })

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center h-6 pl-4 cursor-pointer tree-node ${isSelected ? 'bg-blue-600 text-white' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  )
}

// ─── Sortable Event Item ──────────────────────────────────────────────────────

function SortableEventItem({
  event, session, isSelected, isExpanded, selected, multiSelectedGroups, onSelect, onToggle, onContextMenu,
  onSelectGroup, onContextMenuGroup, t,
}: {
  event: CompetitionEvent
  session: Session
  isSelected: boolean
  isExpanded: boolean
  selected: SelectedItem
  multiSelectedGroups: Set<number>
  onSelect: () => void
  onToggle: () => void
  onContextMenu: (e: MouseEvent) => void
  onSelectGroup: (group: AgeGroup, e: MouseEvent) => void
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
          {event.nameEn}
          {event.maxEntries != null && (
            <span className="ml-1 text-orange-600 text-[10px]">[max:{event.maxEntries}]</span>
          )}
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
          const isGroupSelected = (selected.type === 'agegroup' && selected.group.id === group.id) || multiSelectedGroups.has(group.id)
          return (
            <div
              key={group.id}
              className={`flex items-center h-6 pl-16 cursor-pointer tree-node ${isGroupSelected ? 'bg-blue-600 text-white' : ''}`}
              onClick={(e) => onSelectGroup(group, e)}
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

function PropertiesPanel({ selected, onUpdateSession, onUpdateEvent, onMeetNameChange }: { selected: SelectedItem; onUpdateSession: (sessionId: number, data: Record<string, unknown>) => void; onUpdateEvent: (eventId: number, sessionId: number, data: Record<string, unknown>) => void; onMeetNameChange: (name: string) => void }) {
  if (selected.type === 'competition') {
    return <CompetitionPropertiesPanel onMeetNameChange={onMeetNameChange} />
  }

  if (selected.type === 'session') {
    const s = selected.session
    return <SessionPropertiesPanel session={s} onUpdate={(data) => onUpdateSession(s.id, data)} />
  }

  if (selected.type === 'event') {
    if (selected.event.isAdmin) {
      return <PausePropertiesPanel event={selected.event} onUpdate={(data) => onUpdateEvent(selected.event.id, selected.event.sessionId, data)} />
    }
    return <EventPropertiesPanel event={selected.event} onUpdate={(data) => onUpdateEvent(selected.event.id, selected.event.sessionId, data)} />
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
  const [numHeats, setNumHeats] = useState(group.numHeats)

  useEffect(() => {
    setMinAge(group.minAge)
    setMaxAge(group.maxAge)
    setGender(group.gender)
    setNumHeats(group.numHeats)
  }, [group.id, group.minAge, group.maxAge, group.gender, group.numHeats])

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
  const headerTitle = `${t.events.props.general} - ${event.number}. ${gLabel}, ${event.nameFr} / ${event.nameEn}, ${t.events.phaseLabel(event.phase)}`

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
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.props.numHeats}</td>
                <td className="px-2 py-0.5">
                  <input
                    type="number"
                    min={1}
                    max={26}
                    className="w-16 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={numHeats}
                    onChange={(e) => setNumHeats(Math.max(1, Math.min(26, parseInt(e.target.value, 10) || 1)))}
                    onBlur={() => {
                      if (numHeats !== group.numHeats) {
                        api.updateAgeGroup(group.id, { heatcount: numHeats } as unknown as Record<string, unknown>)
                      }
                    }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">Type de répartition (finales)</td>
                <td className="px-2 py-0.5">
                  <select
                    className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={group.finalSeedType ?? 0}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      api.updateAgeGroup(group.id, { finalseedtype: v } as unknown as Record<string, unknown>)
                    }}
                  >
                    <option value={0}>Éliminatoires (circle seed)</option>
                    <option value={1}>Finales (rapides en dernière série)</option>
                  </select>
                </td>
              </tr>
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

// ─── Pause Properties Panel (simplified: name, time, duration) ────────────────

function PausePropertiesPanel({ event, onUpdate }: { event: CompetitionEvent; onUpdate: (data: Record<string, unknown>) => void }) {
  const { t } = useLang()
  const [pauseName, setPauseName] = useState(event.nameFr)
  const [scheduledTime, setScheduledTime] = useState(event.scheduledTime ?? '')
  const [duration, setDuration] = useState(event.duration ?? '')

  useEffect(() => {
    setPauseName(event.nameFr)
    setScheduledTime(event.scheduledTime ?? '')
    setDuration(event.duration ?? '')
  }, [event.id, event.nameFr, event.scheduledTime, event.duration])

  function save(data: Record<string, unknown>) {
    onUpdate(data)
  }

  return (
    <div className="text-xs">
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0">
        <svg className="w-4 h-4 mr-2 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 3v5l3 3-1.5 1.5L8 11V5h2z" />
        </svg>
        Pause
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.designationCol}</div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">{t.events.eventPanel.valueCol}</div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          <tr className="border-b border-gray-100 hover:bg-gray-50">
            <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.name}</td>
            <td className="px-2 py-0.5">
              <input
                type="text"
                className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                value={pauseName}
                onChange={(e) => setPauseName(e.target.value)}
                onBlur={() => save({ comment: pauseName })}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </td>
          </tr>
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
            <td className="px-2 py-0.5">
              <input
                type="time"
                className="w-28 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                onBlur={() => save({ duration: duration || null })}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─── Event Properties Panel (editable, Splash-style) ──────────────────────────

function EventPropertiesPanel({ event, onUpdate }: { event: CompetitionEvent; onUpdate: (data: Record<string, unknown>) => void }) {
  const { t } = useLang()
  const api = useApi()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [evNumber, setEvNumber] = useState(event.number)
  const [roundName, setRoundName] = useState(event.nameFr)
  const [evGender, setEvGender] = useState(event.gender)
  const [masters, setMasters] = useState(false)
  const [scheduledTime, setScheduledTime] = useState(event.scheduledTime ?? '')
  const [duration, setDuration] = useState(event.duration ?? '')
  const [swimStyles, setSwimStyles] = useState<SwimStyle[]>([])
  const [selectedStyleId, setSelectedStyleId] = useState<number | null>(null)
  const [finalOrder, setFinalOrder] = useState<number>(event.finalOrder ?? 2)
  const [isBeach, setIsBeach] = useState(false)

  useEffect(() => {
    api.getMeetConfig().then(cfg => {
      setIsBeach((cfg?.MEETTYPE || '').toUpperCase() === 'BEACH')
    }).catch(() => {})
  }, [api])

  useEffect(() => {
    setEvNumber(event.number)
    setRoundName(event.nameFr)
    setEvGender(event.gender)
    setScheduledTime(event.scheduledTime ?? '')
    setDuration(event.duration ?? '')
    setSelectedStyleId(event.swimstyleId ?? null)
    setFinalOrder(event.finalOrder ?? 2)
    // Load swim styles
    api.getSwimStyles().then((styles) => {
      setSwimStyles(styles || [])
      // Ensure selectedStyleId is valid; if not, use the event's value
      const evStyleId = event.swimstyleId
      if (evStyleId && styles && styles.some((s: SwimStyle) => s.id === evStyleId)) {
        setSelectedStyleId(evStyleId)
      }
    }).catch(() => setSwimStyles([]))
  }, [event.id])

  function save(data: Record<string, unknown>) {
    onUpdate(data)
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
  const headerTitle = `${event.number}. ${gLabel}, ${event.nameFr} / ${event.nameEn}`

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
                    onBlur={() => save({ eventnumber: evNumber })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                </td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">{t.events.eventPanel.designation}</td>
                <td className="px-2 py-0.5">
                  <select
                    className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={String(selectedStyleId || '')}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null
                      setSelectedStyleId(id)
                      if (id) save({ swimstyleid: id })
                    }}
                  >
                    {swimStyles.map((s) => (
                      <option key={s.id} value={String(s.id)}>{s.name}</option>
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
                <td className="px-2 py-0.5">
                  <input
                    type="time"
                    className="w-28 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    onBlur={() => save({ duration: duration || null })}
                  />
                </td>
              </tr>
              {event.phase === 'Finale' && (
                <tr className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-0.5 text-gray-600 w-64">Ordre des finales</td>
                  <td className="px-2 py-0.5">
                    <select
                      className="border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                      value={finalOrder}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        setFinalOrder(v)
                        save({ finalorder: v })
                      }}
                    >
                      <option value={2}>Lent en premier (A dernier)</option>
                      <option value={1}>Rapide en premier (A premier)</option>
                    </select>
                  </td>
                </tr>
              )}
              {isBeach && (
              <tr className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-0.5 text-gray-600 w-64">Max participants / vague</td>
                <td className="px-2 py-0.5">
                  <input
                    type="number"
                    min={1}
                    className="border border-gray-200 rounded px-1 py-0 text-xs w-16 focus:border-blue-400 focus:outline-none"
                    defaultValue={event.maxEntries ?? ''}
                    placeholder={String(event.distance)}
                    onBlur={(e) => {
                      const v = e.target.value ? parseInt(e.target.value, 10) : null
                      save({ maxentries: v })
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                  <span className="ml-1 text-gray-400 text-[10px]">(défaut: {event.distance})</span>
                </td>
              </tr>
              )}
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

  function DateFieldRow({ label, fieldKey }: { label: string; fieldKey: string }) {
    // Splash date format: YYYYMMDDHHMMSSMMM → display as YYYY-MM-DD
    const raw = meetValues[fieldKey] ?? ''
    const toIso = (v: string): string => {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
      if (/^\d{8,}/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
      return v
    }
    const toSplash = (iso: string): string => {
      // YYYY-MM-DD → YYYYMMDD000000000
      return iso.replace(/-/g, '') + '000000000'
    }
    const [val, setVal] = useState(toIso(raw))
    useEffect(() => { setVal(toIso(meetValues[fieldKey] ?? '')) }, [meetValues[fieldKey]])
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
        <td className="px-2 py-0.5">
          <input
            type="date"
            className="w-40 border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => saveField(fieldKey, toSplash(val), 'D')}
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
        {t.events.meetPanel.title}
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
              <DateFieldRow label={t.events.meetPanel.ageDate} fieldKey="AGEDATE" />
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
              <DateFieldRow label={t.events.meetPanel.deadline} fieldKey="DEADLINE" />
            </>
          )}

          {/* Période de qualification */}
          <SectionHeader title={t.events.meetPanel.qualification} />
          {!collapsed.has(t.events.meetPanel.qualification) && (
            <>
              <TextFieldRow label={t.events.meetPanel.qualiFrom} fieldKey="QUALIFROM" />
              <TextFieldRow label={t.events.meetPanel.qualiTo} fieldKey="QUALITO" />
              <SelectFieldRow label={t.events.meetPanel.qualiCourse} fieldKey="QUALICOURSE" options={[
                { value: '0', label: t.events.meetPanel.qualiCourseAll },
                { value: '1', label: t.events.meetPanel.qualiCourseSame },
              ]} />
            </>
          )}

          {/* Répartition des séries */}
          <SectionHeader title={t.events.meetPanel.seeding} />
          {!collapsed.has(t.events.meetPanel.seeding) && (
            <>
              <SelectFieldRow label={t.events.meetPanel.seedingMethod} fieldKey="SEEDMETHOD" options={[
                { value: '0', label: t.events.meetPanel.seedingCircle },
                { value: '1', label: t.events.meetPanel.seedingPyramid },
                { value: '2', label: t.events.meetPanel.seedingStraight },
              ]} />
              <NumberFieldRow label={t.events.meetPanel.fastHeatCount} fieldKey="FASTHEATCOUNT" />
              <CheckFieldRow label={t.events.meetPanel.seedBonusLast} fieldKey="SEEDBONUSLAST" />
              <CheckFieldRow label={t.events.meetPanel.seedExhLast} fieldKey="SEEDEXHLAST" />
              <CheckFieldRow label={t.events.meetPanel.seedLateLast} fieldKey="SEEDLATELAST" />
              <CheckFieldRow label={t.events.meetPanel.combineAgeGroups} fieldKey="COMBINEAGEGROUPS" />
              <NumberFieldRow label={t.events.meetPanel.minPerHeat} fieldKey="MINPERHEAT" />
              <SelectFieldRow label={t.events.meetPanel.lanesOrder} fieldKey="LANESORDER" options={[
                { value: '0', label: t.events.meetPanel.lanesOrderDefault },
                { value: '1', label: t.events.meetPanel.lanesOrderCustom },
              ]} />
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
          <tr className="border-b border-gray-100 hover:bg-gray-50">
            <td className="px-4 py-0.5 text-gray-600 w-64">Date</td>
            <td className="px-2 py-0.5">
              <input
                type="date"
                className="w-full border border-gray-200 rounded px-1 py-0 text-xs focus:border-blue-400 focus:outline-none"
                defaultValue={session.date ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (session.date ?? '')) onUpdate({ startdate: e.target.value || null })
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </td>
          </tr>
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
