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

/**
 * Blank timing sheets — for late arrivals / missing chrono sheets.
 *
 * A blank strip has no barcode: the timer hand-writes Event / Heat / Lane on
 * underlined fields next to the two chrono times. The scanner captures it
 * manually (no barcode to trigger on) and stores it with a `BLANK-…` id and
 * event/heat/lane = 0; Gemini then reads the identity along with the times,
 * and `findBlankSheetCandidates` maps it to the entry seeded at that lane.
 *
 * Pure (no electron import) so it can be unit tested.
 */

export const BLANK_BARCODE_PREFIX = 'BLANK-'

export function isBlankScan(barcodeRaw: string): boolean {
  return barcodeRaw.startsWith(BLANK_BARCODE_PREFIX)
}

export function makeBlankBarcode(now: number = Date.now()): string {
  return `${BLANK_BARCODE_PREFIX}${now}`
}

// ── Gemini prompts + parsing ──────────────────────────────────────────────────

export const CHRONO_PROMPT = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times labeled "Chrono 1" and "Chrono 2".
Each time is written on three underlined fields: minutes, seconds, hundredths,
with the separators : and . pre-printed between them (format M:SS.HH).
The handwriting may go above or across the lines. Seconds and hundredths are two digits:
if only one digit is written on such a field, pad it with a leading 0.
Ignore any separator the timer also wrote by hand, and ignore the "Initiales" signatures on the right.

Read the handwritten digits carefully and return ONLY the two times in this exact format:
C1:M:SS.HH
C2:M:SS.HH

For example:
C1:1:23.45
C2:1:24.02

If you cannot read a time clearly, write "unclear" for that line. Return nothing else.`

export const BLANK_SHEET_PROMPT = `This image shows a hand-filled BLANK timing sheet from a lifesaving sport competition.
At the top, three numbers are handwritten on underlined fields labeled
"Épreuve" (event number), "Série" (heat number) and "Couloir" (lane number).
Below, two rows of handwritten times labeled "Chrono 1" and "Chrono 2".
Each time is written on three underlined fields: minutes, seconds, hundredths,
with the separators : and . pre-printed between them (format M:SS.HH).
The handwriting may go above or across the lines. Seconds and hundredths are two digits:
if only one digit is written on such a field, pad it with a leading 0.
Ignore any separator the timer also wrote by hand, and ignore the "Initiales" signatures on the right.
Ignore the swimmer name line.

Read the handwriting carefully and return ONLY these five lines in this exact format:
E:<event number>
H:<heat number>
L:<lane number>
C1:M:SS.HH
C2:M:SS.HH

For example:
E:12
H:3
L:5
C1:1:23.45
C2:1:24.02

If you cannot read a value clearly, write "unclear" for that line. Return nothing else.`

export interface ChronoTimes {
  time1: string
  time2: string
  confidence: number
}

/** Parse the `C1:` / `C2:` lines of a Gemini answer. */
export function parseChronoTimes(text: string): ChronoTimes {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  let time1 = ''
  let time2 = ''

  for (const line of lines) {
    const m1 = line.match(/^(?:C1|Chrono\s*1)\s*[:=]\s*(.+)$/i)
    if (m1) { time1 = m1[1].trim(); continue }
    const m2 = line.match(/^(?:C2|Chrono\s*2)\s*[:=]\s*(.+)$/i)
    if (m2) { time2 = m2[1].trim(); continue }
  }

  // Fallback: extract time patterns
  if (!time1 && !time2) {
    const matches = text.match(/(\d{1,2}:\d{2}\.\d{2})/g)
    if (matches && matches.length >= 1) time1 = matches[0]
    if (matches && matches.length >= 2) time2 = matches[1]
  }

  const confidence = (time1 && time1 !== 'unclear' && time2 && time2 !== 'unclear') ? 0.95 : 0.3
  return { time1, time2, confidence }
}

export interface BlankSheetReading extends ChronoTimes {
  /** 0 = unreadable */
  eventNumber: number
  heatNumber: number
  lane: number
}

/** Parse the E/H/L + C1/C2 answer to BLANK_SHEET_PROMPT. Unreadable numbers → 0. */
export function parseBlankSheetResponse(text: string): BlankSheetReading {
  const num = (key: string): number => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*(\\d{1,3})\\s*$`, 'im'))
    return m ? parseInt(m[1], 10) : 0
  }
  const times = parseChronoTimes(text)
  const eventNumber = num('E')
  const heatNumber = num('H')
  const lane = num('L')
  const identityOk = eventNumber > 0 && heatNumber > 0 && lane > 0
  return {
    ...times,
    eventNumber,
    heatNumber,
    lane,
    confidence: identityOk ? times.confidence : Math.min(times.confidence, 0.3),
  }
}

