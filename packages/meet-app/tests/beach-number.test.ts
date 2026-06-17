/**
 * Tests for beach number generation.
 *
 * - Property-based tests: **Validates: Requirements 2.5, 3.2, 3.4, 4.5**
 * - Unit tests for sequence numbering: **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
 * - Unit tests for late arrival: **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { createTestDb } from './helpers'
import { generateBeachNumbers, assignLateBeachNumber } from '../src/main/beachNumber'
import type Database from 'better-sqlite3'

// ── Shared Helpers ────────────────────────────────────────────────────────────

/** Insert clubs and athletes into the DB, with swimresult entries to make them "registered". */
function populateDb(
  db: Database.Database,
  clubs: Array<{ code: string; name: string; athletes: Array<{ firstname: string; lastname: string }> }>
) {
  let clubId = 1
  let athleteId = 1
  let swimresultId = 1

  db.exec(`INSERT OR IGNORE INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
  db.exec(`INSERT OR IGNORE INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT OR IGNORE INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 5, 1, 'F')`)

  const insertClub = db.prepare(`INSERT INTO club (clubid, code, name) VALUES (?, ?, ?)`)
  const insertAthlete = db.prepare(`INSERT INTO athlete (athleteid, clubid, firstname, lastname) VALUES (?, ?, ?, ?)`)
  const insertResult = db.prepare(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid) VALUES (?, ?, ?)`)

  for (const club of clubs) {
    insertClub.run(clubId, club.code, club.name)
    for (const athlete of club.athletes) {
      insertAthlete.run(athleteId, clubId, athlete.firstname, athlete.lastname)
      insertResult.run(swimresultId, athleteId, 1)
      athleteId++
      swimresultId++
    }
    clubId++
  }
}

/** Read all assigned beach numbers from the DB. */
function getAllBeachNumbers(db: Database.Database): Array<{ athleteid: number; nameprefix: string }> {
  return db.prepare(`
    SELECT athleteid, nameprefix FROM athlete
    WHERE nameprefix IS NOT NULL AND nameprefix != ''
    ORDER BY athleteid
  `).all() as Array<{ athleteid: number; nameprefix: string }>
}

/** Insert a single club. */
function insertClub(db: Database.Database, clubid: number, code: string, name: string) {
  db.prepare(`INSERT INTO club (clubid, code, name) VALUES (?, ?, ?)`).run(clubid, code, name)
}

/** Insert a single athlete. */
function insertAthlete(db: Database.Database, athleteid: number, clubid: number, lastname: string, firstname: string) {
  db.prepare(
    `INSERT INTO athlete (athleteid, clubid, lastname, firstname) VALUES (?, ?, ?, ?)`
  ).run(athleteid, clubid, lastname, firstname)
}

/** Insert a swimresult linking an athlete. */
function insertSwimresult(db: Database.Database, swimresultid: number, athleteid: number) {
  db.prepare(`INSERT INTO swimresult (swimresultid, athleteid) VALUES (?, ?)`).run(swimresultid, athleteid)
}

/** Get nameprefix for an athlete. */
function getNameprefix(db: Database.Database, athleteid: number): string | null {
  const row = db.prepare(`SELECT nameprefix FROM athlete WHERE athleteid = ?`).get(athleteid) as { nameprefix: string | null } | undefined
  return row?.nameprefix ?? null
}

// ── Arbitraries (for property tests) ──────────────────────────────────────────

/** Generate a club code (1-6 chars, starts with alpha). */
const arbClubCode = fc.stringMatching(/^[A-Za-z][A-Za-z0-9\-]{0,5}$/)

/** Generate an athlete name (non-empty alpha string). */
const arbName = fc.stringMatching(/^[A-Za-z]{1,10}$/)

/** Generate an athlete record. */
const arbAthlete = fc.record({
  firstname: arbName,
  lastname: arbName,
})

/** Generate a club with athletes (1–20 athletes per club to keep tests fast). */
const arbClub = fc.record({
  code: arbClubCode,
  name: arbName,
  athletes: fc.array(arbAthlete, { minLength: 1, maxLength: 20 }),
})

