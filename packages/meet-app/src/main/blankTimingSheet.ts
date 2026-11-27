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
 * A blank strip has no event/heat/lane barcode: the timer hand-writes Event / Heat / Lane
 * on underlined fields next to the two chrono times. It carries a generic `BLANK-…`
 * barcode (see below) that triggers the scanner; older strips without one are captured
 * manually (button / Space). The scan is stored with a `BLANK-…` id and
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

// ── Printed blank-strip barcode ───────────────────────────────────────────────
// Each blank strip carries its own Code128 barcode `FV-<batch>-<nn>` ("Fiche Vierge") so the
// scanner can trigger on it (no button press with the other hand). `<batch>` is random per
// print job, `<nn>` numbers the strips of that job, so every strip is unique: re-presenting
// the same strip replaces its scan, and two different blank strips never collide.
// The scanner stores it as `BLANK-<batch>-<nn>` (`blankScanIdFromCode`) so `isBlankScan` and
// the whole blank flow apply unchanged. The printed prefix is deliberately short: a longer
// `BLANK-…` code made the bars narrower and Quagga read it noticeably less reliably
// (~75% vs 100% in a synthetic test over widths 480-1280 px and slight blur).

/** No 0/O/1/I so a hand-typed or misread code can't be ambiguous. */
const BLANK_BATCH_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export const BLANK_SHEET_CODE_RE = /^FV-([2-9A-HJ-NP-Z]{4}-\d{2,3})$/

export function newBlankBatchId(rand: () => number = Math.random): string {
  let id = ''
  for (let i = 0; i < 4; i++) id += BLANK_BATCH_ALPHABET[Math.floor(rand() * BLANK_BATCH_ALPHABET.length)]
  return id
}

/** The code printed (as a barcode) on strip number `n` of a print job. */
export function makeBlankSheetCode(batchId: string, n: number): string {
  return `FV-${batchId}-${String(n).padStart(2, '0')}`
}

/** True for the barcode printed on a blank strip. */
export function isBlankSheetCode(raw: string): boolean {
  return BLANK_SHEET_CODE_RE.test(raw)
}

/** Scan id (`barcode_raw`) to store for a scanned blank-strip barcode, or null if it isn't one. */
export function blankScanIdFromCode(raw: string): string | null {
  const m = raw.match(BLANK_SHEET_CODE_RE)
  return m ? `${BLANK_BARCODE_PREFIX}${m[1]}` : null
}

// ── Gemini prompts + parsing ──────────────────────────────────────────────────

/**
 * Shared reading rules. Learned from real scans:
 *  - with a bare "M:SS.HH" answer and an example whose minutes were 1, the model invented a
 *    minute "1" for an empty minutes box, and "normalized" impossible seconds (67 -> 1:07);
 *  - asked to pad one-digit boxes itself, it padded the seconds correctly (5 -> 05) but the
 *    hundredths on the wrong side (6 -> 60, written "1 : 5 . 6" = 1:05.06 read as 1:05.60).
 * So the model only TRANSCRIBES the three boxes, separated by |, exactly as written; the padding,
 * the empty-box defaults and the impossible-time check are done in code (normalizeChronoTime).
 */
const TIME_READING_RULES = `Each time is written in three boxes: minutes, seconds, hundredths.
Transcribe each box separately, exactly as written. Do no arithmetic, padding, correction or conversion.
- Write only the digits that are in the box. If a box is empty, leave it empty.
- Never add a digit that is not written, and never move a digit from one box to another.
- If you cannot read a box clearly, write "unclear" for that whole line instead.
Examples (boxes -> answer line): minutes 1, seconds 05, hundredths 30 gives 1|05|30; minutes empty, seconds 42, hundredths 38 gives |42|38; minutes 2, seconds 7, hundredths 6 gives 2|7|6; minutes 1, seconds 05, hundredths empty gives 1|05|`

export const CHRONO_PROMPT = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times labeled "Chrono 1" and "Chrono 2".
Each time is written on three underlined fields: minutes, seconds, hundredths,
with the separators : and . pre-printed between them.
The handwriting may go above or across the lines.
Ignore any separator the timer also wrote by hand, and ignore the "Initiales" signatures on the right.

${TIME_READING_RULES}

