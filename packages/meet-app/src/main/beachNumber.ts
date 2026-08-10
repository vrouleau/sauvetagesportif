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
import { ageGroupCodeFor, AGE_CODE_ORDER } from '@shared/logic/ageGroupCode'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface BeachNumberResult {
  assigned: number
  errors: string[]
}

// ── Category Codes ────────────────────────────────────────────────────────────

/**
 * The character right after the club letter encodes the athlete's category
 * (age bracket + sex). Unlike the old scheme, this is a fixed global table —
 * every club uses the same code for the same category, it is not assigned
 * dynamically per club.
 *
 * Age brackets come from the same canonical order used for individual-entry
 * categories (`AGE_CODE_ORDER`: 10-, 11-12, 13-14, 15-18, Open, Masters).
 * Each bracket has a female slot then a male slot, in that order:
 *   10-F=0, 10-M=1, 11-12F=2, 11-12M=3, 13-14F=4, 13-14M=5,
 *   15-18F=6, 15-18M=7, OpenF=8, OpenM=9, MastersF=A, MastersM=B
 * The 10 single-digit slots (0-9) cover the first 5 brackets; once those are
 * exhausted, remaining brackets (just Masters) use letters starting at 'A'.
 *
 * Full format: Letter + 3 chars, e.g. "C201" = club C, category '2' (11-12 F),
 * athlete #01. For Masters: "C A01" (no space) = club C, category 'A'
 * (Masters F), athlete #01.
 *
 * Maximum: 99 athletes per category (per club).
 */

type Sex = 1 | 2 // 1=M, 2=F (matches athlete.gender encoding)

const CATEGORY_ORDER: ReadonlyArray<{ bracket: string; sex: Sex }> =
  AGE_CODE_ORDER.flatMap((bracket) => [
    { bracket, sex: 2 as Sex }, // F
    { bracket, sex: 1 as Sex }, // M
  ])

function codeForIndex(index: number): string {
  return index < 10 ? String(index) : String.fromCharCode(65 + (index - 10)) // 'A', 'B', ...
}

const CATEGORY_CODE_MAP: ReadonlyMap<string, string> = new Map(
  CATEGORY_ORDER.map((cat, i) => [`${cat.bracket}|${cat.sex}`, codeForIndex(i)])
)

/**
 * Resolve an athlete's category code from their age group (age bracket only —
 * a relay's own age group can be mixed-gender, so it is not used for sex) and
 * their own `athlete.gender` (1=M, 2=F). Returns `null` if the athlete's sex
 * is unknown (missing/invalid gender), since the category table has no slot
 * for that.
 */
function categoryCodeFor(
  agName: string | null,
  agemin: number | null,
  agemax: number | null,
  athleteGender: number | null
): string | null {
  if (athleteGender !== 1 && athleteGender !== 2) return null
  const bracket = ageGroupCodeFor(agName, agemin, agemax)
  return CATEGORY_CODE_MAP.get(`${bracket}|${athleteGender}`) ?? null
}

// ── Core Generation ───────────────────────────────────────────────────────────

/**
 * Generate beach numbers for ALL athletes in the current meet.
 * Called after LXF import when MEET_TYPE='BEACH'.
 * Clears all existing nameprefix values, then recomputes deterministically.
 *
 * Beach number format: Letter + 3 chars (e.g., "C201")
 *   - Letter: club identifier (A-Z)
 *   - Category char: fixed age-bracket + sex code (see CATEGORY_ORDER above)
 *   - Last 2 chars: athlete sequence within category (01-99)
 */
