import type Database from 'better-sqlite3'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface BeachNumberResult {
  assigned: number
  errors: string[]
}

// ── Core Generation ───────────────────────────────────────────────────────────

/**
 * Generate beach numbers for ALL athletes in the current meet.
 * Called after LXF import when MEET_TYPE='BEACH'.
 * Clears all existing nameprefix values, then recomputes deterministically.
 */
export function generateBeachNumbers(db: Database.Database): BeachNumberResult {
  const errors: string[] = []
  let assigned = 0

  // Step 1: Clear all existing beach numbers (idempotent regeneration)
  db.prepare(`UPDATE athlete SET nameprefix = NULL`).run()

  // Step 2: Query clubs with registered athletes, sorted by UPPER(code) for determinism
  const clubs = db.prepare(`
    SELECT DISTINCT c.clubid, c.code, c.name
    FROM club c
    JOIN athlete a ON a.clubid = c.clubid
    JOIN swimresult r ON r.athleteid = a.athleteid
    ORDER BY UPPER(c.code)
  `).all() as Array<{ clubid: number; code: string; name: string }>

  // Step 3: Assign club letters
  const usedLetters = new Set<string>()
  const clubLetterMap = new Map<number, string>()

  for (const club of clubs) {
    let letterAssigned = false

    // Try each character in the club code
    const code = club.code || ''
    for (const ch of code) {
      const letter = ch.toUpperCase()
      if (letter >= 'A' && letter <= 'Z' && !usedLetters.has(letter)) {
        usedLetters.add(letter)
        clubLetterMap.set(club.clubid, letter)
        letterAssigned = true
        break
      }
    }

    // Fallback: first available A-Z
    if (!letterAssigned) {
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c)
        if (!usedLetters.has(letter)) {
          usedLetters.add(letter)
          clubLetterMap.set(club.clubid, letter)
          letterAssigned = true
          break
        }
      }
    }

    // >26 clubs: report error, skip
    if (!letterAssigned) {
      errors.push(`Club "${club.name}" (${club.code}): no letter available (all 26 letters exhausted)`)
    }
  }

  // Step 4: Assign sequence numbers per club
  const updateStmt = db.prepare(`UPDATE athlete SET nameprefix = ? WHERE athleteid = ?`)

  for (const club of clubs) {
    const letter = clubLetterMap.get(club.clubid)
    if (!letter) continue // skipped due to letter exhaustion

    // Query distinct athletes for this club, sorted by lastname then firstname (case-insensitive)
    const athletes = db.prepare(`
      SELECT DISTINCT a.athleteid, a.lastname, a.firstname
      FROM athlete a
      JOIN swimresult r ON r.athleteid = a.athleteid
      WHERE a.clubid = ?
      ORDER BY a.lastname COLLATE NOCASE, a.firstname COLLATE NOCASE
    `).all(club.clubid) as Array<{ athleteid: number; lastname: string; firstname: string }>

    let seq = 1
    for (const athlete of athletes) {
      if (seq > 99) {
        errors.push(`Club "${club.name}" (${letter}): more than 99 athletes, cannot assign beach numbers beyond position 99`)
        break
      }
      const beachNumber = `${letter}${String(seq).padStart(2, '0')}`
      updateStmt.run(beachNumber, athlete.athleteid)
      assigned++
      seq++
    }
  }

  // Step 5: Return result
  return { assigned, errors }
}

// ── Late Arrival ──────────────────────────────────────────────────────────────

/**
 * Assign a beach number to a single late-arrival athlete.
 * Reads existing assignments to determine the club letter and next sequence.
 * Returns the assigned beach number (e.g., "C13") or throws on capacity error.
 */
export function assignLateBeachNumber(db: Database.Database, athleteId: number): string {
  // Step 1: Check if athlete already has a beach number assigned
  const athlete = db.prepare(`
    SELECT a.nameprefix, a.clubid
    FROM athlete a
    WHERE a.athleteid = ?
  `).get(athleteId) as { nameprefix: string | null; clubid: number } | undefined

  if (!athlete) {
    throw new Error(`Athlete with id ${athleteId} not found`)
  }

  // If athlete already has a non-empty nameprefix, return it (no reassignment)
  if (athlete.nameprefix && athlete.nameprefix.trim() !== '') {
    return athlete.nameprefix
  }

  // Step 2: Get club info for this athlete
  const club = db.prepare(`
    SELECT c.clubid, c.code
    FROM club c
    WHERE c.clubid = ?
  `).get(athlete.clubid) as { clubid: number; code: string } | undefined

  if (!club) {
    throw new Error(`Club with id ${athlete.clubid} not found for athlete ${athleteId}`)
  }

  // Step 3: Check if club already has an assigned letter
  const existingLetter = db.prepare(`
    SELECT SUBSTR(nameprefix, 1, 1) AS letter
    FROM athlete
    WHERE clubid = ? AND nameprefix IS NOT NULL AND nameprefix != ''
    LIMIT 1
  `).get(club.clubid) as { letter: string } | undefined

  let letter: string

  if (existingLetter) {
    // Club already has a letter assigned
    letter = existingLetter.letter
  } else {
    // Step 4: No existing letter — apply letter selection algorithm
    // Get all currently used letters across all clubs
    const usedLettersRows = db.prepare(`
      SELECT DISTINCT SUBSTR(nameprefix, 1, 1) AS letter
      FROM athlete
      WHERE nameprefix IS NOT NULL AND nameprefix != ''
    `).all() as Array<{ letter: string }>

    const usedLetters = new Set<string>(usedLettersRows.map(r => r.letter.toUpperCase()))

    let letterAssigned = false
    letter = ''

    // Try each character in the club code
    const code = club.code || ''
    for (const ch of code) {
      const candidate = ch.toUpperCase()
      if (candidate >= 'A' && candidate <= 'Z' && !usedLetters.has(candidate)) {
        letter = candidate
        letterAssigned = true
        break
      }
    }

    // Fallback: first available A-Z
    if (!letterAssigned) {
      for (let c = 65; c <= 90; c++) {
        const candidate = String.fromCharCode(c)
        if (!usedLetters.has(candidate)) {
          letter = candidate
          letterAssigned = true
          break
        }
      }
    }

    if (!letterAssigned) {
      throw new Error(`No letter available for club "${club.code}" (all 26 letters exhausted)`)
    }
  }

  // Step 5: Get max existing sequence for this letter
  const maxSeqRow = db.prepare(`
    SELECT MAX(CAST(SUBSTR(nameprefix, 2) AS INTEGER)) AS maxSeq
    FROM athlete
    WHERE SUBSTR(nameprefix, 1, 1) = ?
  `).get(letter) as { maxSeq: number | null } | undefined

  const maxSeq = maxSeqRow?.maxSeq ?? 0
  const nextSeq = maxSeq + 1

  // Step 6: Check capacity
  if (nextSeq > 99) {
    throw new Error(`Club letter "${letter}" has reached maximum capacity (99 athletes)`)
  }

  // Step 7: Assign the beach number
  const beachNumber = `${letter}${String(nextSeq).padStart(2, '0')}`
  db.prepare(`UPDATE athlete SET nameprefix = ? WHERE athleteid = ?`).run(beachNumber, athleteId)

  // Step 8: Return the beach number
  return beachNumber
}
