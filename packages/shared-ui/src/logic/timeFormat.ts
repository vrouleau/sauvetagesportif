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
 * Entry-time formatting/parsing shared by meet-app (main + renderer) and
 * shared-ui. DB/wire format is always integer milliseconds; display format is
 * "M:SS.cc" (minutes omitted under 60s).
 */

// Splash's max-int sentinel for "no time".
const MAX_MS_SENTINEL = 2147483647

/** Canonical ms → "M:SS.cc" / "SS.cc". Returns `opts.noTimeText` (default `undefined`) for null/0/negative/sentinel. */
export function msToDisplay(ms: number | null | undefined, opts?: { noTimeText?: string }): string | undefined {
  if (ms == null || ms === 0 || ms >= MAX_MS_SENTINEL || ms < 0) return opts?.noTimeText
  const totalCs = Math.round(ms / 10)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  return `${sec}.${String(cs).padStart(2, '0')}`
}

/** Canonical "H:MM:SS(.cc)" / "M:SS(.cc)" / "SS(.cc)" (or "NT") → ms. */
export function displayToMs(t: string | null | undefined): number | null {
  if (!t || t === 'NT') return null
  const parts = t.split(':')
  let secs: number
  if (parts.length === 3) secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
  else if (parts.length === 2) secs = parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  else secs = parseFloat(parts[0])
  return isNaN(secs) ? null : Math.round(secs * 1000)
}

/** "M:SS.cc" / "SS.cc" → centiseconds (used for multi-time averaging). */
export function timeToCs(t: string): number {
  const parts = t.split(':')
  let secs: number
  if (parts.length === 2) {
    const [minStr, rest] = parts
    secs = parseInt(minStr, 10) * 60 + parseFloat(rest)
  } else {
    secs = parseFloat(parts[0])
  }
  return Math.round(secs * 100)
}

/** Centiseconds → "M:SS.cc" / "SS.cc". */
export function csToTime(cs: number): string {
  const totalCs = Math.round(cs)
  const centis = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
  return `${sec}.${String(centis).padStart(2, '0')}`
}

/**
 * Loosely parse one typed time value into "M:SS.cc" display format. Accepts:
 *   "1:32.45" / "45.00" → as-is (normalized)
 *   "1:42:98" → "1:42.98" (":" used instead of "." for centiseconds)
 *   "4500" → "45.00", "13245" → "1:32.45" (raw digits, magnitude-based)
 * Returns `null` when the input can't be interpreted as a time.
 */
export function parseSingleTime(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null

  // Normalize: treat "1:42:98" as "1:42.98" (user may use : instead of . for centiseconds)
  let normalized = s
  const colonCount = (s.match(/:/g) || []).length
  if (colonCount === 2) {
    const lastColon = s.lastIndexOf(':')
    normalized = s.substring(0, lastColon) + '.' + s.substring(lastColon + 1)
  }

  // Already formatted: contains ":" or "."
  if (normalized.includes(':') || normalized.includes('.')) {
    const m1 = normalized.match(/^(\d{1,2}):(\d{1,2})\.(\d{1,2})$/) // M:SS.cc
    if (m1) {
      const [, min, sec, cs] = m1
      return `${parseInt(min)}:${sec.padStart(2, '0')}.${cs.padEnd(2, '0').slice(0, 2)}`
    }
    const m2 = normalized.match(/^(\d{1,2}):(\d{1,2})$/) // M:SS
    if (m2) {
      const [, min, sec] = m2
      return `${parseInt(min)}:${sec.padStart(2, '0')}.00`
    }
    const m3 = normalized.match(/^(\d{1,3})\.(\d{1,2})$/) // SS.cc
    if (m3) {
      const [, sec, cs] = m3
      const s2 = parseInt(sec)
      const min = Math.floor(s2 / 60)
      const rem = s2 % 60
      if (min > 0) return `${min}:${String(rem).padStart(2, '0')}.${cs.padEnd(2, '0').slice(0, 2)}`
      return `${rem}.${cs.padEnd(2, '0').slice(0, 2)}`
    }
    // Fallback: return as-is if it looks reasonable
    return normalized
  }

  // Pure integer: interpret based on magnitude
  const n = parseInt(s, 10)
  if (isNaN(n) || n <= 0) return null

  if (n < 100) {
    // Whole seconds
    const min = Math.floor(n / 60)
    const sec = n % 60
    if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.00`
    return `${sec}.00`
  }

  const cs = n % 100
  const rest = Math.floor(n / 100)
  const sec = rest % 100
  const min = Math.floor(rest / 100)

  if (sec >= 60) {
    // If seconds >= 60, reinterpret: carry into minutes
    const totalSec = min * 100 + sec // treat as raw seconds
    const realMin = Math.floor(totalSec / 60)
    const realSec = totalSec % 60
    return `${realMin}:${String(realSec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  }

  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  return `${sec}.${String(cs).padStart(2, '0')}`
}

/**
 * Loosely parse a typed time entry into "M:SS.cc" display format, same as
 * `parseSingleTime()`, but also accepts several times separated by spaces or
 * commas (e.g. two stopwatch reads) and averages them.
 */
export function parseLooseTimeInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/[\s,]+/).filter(Boolean)
  if (parts.length === 1) return parseSingleTime(parts[0])

  const parsed: string[] = []
  for (const p of parts) {
    const t = parseSingleTime(p)
    if (t) parsed.push(t)
  }
  if (parsed.length === 0) return null
  if (parsed.length === 1) return parsed[0]

  const totalCs = parsed.reduce((sum, t) => sum + timeToCs(t), 0)
  const avgCs = totalCs / parsed.length
  return csToTime(avgCs)
}

/** Same as `parseLooseTimeInput()`, but returns milliseconds directly. */
export function parseLooseTimeToMs(raw: string): number | null {
  const display = parseLooseTimeInput(raw)
  return display ? displayToMs(display) : null
}

/** Format ms for an editable entry-time field; empty string (not `undefined`) when there's no time. */
export function formatEntryTime(ms: number | null | undefined): string {
  return msToDisplay(ms) ?? ''
}

/**
 * Parse a strict "M:SS.cc" / "SS.cc" entry-time string (as produced by
 * `formatEntryTime()`/`TimeInput`). Returns `null` for an explicit empty/"NT"
 * value, `undefined` when the string doesn't match either format — callers
 * should treat `undefined` as "invalid, don't save".
 */
export function parseEntryTime(str: string): number | null | undefined {
  if (!str || str.trim().toLowerCase() === 'nt') return null
  const s = str.trim()
  let match = s.match(/^(\d+):(\d+)\.(\d+)$/)
  if (match) return parseInt(match[1]) * 60000 + parseInt(match[2]) * 1000 + parseInt(match[3]) * 10
  match = s.match(/^(\d+)\.(\d+)$/)
  if (match) return parseInt(match[1]) * 1000 + parseInt(match[2]) * 10
  return undefined
}
