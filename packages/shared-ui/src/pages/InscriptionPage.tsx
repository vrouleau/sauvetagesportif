import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useLang } from '../context/LangContext'
import { useRegistrationApi } from '../context/RegistrationApiContext'
import type { RegistrationAPI, Club, AthleteListItem, RegistrationData } from '../data/api'
import CascadeTree from '../components/CascadeTree'
import AthleteDetailPanel from '../components/AthleteDetailPanel'
import RegistrationPanel from '../components/RegistrationPanel'
import AddAthleteDialog from '../components/AddAthleteDialog'
import { filterAthletes } from '../utils/filterAthletes'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InscriptionPageProps {
  role: string           // 'admin' | 'coach' | 'organizer'
  clubId?: string        // Pre-filter to single club (team-app coach mode)
  refreshKey?: number    // Trigger re-fetch
}

interface InscriptionPageState {
  clubs: Club[]
  athletesByClub: Map<number, AthleteListItem[]>
  selectedAthleteId: number | null
  registrationData: RegistrationData | null
  filterText: string
  loading: boolean
  error: string | null
}

interface AddAthleteDialogState {
  open: boolean
  clubId: number
  clubName: string
}

interface DeleteConfirmState {
  open: boolean
  athleteId: number
  athleteName: string
}

// ─── Data Loading (role-based) ────────────────────────────────────────────────

async function loadInscriptionData(
  api: RegistrationAPI,
  role: string,
  clubId?: string
): Promise<{ clubs: Club[]; athletesByClub: Map<number, AthleteListItem[]> }> {
  const clubs = await api.getClubs()
  const athletesByClub = new Map<number, AthleteListItem[]>()

  if (role !== 'admin' && clubId) {
    // Coach mode: only load their club
    const visibleClubs = clubs.filter(c => String(c.id) === clubId)
    for (const club of visibleClubs) {
      const athletes = await api.getAthletesByClub(String(club.id))
      athletesByClub.set(club.id, athletes)
    }
    return { clubs: visibleClubs, athletesByClub }
  }

  // Admin mode: load all clubs and their athletes
  for (const club of clubs) {
    const athletes = await api.getAthletesByClub(String(club.id))
    athletesByClub.set(club.id, athletes)
  }

  return { clubs, athletesByClub }
}

// ─── Custom Hook ──────────────────────────────────────────────────────────────