/** Generate a list of clubs (1–10 clubs, ≤26 for no exhaustion errors). */
const arbClubs = fc.array(arbClub, { minLength: 1, maxLength: 10 })

// ── Property Tests ────────────────────────────────────────────────────────────

describe('Beach number generation - Property tests', () => {
  /**
   * Property 1: Determinism
   * Same input clubs/athletes always produce the same beach numbers.
   *
   * **Validates: Requirements 2.5, 3.2**
   */
  it('Property 1: Determinism — same input always produces same beach numbers', () => {
    fc.assert(
      fc.property(arbClubs, (clubs) => {
        const { db: db1, cleanup: cleanup1 } = createTestDb()
        try {
          populateDb(db1, clubs)
          generateBeachNumbers(db1)
          const results1 = getAllBeachNumbers(db1)

          const { db: db2, cleanup: cleanup2 } = createTestDb()
          try {
            populateDb(db2, clubs)
            generateBeachNumbers(db2)
            const results2 = getAllBeachNumbers(db2)

            expect(results1).toEqual(results2)
          } finally {
            cleanup2()
          }
        } finally {
          cleanup1()
        }
      }),
      { numRuns: 20 }
    )
  }, 30_000)

  /**
   * Property 2: Uniqueness
   * No two athletes share the same beach number in a meet.
   *
   * **Validates: Requirements 3.4**
   */
  it('Property 2: Uniqueness — no two athletes share the same beach number', () => {
    fc.assert(
      fc.property(arbClubs, (clubs) => {
        const { db, cleanup } = createTestDb()
        try {
          populateDb(db, clubs)
          generateBeachNumbers(db)
          const results = getAllBeachNumbers(db)

          const beachNumbers = results.map(r => r.nameprefix)
          const uniqueNumbers = new Set(beachNumbers)
          expect(uniqueNumbers.size).toBe(beachNumbers.length)
        } finally {
          cleanup()
        }
      }),
      { numRuns: 50 }
    )
  })

  /**
   * Property 3: Idempotency
   * Re-running generateBeachNumbers on same data yields identical results.
   *
   * **Validates: Requirements 4.5**
   */
  it('Property 3: Idempotency — re-running generation on same data yields identical results', () => {
    fc.assert(
      fc.property(arbClubs, (clubs) => {
        const { db, cleanup } = createTestDb()
        try {
          populateDb(db, clubs)

          generateBeachNumbers(db)
          const results1 = getAllBeachNumbers(db)

          generateBeachNumbers(db)
          const results2 = getAllBeachNumbers(db)

          expect(results1).toEqual(results2)
        } finally {
          cleanup()
        }
      }),
      { numRuns: 50 }
    )
  })
})

// ── Property Test: Late Arrival Stability ─────────────────────────────────────

