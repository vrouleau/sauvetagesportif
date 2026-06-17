// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

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

interface IndividualEntryPageProps {
  role: string           // 'admin' | 'coach' | 'organizer'
  clubId?: string        // Pre-filter to single club (team-app coach mode)
  refreshKey?: number    // Trigger re-fetch
  onImportLxf?: () => void   // Callback to trigger LXF import (individual + relay entries)
  onExportLxf?: () => void   // Callback to trigger LXF export (individual + relay entries)
}

interface IndividualEntryPageState {
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

// ─── Closure Date Check ───────────────────────────────────────────────────────

/**
 * Returns true if the closure date has passed (after 23:59:59 on that day).
 * Returns false if no closure date is set.
 */
function isClosureDatePassed(closureDate: string | null | undefined): boolean {
  if (!closureDate) return false
  const closure = new Date(closureDate)
  // Set to end of day (23:59:59.999)
  closure.setHours(23, 59, 59, 999)
  return new Date() > closure
}

// ─── Data Loading (role-based) ────────────────────────────────────────────────

async function loadInscriptionData(
  api: RegistrationAPI,
  role: string,
  clubId?: string
): Promise<{ clubs: Club[]; athletesByClub: Map<number, AthleteListItem[]> }> {
  const clubs = await api.getClubs()
  const athletesByClub = new Map<number, AthleteListItem[]>()

  if (role === 'coach' && clubId) {
    // Coach mode: only load their club
    const visibleClubs = clubs.filter(c => String(c.id) === String(clubId))
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

// ─── Filter registration data to individual events only ───────────────────────

/**
 * Filters RegistrationData to only include individual events (relay_count = 1 or undefined).
 * Removes relay_events entirely from the data passed to RegistrationPanel.
 */
function filterToIndividualOnly(data: RegistrationData): RegistrationData {
  return {
    ...data,
    // Keep only individual events (relay_count is 1 or not set)
    individual_events: data.individual_events.filter(
      style => !style.relay_count || style.relay_count === 1
    ),
    // Remove all relay events from this page
    relay_events: [],
  }
}

// ─── Custom Hook ──────────────────────────────────────────────────────────────

function useIndividualEntryPage(api: RegistrationAPI, role: string, clubId?: string, refreshKey?: number) {
  const [state, setState] = useState<IndividualEntryPageState>({
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
  const [selectedClubId, setSelectedClubId] = useState<number | null>(null)

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
    // Determine the club this athlete belongs to
    for (const [cId, athletes] of state.athletesByClub) {
      if (athletes.some(a => a.id === athleteId)) {
        setSelectedClubId(cId)
        break
      }
    }
    try {
      const data = await api.getRegistration(athleteId)
      setState(prev => ({ ...prev, registrationData: data }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to load registration',
      }))
    }
  }, [api, state.athletesByClub])

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

  // Add athlete from toolbar (uses selectedClubId)
  const handleAddAthleteFromToolbar = useCallback(() => {
    if (!selectedClubId) return
    const club = state.clubs.find(c => c.id === selectedClubId)
    setAddDialog({ open: true, clubId: selectedClubId, clubName: club?.name || '' })
  }, [selectedClubId, state.clubs])

  // Delete athlete from toolbar (uses selected athlete)
  const handleDeleteAthleteFromToolbar = useCallback(() => {
    if (!state.selectedAthleteId) return
    // Find athlete name from the map
    for (const athletes of state.athletesByClub.values()) {
      const athlete = athletes.find(a => a.id === state.selectedAthleteId)
      if (athlete) {
        setDeleteConfirm({ open: true, athleteId: athlete.id, athleteName: `${athlete.first_name} ${athlete.last_name}` })
        break
      }
    }
  }, [state.selectedAthleteId, state.athletesByClub])

  // Track club selection from tree
  const handleSelectClub = useCallback((clubId: number) => {
    setSelectedClubId(clubId)
  }, [])

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
    selectedClubId,
    setFilterText,
    handleSelectAthlete,
    handleSelectClub,
    handleAddAthlete,
    handleAddAthleteFromToolbar,
    handleDeleteAthleteFromToolbar,
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

// ─── IndividualEntryPage Component ────────────────────────────────────────────

export default function IndividualEntryPage({ role, clubId, refreshKey, onImportLxf, onExportLxf }: IndividualEntryPageProps) {
  const { t } = useLang()
  const api = useRegistrationApi()
  const tr = t.registration

  const {
    state,
    debouncedFilter,
    filteredAthletesByClub,
    addDialog,
    deleteConfirm,
    selectedClubId,
    setFilterText,
    handleSelectAthlete,
    handleSelectClub,
    handleAddAthlete,
    handleAddAthleteFromToolbar,
    handleDeleteAthleteFromToolbar,
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
  } = useIndividualEntryPage(api, role, clubId, refreshKey)

  // ─── Closure date enforcement ─────────────────────────────────────────────
  // For coach role: if current date > closure_date, block access
  // Admin role bypasses closure date
  const closureDate = state.registrationData?.closure_date
  const isClosed = role === 'coach' && isClosureDatePassed(closureDate)

  // If we know from the first loaded registration data that entries are closed for coach, block page
  // We also check after data loads — show closed message if closed
  if (isClosed) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Filter text box (still visible but page is blocked) */}
        <div className="px-3 py-1.5 bg-white border-b border-gray-300 shrink-0">
          <input
            type="text"
            placeholder={tr.search}
            value={state.filterText}
            onChange={e => setFilterText(e.target.value)}
            className="border border-gray-300 px-2 py-1 rounded text-xs w-64"
          />
        </div>

        <SplitPanel
          topPanel={
            <CascadeTree
              clubs={state.clubs}
              athletesByClub={filteredAthletesByClub}
              selectedAthleteId={state.selectedAthleteId}
              filterText={debouncedFilter}
              defaultExpanded={false}
              onSelectAthlete={handleSelectAthlete}
              onSelectClub={handleSelectClub}
              onAddAthlete={handleAddAthlete}
              onDeleteAthlete={handleDeleteAthlete}
              role={role}
            />
          }
          bottomPanel={
            <div className="flex items-center justify-center h-full">
              <div className="text-center p-6">
                <p className="text-sm text-red-600 font-medium">{tr.entriesClosed}</p>
              </div>
            </div>
          }
        />
      </div>
    )
  }

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

