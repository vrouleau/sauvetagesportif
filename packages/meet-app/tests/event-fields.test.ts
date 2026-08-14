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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb, seedMeet } from './helpers'
import { getSessions, updateEvent } from '../src/main/db'

/**
 * Regression tests for the "write path works, read path drops the field" bug
 * class found in this repo: updateEvent persisted a column correctly but
 * getSessions (the query that feeds EventsPage) never selected it back, so
 * the UI showed a stale/default value and a re-save from that stale state
 * could silently overwrite the real value. See HANDOFF_2026-07-28.md.
 */
describe('Event field round-trip (getSessions <-> updateEvent)', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    seedMeet(db)
  })

  afterEach(() => cleanup())

  function findEvent(sessions: Awaited<ReturnType<typeof getSessions>>, eventId: number) {
    for (const s of sessions) {
      const ev = s.events.find(e => e.id === eventId)
      if (ev) return ev
    }
    throw new Error(`event ${eventId} not found in getSessions() result`)
  }

  it('round-trips masters, fee, and maxEntries', async () => {
    await updateEvent(1, { masters: true, fee: 12.5, maxentries: 6 }, db)

    const sessions = await getSessions(db)
    const ev = findEvent(sessions, 1)
    expect(ev.masters).toBe(true)
    expect(ev.fee).toBe(12.5)
    expect(ev.maxEntries).toBe(6)
  })

  it('round-trips masters=false and fee=0 (falsy values must not be dropped)', async () => {
    await updateEvent(1, { masters: true, fee: 12.5 }, db)
    await updateEvent(1, { masters: false, fee: 0 }, db)

    const sessions = await getSessions(db)
    const ev = findEvent(sessions, 1)
    expect(ev.masters).toBe(false)
    expect(ev.fee).toBe(0)
  })

  it('round-trips finalOrder, scheduledTime, and duration', async () => {
    // <input type="time"> always emits zero-padded "HH:MM"
    await updateEvent(1, { finalorder: 1, daytime: '09:15', duration: '00:45' }, db)

    const sessions = await getSessions(db)
    const ev = findEvent(sessions, 1)
    expect(ev.finalOrder).toBe(1)
    expect(ev.scheduledTime).toBe('9:15')
    expect(ev.duration).toBe('0:45')
  })

  it('clears scheduledTime and duration back to undefined when set to null', async () => {
    await updateEvent(1, { daytime: '09:15', duration: '00:45' }, db)
    await updateEvent(1, { daytime: null, duration: null }, db)

    const sessions = await getSessions(db)
    const ev = findEvent(sessions, 1)
    expect(ev.scheduledTime).toBeUndefined()
    expect(ev.duration).toBeUndefined()
  })

  it('does not affect fields that were not part of the update', async () => {
    await updateEvent(1, { fee: 5 }, db)
    await updateEvent(1, { masters: true }, db)

    const sessions = await getSessions(db)
    const ev = findEvent(sessions, 1)
    // A later update() for one field must not clobber an earlier field's value
    expect(ev.fee).toBe(5)
    expect(ev.masters).toBe(true)
  })

  it('flips a prelim\'s age groups off for medals/scoring when a final links to it via preveventid, and back on when the final is deleted (round reverts to TIM)', async () => {
    // Simulate age groups created the normal way (createAgeGroup/importLenex always
    // default to 'T'/'T' — seedMeet's raw INSERT relies on the schema default, 'F').
    db.exec(`UPDATE agegroup SET useformedals='T', useforscoring='T' WHERE swimeventid=1`)

    // Convert event 1 (TIM) into a PRE, and link a new FIN event to it — mirrors
    // handleConvertToFinal's step 1 (round -> PRE) and step 3 (preveventid link).
    await updateEvent(1, { round: 1 }, db)
    db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (4, 1, 1, 1, 1, 4, 3, 'F')`)
    await updateEvent(4, { preveventid: 1 }, db)

    const flags = db.prepare(`SELECT useformedals, useforscoring FROM agegroup WHERE swimeventid=1`).all() as Array<{ useformedals: string; useforscoring: string }>
    expect(flags.length).toBeGreaterThan(0)
    for (const f of flags) {
      expect(f.useformedals).toBe('F')
      expect(f.useforscoring).toBe('F')
    }

    // Deleting the final reverts the prelim's round back to TIM — its age groups
    // must count again, matching a plain (never-split) Timed Final.
    await updateEvent(1, { round: 5 }, db)
    const flagsAfter = db.prepare(`SELECT useformedals, useforscoring FROM agegroup WHERE swimeventid=1`).all() as Array<{ useformedals: string; useforscoring: string }>
    for (const f of flagsAfter) {
      expect(f.useformedals).toBe('T')
      expect(f.useforscoring).toBe('T')
    }
  })
})