function useInscriptionPage(api: RegistrationAPI, role: string, clubId?: string, refreshKey?: number) {
  const [state, setState] = useState<InscriptionPageState>({
    clubs: [],
    athletesByClub: new Map(),
    selectedAthleteId: null,
    registrationData: null,
    filterText: '',
    loading: true,
    error: null,
  })

  const [addDialog, setAddDialog] = useState<AddAthleteDialogState>({ open: false, clubId: 0, clubName: '' })
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({ open: false, athleteId: 0, athleteName: '' })

  // Debounced filter
  const [debouncedFilter, setDebouncedFilter] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setFilterText = useCallback((text: string) => {
    setState(prev => ({ ...prev, filterText: text }))
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedFilter(text)
    }, 150)
  }, [])

  // Load data on mount and when refreshKey changes
  const loadData = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const { clubs, athletesByClub } = await loadInscriptionData(api, role, clubId)
      setState(prev => ({ ...prev, clubs, athletesByClub, loading: false }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load data',
      }))
    }
  }, [api, role, clubId])

  useEffect(() => {
    loadData()
  }, [loadData, refreshKey])

  // Handle athlete selection
  const handleSelectAthlete = useCallback(async (athleteId: number) => {
    setState(prev => ({ ...prev, selectedAthleteId: athleteId, registrationData: null }))
    try {
      const data = await api.getRegistration(athleteId)
      setState(prev => ({ ...prev, registrationData: data }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to load registration',
      }))
    }
  }, [api])

  // Reload registration data for currently selected athlete
  const reloadRegistration = useCallback(async () => {
    const { selectedAthleteId } = state
    if (!selectedAthleteId) return
    try {
      const data = await api.getRegistration(selectedAthleteId)
      setState(prev => ({ ...prev, registrationData: data }))
    } catch {
      // Silently fail on reload
    }
  }, [api, state.selectedAthleteId])

  // Add athlete flow
  const handleAddAthlete = useCallback((clubId: number) => {
    const club = state.clubs.find(c => c.id === clubId)
    setAddDialog({ open: true, clubId, clubName: club?.name || '' })
  }, [state.clubs])

  const confirmAddAthlete = useCallback(async (data: { first_name: string; last_name: string; gender: string; birthdate: string | null; license: string; club_id: number }) => {
    try {
      await api.addAthlete(data)
      setAddDialog({ open: false, clubId: 0, clubName: '' })
      // Refresh the club's athletes
      const athletes = await api.getAthletesByClub(String(data.club_id))
      setState(prev => {
        const newMap = new Map(prev.athletesByClub)
        newMap.set(data.club_id, athletes)
        return { ...prev, athletesByClub: newMap }
      })
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to add athlete',
      }))
    }
  }, [api])

  const cancelAddAthlete = useCallback(() => {
    setAddDialog({ open: false, clubId: 0, clubName: '' })
  }, [])

  // Delete athlete flow
  const handleDeleteAthlete = useCallback((athleteId: number, name: string) => {
    setDeleteConfirm({ open: true, athleteId, athleteName: name })
  }, [])

  const confirmDeleteAthlete = useCallback(async () => {
    const { athleteId } = deleteConfirm
    try {
      await api.deleteAthlete(athleteId)
      setDeleteConfirm({ open: false, athleteId: 0, athleteName: '' })
      // Clear selection if deleted athlete was selected
      setState(prev => {
        const newState = { ...prev }
        if (prev.selectedAthleteId === athleteId) {
          newState.selectedAthleteId = null
          newState.registrationData = null
        }
        return newState
      })
      // Refresh all athletes
      await loadData()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to delete athlete',
      }))
    }
  }, [api, deleteConfirm, loadData])

  const cancelDeleteAthlete = useCallback(() => {
    setDeleteConfirm({ open: false, athleteId: 0, athleteName: '' })
  }, [])

  // Save athlete field
  const handleSaveAthleteField = useCallback(async (field: string, value: string) => {
    if (!state.selectedAthleteId) return
    try {
      await api.updateAthlete(state.selectedAthleteId, { [field]: value })
      // Reload registration data to reflect changes
      const data = await api.getRegistration(state.selectedAthleteId)
      setState(prev => ({ ...prev, registrationData: data }))
      // Also refresh the athlete list for the tree
      await loadData()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to save',
      }))
    }
  }, [api, state.selectedAthleteId, loadData])

  // Registration actions
  const handleRegister = useCallback(async (eventId: number, timeMs: number | null, ageCode: string) => {
    if (!state.selectedAthleteId) return
    try {
      await api.register({ athlete_id: state.selectedAthleteId, event_id: eventId, entry_time_ms: timeMs, age_code: ageCode })
      await reloadRegistration()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to register',
      }))
    }
  }, [api, state.selectedAthleteId, reloadRegistration])

  const handleUnregister = useCallback(async (regId: number) => {
    try {
      await api.unregister(regId)
      await reloadRegistration()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to unregister',
      }))
    }
  }, [api, reloadRegistration])

  const handleUpdateEntryTime = useCallback(async (eventId: number, ageCode: string, timeMs: number | null) => {
    if (!state.selectedAthleteId) return
    try {
      await api.register({ athlete_id: state.selectedAthleteId, event_id: eventId, entry_time_ms: timeMs, age_code: ageCode })
      await reloadRegistration()
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to update entry time',
      }))
    }
  }, [api, state.selectedAthleteId, reloadRegistration])

  // Retry on error
  const handleRetry = useCallback(() => {
    setState(prev => ({ ...prev, error: null }))
    loadData()
  }, [loadData])

  // Filtered athletes (memoized)
  const { filtered: filteredAthletesByClub } = useMemo(
    () => filterAthletes(state.athletesByClub, debouncedFilter),
    [state.athletesByClub, debouncedFilter]
  )

  return {
    state,
    debouncedFilter,
    filteredAthletesByClub,
    addDialog,
    deleteConfirm,
    setFilterText,
    handleSelectAthlete,
    handleAddAthlete,
    confirmAddAthlete,
    cancelAddAthlete,
    handleDeleteAthlete,
    confirmDeleteAthlete,
    cancelDeleteAthlete,
    handleSaveAthleteField,
    handleRegister,
    handleUnregister,
    handleUpdateEntryTime,
    handleRetry,
  }
}

// ─── SplitPanel Component ─────────────────────────────────────────────────────

const DEFAULT_SPLIT = 35 // percent for top panel
const MIN_SPLIT = 15
const MAX_SPLIT = 70

