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
 * Splash schema contract test — the actual "cross-compatibility" test this
 * whole PG-backend effort was for.
 *
 * `tests/fixtures/splash-schema.csv` is a real `information_schema.columns`
 * dump captured 2026-07-31 from a genuine Splash Meet Manager 11 instance,
 * connected via ODBC DSN to a fresh PostgreSQL database — i.e. it's the exact
 * schema Splash itself creates on connect, not our own reverse-engineering of
 * it. This test builds our own schema (schema.ts's SCHEMA_DDL, the same DDL
 * the app runs for a fresh SQLite/PG database) and diffs it against that
 * fixture for every table we both define.
 *
 * Two kinds of drift are checked:
 * - MISSING: a column Splash has that we don't → we'd silently drop that
 *   data, or crash reading a real Splash-created database that has it.
 *   This must never happen — any diff here fails the test.
 * - EXTRA: a column we have that Splash doesn't → intentional additions
 *   (bilingual UI fields etc.) are fine as long as they're on the allowlist
 *   below *and* the app backfills them onto pre-existing Splash-created
 *   tables (see connectionManager.ts's dsqitem.name_en handling). An
 *   unlisted extra column fails the test, forcing a deliberate decision
 *   instead of silent schema drift.
 *
 * Regenerating the fixture: connect real Splash (via its ODBC DSN) to a
 * fresh empty Postgres database, then:
 *   psql -h <host> -p <port> -U <user> -d <db> -A -F"," -c \
 *     "SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
 *      FROM information_schema.columns WHERE table_schema='public'
 *      ORDER BY table_name, ordinal_position;" -o splash-schema.csv
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPgTestDb, isPgTestAvailable, getTableColumns } from './helpers'
import type { PgBackend } from '../src/main/pgBackend'

const pgAvailable = await isPgTestAvailable()
if (!pgAvailable) {
  console.warn(
    '[splash-schema-contract.test.ts] Postgres not reachable — skipping. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

/** Columns we intentionally added that real Splash doesn't have. */
const KNOWN_EXTRA_COLUMNS: Record<string, string[]> = {
  dsqitem: ['name_en'], // bilingual DSQ codes — backfilled via ALTER TABLE in connectionManager.ts
}

function parseSplashSchema(): Map<string, Set<string>> {
  const csv = readFileSync(join(__dirname, 'fixtures', 'splash-schema.csv'), 'utf-8')
  const lines = csv.trim().split('\n').slice(1) // skip header row
  const byTable = new Map<string, Set<string>>()
  for (const line of lines) {
    const [table, column] = line.split(',')
    if (!byTable.has(table)) byTable.set(table, new Set())
    byTable.get(table)!.add(column)
  }
  return byTable
}

describe.skipIf(!pgAvailable)('Splash schema contract', () => {
  let db: PgBackend
  let dropDb: () => Promise<void>
  const splashSchema = parseSplashSchema()

  beforeAll(async () => {
    const h = await createPgTestDb()
    db = h.db
    dropDb = h.cleanup
  })

  afterAll(async () => {
    await dropDb()
  })

  // Only tables we actually model — schema.ts intentionally doesn't cover
  // Splash's official/judge/record/timestandard/etc. tables (see CLAUDE.md).
  const ourTables = [
    'bsglobal', 'dsqitem', 'swimstyle', 'club', 'swimsession',
    'athlete', 'swimevent', 'agegroup', 'heat', 'swimresult',
    'split', 'relay', 'relayposition', 'relaysplit',
  ]

  it.each(ourTables)('%s has no columns missing relative to real Splash', (table) => {
    const splashCols = splashSchema.get(table)
    expect(splashCols, `fixture has no "${table}" table — did the CSV parse correctly?`).toBeDefined()

    const ourCols = new Set(getTableColumns(db, 'pg', table))
    const missing = [...splashCols!].filter(c => !ourCols.has(c))

    expect(missing, `columns Splash has but we don't: ${missing.join(', ')}`).toEqual([])
  })

  it.each(ourTables)('%s has no undocumented extra columns relative to real Splash', (table) => {
    const splashCols = splashSchema.get(table)!
    const ourCols = getTableColumns(db, 'pg', table)
    const allowed = new Set(KNOWN_EXTRA_COLUMNS[table] ?? [])
    const extra = ourCols.filter(c => !splashCols.has(c) && !allowed.has(c))

    expect(extra, `undocumented columns we have but Splash doesn't: ${extra.join(', ')} — add to KNOWN_EXTRA_COLUMNS if intentional`).toEqual([])
  })
})