describe('Beach number generation - Late arrival stability property test', () => {
  /**
   * Property 4: Late arrival stability
   * Existing beach numbers are never changed when a new athlete (late arrival) is added.
   * The new number extends the sequence without disturbing any previously assigned numbers.
   *
   * **Validates: Requirements 5.5**
   */
  it('Property 4: Late arrival stability — existing beach numbers unchanged when new athlete added', () => {
    fc.assert(
      fc.property(
        arbClubs,
        // Generate a club index to add the late arrival to (within bounds of generated clubs)
        fc.nat(),
        // Generate a late arrival athlete
        arbAthlete,
        (clubs, clubIndexRaw, lateAthlete) => {
          // Skip empty clubs array (shouldn't happen with minLength:1 but guard)
          if (clubs.length === 0) return

          const { db, cleanup } = createTestDb()
          try {
            // Step 1: Populate DB with initial clubs and athletes
            populateDb(db, clubs)

            // Step 2: Generate initial beach numbers
            generateBeachNumbers(db)

            // Step 3: Record all existing beach numbers
            const beforeNumbers = getAllBeachNumbers(db)

            // Step 4: Add a late arrival athlete to one of the existing clubs
            // Pick a club using modulo to stay in bounds
            const clubIndex = clubIndexRaw % clubs.length
            const targetClubId = clubIndex + 1 // clubids are 1-based in populateDb

            // Calculate next available athlete ID and swimresult ID
            const totalAthletes = clubs.reduce((sum, c) => sum + c.athletes.length, 0)
            const newAthleteId = totalAthletes + 1
            const newSwimresultId = totalAthletes + 1

            // Insert the late arrival athlete
            db.prepare(
              `INSERT INTO athlete (athleteid, clubid, firstname, lastname) VALUES (?, ?, ?, ?)`
            ).run(newAthleteId, targetClubId, lateAthlete.firstname, lateAthlete.lastname)

            // Step 5: Call assignLateBeachNumber for the new athlete
            const newBeachNumber = assignLateBeachNumber(db, newAthleteId)

            // Step 6: Verify ALL previously assigned beach numbers remain unchanged
            const afterNumbers = getAllBeachNumbers(db)
            for (const before of beforeNumbers) {
              const after = afterNumbers.find(a => a.athleteid === before.athleteid)
              expect(after).toBeDefined()
              expect(after!.nameprefix).toBe(before.nameprefix)
            }

            // Step 7: Verify the new athlete got a valid beach number
            // Format check: one uppercase letter + two digits
            expect(newBeachNumber).toMatch(/^[A-Z]\d{2}$/)

            // Verify it doesn't conflict with any existing numbers
            const existingNumbers = beforeNumbers.map(b => b.nameprefix)
            expect(existingNumbers).not.toContain(newBeachNumber)

            // Verify it's stored in the DB
            const storedNumber = db.prepare(
              `SELECT nameprefix FROM athlete WHERE athleteid = ?`
            ).get(newAthleteId) as { nameprefix: string | null }
            expect(storedNumber.nameprefix).toBe(newBeachNumber)
          } finally {
            cleanup()
          }
        }
      ),
      { numRuns: 50 }
    )
  }, 30_000)
})

// ── Unit Tests: Sequence Numbering ────────────────────────────────────────────