Return ONLY these two lines, with the three boxes separated by | :
C1:<minutes>|<seconds>|<hundredths>
C2:<minutes>|<seconds>|<hundredths>`

export const BLANK_SHEET_PROMPT = `This image shows a hand-filled BLANK timing sheet from a lifesaving sport competition.
At the top, three numbers are handwritten on underlined fields labeled
"Épreuve" (event number), "Série" (heat number) and "Couloir" (lane number).
Below, two rows of handwritten times labeled "Chrono 1" and "Chrono 2".
Each time is written on three underlined fields: minutes, seconds, hundredths,
with the separators : and . pre-printed between them.
The handwriting may go above or across the lines.
Ignore any separator the timer also wrote by hand, and ignore the "Initiales" signatures on the right.
Ignore the swimmer name line.

${TIME_READING_RULES}

Return ONLY these five lines (the first three could be, for example, E:12, H:3 and L:5):
E:<event number>
H:<heat number>
L:<lane number>
C1:<minutes>|<seconds>|<hundredths>
C2:<minutes>|<seconds>|<hundredths>
If you cannot read the event, heat or lane clearly, write "unclear" for that line.`

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

  // Impossible / unreadable times come back blank for the operator to type (never rewritten).
  time1 = normalizeChronoTime(time1)
  time2 = normalizeChronoTime(time2)
  const confidence = (time1 && time2) ? 0.95 : 0.3
  return { time1, time2, confidence }
}

/**
 * A valid chrono time as `M:SS.HH`, or '' when it is unreadable ("unclear"), malformed or
 * impossible (seconds >= 60). Accepts what the prompt asks for, the three boxes as written
 * separated by `|` ("1|5|6", "|42|38"), and the plain `M:SS.HH` form.
 * The padding is done here, not by the model: an empty minutes box is 0, an empty hundredths
 * box is 00, and a lone digit is the UNITS digit (the missing tens is 0): "6" hundredths is 06,
 * never 60; "5" seconds is 05.
 */
export function normalizeChronoTime(raw: string): string {
  const text = raw.trim()
  if (text.includes('|')) {
    const boxes = text.split('|').map((p) => p.trim())
    return boxes.length === 3 ? buildChronoTime(boxes[0], boxes[1], boxes[2]) : ''
  }
  const m = text.match(/^(?:(\d{1,2})\s*:\s*)?(\d{1,2})\s*[.,]\s*(\d{1,2})$/)
  return m ? buildChronoTime(m[1] ?? '', m[2], m[3]) : ''
}

function buildChronoTime(minutes: string, seconds: string, hundredths: string): string {
  if (!/^\d{0,2}$/.test(minutes) || !/^\d{1,2}$/.test(seconds) || !/^\d{0,2}$/.test(hundredths)) return ''
  const sec = parseInt(seconds, 10)
  if (sec > 59) return ''
  const min = minutes === '' ? 0 : parseInt(minutes, 10)
  return `${min}:${String(sec).padStart(2, '0')}.${hundredths.padStart(2, '0')}`
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
  /** swimevent.round — Splash codes (rounds.ts): 1 TIM, 2 PRE, 6 SEM, 9 FIN */
  round: number
  eventName: string
  /** Athlete "Last, First" or relay team name */
  entryLabel: string
  clubCode: string
  /** The lane already has a time (swimtime > 0) */
  hasTime: boolean
}

/** Display name of an event: "100m Freestyle" (style names that already start with a digit are kept). */
function eventDisplayName(style: string | null, distance: number | null): string {
  const st = style ?? ''
  return /^\d/.test(st) || !distance ? st : `${distance}m ${st}`
}

/**
 * Entries seeded at any combination of the given event numbers / heats / lanes.
 * Shared by the exact lookup and the handwriting-alternatives lookup below.
 */
function queryEntries(db: QueryableDb, events: number[], heats: number[], lanes: number[]): BlankSheetCandidate[] {
  if (!events.length || !heats.length || !lanes.length) return []
  const ph = (n: number) => Array(n).fill('?').join(',')
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
    WHERE e.eventnumber IN (${ph(events.length)}) AND h.heatnumber IN (${ph(heats.length)}) AND x.lane IN (${ph(lanes.length)})
    ORDER BY e.round, e.swimeventid, h.heatnumber, x.lane
  `).all(...events, ...heats, ...lanes) as Array<{
    swimeventid: number; eventnumber: number; round: number | null
    stylename: string | null; distance: number | null; heatnumber: number
    lane: number; label: string | null; clubcode: string | null; swimtime: number | null
  }>

  return rows.map((r) => ({
    swimEventId: Number(r.swimeventid),
    eventNumber: Number(r.eventnumber),
    heatNumber: Number(r.heatnumber),
    lane: Number(r.lane),
    round: Number(r.round ?? 0),
    eventName: eventDisplayName(r.stylename, r.distance),
    entryLabel: r.label ?? '',
    clubCode: r.clubcode ?? '',
    hasTime: Number(r.swimtime ?? 0) > 0,
  }))
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
  return queryEntries(db, [eventNumber], [heatNumber], [lane])
}

