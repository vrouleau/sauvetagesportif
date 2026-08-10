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
 * Regression tests: BSGLOBAL points config used to be written under a key
 * ("POINTSCORES", plural) and schema that Splash never actually reads. Real
 * Splash's own key is "POINTSCORE" (singular), with a single <POINTSCORE>
 * element carrying ~20 attributes plus nested <AGEGROUPS>/<PLACEPOINTS> —
 * verified against 4 real Splash-native .mdb files. Splash's own
 * points-standings report showed no configured scale at all as a result,
 * in both a restored .smb and (since regeneratePointScores runs against
 * whatever backend is active) a live-shared Postgres database.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTestDb } from './helpers'
import type Database from 'better-sqlite3'
import { regeneratePointScores } from '../src/main/pointScores'

beforeAll(() => {
  const userData = join(tmpdir(), 'sauvetagemeet-test-point-scores')
  mkdirSync(userData, { recursive: true })
  process.env.TEST_USER_DATA = userData
})

describe('pointScores', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
  })

  afterEach(() => cleanup())

  it('writes the singular POINTSCORE key, not the plural POINTSCORES', () => {
    regeneratePointScores(db)

    const row = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORE'`).get() as { data: string } | undefined
    expect(row).toBeDefined()

    const stale = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORES'`).get()
    expect(stale).toBeUndefined()
  })

  it('writes XML matching Splash\'s real native schema', () => {
    regeneratePointScores(db)
    const row = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORE'`).get() as { data: string }

    // Single <POINTSCORE> wrapper with the real Splash attribute set (not our old
    // simplified "points=1,2,3" comma-list on multiple named definitions).
    expect(row.data).toContain('<POINTSCORE pointscoreid=')
    expect(row.data).toContain('pointsmaxtimonly="T"')
    expect(row.data).toContain('<AGEGROUPS>')
    expect(row.data).toContain('<AGEGROUP from="-1" to="-1" />')
    expect(row.data).toContain('<PLACEPOINTS>')
    expect(row.data).toContain('<PLACEPOINT position="1" individual="20" relay="20" />')
  })

  it('cleans up a stale plural POINTSCORES row left by an earlier version', () => {
    db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('POINTSCORES', '<stale/>')`).run()

    regeneratePointScores(db)

    const stale = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORES'`).get()
    expect(stale).toBeUndefined()
    const row = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORE'`).get()
    expect(row).toBeDefined()
  })

  it('self-heals a pre-existing userData config file from before splashPointScore existed', () => {
    // Simulates a real installation upgrading from an older app version: its userData copy of
    // point-scores-config.json predates the splashPointScore field entirely (only had
    // definitions/assignments). loadPointScoresConfig's copy-on-first-run logic never fires
    // for it (the file already exists), so without the self-heal this crashes every single
    // regeneratePointScores() call forever — reproduced via move-age-group.test.ts's stable,
    // persisted TEST_USER_DATA dir picking up a stale file from before this fix.
    const staleUserData = join(tmpdir(), `sauvetagemeet-test-stale-config-${randomBytes(4).toString('hex')}`)
    mkdirSync(staleUserData, { recursive: true })
    const staleConfigPath = join(staleUserData, 'point-scores-config.json')
    writeFileSync(staleConfigPath, JSON.stringify({
      description: 'old',
      definitions: [{ pointscoreid: 1, name: 'Standard 16 places', points: [20, 18] }],
      assignments: [],
    }), 'utf-8')

    const prevUserData = process.env.TEST_USER_DATA
    process.env.TEST_USER_DATA = staleUserData
    try {
      expect(() => regeneratePointScores(db)).not.toThrow()

      const row = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORE'`).get() as { data: string }
      expect(row.data).toContain('<POINTSCORE pointscoreid=')

      // Patched on disk too, so the crash doesn't recur on the next call.
      const healed = JSON.parse(readFileSync(staleConfigPath, 'utf-8'))
      expect(healed.splashPointScore).toBeDefined()
      expect(healed.definitions).toEqual([{ pointscoreid: 1, name: 'Standard 16 places', points: [20, 18] }])
    } finally {
      process.env.TEST_USER_DATA = prevUserData
    }
  })

  it('self-heals a userData config stuck on the single {-1,-1} bucket from before per-age-bracket sections existed', () => {
    // Reproduces a real bug found auditing a live beach meet: the userData copy had
    // splashPointScore (so the "fully absent" self-heal above never fired) but its ageGroups
    // was still the original single {-1,-1} catch-all bucket, from before the bundled default
    // was updated to carry Splash's real 4-bracket structure (14 ans et moins / 15-18 / 19+ /
    // Cat. générale). Splash's own report showed all 4 brackets correctly; meet-app's own
    // "Point Standings" report silently showed only "Cat. générale" forever, with no way for
    // the user to get the other 3 sections short of deleting the file by hand.
    const staleUserData = join(tmpdir(), `sauvetagemeet-test-single-bucket-${randomBytes(4).toString('hex')}`)
    mkdirSync(staleUserData, { recursive: true })
    const staleConfigPath = join(staleUserData, 'point-scores-config.json')
    writeFileSync(staleConfigPath, JSON.stringify({
      description: 'old',
      definitions: [],
      assignments: [],
      splashPointScore: {
        pointscoreid: 1198,
        name: 'Classement de sauvetage',
        titleforprints: 'Classement aux points des clubs',
        attributes: { pointsmaxtimonly: 'T' },
        ageGroups: [{ from: -1, to: -1 }],
        placePoints: [{ position: 1, individual: 99, relay: 99 }], // customized value — must survive
      },
    }), 'utf-8')

    const prevUserData = process.env.TEST_USER_DATA
    process.env.TEST_USER_DATA = staleUserData
    try {
      regeneratePointScores(db)

      const row = db.prepare(`SELECT data FROM bsglobal WHERE name='POINTSCORE'`).get() as { data: string }
      expect(row.data).toContain('<AGEGROUP from="-1" to="14" />')
      expect(row.data).toContain('<AGEGROUP from="15" to="18" />')
      expect(row.data).toContain('<AGEGROUP from="19" to="-1" />')
      // The user's customized point value must survive the heal untouched.
      expect(row.data).toContain('<PLACEPOINT position="1" individual="99" relay="99" />')

      const healed = JSON.parse(readFileSync(staleConfigPath, 'utf-8'))
      expect(healed.splashPointScore.ageGroups.length).toBeGreaterThan(1)
      expect(healed.splashPointScore.placePoints).toEqual([{ position: 1, individual: 99, relay: 99 }])
    } finally {
      process.env.TEST_USER_DATA = prevUserData
    }
  })
})
