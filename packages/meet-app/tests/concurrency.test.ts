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
 * Multi-station concurrency tests — exercise the hard requirement that two
 * independent stations (two SauvetageMeet instances, or SauvetageMeet +
 * Splash Meet Manager) can point at the same PostgreSQL server at once
 * without corrupting data.
 *
 * Concurrency model for this app (confirmed): only ONE station ever changes
 * event structure (heat generation, event/agegroup edits, beach-number
 * assignment) during a meet. Multiple stations DO concurrently enter results
 * (timing) and generate/read reports. So this file only covers the latter —
 * it deliberately does NOT test concurrent heat generation or concurrent
 * beach-number assignment, since those never happen from more than one
 * station in practice.
 *
 * IMPORTANT — why this uses raw `pg` Clients instead of two `PgBackend`
 * instances: PgBackend (src/main/pgBackend.ts) executes every query
 * *synchronously* from the caller's perspective (it blocks the calling
 * thread on Atomics.wait while its own Worker performs the real async
 * query). That's correct for Electron's main process, but it means two
 * PgBackend calls issued back-to-back from this SAME test process can never
 * actually overlap in wall-clock time — whichever call goes first runs to
 * completion before the second one is even dispatched, which would make a
 * "concurrency" test here a no-op. Two real stations are two separate OS
 * processes, so they don't have this limitation; plain `pg` Clients (genuinely
 * async, non-blocking) let us reproduce real overlap from one test process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'
import { createPgTestDb, isPgTestAvailable, seedMeet, resetTestDb } from './helpers'
import type { PgBackend } from '../src/main/pgBackend'

const pgAvailable = await isPgTestAvailable()
if (!pgAvailable) {
  console.warn(
    '[concurrency.test.ts] Postgres not reachable — skipping multi-station concurrency tests. ' +
    'Start it with: docker compose -f packages/meet-app/docker-compose.postgres.yml up -d'
  )
}

describe.skipIf(!pgAvailable)('Multi-station concurrency (real Postgres)', () => {
  let seedDb: PgBackend
  let dropDb: () => Promise<void>
  let clientA: Client
  let clientB: Client

  beforeAll(async () => {
    const h = await createPgTestDb()
    seedDb = h.db
    dropDb = h.cleanup

    const cfg = {
      host: process.env.TEST_PG_HOST || 'localhost',
      port: Number(process.env.TEST_PG_PORT) || 5432,
      user: process.env.TEST_PG_USER || 'meetmgr',
      password: process.env.TEST_PG_PASSWORD || 'meetmgr',
      database: h.databaseName,
    }
    clientA = new Client(cfg)
    clientB = new Client(cfg)
    await clientA.connect()
    await clientB.connect()
  })

  afterAll(async () => {
    await clientA.end()
    await clientB.end()
    seedDb.close()
    await dropDb()
  })

  beforeEach(() => {
    resetTestDb(seedDb)
    seedMeet(seedDb)
    seedDb.exec(`UPDATE swimsession SET lanemin=1, lanemax=8 WHERE swimsessionid=1`)
  })

  it('two stations writing swimtime for different rows of the same heat both persist (no lost update)', async () => {
    seedDb.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 1, 1, 4)`)
    seedDb.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane) VALUES (1, 1, 1, 1, 1, 4)`)
    seedDb.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane) VALUES (2, 1, 1, 1, 1, 5)`)

    await Promise.all([
      clientA.query(`UPDATE swimresult SET swimtime=$1 WHERE swimresultid=1`, [31500]),
      clientB.query(`UPDATE swimresult SET swimtime=$1 WHERE swimresultid=2`, [28750]),
    ])

    const rows = seedDb.prepare(`SELECT swimresultid, swimtime FROM swimresult WHERE heatid=1 ORDER BY swimresultid`).all() as Array<{ swimresultid: number; swimtime: number }>
    expect(rows.find(r => r.swimresultid === 1)?.swimtime).toBe(31500)
    expect(rows.find(r => r.swimresultid === 2)?.swimtime).toBe(28750)
  })

  it('a report reads consistent joined data while another station is concurrently entering results', async () => {
    seedDb.exec(`INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus) VALUES (1, 1, 1, 4)`)
    seedDb.exec(`INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane) VALUES (1, 1, 1, 1, 1, 4)`)

    // Station A (timing) writes a result while station B (report viewer) reads
    // the same heat's results joined with athlete/club, repeatedly, at the
    // same time — a real report page polls like this while results come in.
    const writePromise = clientA.query(`UPDATE swimresult SET swimtime=$1, resultstatus=NULL WHERE swimresultid=1`, [31500])

    const reportQuery = `
      SELECT sr.swimresultid, sr.swimtime, a.firstname, a.lastname, c.name AS clubname
      FROM swimresult sr
      JOIN athlete a ON sr.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      WHERE sr.heatid = 1
    `
    // Sequential on clientB (a single connection can't pipeline queries),
    // but still genuinely overlapping clientA's in-flight write above.
    const reads = [
      await clientB.query(reportQuery),
      await clientB.query(reportQuery),
      await clientB.query(reportQuery),
    ]
    await writePromise

    // Every read must return the fully-joined row (never a partial/torn read
    // or an error) — swimtime is either the old or new value, but the
    // athlete/club join is always intact.
    for (const r of reads) {
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0].firstname).toBe('John')
      expect(r.rows[0].clubname).toBe('Test Club')
    }

    const finalRow = seedDb.prepare(`SELECT swimtime FROM swimresult WHERE swimresultid=1`).get() as { swimtime: number }
    expect(finalRow.swimtime).toBe(31500)
  })
})