// ── Target resolution ─────────────────────────────────────────────────────────

/** Minimal db surface — works with better-sqlite3 and the meet-app DbBackend. */
interface QueryableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

export interface BlankSheetCandidate {
  swimEventId: number
  eventNumber: number
  heatNumber: number
  lane: number
  /** swimevent.round — 1 PRE, 2 SEM, 4 FIN, 5 TIM */
  round: number
  eventName: string
  /** Athlete "Last, First" or relay team name */
  entryLabel: string
  clubCode: string
  /** The lane already has a time (swimtime > 0) */
  hasTime: boolean
}

/**
 * Entries seeded at (eventNumber, heat, lane). Usually 0 or 1 rows; 2+ when a
 * prelim and its final share the event number (Splash convention) and both
 * have that heat/lane seeded.
 */
export function findBlankSheetCandidates(
  db: QueryableDb, eventNumber: number, heatNumber: number, lane: number,
): BlankSheetCandidate[] {
  if (!(eventNumber > 0 && heatNumber > 0 && lane > 0)) return []
  const rows = db.prepare(`
    SELECT e.swimeventid, e.eventnumber, e.round, ss.name AS stylename, ss.distance,
           h.heatnumber, x.lane, x.label, x.clubcode, x.swimtime
    FROM swimevent e
    JOIN swimstyle ss ON ss.swimstyleid = e.swimstyleid
    JOIN heat h ON h.swimeventid = e.swimeventid
    JOIN (
      SELECT sr.heatid, sr.lane, a.lastname || COALESCE(', ' || a.firstname, '') AS label,
             c.code AS clubcode, sr.swimtime
      FROM swimresult sr
      LEFT JOIN athlete a ON sr.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      UNION ALL
      SELECT r.heatid, r.lane, r.name AS label, c.code AS clubcode, r.swimtime
      FROM relay r
      LEFT JOIN club c ON r.clubid = c.clubid
    ) x ON x.heatid = h.heatid
    WHERE e.eventnumber = ? AND h.heatnumber = ? AND x.lane = ?
    ORDER BY e.round, e.swimeventid
  `).all(eventNumber, heatNumber, lane) as Array<{
    swimeventid: number; eventnumber: number; round: number | null
    stylename: string | null; distance: number | null; heatnumber: number
    lane: number; label: string | null; clubcode: string | null; swimtime: number | null
  }>

  return rows.map((r) => {
    const style = r.stylename ?? ''
    const eventName = /^\d/.test(style) || !r.distance ? style : `${r.distance}m ${style}`
    return {
      swimEventId: Number(r.swimeventid),
      eventNumber: Number(r.eventnumber),
      heatNumber: Number(r.heatnumber),
      lane: Number(r.lane),
      round: Number(r.round ?? 0),
      eventName,
      entryLabel: r.label ?? '',
      clubCode: r.clubcode ?? '',
      hasTime: Number(r.swimtime ?? 0) > 0,
    }
  })
}

/**
 * Pick the target automatically when unambiguous: the only candidate, or the
 * only one still without a time (the round being swum now). Otherwise null —
 * the operator chooses in the Traitement tab.
 */
export function pickBlankSheetTarget(candidates: BlankSheetCandidate[]): BlankSheetCandidate | null {
  if (candidates.length === 1) return candidates[0]
  const open = candidates.filter((c) => !c.hasTime)
  return open.length === 1 ? open[0] : null
}
