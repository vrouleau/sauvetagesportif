import { useState, useEffect, useCallback, useRef, type MouseEvent } from 'react'
import type { Club, AthleteListItem } from '../data/api'
import { useLang } from '../context/LangContext'

export interface CascadeTreeProps {
  clubs: Club[]
  athletesByClub: Map<number, AthleteListItem[]>
  selectedAthleteId: number | null
  filterText: string
  defaultExpanded: boolean
  onSelectAthlete: (athleteId: number) => void
  onAddAthlete: (clubId: number) => void
  onDeleteAthlete: (athleteId: number, name: string) => void
  role: string
}

interface ContextMenuState {
  x: number
  y: number
  clubId?: number
  athleteId?: number
  athleteName?: string
}

export default function CascadeTree({
  clubs,
  athletesByClub,
  selectedAthleteId,
  filterText,
  defaultExpanded,
  onSelectAthlete,
  onAddAthlete,
  onDeleteAthlete,
  role: _role,
}: CascadeTreeProps) {
  void _role // reserved for future role-based rendering
  const { t } = useLang()
  // Manual expansion state (user clicks)
  const [expandedClubs, setExpandedClubs] = useState<Set<number>>(new Set())
  // Track manual state separately so we can restore it when filter is cleared
  const manualExpandedRef = useRef<Set<number>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Reset expanded state when defaultExpanded changes (always starts collapsed)
  useEffect(() => {
    if (defaultExpanded) {
      const all = new Set(clubs.map((c) => c.id))
      setExpandedClubs(all)
      manualExpandedRef.current = all
    } else {
      setExpandedClubs(new Set())
      manualExpandedRef.current = new Set()
    }
  }, [defaultExpanded])

  // Auto-expand clubs that have matching athletes when filter is active;
  // restore manual state when filter is cleared
  useEffect(() => {
    if (filterText) {
      const autoExpand = new Set<number>()
      for (const [clubId, athletes] of athletesByClub) {
        if (athletes.length > 0) {
          autoExpand.add(clubId)
        }
      }
      setExpandedClubs(autoExpand)
    } else {
      // Restore manual expansion state
      setExpandedClubs(new Set(manualExpandedRef.current))
    }
  }, [filterText, athletesByClub])

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  const toggleClub = useCallback((clubId: number) => {
    setExpandedClubs((prev) => {
      const next = new Set(prev)
      if (next.has(clubId)) {
        next.delete(clubId)
      } else {
        next.add(clubId)
      }
      // Update manual ref only when no filter is active
      if (!filterText) {
        manualExpandedRef.current = next
      }
      return next
    })
  }, [filterText])

  function handleClubContextMenu(e: MouseEvent, clubId: number) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, clubId })
  }

  function handleAthleteContextMenu(e: MouseEvent, athleteId: number, athleteName: string) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, athleteId, athleteName })
  }

  return (
    <div className="overflow-y-auto bg-white select-none text-xs relative">
      {clubs.length === 0 && (
        <div className="px-4 py-3 text-gray-400 italic">{t.registration.loading}</div>
      )}

      {clubs.map((club) => {
        const athletes = athletesByClub.get(club.id) || []
        const expanded = expandedClubs.has(club.id)

        // When filter is active, hide clubs with no matching athletes
        if (filterText && athletes.length === 0) return null

        return (
          <div key={club.id}>
            {/* Club node */}
            <div
              className="flex items-center h-6 px-2 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
              onClick={() => toggleClub(club.id)}
              onContextMenu={(e) => handleClubContextMenu(e, club.id)}
            >
              <span className="w-4 text-center mr-1 text-gray-500">
                {athletes.length > 0 ? (expanded ? '▼' : '▶') : ''}
              </span>
              <span className="flex-1 font-medium truncate">
                {club.name}
              </span>
              <span className="text-gray-400 mr-1">
                ({athletes.length})
              </span>
            </div>

            {/* Athlete nodes */}
            {expanded &&
              athletes.map((athlete) => {
                const isSelected = selectedAthleteId === athlete.id
                return (
                  <div
                    key={athlete.id}
                    className={`flex items-center h-6 pl-7 pr-2 cursor-pointer border-b border-gray-50 ${
                      isSelected
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-blue-50'
                    }`}
                    onClick={() => onSelectAthlete(athlete.id)}
                    onContextMenu={(e) =>
                      handleAthleteContextMenu(
                        e,
                        athlete.id,
                        `${athlete.first_name} ${athlete.last_name}`
                      )
                    }
                  >
                    <span className="flex-1 truncate">
                      {athlete.last_name}, {athlete.first_name}
                    </span>
                    <span className={`text-xs ${isSelected ? 'text-blue-200' : 'text-gray-400'}`}>
                      {athlete.gender}
                    </span>
                  </div>
                )
              })}
          </div>
        )
      })}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[9999] bg-white border border-gray-300 rounded shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.clubId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 hover:text-blue-700"
              onClick={() => {
                onAddAthlete(contextMenu.clubId!)
                setContextMenu(null)
              }}
            >
              {t.registration.addAthlete}
            </button>
          )}
          {contextMenu.athleteId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-red-50 hover:text-red-700"
              onClick={() => {
                onDeleteAthlete(contextMenu.athleteId!, contextMenu.athleteName || '')
                setContextMenu(null)
              }}
            >
              {t.registration.delete}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