function SplitPanel({ topPanel, bottomPanel }: { topPanel: React.ReactNode; bottomPanel: React.ReactNode }) {
  const [splitPct, setSplitPct] = useState(DEFAULT_SPLIT)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const y = e.clientY - rect.top
    const pct = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (y / rect.height) * 100))
    setSplitPct(pct)
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative">
      {/* Top panel */}
      <div className="overflow-auto" style={{ height: `${splitPct}%` }}>
        {topPanel}
      </div>

      {/* Draggable divider */}
      <div
        className="shrink-0 h-1.5 bg-gray-300 hover:bg-blue-400 cursor-row-resize flex items-center justify-center transition-colors"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="w-8 h-0.5 bg-gray-500 rounded" />
      </div>

      {/* Bottom panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {bottomPanel}
      </div>
    </div>
  )
}

// ─── InscriptionPage Component ────────────────────────────────────────────────

export default function InscriptionPage({ role, clubId, refreshKey }: InscriptionPageProps) {
  const { t } = useLang()
  const api = useRegistrationApi()
  const tr = t.registration

  const {
    state,
    debouncedFilter,
    filteredAthletesByClub,
    addDialog,
    deleteConfirm,
    setFilterText,
    handleSelectAthlete,
    handleAddAthlete,
    confirmAddAthlete,
    cancelAddAthlete,
    handleDeleteAthlete,
    confirmDeleteAthlete,
    cancelDeleteAthlete,
    handleSaveAthleteField,
    handleRegister,
    handleUnregister,
    handleUpdateEntryTime,
    handleRetry,
  } = useInscriptionPage(api, role, clubId, refreshKey)

  // Error state with retry
  if (state.error && state.clubs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-red-600 text-sm">{state.error}</p>
        <button
          onClick={handleRetry}
          className="px-4 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    )
  }

  // Loading state
  if (state.loading && state.clubs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 text-xs">{tr.loading}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter text box */}
      <div className="px-3 py-1.5 bg-white border-b border-gray-300 shrink-0">
        <input
          type="text"
          placeholder={tr.search}
          value={state.filterText}
          onChange={e => setFilterText(e.target.value)}
          className="border border-gray-300 px-2 py-1 rounded text-xs w-64"
        />
      </div>

      {/* Split-panel layout with draggable divider */}
      <SplitPanel
        topPanel={
          <CascadeTree
            clubs={state.clubs}
            athletesByClub={filteredAthletesByClub}
            selectedAthleteId={state.selectedAthleteId}
            filterText={debouncedFilter}
            defaultExpanded={false}
            onSelectAthlete={handleSelectAthlete}
            onAddAthlete={handleAddAthlete}
            onDeleteAthlete={handleDeleteAthlete}
            role={role}
          />
        }
        bottomPanel={
          state.selectedAthleteId && state.registrationData ? (
            <>
              <AthleteDetailPanel
                athlete={state.registrationData.athlete}
                athleteId={state.selectedAthleteId}
                onSave={handleSaveAthleteField}
              />
              <div className="flex-1 overflow-auto">
                <RegistrationPanel
                  data={state.registrationData}
                  athleteId={state.selectedAthleteId}
                  onRegister={handleRegister}
                  onUnregister={handleUnregister}
                  onUpdateEntryTime={handleUpdateEntryTime}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-xs italic">
              {tr.noAthleteSelected}
            </div>
          )
        }
      />

      {/* Inline error toast (when data is loaded but an operation fails) */}
      {state.error && state.clubs.length > 0 && (
        <div className="absolute bottom-4 right-4 bg-red-100 border border-red-300 text-red-700 text-xs px-3 py-2 rounded shadow">
          {state.error}
        </div>
      )}

      {/* Add Athlete Dialog */}
      {addDialog.open && (
        <AddAthleteDialog
          clubId={addDialog.clubId}
          clubName={addDialog.clubName}
          onConfirm={confirmAddAthlete}
          onCancel={cancelAddAthlete}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-400 shadow-xl w-[360px] text-xs">
            <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
              <span className="font-semibold">{tr.delete}</span>
              <button onClick={cancelDeleteAthlete} className="hover:text-gray-300 text-lg leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-700">
                {`Delete ${deleteConfirm.athleteName}?`}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                This will also remove all registrations for this athlete.
              </p>
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-gray-200 bg-gray-50 gap-2">
              <button
                onClick={cancelDeleteAthlete}
                className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
              >
                {t.athletes.dialog.cancel}
              </button>
              <button
                onClick={confirmDeleteAthlete}
                className="px-4 py-1 bg-red-600 text-white hover:bg-red-700 border border-red-700"
              >
                {tr.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
