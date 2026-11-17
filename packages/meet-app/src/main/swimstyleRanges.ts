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

// Known swimstyle id series (config/swimstyle-ranges.json) — mirrors team-app's
// backend/app/swimstyle_check.py. A style id outside both series comes from a
// stale or foreign template; a structure mixing pool and beach ids is never a
// valid meet (MEET_TYPE auto-detect would silently call it BEACH).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type MeetType = 'POOL' | 'BEACH'

type Ranges = Record<MeetType, { min: number; max: number }>

function getConfigPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'swimstyle-ranges.json')
    : join(__dirname, '../../../../config/swimstyle-ranges.json')
}

let cached: Ranges | null = null

export function loadSwimstyleRanges(): Ranges {
  if (!cached) {
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    cached = { POOL: raw.POOL, BEACH: raw.BEACH } as Ranges
  }
  return cached
}

export function styleMeetType(id: number | null | undefined): MeetType | null {
  if (!id) return null
  const r = loadSwimstyleRanges()
  for (const t of ['POOL', 'BEACH'] as const) {
    if (id >= r[t].min && id <= r[t].max) return t
  }
  return null
}

export function rangesLabel(): string {
  const r = loadSwimstyleRanges()
  return `${r.POOL.min}-${r.POOL.max} / ${r.BEACH.min}-${r.BEACH.max}`
}

export interface SwimstyleIssues {
  /** Distinct style ids outside both known series, sorted by id. */
  outOfRange: Array<{ id: number; name: string }>
  /** True when the ids include both pool-series and beach-series styles. */
  mixed: boolean
}

/** Falsy ids (pause/break placeholders) are ignored. */
export function findSwimstyleIssues(styles: Iterable<{ id: number; name: string }>): SwimstyleIssues {
  const seen = new Map<number, string>()
  for (const s of styles) {
    if (s.id && !seen.has(s.id)) seen.set(s.id, s.name)
  }
  const types = new Set<MeetType>()
  const outOfRange: Array<{ id: number; name: string }> = []
  for (const [id, name] of [...seen].sort((a, b) => a[0] - b[0])) {
    const t = styleMeetType(id)
    if (t) types.add(t)
    else outOfRange.push({ id, name })
  }
  return { outOfRange, mixed: types.size > 1 }
}
