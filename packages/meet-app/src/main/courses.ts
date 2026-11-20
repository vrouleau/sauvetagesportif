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
 * Pool course codes — Splash Meet Manager's own, stored as-is in swimsession.course,
 * swimresult/relay entrycourse and qtcourse, MEETVALUES COURSE and bsglobal MeetCourse
 * (Splash reads our rows directly on a shared Postgres database).
 *
 * Splash's CourseNames (Meet.xus): 0 All, 1 Long Course (50m), 2 Short Course (25m),
 * 3 Yards (25y) — confirmed by real 25 m Splash meets (CAEM 2026, CQS 2025: COURSE=2).
 * A beach meet's MEETVALUES COURSE is 7 in Splash (one real sample).
 *
 * team-app numbers them differently (1 LCM, 2 SCY, 3 SCM); the shared editor and the API
 * between the apps use the LENEX names, never the numbers.
 */
export const COURSE = {
  LCM: 1,
  SCM: 2,
  SCY: 3,
  BEACH: 7,
} as const

export type CourseName = 'LCM' | 'SCM' | 'SCY'

/** LENEX/API course name → Splash code (unknown → null). */
export function courseFromName(c: string | null | undefined): number | null {
  switch ((c ?? '').toUpperCase()) {
    case 'LCM': return COURSE.LCM
    case 'SCM': return COURSE.SCM
    case 'SCY': return COURSE.SCY
    default: return null
  }
}

/** Splash code → LENEX/API course name (beach and unknown → LCM, as meet-app always did). */
export function courseToName(c: number | string | null | undefined): CourseName {
  switch (typeof c === 'string' ? parseInt(c, 10) : c) {
    case COURSE.SCM: return 'SCM'
    case COURSE.SCY: return 'SCY'
    default: return 'LCM'
  }
}

/** Course from the shared editor: a LENEX name, or a Splash code already. */
export function courseFromRequest(c: string | number | null | undefined): number | null {
  if (typeof c === 'number') return c
  if (c != null && /^\d+$/.test(c)) return parseInt(c, 10)
  return courseFromName(c)
}
