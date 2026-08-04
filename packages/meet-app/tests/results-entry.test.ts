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
 * PG-parity coverage for saveResult()/getHeatListSessions() — the results-entry write path
 * and the heat-list read path every timing station hits. Per packages/meet-app/CLAUDE.md's
 * documented concurrency model, this exact pair is what multiple real stations run
 * concurrently against a *shared* Postgres server (only event-structure changes — heat
 * generation, event/agegroup edits — are single-station; results entry and report reads are
 * the multi-station case), making this pairing the highest real-world-exposure spot to have
 * PG-parity coverage. Neither function used any SQLite-only syntax (both
 * already relied on inClause() and portable SQL), so unlike beachNumber.ts's PG-parity suite
 * this isn't chasing a known bug — it added coverage on a high-traffic path that had none.
 * Skipped automatically if no Postgres server is reachable.
 */
import { describe, it, expect } from 'vitest'
import { createTestDb, createPgTestDb, isPgTestAvailable, seedMeet, type TestBackendKind } from './helpers'
import { saveResult, getHeatListSessions } from '../src/main/db'

const pgAvailable = await isPgTestAvailable()
const BACKENDS: TestBackendKind[] = pgAvailable ? ['sqlite', 'pg'] : ['sqlite']
if (!pgAvailable) {
  console.warn(
    '[results-entry.test.ts] Postgres not reachable — skipping PG-backend tests. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

describe.each(BACKENDS)('saveResult / getHeatListSessions backend parity [%s]', (kind) => {
  async function withDb(fn: (db: any) => Promise<void>) {
    if (kind === 'sqlite') {
      const { db, cleanup } = createTestDb()
      try {
        await fn(db)
      } finally {
        cleanup()
      }
    } else {
      const { db, cleanup } = await createPgTestDb()
      try {
        await fn(db)
      } finally {
        await cleanup()
      }
    }
  }

  it('writes a time + splits via saveResult and reads them back via getHeatListSessions', async () => {
    await withDb(async (db) => {
      seedMeet(db)
      // seedMeet leaves swimresult empty — add one lane entry on a not-yet-validated (racestatus=4) heat.
      db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 1, 1, 4, 1)`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, agegroupid) VALUES (1, 1, 1, 1, 4, 1)`)

      await saveResult(1, '1:05.43', 0.65, null, { 50: '31.20' }, null, db)

      const sessions = await getHeatListSessions(db)
      const entry = sessions[0]?.events[0]?.heats[0]?.entries[0]
      expect(entry).toBeDefined()
      expect(entry!.finalTime).toBe('1:05.43')
      expect(entry!.status).toBeFalsy()
      expect(entry!.splitTimes?.[50]).toBe('31.20')
    })
  })

  it('rejects a result write on a validated (racestatus=5) heat', async () => {
    await withDb(async (db) => {
      seedMeet(db)
      db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 1, 1, 5, 1)`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, agegroupid) VALUES (1, 1, 1, 1, 4, 1)`)

      await expect(saveResult(1, '1:05.43', null, null, undefined, null, db)).rejects.toThrow()
    })
  })

  it('records a DSQ status and clears the displayed final time', async () => {
    await withDb(async (db) => {
      seedMeet(db)
      db.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode) VALUES (1, 1, 1, 4, 1)`)
      db.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, agegroupid) VALUES (1, 1, 1, 1, 4, 1)`)

      await saveResult(1, '1:05.43', null, 'DSQ', undefined, null, db)

      const sessions = await getHeatListSessions(db)
      const entry = sessions[0]?.events[0]?.heats[0]?.entries[0]
      expect(entry!.status).toBe('DSQ')
      expect(entry!.finalTime).toBeUndefined()
    })
  })
})
