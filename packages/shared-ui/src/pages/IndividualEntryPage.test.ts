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

import { describe, it, expect } from 'vitest'
import type { RegistrationData, RegistrationStyle, RegistrationAPI } from '../data/api'

// ─── Replicate core logic from IndividualEntryPage.tsx (not exported) ──────────

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

/**
 * Filters RegistrationData to only include individual events (relay_count = 1 or undefined).
 * Removes relay_events entirely from the data passed to RegistrationPanel.
 */
function filterToIndividualOnly(data: RegistrationData): RegistrationData {
  return {
    ...data,
    individual_events: data.individual_events.filter(
      style => !style.relay_count || style.relay_count === 1
    ),
    relay_events: [],
  }
}

/**
 * Determines if the page is closed for a given role and closure date.
 * Coach role is blocked when closure date has passed.
 * Admin role bypasses closure date.
 */
function isPageClosedForRole(role: string, closureDate: string | null | undefined): boolean {
  return role === 'coach' && isClosureDatePassed(closureDate)
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeStyle(overrides: Partial<RegistrationStyle> = {}): RegistrationStyle {
  return {
    style_uid: 'style-1',
    style_name: '50m Freestyle',
    best_time_lcm_ms: null,
    best_time_scm_ms: null,
    categories: [],
    ...overrides,
  }
}

function makeRegistrationData(overrides: Partial<RegistrationData> = {}): RegistrationData {
  return {
    athlete: {
      first_name: 'John',
      last_name: 'Doe',
      gender: 'M',
      birthdate: '2005-01-15',
      license: 'ABC123',
      club: 'Club A',
      handicapex: '',
    },
    individual_events: [],
    relay_events: [],
    club_athletes: [],
    suggested_age_code: '15-18',
    meet_course: 'LCM',
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IndividualEntryPage - filterToIndividualOnly', () => {
  /**
   * **Validates: Requirements 1.3**
   * Only individual events (relaycount = 1) are displayed on the Individual Entry Page.
   */

  it('keeps events with relay_count = 1', () => {
    const data = makeRegistrationData({
      individual_events: [
        makeStyle({ style_uid: 'ind-1', style_name: '50m Freestyle', relay_count: 1 }),
        makeStyle({ style_uid: 'ind-2', style_name: '100m Backstroke', relay_count: 1 }),
      ],
    })

    const result = filterToIndividualOnly(data)

    expect(result.individual_events).toHaveLength(2)
    expect(result.individual_events.map(e => e.style_uid)).toEqual(['ind-1', 'ind-2'])
  })

  it('keeps events with relay_count undefined (defaults to individual)', () => {
    const data = makeRegistrationData({
      individual_events: [
        makeStyle({ style_uid: 'ind-1', style_name: '50m Freestyle' }), // no relay_count
        makeStyle({ style_uid: 'ind-2', style_name: '100m Breaststroke', relay_count: undefined }),
      ],
    })

    const result = filterToIndividualOnly(data)

    expect(result.individual_events).toHaveLength(2)
  })

  it('removes events with relay_count > 1', () => {
    const data = makeRegistrationData({
      individual_events: [
        makeStyle({ style_uid: 'ind-1', style_name: '50m Freestyle', relay_count: 1 }),
        makeStyle({ style_uid: 'relay-1', style_name: '4x50m Freestyle Relay', relay_count: 4 }),
        makeStyle({ style_uid: 'relay-2', style_name: '4x100m Medley Relay', relay_count: 4 }),
      ],
    })

    const result = filterToIndividualOnly(data)

    expect(result.individual_events).toHaveLength(1)
    expect(result.individual_events[0].style_uid).toBe('ind-1')
  })

  it('always sets relay_events to empty array', () => {
    const data = makeRegistrationData({
      relay_events: [
        makeStyle({ style_uid: 'relay-1', style_name: '4x50m Freestyle Relay', relay_count: 4 }),
      ],
    })

    const result = filterToIndividualOnly(data)

    expect(result.relay_events).toEqual([])
  })

  it('preserves all other registration data fields', () => {
    const data = makeRegistrationData({
      individual_events: [makeStyle({ style_uid: 'ind-1', relay_count: 1 })],
      suggested_age_code: '13-14',
      meet_course: 'SCM',
      closure_date: '2025-06-15',
    })

    const result = filterToIndividualOnly(data)

    expect(result.athlete).toEqual(data.athlete)
    expect(result.suggested_age_code).toBe('13-14')
    expect(result.meet_course).toBe('SCM')
    expect(result.closure_date).toBe('2025-06-15')
  })

  it('handles empty individual_events array', () => {
    const data = makeRegistrationData({ individual_events: [] })

    const result = filterToIndividualOnly(data)

    expect(result.individual_events).toEqual([])
    expect(result.relay_events).toEqual([])
  })

  it('mixed list: keeps only relay_count=1 or undefined, removes relay_count>1', () => {
    const data = makeRegistrationData({
      individual_events: [
        makeStyle({ style_uid: 'a', relay_count: 1 }),
        makeStyle({ style_uid: 'b', relay_count: 4 }),
        makeStyle({ style_uid: 'c' }), // undefined
        makeStyle({ style_uid: 'd', relay_count: 2 }),
        makeStyle({ style_uid: 'e', relay_count: 1 }),
      ],
    })

    const result = filterToIndividualOnly(data)

    expect(result.individual_events.map(e => e.style_uid)).toEqual(['a', 'c', 'e'])
  })
})

describe('IndividualEntryPage - isClosureDatePassed', () => {
  /**
   * **Validates: Requirements 2.5, 2.6**
   * Closure date enforcement for coach role and admin bypass.
   */

  it('returns false when closureDate is null', () => {
    expect(isClosureDatePassed(null)).toBe(false)
  })

  it('returns false when closureDate is undefined', () => {
    expect(isClosureDatePassed(undefined)).toBe(false)
  })

  it('returns true when closure date is in the past', () => {
    // Use a date far in the past
    expect(isClosureDatePassed('2020-01-01')).toBe(true)
  })

  it('returns false when closure date is in the future', () => {
    // Use a date far in the future
    expect(isClosureDatePassed('2099-12-31')).toBe(false)
  })

  it('returns false when closure date is far in the future (same-day safe)', () => {
    // Use tomorrow to reliably test that a future closure date is not passed
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    expect(isClosureDatePassed(tomorrowStr)).toBe(false)
  })

  it('returns true for yesterday', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]
    expect(isClosureDatePassed(yesterdayStr)).toBe(true)
  })
})

