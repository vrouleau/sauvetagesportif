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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type Database from 'better-sqlite3'

export type MeetType = 'POOL' | 'BEACH'

interface MonthDay {
  month: number
  day: number
}

interface AgeGroupRulesConfig {
  seasonStartDate: Record<MeetType, MonthDay>
  yearEndDate: MonthDay
  seasonStartBrackets: string[]
}

function getConfigPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'age-group-rules.json')
    : join(__dirname, '../../../../config/age-group-rules.json')
}

let cachedRules: AgeGroupRulesConfig | null = null

/** Reads config/age-group-rules.json (see that file for the rule it encodes). */
export function loadAgeGroupRules(): AgeGroupRulesConfig {
  if (!cachedRules) {
    cachedRules = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as AgeGroupRulesConfig
  }
  return cachedRules
}

function ageAsOf(birthdate: Date, refDate: Date): number {
  let age = refDate.getFullYear() - birthdate.getFullYear()
  const beforeBirthdayThisYear =
    refDate.getMonth() < birthdate.getMonth() ||
    (refDate.getMonth() === birthdate.getMonth() && refDate.getDate() < birthdate.getDate())
  if (beforeBirthdayThisYear) age--
  return age
}

/**
 * Resolves the age to use when matching an athlete's birthdate against an
 * event's agemin/agemax brackets, per Règlements des compétitions de
 * sauvetage sportif au Québec (Édition septembre 2025), §1.1-1.3:
 * - 10 ans et moins / 11-12 ans: age at season start (1er septembre pool /
 *   1er mai beach), locked for the whole season — unless the athlete will
 *   turn 13 before year end, in which case they're bumped to 13-14 for the
 *   season instead of staying in 11-12.
 * - 13-14 ans / 15-18 ans / Senior / Masters: age at 31 décembre of the
 *   season's start year (ILS rule), also locked for the whole season.
 */
export function resolveMatchingAge(birthdate: Date, meetType: MeetType, seasonYear: number): number {
  const rules = loadAgeGroupRules()
  const ss = rules.seasonStartDate[meetType]
  const ye = rules.yearEndDate
  const ageAtSeasonStart = ageAsOf(birthdate, new Date(seasonYear, ss.month - 1, ss.day))
  const ageAtYearEnd = ageAsOf(birthdate, new Date(seasonYear, ye.month - 1, ye.day))
  if (ageAtSeasonStart <= 10) return ageAtSeasonStart
  if (ageAtSeasonStart <= 12 && ageAtYearEnd < 13) return ageAtSeasonStart
  return ageAtYearEnd
}

/**
 * Season-anchor year: the year component of the meet's AGEDATE (set once at
 * meet creation/reset, see db.ts flushMeet — `bsglobal.AGEDATE`, Splash
 * MEETVALUES-style `D;YYYYMMDDHHMMSSMMM` format), falling back to the
 * current calendar year if not yet set. Fixed at meet setup rather than
 * read from wall-clock time so a season spanning two calendar years
 * (e.g. a pool meet held in early 2026 for the 2025-2026 season) keeps
 * using the season's actual start year, not whatever year it happens to be
 * on the day a coach registers an athlete.
 */
export function getSeasonYear(db: Database.Database): number {
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name = 'AGEDATE'`).get() as
    { data: string | null } | undefined
  const raw = row?.data ?? ''
  const digits = raw.includes(';') ? raw.slice(raw.indexOf(';') + 1) : raw
  const year = parseInt(digits.slice(0, 4), 10)
  return Number.isFinite(year) && year > 0 ? year : new Date().getFullYear()
}
