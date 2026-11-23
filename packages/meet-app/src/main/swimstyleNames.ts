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

// Swim style names by id (config/swimstyle-names.json) — mirrors team-app's
// backend/app/swimstyle_names.py. LENEX keeps the French name; this supplies
// the English one for the UI.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

function getConfigPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'swimstyle-names.json')
    : join(__dirname, '../../../../config/swimstyle-names.json')
}

let cached: Map<number, string> | null = null

function loadEnglishNames(): Map<number, string> {
  if (!cached) {
    cached = new Map()
    try {
      const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
      for (const series of ['pool', 'beach']) {
        const entries = (raw[series] ?? {}) as Record<string, { name_en?: string }>
        for (const [id, v] of Object.entries(entries)) {
          if (v?.name_en) cached.set(Number(id), v.name_en)
        }
      }
    } catch {
      // Missing/invalid file: fall back to the LENEX name everywhere.
    }
  }
  return cached
}

/** English name for a swim style id, or `fallback` (the LENEX name) when unknown. */
export function swimstyleNameEn(id: number | null | undefined, fallback: string): string {
  return (id != null && loadEnglishNames().get(id)) || fallback
}
