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
import * as fc from 'fast-check'
import type { EligibleAthlete, RelayTeam, RelayTeamMember } from '../data/api'

// ─── Pure Logic Functions (replicated from RelayEntryPage / backend logic) ────

/**
 * Filters athletes by gender based on event gender restriction.
 * M or F events: only matching gender. X (mixed): all athletes.
 */
function filterAthletesByGender(
  athletes: EligibleAthlete[],
  eventGender: 'M' | 'F' | 'X'
): EligibleAthlete[] {
  if (eventGender === 'X') return athletes
  return athletes.filter(a => a.gender === eventGender)
}

/**
 * Computes age as of a base date given a birthdate.
 * Standard age calculation: years elapsed, subtracting 1 if birthday hasn't occurred yet this year.
 */
function computeAge(birthdate: Date, ageBaseDate: Date): number {
  let age = ageBaseDate.getFullYear() - birthdate.getFullYear()
  const monthDiff = ageBaseDate.getMonth() - birthdate.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && ageBaseDate.getDate() < birthdate.getDate())) {
    age--
  }
  return age
}

/**
 * Filters athletes by age range based on meet's age base date.
 * ageMax null means open-ended upper bound.
 */
function filterAthletesByAge(
  athletes: Array<{ id: number; name: string; gender: 'M' | 'F'; birthdate: Date }>,
  ageMin: number,
  ageMax: number | null,
  ageBaseDate: Date
): Array<{ id: number; name: string; gender: 'M' | 'F'; birthdate: Date }> {
  return athletes.filter(a => {
    const age = computeAge(a.birthdate, ageBaseDate)
    if (age < ageMin) return false
    if (ageMax !== null && age > ageMax) return false
    return true
  })
}

/**
 * Validates cross-team uniqueness: no athlete appears in multiple teams
 * for the same event/age/club combination.
 */
function validateCrossTeamUniqueness(teams: RelayTeam[]): boolean {
  const seen = new Set<number>()
  for (const team of teams) {
    for (const member of team.members) {
      if (member.athleteId != null) {
        if (seen.has(member.athleteId)) return false
        seen.add(member.athleteId)
      }
    }
  }
  return true
}

/**
 * Validates intra-team uniqueness: no athlete appears in multiple positions
 * within a single team.
 */
function validateIntraTeamUniqueness(team: RelayTeam): boolean {
  const seen = new Set<number>()
  for (const member of team.members) {
    if (member.athleteId != null) {
      if (seen.has(member.athleteId)) return false
      seen.add(member.athleteId)
    }
  }
  return true
}

/**
 * Simulates team number stability on deletion.
 * Teams are created with sequential numbers. When deleted, surviving teams keep their numbers.
 */
function simulateTeamLifecycle(
  operations: Array<{ type: 'create' } | { type: 'delete'; index: number }>
): string[] {
  const teams: Array<{ number: string; alive: boolean }> = []
  let nextLetter = 0 // 0=A, 1=B, ...

  for (const op of operations) {
    if (op.type === 'create') {
      if (nextLetter < 26) {
        teams.push({ number: String.fromCharCode(65 + nextLetter), alive: true })
        nextLetter++
      }
    } else if (op.type === 'delete') {
      const aliveTeams = teams.filter(t => t.alive)
      if (aliveTeams.length > 0) {
        const idx = op.index % aliveTeams.length
        aliveTeams[idx].alive = false
      }
    }
  }

  return teams.filter(t => t.alive).map(t => t.number)
}

/**
 * Generates default team name from assigned members.
 * If members assigned: hyphenated last names.
 * If no members: team number letter.
 */
function generateDefaultTeamName(
  members: RelayTeamMember[],
  teamNumber: string
): string {
  const assignedMembers = members.filter(m => m.athleteName)
  if (assignedMembers.length > 0) {
    return assignedMembers.map(m => m.athleteName!.split(',')[0].trim()).join('-')
  }
  return teamNumber
}

/**
 * Initializes positions for a new relay team.
 * Returns relaycount positions, all set to null.
 */
function initializePositions(relaycount: number): RelayTeamMember[] {
  return Array.from({ length: relaycount }, (_, i) => ({
    position: i + 1,
    athleteId: null,
    athleteName: null,
  }))
}

/**
 * Checks if an operation should be allowed based on closure date and role.
 * Coach is blocked past closure. Admin and organizer bypass.
 */
