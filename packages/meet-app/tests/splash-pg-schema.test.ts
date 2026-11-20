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
 * meet-app creating a shared Postgres database (splashPgSchema.ts): it must be the database
 * real Splash would create, and meet-app itself must work on Splash's real column types
 * (timestamp, smallint, varchar(n), char(1), uuid…) — not only on its own generic SCHEMA_DDL.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { createPgTestDb, isPgTestAvailable } from './helpers'

const { pgState } = vi.hoisted(() => ({ pgState: { connected: true } }))
vi.mock('../src/main/connectionManager', () => ({
  isPgConnected: () => pgState.connected,
  getDb: () => { throw new Error('tests inject db explicitly') },
  closeDb: () => {},
}))

const { ensureSplashSchema } = await import('../src/main/splashPgSchema')
const { importLenex, writeZipSingleEntry } = await import('../src/main/lenex')
const { generateHeats } = await import('../src/main/db')

const CONFIG = join(__dirname, '..', '..', '..', 'config')
const schemaSql = readFileSync(join(CONFIG, 'splash-pg-schema.sql'), 'utf8')
const seedSql = readFileSync(join(CONFIG, 'splash-pg-seed.sql'), 'utf8')
const TEAM_FIXTURES = join(__dirname, '..', '..', 'team-app', 'tests', 'fixtures')

const pgAvailable = await isPgTestAvailable()

describe.skipIf(!pgAvailable)('meet-app creates the shared Postgres database (Splash schema)', () => {
  it('creates Splash\'s database on an empty one, and leaves an existing one alone', async () => {
    const { db, cleanup } = await createPgTestDb({ splashSchema: false })
    try {
      // createPgTestDb ran meet-app's SCHEMA_DDL — start from a really empty database instead
      for (const { name } of db.prepare(`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`).all() as Array<{ name: string }>) {
        db.exec(`DROP TABLE "${name}" CASCADE`)
      }
      expect(ensureSplashSchema(db, schemaSql, seedSql)).toBe('created')

      const tables = db.prepare(`SELECT COUNT(*) AS c FROM pg_tables WHERE schemaname = current_schema()`).get() as { c: string }
      expect(Number(tables.c)).toBe(35)
      const keys = (db.prepare(`SELECT name FROM bsglobal`).all() as Array<{ name: string }>).map(r => r.name)
      expect(keys).toEqual(expect.arrayContaining(['BSAPPLICATION', 'BSDB_DDL_VERSION_APPLICATION', 'DB_DDL_VERSION_BASE', 'REPORTDEFINITION']))
      const styles = db.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT swimstyleguid) AS g FROM swimstyle`).get() as { c: string; g: string }
      expect([Number(styles.c), Number(styles.g)]).toEqual([58, 58])
      // Splash's multi-line values keep their CRLF
      const gs = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GeneralSettings'`).get() as { data: string }
      expect(gs.data).toContain('\r\n')

      expect(ensureSplashSchema(db, schemaSql, seedSql)).toBe('existing')
    } finally {
      await cleanup()
    }
  })

  it('replaces the empty dsqitem older meet-app versions left behind, refuses foreign tables', async () => {
    const { db, cleanup } = await createPgTestDb({ splashSchema: false })
    try {
      for (const { name } of db.prepare(`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`).all() as Array<{ name: string }>) {
        db.exec(`DROP TABLE "${name}" CASCADE`)
      }
      db.exec(`CREATE TABLE dsqitem (dsqitemid INTEGER PRIMARY KEY)`)
      expect(ensureSplashSchema(db, schemaSql, seedSql)).toBe('created')

      db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
      db.exec(`CREATE TABLE something_else (id INTEGER)`)
      expect(() => ensureSplashSchema(db, schemaSql, seedSql)).toThrow(/not Splash Meet Manager/)
      const left = db.prepare(`SELECT COUNT(*) AS c FROM pg_tables WHERE schemaname = current_schema()`).get() as { c: string }
      expect(Number(left.c)).toBe(1)  // nothing touched
    } finally {
      await cleanup()
    }
  })

  it('imports a meet and its entries and generates heats on Splash\'s real column types', async () => {
    const { db, cleanup } = await createPgTestDb({ splashSchema: true })
    try {
      const sqliteLike = db as unknown as Database.Database
      const meet = importLenex(join(TEAM_FIXTURES, 'meet_template.lxf'), sqliteLike)
      expect(meet.errors).toEqual([])
      // 10 swimmers entered in the template's event 1095 (10 & under, agegroup 1096)
      const athletes = Array.from({ length: 10 }, (_, i) =>
        `<ATHLETE athleteid="${900 + i}" firstname="A${i}" lastname="Test" gender="${i % 2 ? 'M' : 'F'}" birthdate="2017-0${(i % 9) + 1}-15">` +
        `<ENTRIES><ENTRY eventid="1095" agegroupid="1096" entrytime="00:00:${40 + i}.00" entrycourse="LCM" /></ENTRIES></ATHLETE>`).join('')
      const entriesPath = join(tmpdir(), `splash-pg-entries-${process.pid}.lxf`)
      writeZipSingleEntry(entriesPath, 'entries.lef', `<?xml version="1.0" encoding="UTF-8"?>
<LENEX version="3.0"><MEETS><MEET name="Entries" course="LCM"><CLUBS>
<CLUB clubid="77" code="TST" name="Test Club" nation="CAN"><ATHLETES>${athletes}</ATHLETES></CLUB>
</CLUBS></MEET></MEETS></LENEX>`)
      const entries = importLenex(entriesPath, sqliteLike)
      expect(entries.errors).toEqual([])
      expect(entries.results).toBe(10)

      const result = await generateHeats(undefined, undefined, db as never)
      expect(result.heatsCreated).toBeGreaterThan(0)

      const heats = db.prepare(`SELECT racestatus, agegroupid FROM heat`).all() as Array<{ racestatus: number; agegroupid: number | null }>
      expect(heats.every(h => h.racestatus === 2 && h.agegroupid != null)).toBe(true)
      // new rows draw from Splash's own id sequence, past its 58 seeded styles (1001-1058)
      const minClub = db.prepare(`SELECT MIN(clubid) AS m FROM club`).get() as { m: number }
      expect(minClub.m).toBeGreaterThan(1058)
    } finally {
      await cleanup()
    }
  })
})
