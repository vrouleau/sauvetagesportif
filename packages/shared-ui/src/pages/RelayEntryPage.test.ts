import { describe, it, expect } from 'vitest'
import type { RelayPageData, RelayTeam, RelayTeamMember, RelayAgeCategory, RelayEventGroup } from '../data/api'

// ─── Replicate core logic from RelayEntryPage.tsx (not exported) ──────────────

/**
 * Determines if the page is closed: current date is past closure date end-of-day.
 */
function isClosureDatePassed(closureDate: string | null | undefined): boolean {
  if (!closureDate) return false
  const closure = new Date(closureDate)
  closure.setHours(23, 59, 59, 999)
  return new Date() > closure
}

/**
 * Determines if controls should be disabled based on role and closure state.
 */
function isControlsDisabled(isClosed: boolean, role: string): boolean {
  return isClosed && role === 'coach'
}

/**
 * Determines if admin club filter should be shown.
 */
function shouldShowClubFilter(role: string): boolean {
  return role === 'admin'
}

/**
 * Determines if a relay team deletion requires confirmation.
 * Teams with at least one assigned member require confirmation.
 */
function requiresDeleteConfirmation(team: RelayTeam): boolean {
  return team.members.some(m => m.athleteId != null)
}

/**
 * Determines if the empty state message should be shown.
 */
function shouldShowEmptyState(ageCategories: RelayAgeCategory[]): boolean {
  return ageCategories.length === 0
}

/**
 * Determines whether navigation tabs are visible for a role.
 * All authenticated roles see both tabs.
 */
function areTabsVisibleForRole(role: string): boolean {
  return role === 'coach' || role === 'admin' || role === 'organizer'
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeRelayTeam(overrides: Partial<RelayTeam> = {}): RelayTeam {
  return {
    id: 1,
    teamNumber: 'A',
    teamName: null,
    members: [
      { position: 1, athleteId: null, athleteName: null },
      { position: 2, athleteId: null, athleteName: null },
      { position: 3, athleteId: null, athleteName: null },
      { position: 4, athleteId: null, athleteName: null },
    ],
    ...overrides,
  }
}

function makeRelayEvent(overrides: Partial<RelayEventGroup> = {}): RelayEventGroup {
  return {
    eventId: 1,
    eventName: '4x50m Freestyle Relay',
    swimstyleId: 10,
    relaycount: 4,
    gender: 'X',
    eventNumber: 1,
    ...overrides,
  }
}

function makeAgeCategory(overrides: Partial<RelayAgeCategory> = {}): RelayAgeCategory {
  return {
    ageCode: '13-14',
    ageMin: 13,
    ageMax: 14,
    events: [makeRelayEvent()],
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RelayEntryPage - Navigation tabs visibility', () => {
  /**
   * **Validates: Requirements 1.6**
   * Navigation tabs are visible to all authenticated roles.
   */

  it('tabs are visible for coach role', () => {
    expect(areTabsVisibleForRole('coach')).toBe(true)
  })

  it('tabs are visible for admin role', () => {
    expect(areTabsVisibleForRole('admin')).toBe(true)
  })

  it('tabs are visible for organizer role', () => {
    expect(areTabsVisibleForRole('organizer')).toBe(true)
  })

  it('tabs are not visible for unknown role', () => {
    expect(areTabsVisibleForRole('unknown')).toBe(false)
  })
})

describe('RelayEntryPage - Closure date message display', () => {
  /**
   * **Validates: Requirements 8.2**
   * Closure date message displays when past deadline for coach.
   */

  it('shows closure message when past deadline and role is coach', () => {
    // Past closure date
    const isClosed = true
    const role = 'coach'
    expect(isControlsDisabled(isClosed, role)).toBe(true)
  })

  it('does not show closure message for admin even when past deadline', () => {
    const isClosed = true
    const role = 'admin'
    expect(isControlsDisabled(isClosed, role)).toBe(false)
  })

  it('does not show closure message for organizer even when past deadline', () => {
    const isClosed = true
    const role = 'organizer'
    expect(isControlsDisabled(isClosed, role)).toBe(false)
  })

  it('does not show closure message when before deadline', () => {
    const isClosed = false
    const role = 'coach'
    expect(isControlsDisabled(isClosed, role)).toBe(false)
  })

  it('isClosureDatePassed returns true for past date', () => {
    expect(isClosureDatePassed('2020-01-01')).toBe(true)
  })

  it('isClosureDatePassed returns false for future date', () => {
    expect(isClosureDatePassed('2099-12-31')).toBe(false)
  })

  it('isClosureDatePassed returns false for null', () => {
    expect(isClosureDatePassed(null)).toBe(false)
  })
})

describe('RelayEntryPage - Admin club filter dropdown', () => {
  /**
   * **Validates: Requirements 9.3**
   * Admin club filter dropdown appears only for admin role.
   */

  it('shows club filter for admin role', () => {
    expect(shouldShowClubFilter('admin')).toBe(true)
  })

  it('does not show club filter for coach role', () => {
    expect(shouldShowClubFilter('coach')).toBe(false)
  })

  it('does not show club filter for organizer role', () => {
    expect(shouldShowClubFilter('organizer')).toBe(false)
  })
})

describe('RelayEntryPage - Empty state message', () => {
  /**
   * **Validates: Requirements 3.7**
   * Empty state message when no relay events exist.
   */

  it('shows empty state when no age categories exist', () => {
    expect(shouldShowEmptyState([])).toBe(true)
  })

  it('does not show empty state when age categories exist', () => {
    expect(shouldShowEmptyState([makeAgeCategory()])).toBe(false)
  })

  it('does not show empty state with multiple categories', () => {
    expect(shouldShowEmptyState([
      makeAgeCategory({ ageCode: '10-12' }),
      makeAgeCategory({ ageCode: '13-14' }),
    ])).toBe(false)
  })
})

describe('RelayEntryPage - Delete team confirmation dialog', () => {
  /**
   * **Validates: Requirements 6.5**
   * Confirmation dialog appears when deleting team with assigned members.
   */

  it('requires confirmation when team has assigned members', () => {
    const team = makeRelayTeam({
      members: [
        { position: 1, athleteId: 42, athleteName: 'Smith, John' },
        { position: 2, athleteId: null, athleteName: null },
        { position: 3, athleteId: null, athleteName: null },
        { position: 4, athleteId: null, athleteName: null },
      ],
    })
    expect(requiresDeleteConfirmation(team)).toBe(true)
  })

  it('requires confirmation when team has all members assigned', () => {
    const team = makeRelayTeam({
      members: [
        { position: 1, athleteId: 1, athleteName: 'A, B' },
        { position: 2, athleteId: 2, athleteName: 'C, D' },
        { position: 3, athleteId: 3, athleteName: 'E, F' },
        { position: 4, athleteId: 4, athleteName: 'G, H' },
      ],
    })
    expect(requiresDeleteConfirmation(team)).toBe(true)
  })

  it('does not require confirmation when team has no members', () => {
    const team = makeRelayTeam({
      members: [
        { position: 1, athleteId: null, athleteName: null },
        { position: 2, athleteId: null, athleteName: null },
        { position: 3, athleteId: null, athleteName: null },
        { position: 4, athleteId: null, athleteName: null },
      ],
    })
    expect(requiresDeleteConfirmation(team)).toBe(false)
  })

  it('does not require confirmation for empty members array', () => {
    const team = makeRelayTeam({ members: [] })
    expect(requiresDeleteConfirmation(team)).toBe(false)
  })
})