// ── Handwriting confusions ────────────────────────────────────────────────────
// The identity (event / heat / lane) is handwritten and a misread silently files the times under
// the WRONG swimmer. Seen on real scans: 7 read as 1, 2 read as 7 (E2-H7-L2 became E7-H1-L2),
// 6 as 0, 4 as 9. So besides the exact reading we offer every entry that exists in the meet
// where some digits were swapped for look-alikes, and let the operator pick.

const CONFUSABLE_PAIRS = [['1', '7'], ['2', '7'], ['0', '6'], ['5', '6'], ['4', '9'], ['3', '8']]
const CONFUSABLE: Record<string, string[]> = {}
for (const [a, b] of CONFUSABLE_PAIRS) {
  ;(CONFUSABLE[a] ??= []).push(b)
  ;(CONFUSABLE[b] ??= []).push(a)
}

/** Numbers reachable from `n` by swapping digits for look-alikes → how many digits were swapped (0 = as read). */
export function digitVariants(n: number): Map<number, number> {
  const out = new Map<number, number>()
  if (!(n > 0)) return out
  const s = String(n)
  const walk = (i: number, acc: string, dist: number): void => {
    if (i === s.length) {
      const v = parseInt(acc, 10)
      if (v > 0 && String(v) === acc) {
        const prev = out.get(v)
        if (prev === undefined || dist < prev) out.set(v, dist)
      }
      return
    }
    walk(i + 1, acc + s[i], dist)
    for (const c of CONFUSABLE[s[i]] ?? []) walk(i + 1, acc + c, dist + 1)
  }
  walk(0, '', 0)
  return out
}

export interface BlankSheetAlternative extends BlankSheetCandidate {
  /** Number of digits that differ from what was read (always >= 1). */
  distance: number
}

/**
 * Entries that exist in the meet at a look-alike reading of (event, heat, lane), excluding the
 * reading itself. Open entries (no time yet) first, then fewest changed digits.
 */
export function findBlankSheetAlternatives(
  db: QueryableDb, eventNumber: number, heatNumber: number, lane: number, limit = 8,
): BlankSheetAlternative[] {
  const dE = digitVariants(eventNumber)
  const dH = digitVariants(heatNumber)
  const dL = digitVariants(lane)
  if (!dE.size || !dH.size || !dL.size) return []
  return queryEntries(db, [...dE.keys()], [...dH.keys()], [...dL.keys()])
    .map((c) => ({ ...c, distance: (dE.get(c.eventNumber) ?? 0) + (dH.get(c.heatNumber) ?? 0) + (dL.get(c.lane) ?? 0) }))
    .filter((c) => c.distance > 0)
    .sort((x, y) =>
      Number(x.hasTime) - Number(y.hasTime) || x.distance - y.distance ||
      x.eventNumber - y.eventNumber || x.heatNumber - y.heatNumber || x.lane - y.lane)
    .slice(0, limit)
}

// ── Event labels (Traitement list grouping) ───────────────────────────────────

export interface EventLabel {
  swimEventId: number
  eventNumber: number
  /** swimevent.round — Splash codes (rounds.ts) */
  round: number
  eventName: string
}

/** Every event of the meet, for naming the groups of the scan list. */
export function listEventLabels(db: QueryableDb): EventLabel[] {
  const rows = db.prepare(`
    SELECT e.swimeventid, e.eventnumber, e.round, ss.name AS stylename, ss.distance
    FROM swimevent e
    LEFT JOIN swimstyle ss ON ss.swimstyleid = e.swimstyleid
    ORDER BY e.eventnumber, e.round, e.swimeventid
  `).all() as Array<{ swimeventid: number; eventnumber: number; round: number | null; stylename: string | null; distance: number | null }>
  return rows.map((r) => ({
    swimEventId: Number(r.swimeventid),
    eventNumber: Number(r.eventnumber),
    round: Number(r.round ?? 0),
    eventName: eventDisplayName(r.stylename, r.distance),
  }))
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