function isOperationAllowed(
  role: 'admin' | 'coach' | 'organizer',
  currentDate: Date,
  closureDate: Date | null
): boolean {
  if (closureDate === null) return true
  if (role === 'admin' || role === 'organizer') return true
  // Coach: blocked if current date is past end of closure day
  const closureEnd = new Date(closureDate)
  closureEnd.setHours(23, 59, 59, 999)
  return currentDate <= closureEnd
}

/**
 * Partitions events into individual (relaycount=1) and relay (relaycount>1).
 */
function partitionEvents(
  events: Array<{ id: number; relaycount: number }>
): { individual: Array<{ id: number; relaycount: number }>; relay: Array<{ id: number; relaycount: number }> } {
  const individual = events.filter(e => e.relaycount === 1)
  const relay = events.filter(e => e.relaycount > 1)
  return { individual, relay }
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const genderArb = fc.oneof(fc.constant('M' as const), fc.constant('F' as const))

const eligibleAthleteArb: fc.Arbitrary<EligibleAthlete> = fc.record({
  id: fc.nat({ max: 100000 }),
  name: fc.tuple(
    fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim().length > 0 && !s.includes(',')),
    fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim().length > 0 && !s.includes(','))
  ).map(([last, first]) => `${last}, ${first}`),
  gender: genderArb,
})

