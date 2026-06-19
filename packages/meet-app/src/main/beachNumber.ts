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

import type Database from 'better-sqlite3'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface BeachNumberResult {
  assigned: number
  errors: string[]
}

// ── Category Hundreds ─────────────────────────────────────────────────────────

/**
 * The "hundreds" digit encodes the athlete's category (age group + gender).
 * Categories are assigned dynamically per club based on which categories are
 * actually present in the registrations, starting at 100, then 200, 300, etc.
 *
 * Within each category, athletes get a sequential number from 01-99.
 * Full format: Letter + 3 digits, e.g., "C101" = club C, category 1 (100-block), athlete #01.
 *
 * Maximum: 9 categories per club (100-900), 99 athletes per category.
 * The "000" block (e.g., C001-C099) is reserved for overflow/uncategorized if needed.
 */

const CATEGORY_HUNDREDS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const

/**
 * Build a deterministic category key from an age group row.
 * Used to group athletes into their category for beach number assignment.
 */
function buildCategoryKey(agemin: number | null, agemax: number | null, gender: number | null): string {
  const g = gender ?? 0
  const min = agemin ?? 0
  const max = agemax ?? -1
  return `${min}-${max}-${g}`
}

// ── Core Generation ───────────────────────────────────────────────────────────

/**
 * Generate beach numbers for ALL athletes in the current meet.
 * Called after LXF import when MEET_TYPE='BEACH'.
 * Clears all existing nameprefix values, then recomputes deterministically.
 *
 * Beach number format: Letter + 3 digits (e.g., "C201")
 *   - Letter: club identifier (A-Z)
 *   - Hundreds digit: category (age group + gender), assigned dynamically per club
 *   - Tens + units: athlete sequence within category (01-99)
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

  // Step 4: Assign category-based beach numbers per club
  const updateStmt = db.prepare(`UPDATE athlete SET nameprefix = ? WHERE athleteid = ?`)

  for (const club of clubs) {
    const letter = clubLetterMap.get(club.clubid)
    if (!letter) continue // skipped due to letter exhaustion

    // Query distinct athletes with their category info for this club
    const athletes = db.prepare(`
      SELECT DISTINCT a.athleteid, a.lastname, a.firstname,
             ag.agemin, ag.agemax, ag.gender AS ag_gender
      FROM athlete a
      JOIN swimresult r ON r.athleteid = a.athleteid
      LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
      WHERE a.clubid = ?
      ORDER BY ag.agemin, ag.agemax, ag.gender, a.lastname COLLATE NOCASE, a.firstname COLLATE NOCASE
    `).all(club.clubid) as Array<{
      athleteid: number; lastname: string; firstname: string
      agemin: number | null; agemax: number | null; ag_gender: number | null
    }>

    // Deduplicate athletes (an athlete may appear in multiple events/age groups)
    // Use the FIRST age group encountered (sorted deterministically above)
    const seen = new Set<number>()
    const athletesByCategory = new Map<string, Array<{ athleteid: number; lastname: string; firstname: string }>>()

    for (const row of athletes) {
      if (seen.has(row.athleteid)) continue
      seen.add(row.athleteid)

      const catKey = buildCategoryKey(row.agemin, row.agemax, row.ag_gender)
      if (!athletesByCategory.has(catKey)) {
        athletesByCategory.set(catKey, [])
      }
      athletesByCategory.get(catKey)!.push({
        athleteid: row.athleteid,
        lastname: row.lastname,
        firstname: row.firstname,
      })
    }

    // Assign each category a hundred (100, 200, 300, ...)
    const categories = [...athletesByCategory.keys()]
    // categories are already in deterministic order (sorted by agemin, agemax, gender from the query)

    if (categories.length > CATEGORY_HUNDREDS.length) {
      errors.push(`Club "${club.name}" (${letter}): more than ${CATEGORY_HUNDREDS.length} categories, some athletes will not get beach numbers`)
    }

    for (let catIdx = 0; catIdx < categories.length && catIdx < CATEGORY_HUNDREDS.length; catIdx++) {
      const catKey = categories[catIdx]
      const catAthletes = athletesByCategory.get(catKey)!
      const hundred = CATEGORY_HUNDREDS[catIdx]

      // Sort athletes within category alphabetically
      catAthletes.sort((a, b) =>
        a.lastname.localeCompare(b.lastname, undefined, { sensitivity: 'base' }) ||
        a.firstname.localeCompare(b.firstname, undefined, { sensitivity: 'base' })
      )

      let seq = 1
      for (const athlete of catAthletes) {
        if (seq > 99) {
          errors.push(`Club "${club.name}" (${letter}), category ${hundred}: more than 99 athletes, cannot assign beach numbers beyond position 99`)
          break
        }
        const beachNumber = `${letter}${String(hundred + seq).padStart(3, '0')}`
        updateStmt.run(beachNumber, athlete.athleteid)
        assigned++
        seq++
      }
    }
  }

  // Step 5: Return result
  return { assigned, errors }
}

// ── Late Arrival ──────────────────────────────────────────────────────────────

/**
 * Assign a beach number to a single late-arrival athlete.
 * Reads existing assignments to determine the club letter and the athlete's category,
 * then assigns the next sequence within that category.
 * Returns the assigned beach number (e.g., "C201") or throws on capacity error.
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

  // Step 5: Determine the athlete's category
  // Look at their swimresult entries to find their age group
  const agRow = db.prepare(`
    SELECT ag.agemin, ag.agemax, ag.gender
    FROM swimresult r
    JOIN agegroup ag ON r.agegroupid = ag.agegroupid
    WHERE r.athleteid = ?
    LIMIT 1
  `).get(athleteId) as { agemin: number | null; agemax: number | null; gender: number | null } | undefined

  const catKey = agRow
    ? buildCategoryKey(agRow.agemin, agRow.agemax, agRow.gender)
    : buildCategoryKey(null, null, null)

  // Step 6: Find which hundred is assigned to this category for this club letter
  // Look at existing beach numbers for this letter to determine category mapping
  const existingNumbers = db.prepare(`
    SELECT DISTINCT CAST(SUBSTR(nameprefix, 2, 1) AS INTEGER) AS hundredDigit,
           ag.agemin, ag.agemax, ag.gender
    FROM athlete a
    JOIN swimresult r ON r.athleteid = a.athleteid
    LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
    WHERE SUBSTR(a.nameprefix, 1, 1) = ?
      AND a.nameprefix IS NOT NULL AND a.nameprefix != ''
    GROUP BY CAST(SUBSTR(nameprefix, 2, 1) AS INTEGER), ag.agemin, ag.agemax, ag.gender
  `).all(letter) as Array<{ hundredDigit: number; agemin: number | null; agemax: number | null; gender: number | null }>

  // Build mapping: categoryKey → hundred
  const catToHundred = new Map<string, number>()
  for (const row of existingNumbers) {
    const key = buildCategoryKey(row.agemin, row.agemax, row.gender)
    const hundred = row.hundredDigit * 100
    if (hundred > 0 && !catToHundred.has(key)) {
      catToHundred.set(key, hundred)
    }
  }

  let hundred: number

  if (catToHundred.has(catKey)) {
    // Category already exists for this club
    hundred = catToHundred.get(catKey)!
  } else {
    // New category — find the next available hundred
    const usedHundreds = new Set([...catToHundred.values()])
    hundred = 0
    for (const h of CATEGORY_HUNDREDS) {
      if (!usedHundreds.has(h)) {
        hundred = h
        break
      }
    }
    if (hundred === 0) {
      throw new Error(`Club letter "${letter}" has exhausted all 9 category slots`)
    }
  }

  // Step 7: Find the next sequence within this hundred for this letter
  const maxSeqRow = db.prepare(`
    SELECT MAX(CAST(SUBSTR(nameprefix, 2) AS INTEGER)) AS maxNum
    FROM athlete
    WHERE SUBSTR(nameprefix, 1, 1) = ?
      AND CAST(SUBSTR(nameprefix, 2) AS INTEGER) >= ?
      AND CAST(SUBSTR(nameprefix, 2) AS INTEGER) < ?
  `).get(letter, hundred, hundred + 100) as { maxNum: number | null } | undefined

  const maxNum = maxSeqRow?.maxNum ?? (hundred)
  const nextNum = maxNum + 1

  // Check capacity: only 99 slots per category (hundred+01 to hundred+99)
  if (nextNum >= hundred + 100) {
    throw new Error(`Club letter "${letter}", category ${hundred}: has reached maximum capacity (99 athletes)`)
  }

  // Step 8: Assign the beach number
  const beachNumber = `${letter}${String(nextNum).padStart(3, '0')}`
  db.prepare(`UPDATE athlete SET nameprefix = ? WHERE athleteid = ?`).run(beachNumber, athleteId)

  return beachNumber
}