  // Filter registration data to individual events only
  const filteredRegistrationData = state.registrationData
    ? filterToIndividualOnly(state.registrationData)
    : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar: search + add/delete buttons + import/export */}
      <div className="flex items-center h-7 bg-gray-100 border-b border-gray-300 px-2 gap-1 shrink-0 text-xs select-none">
        <input
          type="text"
          placeholder={tr.search}
          value={state.filterText}
          onChange={e => setFilterText(e.target.value)}
          className="border border-gray-300 px-2 py-0.5 rounded text-xs w-64"
        />
        <button
          disabled={!selectedClubId}
          onClick={handleAddAthleteFromToolbar}
          className={`px-2 py-0.5 border rounded text-xs transition-colors ${
            selectedClubId
              ? 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
              : 'border-gray-200 text-gray-300 bg-white cursor-not-allowed'
          }`}
        >
          {tr.addAthlete}
        </button>
        <button
          disabled={!state.selectedAthleteId}
          onClick={handleDeleteAthleteFromToolbar}
          className={`px-2 py-0.5 border rounded text-xs transition-colors ${
            state.selectedAthleteId
              ? 'border-red-300 text-red-600 bg-white hover:bg-red-50'
              : 'border-gray-200 text-gray-300 bg-white cursor-not-allowed'
          }`}
        >
          {tr.delete}
        </button>
        <div className="flex-1" />
        {onImportLxf && (
          <button
            onClick={onImportLxf}
            className="px-3 py-0.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
          >
            {tr.importLxf}
          </button>
        )}
        {onExportLxf && (
          <button
            onClick={onExportLxf}
            className="px-3 py-0.5 bg-green-600 text-white text-xs rounded hover:bg-green-700"
          >
            {tr.exportLxf}
          </button>
        )}
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
            onSelectClub={handleSelectClub}
            onAddAthlete={handleAddAthlete}
            onDeleteAthlete={handleDeleteAthlete}
            role={role}
          />
        }
        bottomPanel={
          state.selectedAthleteId && filteredRegistrationData ? (
            <>
              <AthleteDetailPanel
                athlete={filteredRegistrationData.athlete}
                athleteId={state.selectedAthleteId}
                onSave={handleSaveAthleteField}
              />
              <div className="flex-1 overflow-auto">
                <RegistrationPanel
                  data={filteredRegistrationData}
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