export function generateBeachNumbers(db: Database.Database): BeachNumberResult {
  const errors: string[] = []
  let assigned = 0

  // Step 1: Clear all existing beach numbers (idempotent regeneration)
  db.prepare(`UPDATE athlete SET nameprefix = NULL`).run()

  // Step 2: Query clubs with registered athletes (individual OR relay-only), sorted by
  // UPPER(code) for determinism
  const clubs = db.prepare(`
    SELECT DISTINCT c.clubid, c.code, c.name, UPPER(c.code) AS code_upper
    FROM club c
    WHERE EXISTS (
      SELECT 1 FROM athlete a JOIN swimresult r ON r.athleteid = a.athleteid WHERE a.clubid = c.clubid
    ) OR EXISTS (
      SELECT 1 FROM athlete a JOIN relayposition rp ON rp.athleteid = a.athleteid WHERE a.clubid = c.clubid
    )
    ORDER BY code_upper
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

    // Query distinct athletes with their category info for this club, from BOTH individual
    // entries (swimresult) and relay-only entries (relayposition/relay) — an athlete who only
    // swims relays still needs a beach number. Relay rows use the team's own age group
    // (relay.agegroupid) for the age bracket, same as the "team's category = event it was
    // created under" rule used elsewhere for relay entry — but the athlete's own gender (not
    // the age group's, which can be mixed for X relays) decides the sex slot.
    // Not DISTINCT: an athlete can legitimately appear once per swimresult/relayposition row
    // (multiple events/age groups) — the loop below already dedupes by athleteid, keeping the
    // first row encountered in this deterministic order. SQLite's COLLATE NOCASE has no
    // Postgres equivalent; plain lastname/firstname ordering is enough here since this only
    // picks which duplicate row wins the dedup (final display order is re-sorted with proper
    // locale comparison below).
    const athletes = db.prepare(`
      SELECT athleteid, lastname, firstname, athlete_gender, agemin, agemax, ag_name FROM (
        SELECT a.athleteid AS athleteid, a.lastname AS lastname, a.firstname AS firstname,
               a.gender AS athlete_gender,
               ag.agemin AS agemin, ag.agemax AS agemax, ag.name AS ag_name
        FROM athlete a
        JOIN swimresult r ON r.athleteid = a.athleteid
        LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
        WHERE a.clubid = ?
        UNION ALL
        SELECT a.athleteid AS athleteid, a.lastname AS lastname, a.firstname AS firstname,
               a.gender AS athlete_gender,
               ag.agemin AS agemin, ag.agemax AS agemax, ag.name AS ag_name
        FROM athlete a
        JOIN relayposition rp ON rp.athleteid = a.athleteid
        JOIN relay rl ON rl.relayid = rp.relayid
        LEFT JOIN agegroup ag ON rl.agegroupid = ag.agegroupid
        WHERE a.clubid = ?
      )
      ORDER BY agemin, agemax, athlete_gender, lastname, firstname
    `).all(club.clubid, club.clubid) as Array<{
      athleteid: number; lastname: string; firstname: string; athlete_gender: number | null
      agemin: number | null; agemax: number | null; ag_name: string | null
    }>

    // Deduplicate athletes (an athlete may appear in multiple events/age groups)
    // Use the FIRST age group encountered (sorted deterministically above)
    const seen = new Set<number>()
    const athletesByCategory = new Map<string, Array<{ athleteid: number; lastname: string; firstname: string }>>()

    for (const row of athletes) {
      if (seen.has(row.athleteid)) continue
      seen.add(row.athleteid)

      const catCode = categoryCodeFor(row.ag_name, row.agemin, row.agemax, row.athlete_gender)
      if (catCode === null) {
        errors.push(`Athlete "${row.lastname}, ${row.firstname}" (club "${club.name}"): unknown or missing sex, cannot assign a beach number category`)
        continue
      }
      if (!athletesByCategory.has(catCode)) {
        athletesByCategory.set(catCode, [])
      }
      athletesByCategory.get(catCode)!.push({
        athleteid: row.athleteid,
        lastname: row.lastname,
        firstname: row.firstname,
      })
    }

    // Step 5: Assign sequence numbers within each (fixed) category code
    for (const [catCode, catAthletes] of athletesByCategory) {
      // Sort athletes within category alphabetically
      catAthletes.sort((a, b) =>
        a.lastname.localeCompare(b.lastname, undefined, { sensitivity: 'base' }) ||
        a.firstname.localeCompare(b.firstname, undefined, { sensitivity: 'base' })
      )

      let seq = 1
      for (const athlete of catAthletes) {
        if (seq > 99) {
          errors.push(`Club "${club.name}" (${letter}), category ${catCode}: more than 99 athletes, cannot assign beach numbers beyond position 99`)
          break
        }
        const beachNumber = `${letter}${catCode}${String(seq).padStart(2, '0')}`
        updateStmt.run(beachNumber, athlete.athleteid)
        assigned++
        seq++
      }
    }
  }

  // Step 6: Return result
  return { assigned, errors }
}

// ── Late Arrival ──────────────────────────────────────────────────────────────

/**
 * Assign a beach number to a single late-arrival athlete.
 * Reads the athlete's club letter (assigning a new one if this is the club's first
 * athlete), resolves their fixed category code (age bracket + sex), then assigns
 * the next sequence within that club+category block.
 * Returns the assigned beach number (e.g., "C201") or throws on capacity error.
 */
export function assignLateBeachNumber(db: Database.Database, athleteId: number): string {
  // Step 1: Check if athlete already has a beach number assigned
  const athlete = db.prepare(`
    SELECT a.nameprefix, a.clubid, a.gender
    FROM athlete a
    WHERE a.athleteid = ?
  `).get(athleteId) as { nameprefix: string | null; clubid: number; gender: number | null } | undefined

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

  // Step 5: Determine the athlete's age group (for the age bracket)
  // Look at their swimresult entries to find their age group
  let agRow = db.prepare(`
    SELECT ag.agemin, ag.agemax, ag.name
    FROM swimresult r
    JOIN agegroup ag ON r.agegroupid = ag.agegroupid
    WHERE r.athleteid = ?
    LIMIT 1
  `).get(athleteId) as { agemin: number | null; agemax: number | null; name: string | null } | undefined

  // Relay-only athlete (no individual entries): fall back to the relay team's own age group
  if (!agRow) {
    agRow = db.prepare(`
      SELECT ag.agemin, ag.agemax, ag.name
      FROM relayposition rp
      JOIN relay rl ON rl.relayid = rp.relayid
      JOIN agegroup ag ON rl.agegroupid = ag.agegroupid
      WHERE rp.athleteid = ?
      LIMIT 1
    `).get(athleteId) as { agemin: number | null; agemax: number | null; name: string | null } | undefined
  }

  const catCode = categoryCodeFor(agRow?.name ?? null, agRow?.agemin ?? null, agRow?.agemax ?? null, athlete.gender)
  if (catCode === null) {
    throw new Error(`Athlete ${athleteId}: unknown or missing sex, cannot assign a beach number category`)
  }

  // Step 6: Find the next sequence within this club+category block
  const maxSeqRow = db.prepare(`
    SELECT MAX(CAST(SUBSTR(nameprefix, 3) AS INTEGER)) AS maxNum
    FROM athlete
    WHERE SUBSTR(nameprefix, 1, 2) = ?
  `).get(`${letter}${catCode}`) as { maxNum: number | null } | undefined

  const nextSeq = (maxSeqRow?.maxNum ?? 0) + 1

  // Check capacity: only 99 slots per category (01-99)
  if (nextSeq > 99) {
    throw new Error(`Club letter "${letter}", category ${catCode}: has reached maximum capacity (99 athletes)`)
  }

  // Step 7: Assign the beach number
  const beachNumber = `${letter}${catCode}${String(nextSeq).padStart(2, '0')}`
  db.prepare(`UPDATE athlete SET nameprefix = ? WHERE athleteid = ?`).run(beachNumber, athleteId)

  return beachNumber
}