describe('Sequence numbering (generateBeachNumbers)', () => {
  it('assigns sequences sorted alphabetically by lastname, firstname (case-insensitive)', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'ABC', 'Alpha Club')
      // Insert athletes out of alphabetical order
      insertAthlete(db, 1, 1, 'Zeta', 'Anna')
      insertAthlete(db, 2, 1, 'Alpha', 'Charlie')
      insertAthlete(db, 3, 1, 'Alpha', 'Bob')
      insertAthlete(db, 4, 1, 'mango', 'Diane') // lowercase lastname
      // Create swimresults so they count as registered
      insertSwimresult(db, 1, 1)
      insertSwimresult(db, 2, 2)
      insertSwimresult(db, 3, 3)
      insertSwimresult(db, 4, 4)

      const result = generateBeachNumbers(db)

      expect(result.errors).toEqual([])
      expect(result.assigned).toBe(4)
      // Alphabetical order: Alpha Bob (A01), Alpha Charlie (A02), mango Diane (A03), Zeta Anna (A04)
      expect(getNameprefix(db, 3)).toBe('A01') // Alpha, Bob
      expect(getNameprefix(db, 2)).toBe('A02') // Alpha, Charlie
      expect(getNameprefix(db, 4)).toBe('A03') // mango, Diane
      expect(getNameprefix(db, 1)).toBe('A04') // Zeta, Anna
    } finally {
      cleanup()
    }
  })

  it('produces zero-padded sequences (01, 02, ..., 99)', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'T', 'Test Club')
      // Insert 10 athletes to verify padding
      for (let i = 1; i <= 10; i++) {
        const lastname = `Name${String(i).padStart(2, '0')}` // Name01..Name10 for sort order
        insertAthlete(db, i, 1, lastname, 'First')
        insertSwimresult(db, i, i)
      }

      const result = generateBeachNumbers(db)

      expect(result.errors).toEqual([])
      expect(result.assigned).toBe(10)
      // First athlete (Name01) gets T01, last (Name10) gets T10
      expect(getNameprefix(db, 1)).toBe('T01')
      expect(getNameprefix(db, 2)).toBe('T02')
      expect(getNameprefix(db, 9)).toBe('T09')
      expect(getNameprefix(db, 10)).toBe('T10')
    } finally {
      cleanup()
    }
  })

  it('reports error when >99 athletes in a single club', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'X', 'Big Club')
      // Insert 101 athletes
      for (let i = 1; i <= 101; i++) {
        const lastname = `Athlete${String(i).padStart(3, '0')}`
        insertAthlete(db, i, 1, lastname, 'First')
        insertSwimresult(db, i, i)
      }

      const result = generateBeachNumbers(db)

      // Should have assigned exactly 99 and reported an error
      expect(result.assigned).toBe(99)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0]).toContain('more than 99 athletes')
      expect(result.errors[0]).toContain('Big Club')
      // Athletes beyond 99 should NOT have beach numbers
      expect(getNameprefix(db, 100)).toBeNull()
      expect(getNameprefix(db, 101)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('pool meet (MEET_TYPE=POOL) does not trigger generation', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('MEET_TYPE', 'POOL')`).run()
      insertClub(db, 1, 'ABC', 'Pool Club')
      insertAthlete(db, 1, 1, 'Doe', 'John')
      insertSwimresult(db, 1, 1)

      // Simulate the import guard: only call generateBeachNumbers if MEET_TYPE is BEACH
      const meetType = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
      if ((meetType?.data || 'POOL').toUpperCase() === 'BEACH') {
        generateBeachNumbers(db)
      }

      // nameprefix should remain unchanged (NULL)
      expect(getNameprefix(db, 1)).toBeNull()
    } finally {
      cleanup()
    }
  })
})

// ── Unit Tests: Late Arrival ──────────────────────────────────────────────────

describe('Late arrival (assignLateBeachNumber)', () => {
  it('assigns next sequence number after existing max for the club', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'C', 'Club C')
      insertAthlete(db, 1, 1, 'Alpha', 'One')
      insertAthlete(db, 2, 1, 'Beta', 'Two')
      insertAthlete(db, 3, 1, 'Gamma', 'Three')
      insertSwimresult(db, 1, 1)
      insertSwimresult(db, 2, 2)
      insertSwimresult(db, 3, 3)

      // Generate initial numbers: Alpha->C01, Beta->C02, Gamma->C03
      generateBeachNumbers(db)

      // Add a late arrival athlete
      insertAthlete(db, 4, 1, 'Late', 'Arrival')

      const beachNumber = assignLateBeachNumber(db, 4)

      expect(beachNumber).toBe('C04')
      expect(getNameprefix(db, 4)).toBe('C04')
    } finally {
      cleanup()
    }
  })

  it('assigns a new letter for a late arrival from a new club', () => {
    const { db, cleanup } = createTestDb()
    try {
      // Club with code 'ABC' gets letter 'A'
      insertClub(db, 1, 'ABC', 'Alpha Club')
      insertAthlete(db, 1, 1, 'Doe', 'John')
      insertSwimresult(db, 1, 1)
      generateBeachNumbers(db)

      // Add a new club that wasn't in the initial import
      insertClub(db, 2, 'DEF', 'Delta Club')
      insertAthlete(db, 2, 2, 'New', 'Person')

      const beachNumber = assignLateBeachNumber(db, 2)

      // Should get letter 'D' (first char of 'DEF' not already used)
      expect(beachNumber).toBe('D01')
      expect(getNameprefix(db, 2)).toBe('D01')
    } finally {
      cleanup()
    }
  })

  it('reuses existing beach number if athlete already has one', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'M', 'My Club')
      insertAthlete(db, 1, 1, 'Already', 'Assigned')
      insertSwimresult(db, 1, 1)
      generateBeachNumbers(db)

      const existingNumber = getNameprefix(db, 1)
      expect(existingNumber).toBe('M01')

      // Call assignLateBeachNumber again for same athlete (e.g., added to another event)
      const beachNumber = assignLateBeachNumber(db, 1)

      expect(beachNumber).toBe('M01')
      expect(getNameprefix(db, 1)).toBe('M01')
    } finally {
      cleanup()
    }
  })

  it('throws when club reaches 99 athletes capacity', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'F', 'Full Club')
      // Insert 99 athletes with swimresults
      for (let i = 1; i <= 99; i++) {
        insertAthlete(db, i, 1, `Athlete${String(i).padStart(2, '0')}`, 'First')
        insertSwimresult(db, i, i)
      }
      generateBeachNumbers(db)

      // Add athlete #100 as a late arrival
      insertAthlete(db, 100, 1, 'Overflow', 'Athlete')

      expect(() => assignLateBeachNumber(db, 100)).toThrow(/maximum capacity/)
    } finally {
      cleanup()
    }
  })

  it('preserves existing beach numbers when assigning to late arrival', () => {
    const { db, cleanup } = createTestDb()
    try {
      insertClub(db, 1, 'P', 'Preserve Club')
      insertAthlete(db, 1, 1, 'First', 'Athlete')
      insertAthlete(db, 2, 1, 'Second', 'Athlete')
      insertSwimresult(db, 1, 1)
      insertSwimresult(db, 2, 2)
      generateBeachNumbers(db)

      const before1 = getNameprefix(db, 1)
      const before2 = getNameprefix(db, 2)

      // Add late arrival
      insertAthlete(db, 3, 1, 'Late', 'Comer')
      assignLateBeachNumber(db, 3)

      // Existing numbers unchanged
      expect(getNameprefix(db, 1)).toBe(before1)
      expect(getNameprefix(db, 2)).toBe(before2)
      expect(getNameprefix(db, 3)).toBe('P03')
    } finally {
      cleanup()
    }
  })
})

// ── Unit Tests: Club Letter Assignment Edge Cases ─────────────────────────────

describe('Club letter assignment edge cases', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  // ── Local Helpers ─────────────────────────────────────────────────────────

  let nextClubId = 0
  let nextAthleteId = 0
  let nextResultId = 0

  beforeEach(() => {
    nextClubId = 1
    nextAthleteId = 1
    nextResultId = 1
  })

  function addClubWithAthletes(code: string, name: string, athleteCount = 1): number {
    const clubId = nextClubId++
    db.prepare('INSERT INTO club (clubid, code, name) VALUES (?, ?, ?)').run(clubId, code, name)
    for (let i = 0; i < athleteCount; i++) {
      const athleteId = nextAthleteId++
      db.prepare(
        'INSERT INTO athlete (athleteid, clubid, lastname, firstname) VALUES (?, ?, ?, ?)'
      ).run(athleteId, clubId, `Last${athleteId}`, `First${athleteId}`)
      db.prepare(
        'INSERT INTO swimresult (swimresultid, athleteid) VALUES (?, ?)'
      ).run(nextResultId++, athleteId)
    }
    return clubId
  }

  function getPrefix(athleteId: number): string | null {
    const row = db.prepare('SELECT nameprefix FROM athlete WHERE athleteid = ?').get(athleteId) as { nameprefix: string | null }
    return row.nameprefix
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  it('club code with no alpha characters uses A-Z fallback', () => {
    addClubWithAthletes('123', 'Numeric Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(getPrefix(1)).toBe('A01')
  })

  it('club code chars already taken uses next available from code, then fallback', () => {
    // "ABC" sorted before "ACD" → "ABC" gets 'A', "ACD" tries 'A' (taken) then 'C' (free)
    addClubWithAthletes('ABC', 'Alpha Club')
    addClubWithAthletes('ACD', 'Ace Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(2)
    expect(result.errors).toHaveLength(0)
    expect(getPrefix(1)).toBe('A01')
    expect(getPrefix(2)).toBe('C01')
  })

  it('all code chars taken falls back to first available A-Z letter', () => {
    // "A1" takes 'A'. "AB" tries 'A' (taken), then 'B' (free).
    // "AC" code has only A and C → tries 'A' (taken), 'C' free → gets 'C'
    // Now "AAA" has only letter 'A' which is taken → fallback finds 'D' (first free after A,B,C)
    addClubWithAthletes('A1', 'A1 Club')
    addClubWithAthletes('AB', 'AB Club')
    addClubWithAthletes('AC', 'AC Club')
    addClubWithAthletes('AAA', 'All-A Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(4)
    expect(result.errors).toHaveLength(0)
    // Sorted: A1, AAA, AB, AC
    // "A1" → 'A'
    expect(getPrefix(1)).toBe('A01')
    // "AAA" → tries 'A' (taken) × 3 → fallback picks 'B' (first free)
    expect(getPrefix(4)).toBe('B01')
    // "AB" → tries 'A' (taken), 'B' (taken) → fallback picks 'C'
    expect(getPrefix(2)).toBe('C01')
    // "AC" → tries 'A' (taken), 'C' (taken) → fallback picks 'D'
    expect(getPrefix(3)).toBe('D01')
  })

  it('>26 clubs produces error, excess clubs have no beach numbers', () => {
    // Create 27 clubs. Use codes "A1".."Z1" for 26 clubs (each gets their first char letter)
    // then "ZZ" as overflow club whose code letters are all taken
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (let i = 0; i < 26; i++) {
      addClubWithAthletes(`${letters[i]}1`, `Club ${letters[i]}`)
    }
    // 27th club: code "ZZ" sorts after "Z1", so processed last, all letters exhausted
    addClubWithAthletes('ZZ', 'Overflow Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(26)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('no letter available')
    expect(result.errors[0]).toContain('all 26 letters exhausted')
    // The overflow club's athlete (id 27) has no beach number
    expect(getPrefix(27)).toBeNull()
  })

  it('case-insensitive letter assignment (lowercase code chars map to uppercase)', () => {
    addClubWithAthletes('abc', 'Lowercase Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(1)
    expect(result.errors).toHaveLength(0)
    // 'a' in code maps to letter 'A'
    expect(getPrefix(1)).toBe('A01')
  })

  it('mixed case code chars are treated case-insensitively for collision', () => {
    // Both "Abc" and "aBc" uppercase to "ABC"
    addClubWithAthletes('Abc', 'Abc Club')
    addClubWithAthletes('aBc', 'aBc Club')

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(2)
    expect(result.errors).toHaveLength(0)
    // Same UPPER(code), first processed gets 'A', second tries 'A' (taken) gets 'B'
    const prefixes = [getPrefix(1), getPrefix(2)]
    expect(prefixes).toContain('A01')
    expect(prefixes).toContain('B01')
  })

  it('deterministic ordering by UPPER(code)', () => {
    // Insert clubs in non-alphabetical order, verify letter assignment follows UPPER(code) sort
    addClubWithAthletes('ZZZ', 'Zulu Club')   // clubid 1, athleteid 1
    addClubWithAthletes('AAA', 'Alpha Club')  // clubid 2, athleteid 2
    addClubWithAthletes('MMM', 'Mike Club')   // clubid 3, athleteid 3

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(3)
    expect(result.errors).toHaveLength(0)
    // ORDER BY UPPER(code): AAA, MMM, ZZZ
    // "AAA" (athleteid 2) → 'A'
    expect(getPrefix(2)).toBe('A01')
    // "MMM" (athleteid 3) → 'M'
    expect(getPrefix(3)).toBe('M01')
    // "ZZZ" (athleteid 1) → 'Z'
    expect(getPrefix(1)).toBe('Z01')
  })

  it('deterministic ordering ignores case of code', () => {
    // 'bbb' and 'AAA': UPPER gives "BBB" and "AAA", so AAA sorted first
    addClubWithAthletes('bbb', 'Bravo Club')  // clubid 1, athleteid 1
    addClubWithAthletes('AAA', 'Alpha Club')  // clubid 2, athleteid 2

    const result = generateBeachNumbers(db)

    expect(result.assigned).toBe(2)
    expect(result.errors).toHaveLength(0)
    // "AAA" processed first → gets 'A'
    expect(getPrefix(2)).toBe('A01')
    // "bbb" (BBB) processed second → gets 'B'
    expect(getPrefix(1)).toBe('B01')
  })
})

// ── Unit Tests: generateHeatsBeach auto-assigns beach numbers ─────────────────

import { generateHeats } from '../src/main/db'

describe('Beach heat generation assigns missing beach numbers', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    // Set up as a beach meet
    db.exec(`INSERT INTO bsglobal (name, data) VALUES ('MEET_TYPE', 'BEACH')`)
    // Swim style with distance=8 (max per heat)
    db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke, sortcode) VALUES (1, 8, 'Beach Sprint', 1, 1, 1)`)
    // Session and event
    db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, lanemin, lanemax) VALUES (1, 1, 'Session 1', 1, 8)`)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 5, 1, 'F')`)
    // Club
    db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'ABC', 'Alpha Club', 'CAN')`)
  })

  afterEach(() => cleanup())

  function getPrefix(athleteId: number): string | null {
    const row = db.prepare(`SELECT nameprefix FROM athlete WHERE athleteid = ?`).get(athleteId) as { nameprefix: string | null } | undefined
    return row?.nameprefix ?? null
  }

  it('assigns beach number to athlete without one when generating heats', async () => {
    // Athlete with no beach number
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'Jean', 'Dupont', 1, '2000-01-01', 'CAN')`)
    // Entry for the athlete
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (1, 1, 1, 60000)`)

    expect(getPrefix(1)).toBeNull()

    const result = await generateHeats(1, undefined, db)

    expect(result.heatsCreated).toBeGreaterThanOrEqual(1)
    expect(result.entriesAssigned).toBe(1)
    // Beach number should now be assigned
    expect(getPrefix(1)).toBe('A01')
  })

  it('does not overwrite existing beach number when generating heats', async () => {
    // Athlete already has a beach number
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation, nameprefix) VALUES (1, 1, 'Jean', 'Dupont', 1, '2000-01-01', 'CAN', 'A01')`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (1, 1, 1, 60000)`)

    const result = await generateHeats(1, undefined, db)

    expect(result.heatsCreated).toBeGreaterThanOrEqual(1)
    // Beach number should remain unchanged
    expect(getPrefix(1)).toBe('A01')
  })

  it('assigns beach numbers to multiple athletes from different clubs', async () => {
    db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (2, 'DEF', 'Delta Club', 'CAN')`)
    // Athletes without beach numbers
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'Jean', 'Dupont', 1, '2000-01-01', 'CAN')`)
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (2, 2, 'Marie', 'Tremblay', 2, '2001-05-15', 'CAN')`)
    // Entries
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (1, 1, 1, 60000)`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (2, 2, 1, 61000)`)

    expect(getPrefix(1)).toBeNull()
    expect(getPrefix(2)).toBeNull()

    await generateHeats(1, undefined, db)

    // Both should now have beach numbers with different club letters
    expect(getPrefix(1)).toBe('A01')
    expect(getPrefix(2)).toBe('D01')
  })

  it('assigns beach number using next sequence when club already has numbered athletes', async () => {
    // Athlete 1 already has a beach number
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation, nameprefix) VALUES (1, 1, 'Jean', 'Dupont', 1, '2000-01-01', 'CAN', 'A01')`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (1, 1, 1, 60000)`)
    // Athlete 2 from same club, no beach number
    db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (2, 1, 'Pierre', 'Martin', 1, '1999-03-20', 'CAN')`)
    db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime) VALUES (2, 2, 1, 62000)`)

    expect(getPrefix(2)).toBeNull()

    await generateHeats(1, undefined, db)

    // Athlete 1 stays A01, athlete 2 gets A02
    expect(getPrefix(1)).toBe('A01')
    expect(getPrefix(2)).toBe('A02')
  })
})