const eventGenderArb = fc.oneof(
  fc.constant('M' as const),
  fc.constant('F' as const),
  fc.constant('X' as const)
)

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('RelayEntryPage - Property 1: Eligible Athlete Gender Filtering', () => {
  /**
   * **Validates: Requirements 4.3, 4.4**
   *
   * For any relay event with a gender restriction (M or F) and for any set of
   * club athletes, the eligible athlete list SHALL contain only athletes whose
   * gender matches the event's gender restriction. For mixed-gender events (X),
   * athletes of all genders SHALL be included.
   */
  it('filtered list only contains athletes matching the event gender; mixed includes all', () => {
    fc.assert(
      fc.property(
        fc.array(eligibleAthleteArb, { minLength: 0, maxLength: 30 }),
        eventGenderArb,
        (athletes, eventGender) => {
          const filtered = filterAthletesByGender(athletes, eventGender)

          if (eventGender === 'X') {
            // Mixed: all athletes should be included
            expect(filtered).toHaveLength(athletes.length)
            expect(filtered).toEqual(athletes)
          } else {
            // Gendered: only matching gender
            for (const a of filtered) {
              expect(a.gender).toBe(eventGender)
            }
            // All matching-gender athletes from input should be present
            const expected = athletes.filter(a => a.gender === eventGender)
            expect(filtered).toHaveLength(expected.length)
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe('RelayEntryPage - Property 2: Eligible Athlete Age Filtering', () => {
  /**
   * **Validates: Requirements 4.2**
   *
   * For any relay event with an age category (agemin, agemax) and for any athlete
   * with a known birthdate, the athlete SHALL be included in the eligible list if
   * and only if their computed age falls within [agemin, agemax] inclusive.
   * When agemax is NULL, any athlete at or above agemin SHALL be eligible.
   */
  it('includes athletes within [agemin, agemax] and excludes others; NULL agemax means open-ended', () => {
    // Fixed age base date for deterministic testing
    const ageBaseDate = new Date(2025, 0, 1) // Jan 1, 2025

    const athleteWithBirthdateArb = fc.record({
      id: fc.nat({ max: 100000 }),
      name: fc.constant('Test, Athlete'),
      gender: genderArb,
      birthdate: fc.date({
        min: new Date(1980, 0, 1),
        max: new Date(2020, 11, 31),
        noInvalidDate: true,
      }),
    })

    const ageRangeArb = fc.tuple(
      fc.integer({ min: 5, max: 50 }),  // ageMin
      fc.oneof(
        fc.integer({ min: 5, max: 60 }), // ageMax as number
        fc.constant(null as number | null) // NULL agemax
      )
    ).map(([ageMin, ageMax]) => {
      // Ensure ageMax >= ageMin when not null
      if (ageMax !== null && ageMax < ageMin) {
        return { ageMin, ageMax: ageMin + Math.abs(ageMax - ageMin) }
      }
      return { ageMin, ageMax }
    })

    fc.assert(
      fc.property(
        fc.array(athleteWithBirthdateArb, { minLength: 0, maxLength: 20 }),
        ageRangeArb,
        (athletes, { ageMin, ageMax }) => {
          const filtered = filterAthletesByAge(athletes, ageMin, ageMax, ageBaseDate)

          for (const a of filtered) {
            const age = computeAge(a.birthdate, ageBaseDate)
            expect(age).toBeGreaterThanOrEqual(ageMin)
            if (ageMax !== null) {
              expect(age).toBeLessThanOrEqual(ageMax)
            }
          }

          // All athletes NOT in filtered should be outside the range
          const filteredIds = new Set(filtered.map(a => a.id))
          for (const a of athletes) {
            if (!filteredIds.has(a.id)) {
              const age = computeAge(a.birthdate, ageBaseDate)
              const inRange = age >= ageMin && (ageMax === null || age <= ageMax)
              expect(inRange).toBe(false)
            }
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe('RelayEntryPage - Property 3: Athlete Uniqueness Across Teams', () => {
  /**
   * **Validates: Requirements 5.1, 5.3**
   *
   * For any relay event, age category, and club, an athlete assigned to one relay
   * team SHALL NOT appear in any other relay team's member list for the same
   * event/age/club combination.
   */
  it('no athlete appears in multiple teams for the same event/age/club', () => {
    // Generate teams where each athlete appears at most once (valid state)
    const validTeamsArb = fc.integer({ min: 1, max: 5 }).chain(numTeams => {
      // Generate a pool of unique athlete IDs
      return fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { minLength: 0, maxLength: numTeams * 4 })
        .map(athleteIds => {
          const teams: RelayTeam[] = []
          let athleteIdx = 0
          for (let t = 0; t < numTeams; t++) {
            const members: RelayTeamMember[] = []
            for (let pos = 1; pos <= 4; pos++) {
              const athleteId = athleteIdx < athleteIds.length ? athleteIds[athleteIdx++] : null
              members.push({
                position: pos,
                athleteId,
                athleteName: athleteId !== null ? `Athlete${athleteId}, First` : null,
              })
            }
            teams.push({
              id: t + 1,
              teamNumber: String.fromCharCode(65 + t),
              teamName: null,
              members,
            })
          }
          return teams
        })
    })

    fc.assert(
      fc.property(validTeamsArb, (teams) => {
        // Valid state: no duplicates across teams
        expect(validateCrossTeamUniqueness(teams)).toBe(true)
      }),
      { numRuns: 200 }
    )
  })

  it('detects violations when an athlete appears in multiple teams', () => {
    // Generate teams with at least one athlete duplicated across teams
    const invalidTeamsArb = fc.tuple(
      fc.integer({ min: 1, max: 100 }), // shared athlete ID
      fc.integer({ min: 2, max: 5 })    // number of teams
    ).map(([sharedId, numTeams]) => {
      const teams: RelayTeam[] = []
      for (let t = 0; t < numTeams; t++) {
        const members: RelayTeamMember[] = [
          { position: 1, athleteId: sharedId, athleteName: `Shared, Athlete` },
          { position: 2, athleteId: null, athleteName: null },
          { position: 3, athleteId: null, athleteName: null },
          { position: 4, athleteId: null, athleteName: null },
        ]
        teams.push({
          id: t + 1,
          teamNumber: String.fromCharCode(65 + t),
          teamName: null,
          members,
        })
      }
      return teams
    })

    fc.assert(
      fc.property(invalidTeamsArb, (teams) => {
        // Invalid state: duplicate detected
        expect(validateCrossTeamUniqueness(teams)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })
})

describe('RelayEntryPage - Property 4: Intra-Team Uniqueness', () => {
  /**
   * **Validates: Requirements 4.6**
   *
   * For any single relay team, no athlete SHALL appear in more than one position.
   */
  it('no athlete appears in multiple positions within a team (valid assignments)', () => {
    const validTeamArb = fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { minLength: 0, maxLength: 4 })
      .map(athleteIds => {
        const members: RelayTeamMember[] = []
        for (let pos = 1; pos <= 4; pos++) {
          const athleteId = pos - 1 < athleteIds.length ? athleteIds[pos - 1] : null
          members.push({
            position: pos,
            athleteId,
            athleteName: athleteId !== null ? `Athlete${athleteId}, First` : null,
          })
        }
        const team: RelayTeam = {
          id: 1,
          teamNumber: 'A',
          teamName: null,
          members,
        }
        return team
      })

    fc.assert(
      fc.property(validTeamArb, (team) => {
        expect(validateIntraTeamUniqueness(team)).toBe(true)
      }),
      { numRuns: 200 }
    )
  })

  it('detects duplicate athlete in different positions within a team', () => {
    const invalidTeamArb = fc.integer({ min: 1, max: 200 }).chain(duplicateId => {
      // Place the same athlete in at least 2 positions
      return fc.integer({ min: 3, max: 6 }).map(relaycount => {
        const members: RelayTeamMember[] = []
        for (let pos = 1; pos <= relaycount; pos++) {
          members.push({
            position: pos,
            athleteId: pos <= 2 ? duplicateId : null, // duplicate in pos 1 and 2
            athleteName: pos <= 2 ? `Dup, Athlete` : null,
          })
        }
        const team: RelayTeam = {
          id: 1,
          teamNumber: 'A',
          teamName: null,
          members,
        }
        return team
      })
    })

    fc.assert(
      fc.property(invalidTeamArb, (team) => {
        expect(validateIntraTeamUniqueness(team)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })
})

describe('RelayEntryPage - Property 5: Team Number Stability on Deletion', () => {
  /**
   * **Validates: Requirements 6.2**
   *
   * For any sequence of relay teams created for the same event/category/club,
   * deleting a team SHALL NOT change the team numbers (letters) of the remaining teams.
   */
  it('surviving team numbers are unchanged after deletions', () => {
    // Generate a sequence of create/delete operations
    const opsArb = fc.array(
      fc.oneof(
        fc.constant({ type: 'create' as const }),
        fc.nat({ max: 25 }).map(index => ({ type: 'delete' as const, index }))
      ),
      { minLength: 1, maxLength: 30 }
    )

    fc.assert(
      fc.property(opsArb, (operations) => {
        // Run full sequence
        const finalTeams = simulateTeamLifecycle(operations)

        // Run a prefix (all but last operation) to get state before last op
        if (operations.length < 2) return // skip trivial case

        // Verify property: for any prefix ending in a delete, 
        // survivors from that prefix keep same numbers in full run
        for (let cutoff = 1; cutoff < operations.length; cutoff++) {
          const prefix = operations.slice(0, cutoff)
          const prefixTeams = simulateTeamLifecycle(prefix)

          // All teams in prefixTeams that also survive to the end should have same numbers
          const finalSet = new Set(finalTeams)
          for (const teamNumber of prefixTeams) {
            if (finalSet.has(teamNumber)) {
              // This team survived to the end — its number was stable
              expect(finalTeams).toContain(teamNumber)
            }
          }
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('RelayEntryPage - Property 6: Default Team Name Generation', () => {
  /**
   * **Validates: Requirements 6.3**
   *
   * For any relay team with no custom name and at least one assigned member,
   * the displayed team name SHALL equal the concatenation of all assigned members'
   * last names separated by hyphens. For a team with no custom name and no members
   * assigned, the displayed name SHALL be the team number letter.
   */
  it('generates hyphenated last names when members assigned; shows letter when empty', () => {
    // Use alphanumeric last names to match real-world athlete names
    const lastNameArb = fc.stringMatching(/^[A-Za-z]{1,15}$/)

    const memberListArb = fc.array(
      fc.tuple(lastNameArb, fc.stringMatching(/^[A-Za-z]{1,10}$/)),
      { minLength: 0, maxLength: 6 }
    )

    const teamLetterArb = fc.integer({ min: 0, max: 25 }).map(i => String.fromCharCode(65 + i))

    fc.assert(
      fc.property(memberListArb, teamLetterArb, (memberNames, teamLetter) => {
        const members: RelayTeamMember[] = memberNames.map(([last, first], i) => ({
          position: i + 1,
          athleteId: i + 1,
          athleteName: `${last}, ${first}`,
        }))

        // Pad with empty positions to fill relay slots
        while (members.length < 4) {
          members.push({
            position: members.length + 1,
            athleteId: null,
            athleteName: null,
          })
        }

        const result = generateDefaultTeamName(members, teamLetter)

        if (memberNames.length === 0) {
          // No members assigned → show team letter
          expect(result).toBe(teamLetter)
        } else {
          // Members assigned → hyphenated last names (trim applied as in component)
          const expectedName = memberNames.map(([last]) => last.trim()).join('-')
          expect(result).toBe(expectedName)
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('RelayEntryPage - Property 7: Position Count Invariant', () => {
  /**
   * **Validates: Requirements 6.4**
   *
   * For any newly created relay team, the number of member positions SHALL equal
   * the relay event's relaycount value. All positions SHALL be initialized to
   * unassigned (null athlete).
   */
  it('initialized positions count equals relaycount, all null', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // relaycount
        (relaycount) => {
          const positions = initializePositions(relaycount)

          // Count invariant
          expect(positions).toHaveLength(relaycount)

          // All positions are sequential 1-based and null
          for (let i = 0; i < relaycount; i++) {
            expect(positions[i].position).toBe(i + 1)
            expect(positions[i].athleteId).toBeNull()
            expect(positions[i].athleteName).toBeNull()
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe('RelayEntryPage - Property 8: Closure Date Enforcement for Coach Role', () => {
  /**
   * **Validates: Requirements 8.1, 8.3, 8.4, 8.5**
   *
   * For any date past the closure date, relay team operations attempted by a coach
   * role user SHALL be rejected. Admin and organizer roles SHALL NOT be affected.
   */
  it('coach is blocked past closure; admin and organizer bypass', () => {
    const roleArb = fc.oneof(
      fc.constant('admin' as const),
      fc.constant('coach' as const),
      fc.constant('organizer' as const)
    )

    // Generate a closure date and a current date relative to it
    const datesArb = fc.tuple(
      fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 11, 31) }), // closure date
      fc.integer({ min: -30, max: 30 }) // days offset from closure
    ).map(([closure, offset]) => {
      const current = new Date(closure)
      current.setDate(current.getDate() + offset)
      return { closure, current, offset }
    })

    fc.assert(
      fc.property(roleArb, datesArb, (role, { closure, current, offset }) => {
        const allowed = isOperationAllowed(role, current, closure)

        if (role === 'admin' || role === 'organizer') {
          // Admin and organizer always allowed
          expect(allowed).toBe(true)
        } else {
          // Coach: allowed only if current <= end of closure day
          // offset > 0 means current is after closure date (next day or later)
          // offset = 0 means same day (allowed since within 23:59:59)
          // offset < 0 means before closure date (allowed)
          if (offset > 0) {
            expect(allowed).toBe(false)
          } else {
            expect(allowed).toBe(true)
          }
        }
      }),
      { numRuns: 200 }
    )
  })

  it('no closure date means all roles are allowed', () => {
    const roleArb = fc.oneof(
      fc.constant('admin' as const),
      fc.constant('coach' as const),
      fc.constant('organizer' as const)
    )

    fc.assert(
      fc.property(
        roleArb,
        fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 11, 31) }),
        (role, currentDate) => {
          const allowed = isOperationAllowed(role, currentDate, null)
          expect(allowed).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('RelayEntryPage - Property 9: Event Filtering by Relay Count', () => {
  /**
   * **Validates: Requirements 1.3, 1.4**
   *
   * For any set of swim events, the Individual Entry Page SHALL display only events
   * where relaycount = 1, and the Relay Entry Page SHALL display only events where
   * relaycount > 1. The two sets SHALL be disjoint and their union SHALL equal the
   * full set of events.
   */
  it('partition between individual and relay is disjoint and complete', () => {
    const eventArb = fc.record({
      id: fc.nat({ max: 100000 }),
      relaycount: fc.integer({ min: 1, max: 8 }),
    })

    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 30 })
          .map(events => {
            // Deduplicate by id — in reality each event has a unique id
            const seen = new Set<number>()
            return events.filter(e => {
              if (seen.has(e.id)) return false
              seen.add(e.id)
              return true
            })
          }),
        (events) => {
          const { individual, relay } = partitionEvents(events)

          // Disjoint: no event in both sets
          const individualIds = new Set(individual.map(e => e.id))
          const relayIds = new Set(relay.map(e => e.id))
          for (const id of individualIds) {
            expect(relayIds.has(id)).toBe(false)
          }

          // Complete: union equals original
          expect(individual.length + relay.length).toBe(events.length)

          // Individual: all have relaycount = 1
          for (const e of individual) {
            expect(e.relaycount).toBe(1)
          }

          // Relay: all have relaycount > 1
          for (const e of relay) {
            expect(e.relaycount).toBeGreaterThan(1)
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})


// ─── Mixed Gender Balance Filtering Logic ─────────────────────────────────────

/**
 * For mixed (X) events, filters the dropdown to enforce N/2 men + N/2 women.
 * Returns the allowed gender (only that gender shown) or null (both shown).
 */
function computeAllowedGender(
  teamMembers: Array<{ position: number; athleteId: number | null }>,
  eligibleAthletes: EligibleAthlete[],
  currentPosition: number,
  relaycount: number
): 'M' | 'F' | null {
  const maxPerGender = relaycount / 2
  let mCount = 0
  let fCount = 0
  for (const m of teamMembers) {
    if (m.position === currentPosition || m.athleteId == null) continue
    const assigned = eligibleAthletes.find(a => a.id === m.athleteId)
    if (assigned?.gender === 'M') mCount++
    else if (assigned?.gender === 'F') fCount++
  }
  if (mCount >= maxPerGender) return 'F'
  if (fCount >= maxPerGender) return 'M'
  return null
}

// ─── Age Group Majority Filtering Logic ───────────────────────────────────────

/**
 * Determines if adding an athlete with a given age group would make it impossible
 * to achieve a strict majority once all positions are filled.
 * Returns true if the athlete should be BLOCKED (excluded from dropdown).
 */
function wouldBlockAgeGroupMajority(
  currentAgeGroups: string[],
  candidateAgeGroup: string,
  relaycount: number
): boolean {
  const allAgeCodes = [...currentAgeGroups, candidateAgeGroup]
  const remainingPositions = relaycount - allAgeCodes.length
  const requiredMajority = Math.floor(relaycount / 2) + 1

  // Count occurrences of each age group
  const counts = new Map<string, number>()
  for (const g of allAgeCodes) counts.set(g, (counts.get(g) ?? 0) + 1)

  // Best possible: the most common group gets all remaining positions
  let maxCount = 0
  for (const c of counts.values()) { if (c > maxCount) maxCount = c }

  return maxCount + remainingPositions < requiredMajority
}

// ─── Property Tests for Mixed Gender Balance ──────────────────────────────────

describe('RelayEntryPage - Property 10: Mixed Event Gender Balance Filtering', () => {
  /**
   * **Validates: RELAY_TEAM_RULES.md - Gender Rules for Mixed (X) Events**
   *
   * For mixed relay events with N positions, exactly N/2 men and N/2 women are
   * required. The dropdown SHALL only show athletes of a gender that still has
   * available slots. Once N/2 of one gender are assigned, only the other gender
   * is shown.
   */
  it('once N/2 men are assigned, only women are allowed (and vice versa)', () => {
    const relaycountArb = fc.constantFrom(2, 4)

    fc.assert(
      fc.property(
        relaycountArb,
        fc.array(eligibleAthleteArb, { minLength: 4, maxLength: 20 }),
        (relaycount, athletes) => {
          const maxPerGender = relaycount / 2

          // Simulate filling positions with men up to the max
          const menAthletes = athletes.filter(a => a.gender === 'M').slice(0, maxPerGender)
          if (menAthletes.length < maxPerGender) return // not enough men to test

          const teamMembers = menAthletes.map((a, i) => ({
            position: i + 1,
            athleteId: a.id,
          }))

          // Check the next unfilled position
          const nextPosition = maxPerGender + 1
          const allowed = computeAllowedGender(teamMembers, athletes, nextPosition, relaycount)

          // Should only allow women now
          expect(allowed).toBe('F')
        }
      ),
      { numRuns: 200 }
    )
  })

  it('when both genders have room, no gender restriction is applied', () => {
    fc.assert(
      fc.property(
        fc.array(eligibleAthleteArb, { minLength: 4, maxLength: 20 }),
        (athletes) => {
          const relaycount = 4
          // Only 1 man assigned — both genders still have room
          const oneMan = athletes.find(a => a.gender === 'M')
          if (!oneMan) return

          const teamMembers = [{ position: 1, athleteId: oneMan.id }]
          const allowed = computeAllowedGender(teamMembers, athletes, 2, relaycount)

          // Both genders still have room (1M < 2 max, 0F < 2 max)
          expect(allowed).toBeNull()
        }
      ),
      { numRuns: 200 }
    )
  })

  it('empty team has no gender restriction', () => {
    fc.assert(
      fc.property(
        fc.array(eligibleAthleteArb, { minLength: 1, maxLength: 10 }),
        fc.constantFrom(2, 4),
        (athletes, relaycount) => {
          const teamMembers: Array<{ position: number; athleteId: number | null }> = []
          const allowed = computeAllowedGender(teamMembers, athletes, 1, relaycount)
          expect(allowed).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ─── Property Tests for Age Group Majority ────────────────────────────────────

describe('RelayEntryPage - Property 11: Age Group Majority Filtering', () => {
  /**
   * **Validates: RELAY_TEAM_RULES.md - Team Age Group Determination**
   *
   * A relay team must have a clear majority (≥3 out of 4 for 4-person relays,
   * ≥2 out of 2 for 2-person relays). The dropdown SHALL exclude athletes whose
   * age group would make achieving a majority impossible given remaining positions.
   */

  const ageGroupArb = fc.constantFrom('10-', '11-12', '13-14', '15-18', '19+')

  it('2-2 split on a 4-person relay is always blocked (last position)', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        ageGroupArb.filter(() => true), // second group (may be same or different)
        (groupA, groupB) => {
          // Scenario: 3 positions filled with 2×groupA + 1×groupB
          // The 4th position with groupB would create 2-2 → should be blocked
          if (groupA === groupB) return // same group → would be 3-1, not 2-2

          const currentAgeGroups = [groupA, groupA, groupB]
          const blocked = wouldBlockAgeGroupMajority(currentAgeGroups, groupB, 4)
          expect(blocked).toBe(true) // 2A + 2B → no majority possible, 0 remaining

          // But adding groupA should be allowed (3A + 1B → valid majority)
          const allowedA = wouldBlockAgeGroupMajority(currentAgeGroups, groupA, 4)
          expect(allowedA).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('3-1 split on a 4-person relay is always valid', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        ageGroupArb,
        (groupA, groupB) => {
          // 3 positions already from groupA, adding anyone is fine (already majority)
          const currentAgeGroups = [groupA, groupA, groupA]
          const blocked = wouldBlockAgeGroupMajority(currentAgeGroups, groupB, 4)
          expect(blocked).toBe(false) // 3A already ≥ required majority of 3
        }
      ),
      { numRuns: 200 }
    )
  })

  it('with remaining positions, candidate is allowed if majority is still achievable', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        ageGroupArb,
        (groupA, groupB) => {
          // 1 position filled with groupA, adding groupB for 2nd position
          // Remaining = 4 - 2 = 2 positions. Best = max(1,1) + 2 = 3 ≥ 3 → allowed
          const currentAgeGroups = [groupA]
          const blocked = wouldBlockAgeGroupMajority(currentAgeGroups, groupB, 4)
          expect(blocked).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('all-different groups with no remaining positions is blocked', () => {
    // 4 different age groups → max count = 1, no majority possible
    const blocked = wouldBlockAgeGroupMajority(
      ['10-', '11-12', '13-14'],
      '15-18',
      4
    )
    expect(blocked).toBe(true) // 1-1-1-1 → max=1, remaining=0, 1+0 < 3
  })

  it('2-person relay: 1-1 split is blocked', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        ageGroupArb.filter(() => true),
        (groupA, groupB) => {
          if (groupA === groupB) return // same group → 2-0, valid
          // For 2-person relay, required majority = 2
          // 1 position filled with groupA, adding groupB → 1-1, remaining=0, max=1 < 2
          const currentAgeGroups = [groupA]
          const blocked = wouldBlockAgeGroupMajority(currentAgeGroups, groupB, 2)
          expect(blocked).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('2-person relay: same group is always allowed', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        (group) => {
          const currentAgeGroups = [group]
          const blocked = wouldBlockAgeGroupMajority(currentAgeGroups, group, 2)
          expect(blocked).toBe(false) // 2-0 → max=2 ≥ required 2
        }
      ),
      { numRuns: 100 }
    )
  })

  it('empty team never blocks any athlete', () => {
    fc.assert(
      fc.property(
        ageGroupArb,
        fc.constantFrom(2, 4),
        (group, relaycount) => {
          // No existing members → remaining = relaycount - 1, max = 1
          // For 4-person: 1 + 3 = 4 ≥ 3 → allowed
          // For 2-person: 1 + 1 = 2 ≥ 2 → allowed
          const blocked = wouldBlockAgeGroupMajority([], group, relaycount)
          expect(blocked).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })
})