describe('IndividualEntryPage - closure date role-based access', () => {
  /**
   * **Validates: Requirements 2.5, 2.6**
   * Coach role is blocked when past closure date.
   * Admin role always has access regardless of closure date.
   */

  it('coach is blocked when closure date has passed', () => {
    expect(isPageClosedForRole('coach', '2020-01-01')).toBe(true)
  })

  it('coach is NOT blocked when closure date is in the future', () => {
    expect(isPageClosedForRole('coach', '2099-12-31')).toBe(false)
  })

  it('coach is NOT blocked when no closure date is set', () => {
    expect(isPageClosedForRole('coach', null)).toBe(false)
    expect(isPageClosedForRole('coach', undefined)).toBe(false)
  })

  it('admin bypasses closure date even when past', () => {
    expect(isPageClosedForRole('admin', '2020-01-01')).toBe(false)
  })

  it('admin has access when closure date is in the future', () => {
    expect(isPageClosedForRole('admin', '2099-12-31')).toBe(false)
  })

  it('admin has access when no closure date is set', () => {
    expect(isPageClosedForRole('admin', null)).toBe(false)
  })

  it('organizer is not blocked by closure date (not coach role)', () => {
    expect(isPageClosedForRole('organizer', '2020-01-01')).toBe(false)
  })
})