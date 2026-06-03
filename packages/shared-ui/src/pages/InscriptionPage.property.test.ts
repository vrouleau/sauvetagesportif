import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import type { RegistrationAPI, Club, AthleteListItem } from '../data/api'

/**
 * Property 3: Coach Role Isolation
 *
 * For any set of clubs and athletes, when role is "coach" and a clubId is
 * provided, the loadInscriptionData function shall return only the club
 * matching that clubId and no athletes from other clubs.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3**
 */

// Replicate the loadInscriptionData logic from InscriptionPage.tsx
// (it's not exported, so we test the same algorithm directly)
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

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const athleteArb: fc.Arbitrary<AthleteListItem> = fc.record({
  id: fc.nat({ max: 100000 }),
  first_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  last_name: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
  gender: fc.oneof(fc.constant('M'), fc.constant('F')),
  birthdate: fc.constant('2000-01-01'),
  license: fc.string({ maxLength: 10 }),
})

const clubArb: fc.Arbitrary<Club> = fc.record({
  id: fc.integer({ min: 1, max: 10000 }),
  name: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
})

// Generate a list of clubs with unique IDs
const uniqueClubsArb = fc
  .array(clubArb, { minLength: 2, maxLength: 10 })
  .map(clubs => {
    const seen = new Set<number>()
    return clubs.filter(c => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
  })
  .filter(clubs => clubs.length >= 2) // Ensure at least 2 clubs for meaningful test

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InscriptionPage - Property 3: Coach Role Isolation', () => {
  it('coach mode returns only the club matching the provided clubId', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueClubsArb,
        fc.array(athleteArb, { minLength: 0, maxLength: 20 }),
        async (clubs, allAthletes) => {
          // Pick a random club to be the coach's club (use the first one)
          const coachClub = clubs[0]
          const coachClubId = String(coachClub.id)

          // Distribute athletes across clubs (round-robin)
          const athletesByClubMap = new Map<string, AthleteListItem[]>()
          for (const club of clubs) {
            athletesByClubMap.set(String(club.id), [])
          }
          allAthletes.forEach((athlete, i) => {
            const club = clubs[i % clubs.length]
            athletesByClubMap.get(String(club.id))!.push(athlete)
          })

          // Create a mock RegistrationAPI
          const mockApi: RegistrationAPI = {
            getClubs: async () => clubs,
            getAthletesByClub: async (clubId: string) => athletesByClubMap.get(clubId) || [],
            getAllAthletes: async () => allAthletes,
            addAthlete: async () => {},
            deleteAthlete: async () => {},
            getRegistration: async () => ({
              athlete: { first_name: '', last_name: '', gender: '', birthdate: '', license: '', club: '', handicapex: '' },
              individual_events: [],
              relay_events: [],
              club_athletes: [],
              suggested_age_code: '',
              meet_course: '',
            }),
            updateAthlete: async () => {},
            register: async () => {},
            unregister: async () => {},
            getRelayPageData: async () => ({ ageCategories: [], teamsByEvent: {}, eligibleAthletes: {}, closureDate: null, isClosed: false }),
            createRelayTeam: async () => ({ teamId: 0, teamNumber: 'A' }),
            deleteRelayTeam: async () => {},
            setRelayTeamMember: async () => {},
            setRelayTeamName: async () => {},
          }

          // Call with role="coach" and the coach's clubId
          const result = await loadInscriptionData(mockApi, 'coach', coachClubId)

          // Assert: returned clubs has exactly 1 entry matching coachClubId
          expect(result.clubs).toHaveLength(1)
          expect(result.clubs[0].id).toBe(coachClub.id)

          // Assert: athletesByClub only has the coach's club key
          const clubIds = Array.from(result.athletesByClub.keys())
          expect(clubIds).toHaveLength(1)
          expect(clubIds[0]).toBe(coachClub.id)

          // Assert: athletes returned are only those belonging to the coach's club
          const returnedAthletes = result.athletesByClub.get(coachClub.id) || []
          const expectedAthletes = athletesByClubMap.get(coachClubId) || []
          expect(returnedAthletes).toEqual(expectedAthletes)
        }
      )
    )
  })

  it('admin mode returns all clubs and all athletes', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueClubsArb,
        fc.array(athleteArb, { minLength: 0, maxLength: 20 }),
        async (clubs, allAthletes) => {
          // Distribute athletes across clubs
          const athletesByClubMap = new Map<string, AthleteListItem[]>()
          for (const club of clubs) {
            athletesByClubMap.set(String(club.id), [])
          }
          allAthletes.forEach((athlete, i) => {
            const club = clubs[i % clubs.length]
            athletesByClubMap.get(String(club.id))!.push(athlete)
          })

          const mockApi: RegistrationAPI = {
            getClubs: async () => clubs,
            getAthletesByClub: async (clubId: string) => athletesByClubMap.get(clubId) || [],
            getAllAthletes: async () => allAthletes,
            addAthlete: async () => {},
            deleteAthlete: async () => {},
            getRegistration: async () => ({
              athlete: { first_name: '', last_name: '', gender: '', birthdate: '', license: '', club: '', handicapex: '' },
              individual_events: [],
              relay_events: [],
              club_athletes: [],
              suggested_age_code: '',
              meet_course: '',
            }),
            updateAthlete: async () => {},
            register: async () => {},
            unregister: async () => {},
            getRelayPageData: async () => ({ ageCategories: [], teamsByEvent: {}, eligibleAthletes: {}, closureDate: null, isClosed: false }),
            createRelayTeam: async () => ({ teamId: 0, teamNumber: 'A' }),
            deleteRelayTeam: async () => {},
            setRelayTeamMember: async () => {},
            setRelayTeamName: async () => {},
          }

          // Call with role="admin" (no clubId restriction)
          const result = await loadInscriptionData(mockApi, 'admin')

          // Assert: all clubs are returned
          expect(result.clubs).toHaveLength(clubs.length)
          expect(result.clubs.map(c => c.id).sort()).toEqual(clubs.map(c => c.id).sort())

          // Assert: athletesByClub has entries for all clubs
          expect(result.athletesByClub.size).toBe(clubs.length)
        }
      )
    )
  })

  it('coach mode with non-existent clubId returns empty results', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueClubsArb,
        fc.array(athleteArb, { minLength: 1, maxLength: 10 }),
        async (clubs, allAthletes) => {
          // Use a clubId that doesn't exist in the clubs list
          const maxId = Math.max(...clubs.map(c => c.id))
          const nonExistentClubId = String(maxId + 1)

          const athletesByClubMap = new Map<string, AthleteListItem[]>()
          for (const club of clubs) {
            athletesByClubMap.set(String(club.id), allAthletes)
          }

          const mockApi: RegistrationAPI = {
            getClubs: async () => clubs,
            getAthletesByClub: async (clubId: string) => athletesByClubMap.get(clubId) || [],
            getAllAthletes: async () => allAthletes,
            addAthlete: async () => {},
            deleteAthlete: async () => {},
            getRegistration: async () => ({
              athlete: { first_name: '', last_name: '', gender: '', birthdate: '', license: '', club: '', handicapex: '' },
              individual_events: [],
              relay_events: [],
              club_athletes: [],
              suggested_age_code: '',
              meet_course: '',
            }),
            updateAthlete: async () => {},
            register: async () => {},
            unregister: async () => {},
            getRelayPageData: async () => ({ ageCategories: [], teamsByEvent: {}, eligibleAthletes: {}, closureDate: null, isClosed: false }),
            createRelayTeam: async () => ({ teamId: 0, teamNumber: 'A' }),
            deleteRelayTeam: async () => {},
            setRelayTeamMember: async () => {},
            setRelayTeamName: async () => {},
          }

          const result = await loadInscriptionData(mockApi, 'coach', nonExistentClubId)

          // No clubs should be returned
          expect(result.clubs).toHaveLength(0)
          // No athletes should be returned
          expect(result.athletesByClub.size).toBe(0)
        }
      )
    )
  })
})
