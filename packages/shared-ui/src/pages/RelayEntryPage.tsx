import { useState, useEffect, useCallback, useMemo } from 'react'
import { useLang } from '../context/LangContext'
import { useRegistrationApi } from '../context/RegistrationApiContext'
import type { RelayPageData, RelayEventGroup, RelayTeam, EligibleAthlete, Club } from '../data/api'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RelayEntryPageProps {
  role: 'admin' | 'coach' | 'organizer'
  clubId?: number
  refreshKey?: number
}

interface DeleteConfirmState {
  open: boolean
  teamId: number
  teamNumber: string
}

interface ErrorToast {
  message: string
  type: 'conflict' | 'error'
}

// ─── FlatRelayEvent: merged event + age info for flat display ─────────────────

interface FlatRelayEvent {
  eventId: number
  eventName: string
  swimstyleId: number
  relaycount: number
  gender: 'M' | 'F' | 'X'
  eventNumber: number
  ageCodes: string[]  // all age codes for this event
}

// ─── RelayEventCard ───────────────────────────────────────────────────────────

function RelayEventCard({
  event,
  teams,
  eligibleAthletes,
  isDisabled,
  onMemberChange,
  onNameChange,
  onCreateTeam,
  onDeleteTeam,
}: {
  event: FlatRelayEvent
  teams: RelayTeam[]
  eligibleAthletes: EligibleAthlete[]
  isDisabled: boolean
  onMemberChange: (teamId: number, position: number, athleteId: number | null) => void
  onNameChange: (teamId: number, name: string | null) => void
  onCreateTeam: (eventId: number) => void
  onDeleteTeam: (team: RelayTeam) => void
}) {
  const { t } = useLang()
  const [creating, setCreating] = useState(false)

  const handleAddTeam = useCallback(async () => {
    setCreating(true)
    try {
      onCreateTeam(event.eventId)
    } finally {
      setCreating(false)
    }
  }, [event.eventId, onCreateTeam])

  const maxTeamsReached = teams.length >= 26

  return (
    <div className="border border-gray-300 rounded p-3 bg-white">
      {/* Event header */}
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium text-gray-800">
          #{event.eventNumber} — {event.eventName}
        </h4>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {event.relaycount}x | {event.gender === 'M' ? 'M' : event.gender === 'F' ? 'F' : 'X'}
          </span>
          <button
            type="button"
            onClick={handleAddTeam}
            disabled={isDisabled || maxTeamsReached || creating}
            className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            {t.relay.addTeam}
          </button>
        </div>
      </div>

      {/* Teams list */}
      {teams.length === 0 ? (
        <p className="text-xs text-gray-400 italic">{t.relay.emptyPosition}</p>
      ) : (
        <div className="space-y-2">
          {teams.map(team => (
            <RelayTeamRow
              key={team.id}
              team={team}
              event={event}
              ageCode=""
              eligibleAthletes={eligibleAthletes}
              allTeamsForEvent={teams}
              isDisabled={isDisabled}
              onMemberChange={onMemberChange}
              onNameChange={onNameChange}
              onDeleteTeam={onDeleteTeam}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── RelayTeamRow ─────────────────────────────────────────────────────────────
// Full interactive team row with member dropdowns and editable team name

function RelayTeamRow({
  team,
  event,
  eligibleAthletes,
  allTeamsForEvent,
  isDisabled,
  onMemberChange,
  onNameChange,
  onDeleteTeam,
}: {
  team: RelayTeam
  event: RelayEventGroup | FlatRelayEvent
  ageCode: string
  eligibleAthletes: EligibleAthlete[]
  allTeamsForEvent: RelayTeam[]
  isDisabled: boolean
  onMemberChange: (teamId: number, position: number, athleteId: number | null) => void
  onNameChange: (teamId: number, name: string | null) => void
  onDeleteTeam: (team: RelayTeam) => void
}) {
  const { t } = useLang()

  // Generate default display name:
  // - If no custom name + at least one member assigned: hyphenated last names
  // - If no custom name + no members: team number letter
  const defaultGeneratedName = useMemo(() => {
    const assignedMembers = team.members.filter(m => m.athleteName)
    if (assignedMembers.length > 0) {
      return assignedMembers.map(m => m.athleteName!.split(',')[0].trim()).join('/')
    }
    return team.teamNumber
  }, [team.members, team.teamNumber])

  // Compute athletes assigned to OTHER teams for the same event/ageCode (cross-team filter)
  const crossTeamAssignedIds = useMemo(() => {
    const ids = new Set<number>()
    for (const otherTeam of allTeamsForEvent) {
      if (otherTeam.id === team.id) continue
      for (const member of otherTeam.members) {
        if (member.athleteId != null) {
          ids.add(member.athleteId)
        }
      }
    }
    return ids
  }, [allTeamsForEvent, team.id])

  // Compute athletes assigned to THIS team (intra-team filter)
  const intraTeamAssignedIds = useMemo(() => {
    const ids = new Set<number>()
    for (const member of team.members) {
      if (member.athleteId != null) {
        ids.add(member.athleteId)
      }
    }
    return ids
  }, [team.members])

  // Handle team name input change
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    // If empty, clear custom name (set to null so default name is shown)
    onNameChange(team.id, val.length === 0 ? null : val)
  }, [team.id, onNameChange])

  // Handle member dropdown change
  const handleMemberSelect = useCallback((position: number, value: string) => {
    const athleteId = value === '' ? null : Number(value)
    onMemberChange(team.id, position, athleteId)
  }, [team.id, onMemberChange])

  return (
    <div className="border border-gray-200 rounded px-3 py-2 bg-gray-50">
      {/* Team header with team number, age group, editable name, and delete button */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-blue-700 shrink-0">
          {team.teamNumber}
        </span>
        {team.ageGroup && event.swimstyleId !== 530 && (
          <span className="text-xs text-gray-500 shrink-0">
            {team.ageGroup}
          </span>
        )}
        <input
          type="text"
          value={team.teamName ?? ''}
          onChange={handleNameChange}
          placeholder={defaultGeneratedName}
          maxLength={50}
          disabled={isDisabled}
          aria-label={t.relay.teamName}
          className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 bg-white disabled:bg-gray-100 disabled:text-gray-500 min-w-0"
        />
        <button
          type="button"
          onClick={() => onDeleteTeam(team)}
          disabled={isDisabled}
          className="text-red-500 hover:text-red-700 disabled:text-gray-300 disabled:cursor-not-allowed text-sm leading-none shrink-0"
          aria-label={`Delete team ${team.teamNumber}`}
        >
          ×
        </button>
      </div>

      {/* Member position dropdowns */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: event.relaycount }, (_, i) => {
          const position = i + 1
          const currentMember = team.members.find(m => m.position === position)
          const currentAthleteId = currentMember?.athleteId ?? null

          // Filter eligible athletes for this position:
          // - Exclude athletes assigned to OTHER positions on THIS team (intra-team)
          // - Exclude athletes assigned to OTHER teams for same event/ageCode (cross-team)
          // - For mixed (X) events: enforce N/2 men + N/2 women balance
          // - For age groups: exclude athletes that would make a valid majority impossible
          // - BUT keep the currently selected athlete for this position in the list

          // For mixed events, compute gender counts on this team (excluding current position)
          // SERC events (swimstyle 530) have no restrictions
          const isSERC = event.swimstyleId === 530
          let allowedGender: 'M' | 'F' | null = null
          if (!isSERC && event.gender === 'X') {
            const maxPerGender = event.relaycount / 2
            let mCount = 0
            let fCount = 0
            for (const m of team.members) {
              if (m.position === position || m.athleteId == null) continue
              const assigned = eligibleAthletes.find(a => a.id === m.athleteId)
              if (assigned?.gender === 'M') mCount++
              else if (assigned?.gender === 'F') fCount++
            }
            if (mCount >= maxPerGender) allowedGender = 'F'
            else if (fCount >= maxPerGender) allowedGender = 'M'
          }

          // For age group filtering: compute current age groups on this team (excluding current position)
          // and determine how many remaining unfilled positions exist after this one
          const currentAgeGroups: string[] = []
          let filledCount = 0
          for (const m of team.members) {
            if (m.position === position || m.athleteId == null) continue
            filledCount++
            const assigned = eligibleAthletes.find(a => a.id === m.athleteId)
            if (assigned?.ageGroup) currentAgeGroups.push(assigned.ageGroup)
          }
          const remainingAfterThis = event.relaycount - filledCount - 1
          const requiredMajority = Math.floor(event.relaycount / 2) + 1

          const filteredAthletes = eligibleAthletes.filter(athlete => {
            // Always show the currently assigned athlete for this position
            if (athlete.id === currentAthleteId) return true
            // Exclude if assigned elsewhere on this team
            if (intraTeamAssignedIds.has(athlete.id) && athlete.id !== currentAthleteId) return false
            // Exclude if assigned to another team for same event
            if (crossTeamAssignedIds.has(athlete.id)) return false
            // For M/F events: hard-filter by event gender
            if (!isSERC && event.gender !== 'X' && athlete.gender !== event.gender) return false
            // For mixed events: exclude gender that has reached its quota
            if (!isSERC && allowedGender != null && athlete.gender !== allowedGender) return false
            // Age group check: would adding this athlete make a valid majority impossible?
            if (!isSERC && athlete.ageGroup && currentAgeGroups.length > 0) {
              const groupsAfter = [...currentAgeGroups, athlete.ageGroup]
              // Count occurrences of each age group
              const counts = new Map<string, number>()
              for (const g of groupsAfter) counts.set(g, (counts.get(g) ?? 0) + 1)
              // Best possible outcome: the most common group gets all remaining positions
              let maxCount = 0
              for (const c of counts.values()) { if (c > maxCount) maxCount = c }
              if (maxCount + remainingAfterThis < requiredMajority) return false
            }
            return true
          })

          // If current athlete is assigned but not in the eligible list, add them so they appear in the dropdown
          if (currentAthleteId != null && !filteredAthletes.some(a => a.id === currentAthleteId)) {
            const memberName = currentMember?.athleteName ?? `Athlete #${currentAthleteId}`
            filteredAthletes.unshift({ id: currentAthleteId, name: memberName, gender: 'M' as const })
          }

          const hasOptions = filteredAthletes.length > 0 || currentAthleteId != null

          return (
            <div key={position} className="flex flex-col">
              <label className="text-xs text-gray-400 mb-0.5">
                {t.relay.positionLabel(position)}
              </label>
              {hasOptions ? (
                <select
                  value={currentAthleteId?.toString() ?? ''}
                  onChange={(e) => handleMemberSelect(position, e.target.value)}
                  disabled={isDisabled}
                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white disabled:bg-gray-100 disabled:text-gray-500"
                >
                  <option value="">{t.relay.emptyPosition}</option>
                  {filteredAthletes.map(athlete => (
                    <option key={athlete.id} value={athlete.id}>
                      {athlete.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-gray-400 italic py-1">
                  {t.relay.noEligibleAthletes}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── RelayEntryPage Component ─────────────────────────────────────────────────

export default function RelayEntryPage({ role, clubId, refreshKey }: RelayEntryPageProps) {
  const { t } = useLang()
  const api = useRegistrationApi()

  const [pageData, setPageData] = useState<RelayPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Admin club filter state — clubs with real DB IDs for relay filtering
  const [clubs, setClubs] = useState<Club[]>([])
  const [selectedClubId, setSelectedClubId] = useState<number | undefined>(clubId)

  // Load clubs for admin/organizer filter
  useEffect(() => {
    if (role === 'admin' || role === 'organizer') {
      // Try Electron IPC first (meet-app has real DB club IDs via dedicated handler)
      const ipcDb = (window as unknown as { api?: { db?: Record<string, (...args: unknown[]) => Promise<unknown>> } }).api?.db
      const clubsPromise = ipcDb?.getClubsReal
        ? (ipcDb.getClubsReal() as Promise<Club[]>)
        : api.getClubs()

      clubsPromise.then(loadedClubs => {
        setClubs(loadedClubs)
        if (!selectedClubId && loadedClubs.length > 0) {
          setSelectedClubId(loadedClubs[0].id)
        }
      }).catch(() => {})
    }
  }, [role, api])

  // Load relay page data — for admin/organizer, loads when a club is selected; for coach, loads immediately
  const loadData = useCallback(async () => {
    if ((role === 'admin' || role === 'organizer') && !selectedClubId) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.getRelayPageData(selectedClubId)
      setPageData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load relay data')
    } finally {
      setLoading(false)
    }
  }, [api, selectedClubId, role])

  useEffect(() => {
    loadData()
  }, [loadData, refreshKey])

  // Handle admin club filter change
  const handleClubFilterChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedClubId(Number(e.target.value))
  }, [])

  // Determine if controls should be disabled (closure enforcement for coach)
  const isClosed = pageData?.isClosed ?? false
  const isDisabled = isClosed && role === 'coach'

  // ─── Error toast state (auto-dismissing) ─────────────────────────────────────
  const [errorToast, setErrorToast] = useState<ErrorToast | null>(null)

  useEffect(() => {
    if (!errorToast) return
    const timer = setTimeout(() => setErrorToast(null), 5000)
    return () => clearTimeout(timer)
  }, [errorToast])

  const dismissToast = useCallback(() => setErrorToast(null), [])

  // ─── Member assignment handler ──────────────────────────────────────────────
  const handleMemberChange = useCallback(async (teamId: number, position: number, athleteId: number | null) => {
    try {
      await api.setRelayTeamMember(teamId, position, athleteId)
      // Reload data to reflect changes across all teams/dropdowns
      await loadData()
    } catch (err: unknown) {
      // Detect 409 Conflict: HTTP adapter sets err.status = 409 + err.detail,
      // IPC adapter throws plain Error with message containing conflict info
      const status = (err as { status?: number }).status
      const detail = (err as { detail?: string }).detail

      if (status === 409) {
        // 409 Conflict from HTTP adapter — use server detail message
        setErrorToast({
          message: detail || 'Athlete is already assigned to another team for this event',
          type: 'conflict',
        })
      } else if (
        err instanceof Error &&
        (err.message.includes('already assigned') || err.message.includes('uniqueness'))
      ) {
        // IPC adapter throws plain Error with conflict description
        setErrorToast({ message: err.message, type: 'conflict' })
      } else {
        // Generic error
        setErrorToast({
          message: err instanceof Error ? err.message : 'Failed to update member',
          type: 'error',
        })
      }
      // Do NOT modify local state — dropdown reverts on next render since loadData is not called
    }
  }, [api, loadData])

  // ─── Team name change handler ───────────────────────────────────────────────
  const handleNameChange = useCallback(async (teamId: number, name: string | null) => {
    try {
      await api.setRelayTeamName(teamId, name)
      // Optimistically update local state
      if (pageData) {
        const updated = { ...pageData, teamsByEvent: { ...pageData.teamsByEvent } }
        for (const key of Object.keys(updated.teamsByEvent)) {
          updated.teamsByEvent[key] = updated.teamsByEvent[key].map(team =>
            team.id === teamId ? { ...team, teamName: name } : team
          )
        }
        setPageData(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update team name')
    }
  }, [api, pageData])

  // ─── Team creation handler ──────────────────────────────────────────────────
  const [creatingTeam, setCreatingTeam] = useState(false)

  const handleCreateTeam = useCallback(async (eventId: number) => {
    if (creatingTeam) return
    setCreatingTeam(true)
    setError(null)
    try {
      // Pass empty ageCode — age group is determined by members, not pre-assigned
      await api.createRelayTeam(eventId, '', selectedClubId)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create team')
    } finally {
      setCreatingTeam(false)
    }
  }, [api, selectedClubId, loadData, creatingTeam])

  // ─── Team deletion handler ──────────────────────────────────────────────────
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({ open: false, teamId: 0, teamNumber: '' })
  const [deletingTeam, setDeletingTeam] = useState(false)

  const performDeleteTeam = useCallback(async (teamId: number) => {
    if (deletingTeam) return
    setDeletingTeam(true)
    setError(null)
    try {
      await api.deleteRelayTeam(teamId)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team')
    } finally {
      setDeletingTeam(false)
      setDeleteConfirm({ open: false, teamId: 0, teamNumber: '' })
    }
  }, [api, loadData, deletingTeam])

  const handleDeleteTeam = useCallback((team: RelayTeam) => {
    // Check if any members are assigned
    const hasMembers = team.members.some(m => m.athleteId != null)
    if (!hasMembers) {
      // No members — delete immediately without confirmation
      performDeleteTeam(team.id)
    } else {
      // Has members — show confirmation dialog
      setDeleteConfirm({ open: true, teamId: team.id, teamNumber: team.teamNumber })
    }
  }, [performDeleteTeam])

  const confirmDeleteTeam = useCallback(() => {
    performDeleteTeam(deleteConfirm.teamId)
  }, [performDeleteTeam, deleteConfirm.teamId])

  const cancelDeleteTeam = useCallback(() => {
    setDeleteConfirm({ open: false, teamId: 0, teamNumber: '' })
  }, [])

  // Flatten all events from all age categories into a single list, sorted by event number
  // NOTE: Must be above early returns to satisfy React hooks rules
  // Each event appears ONCE, with all its age codes collected
  const flatEvents: FlatRelayEvent[] = useMemo(() => {
    if (!pageData || !pageData.ageCategories) return []
    const eventMap = new Map<number, FlatRelayEvent>()
    for (const cat of pageData.ageCategories) {
      if (!cat.events) continue
      for (const ev of cat.events) {
        if (!eventMap.has(ev.eventId)) {
          eventMap.set(ev.eventId, {
            eventId: ev.eventId,
            eventName: ev.eventName,
            swimstyleId: ev.swimstyleId,
            relaycount: ev.relaycount,
            gender: ev.gender,
            eventNumber: ev.eventNumber,
            ageCodes: [cat.ageCode],
          })
        } else {
          const existing = eventMap.get(ev.eventId)!
          if (!existing.ageCodes.includes(cat.ageCode)) {
            existing.ageCodes.push(cat.ageCode)
          }
        }
      }
    }
    const events = Array.from(eventMap.values())
    events.sort((a, b) => a.eventNumber - b.eventNumber)
    return events
  }, [pageData])

  // ─── Loading state ──────────────────────────────────────────────────────────
  if (loading && !pageData) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 text-xs">{t.registration.loading}</p>
      </div>
    )
  }

  // ─── Error state ────────────────────────────────────────────────────────────
  if (error && !pageData) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={loadData}
          className="px-4 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-gray-300 shrink-0 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">{t.relay.pageTitle}</h2>

        {/* Admin/organizer club filter */}
        {(role === 'admin' || role === 'organizer') && clubs.length > 0 && (
          <select
            value={selectedClubId ?? ''}
            onChange={handleClubFilterChange}
            className="border border-gray-300 px-2 py-1 rounded text-xs"
          >
            {clubs.map(club => (
              <option key={club.id} value={club.id}>
                {club.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Closure message */}
      {isClosed && role === 'coach' && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200">
          <p className="text-xs text-red-600 font-medium">{t.relay.closureMessage}</p>
        </div>
      )}

      {/* Content — flat list of events */}
      <div className="flex-1 overflow-auto p-4">
        {flatEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-gray-500 italic">{t.relay.noRelayEvents}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {flatEvents.map(event => {
              // Merge all teams and eligible athletes across all age codes for this event
              const allTeams: RelayTeam[] = []
              const allEligible: EligibleAthlete[] = []
              const seenEligibleIds = new Set<number>()
              for (const ac of event.ageCodes) {
                const key = `${event.eventId}-${ac}`
                const teams = pageData?.teamsByEvent[key] || []
                allTeams.push(...teams)
                for (const ath of (pageData?.eligibleAthletes[key] || [])) {
                  if (!seenEligibleIds.has(ath.id)) {
                    seenEligibleIds.add(ath.id)
                    allEligible.push(ath)
                  }
                }
              }
              return (
                <RelayEventCard
                  key={event.eventId}
                  event={event}
                  teams={allTeams}
                  eligibleAthletes={allEligible}
                  isDisabled={isDisabled}
                  onMemberChange={handleMemberChange}
                  onNameChange={handleNameChange}
                  onCreateTeam={handleCreateTeam}
                  onDeleteTeam={handleDeleteTeam}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Error toast (auto-dismisses after 5 seconds) */}
      {errorToast && (
        <div
          className={`absolute bottom-4 right-4 text-xs px-3 py-2 rounded shadow flex items-center gap-2 max-w-sm ${
            errorToast.type === 'conflict'
              ? 'bg-amber-100 border border-amber-400 text-amber-800'
              : 'bg-red-100 border border-red-300 text-red-700'
          }`}
          role="alert"
        >
          <span className="flex-1">{errorToast.message}</span>
          <button
            type="button"
            onClick={dismissToast}
            className={`shrink-0 text-sm leading-none font-bold ${
              errorToast.type === 'conflict'
                ? 'text-amber-600 hover:text-amber-800'
                : 'text-red-500 hover:text-red-700'
            }`}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Persistent error banner (when data is loaded but a non-toast operation fails) */}
      {error && pageData && !errorToast && (
        <div className="absolute bottom-4 right-4 bg-red-100 border border-red-300 text-red-700 text-xs px-3 py-2 rounded shadow">
          {error}
        </div>
      )}

      {/* Delete Team Confirmation Dialog */}
      {deleteConfirm.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-400 shadow-xl w-[360px] text-xs">
            <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
              <span className="font-semibold">{t.events.menu.delete}</span>
              <button onClick={cancelDeleteTeam} className="hover:text-gray-300 text-lg leading-none">×</button>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-700">
                {t.relay.deleteConfirmation}
              </p>
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-gray-200 bg-gray-50 gap-2">
              <button
                onClick={cancelDeleteTeam}
                className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
              >
                {t.athletes.dialog.cancel}
              </button>
              <button
                onClick={confirmDeleteTeam}
                disabled={deletingTeam}
                className="px-4 py-1 bg-red-600 text-white hover:bg-red-700 border border-red-700 disabled:bg-red-300"
              >
                {t.events.menu.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
