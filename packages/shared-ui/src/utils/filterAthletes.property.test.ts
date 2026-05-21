import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { filterAthletes, computeVisibleExpansion } from './filterAthletes'
import type { AthleteListItem } from '../data/api'

// ─── Arbitraries ────────────────────────────────────────────────────────────────

/** Generate a valid athlete with arbitrary name parts */
const athleteArb = (id: number): fc.Arbitrary<AthleteListItem> =>
  fc.record({
    id: fc.constant(id),
    first_name: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/\s/g, 'a') || 'A'),
    last_name: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/\s/g, 'b') || 'B'),
    gender: fc.constantFrom('M', 'F'),
    birthdate: fc.constant('2000-01-01'),
    license: fc.constant(''),
  })

/** Generate a map of clubs to athletes with unique IDs */
const athletesByClubArb: fc.Arbitrary<Map<number, AthleteListItem[]>> = fc
  .array(
    fc.tuple(
      fc.nat({ max: 999 }), // clubId
      fc.integer({ min: 1, max: 8 }) // number of athletes in this club
    ),
    { minLength: 1, maxLength: 5 }
  )
  .chain((clubSpecs) => {
    // Deduplicate club IDs
    const uniqueClubs = [...new Map(clubSpecs.map((c) => [c[0], c[1]])).entries()]
    let nextId = 1
    const clubArbs = uniqueClubs.map(([clubId, count]) => {
      const athletes = fc.tuple(...Array.from({ length: count }, () => athleteArb(nextId++)))
      return athletes.map((athl) => [clubId, athl] as [number, AthleteListItem[]])
    })
    return fc.tuple(...clubArbs).map((entries) => new Map(entries))
  })

/** Generate a non-empty filter string (printable, no leading/trailing whitespace) */
const nonEmptyFilterArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 10 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

// ─── Property 2: Filter Correctness ────────────────────────────────────────────
// **Validates: Requirements 2.2, 2.4**

describe('Property 2: Filter Correctness', () => {
  it('every visible athlete must match the filter text (case-insensitive substring)', () => {
    fc.assert(
      fc.property(athletesByClubArb, nonEmptyFilterArb, (athletesByClub, filterText) => {
        const { filtered } = filterAthletes(athletesByClub, filterText)
        const needle = filterText.toLowerCase()

        for (const [, athletes] of filtered) {
          for (const athlete of athletes) {
            const fullName = `${athlete.first_name} ${athlete.last_name}`.toLowerCase()
            expect(fullName).toContain(needle)
          }
        }
      }),
      { numRuns: 200 }
    )
  })

  it('no club with zero matching athletes shall be visible', () => {
    fc.assert(
      fc.property(athletesByClubArb, nonEmptyFilterArb, (athletesByClub, filterText) => {
        const { filtered } = filterAthletes(athletesByClub, filterText)

        for (const [, athletes] of filtered) {
          expect(athletes.length).toBeGreaterThan(0)
        }
      }),
      { numRuns: 200 }
    )
  })
})

// ─── Property 1: Cascade Default Collapsed ──────────────────────────────────────
// **Validates: Requirements 1.2, 9.1, 9.2**

describe('Property 1: Cascade Default Collapsed', () => {
  it('for any set of clubs, the initial expanded state shall be an empty set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 999 }), { minLength: 0, maxLength: 20 }),
        (clubIds) => {
          // The design specifies expandedClubs starts as new Set()
          // computeVisibleExpansion with no filter returns the manual state
          const initialExpandedClubs = new Set<number>() // always empty on init
          const autoExpandClubs = new Set<number>() // no filter active
          const filterText = '' // no filter on initial load

          const visibleExpansion = computeVisibleExpansion(
            initialExpandedClubs,
            autoExpandClubs,
            filterText
          )

          // Regardless of how many clubs exist, initial expansion is empty
          expect(visibleExpansion.size).toBe(0)
          // No club should be expanded
          for (const clubId of clubIds) {
            expect(visibleExpansion.has(clubId)).toBe(false)
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

// ─── Property 4: Filter Auto-Expansion ──────────────────────────────────────────
// **Validates: Requirements 2.3**

describe('Property 4: Filter Auto-Expansion', () => {
  it('every club with at least one matching athlete shall be in autoExpandClubs', () => {
    fc.assert(
      fc.property(athletesByClubArb, nonEmptyFilterArb, (athletesByClub, filterText) => {
        const { filtered, autoExpandClubs } = filterAthletes(athletesByClub, filterText)

        // Every club in the filtered result must be auto-expanded
        for (const clubId of filtered.keys()) {
          expect(autoExpandClubs.has(clubId)).toBe(true)
        }

        // Additionally verify: autoExpandClubs only contains clubs with matches
        for (const clubId of autoExpandClubs) {
          expect(filtered.has(clubId)).toBe(true)
        }
      }),
      { numRuns: 200 }
    )
  })

  it('when filter produces matches, computeVisibleExpansion returns autoExpandClubs', () => {
    fc.assert(
      fc.property(athletesByClubArb, nonEmptyFilterArb, (athletesByClub, filterText) => {
        const { autoExpandClubs } = filterAthletes(athletesByClub, filterText)
        const manualExpanded = new Set<number>() // doesn't matter when filter is active

        const visibleExpansion = computeVisibleExpansion(
          manualExpanded,
          autoExpandClubs,
          filterText
        )

        // When filter is active, visible expansion equals autoExpandClubs
        expect(visibleExpansion).toBe(autoExpandClubs)
      }),
      { numRuns: 200 }
    )
  })
})

// ─── Property 5: Filter Round-Trip ──────────────────────────────────────────────
// **Validates: Requirements 2.5**

describe('Property 5: Filter Round-Trip', () => {
  it('applying a filter and then clearing it restores the original manual expansion state', () => {
    fc.assert(
      fc.property(
        athletesByClubArb,
        nonEmptyFilterArb,
        fc.array(fc.nat({ max: 999 }), { minLength: 0, maxLength: 10 }),
        (athletesByClub, filterText, manualExpandedArr) => {
          const manualExpanded = new Set(manualExpandedArr)

          // Step 1: Apply filter — expansion becomes autoExpandClubs
          const { autoExpandClubs } = filterAthletes(athletesByClub, filterText)
          const duringFilter = computeVisibleExpansion(manualExpanded, autoExpandClubs, filterText)
          // During filter, expansion is autoExpandClubs (not manual)
          expect(duringFilter).toBe(autoExpandClubs)

          // Step 2: Clear filter — expansion restores to manual state
          const afterClear = computeVisibleExpansion(manualExpanded, new Set(), '')
          expect(afterClear).toBe(manualExpanded)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('clearing the filter shows all athletes (filtered returns original map)', () => {
    fc.assert(
      fc.property(athletesByClubArb, (athletesByClub) => {
        // With empty filter, filterAthletes returns the original map
        const { filtered, autoExpandClubs } = filterAthletes(athletesByClub, '')
        expect(filtered).toBe(athletesByClub)
        expect(autoExpandClubs.size).toBe(0)
      }),
      { numRuns: 200 }
    )
  })
})
