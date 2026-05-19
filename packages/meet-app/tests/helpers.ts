import Database from 'better-sqlite3'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { unlinkSync } from 'fs'

/**
 * Create a temporary SQLite database with the meet schema initialized.
 * Returns the db instance and a cleanup function.
 */
export function createTestDb(): { db: Database.Database; cleanup: () => void; path: string } {
  const dbPath = join(tmpdir(), `splashmeet-test-${randomBytes(4).toString('hex')}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Initialize schema (same as db.ts initLocalSchema)
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS bsglobal (name TEXT NOT NULL DEFAULT '' PRIMARY KEY, data TEXT)`,
    `CREATE TABLE IF NOT EXISTS swimstyle (swimstyleid INTEGER PRIMARY KEY, code TEXT, distance INTEGER, name TEXT, relaycount INTEGER, stroke INTEGER, sortcode INTEGER, technique INTEGER, uniqueid INTEGER)`,
    `CREATE TABLE IF NOT EXISTS club (clubid INTEGER PRIMARY KEY, code TEXT, name TEXT, nation TEXT)`,
    `CREATE TABLE IF NOT EXISTS swimsession (swimsessionid INTEGER PRIMARY KEY, course INTEGER, daytime TEXT, endtime TEXT, feeathlete REAL, following TEXT DEFAULT 'F', lanemin INTEGER, lanemax INTEGER, name TEXT, officialmeeting TEXT, roundtotenths TEXT DEFAULT 'F', sessionnumber INTEGER, timing INTEGER, touchpadmode INTEGER, warmupfrom TEXT, warmupuntil TEXT, remarks TEXT, remarksjury TEXT, maxentriesathlete INTEGER, maxentriesrelay INTEGER, poolglobal TEXT DEFAULT 'F')`,
    `CREATE TABLE IF NOT EXISTS athlete (athleteid INTEGER PRIMARY KEY, clubid INTEGER REFERENCES club(clubid), firstname TEXT, lastname TEXT, gender INTEGER, birthdate TEXT, nation TEXT, license TEXT, domicile TEXT)`,
    `CREATE TABLE IF NOT EXISTS swimevent (swimeventid INTEGER PRIMARY KEY, swimsessionid INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE, swimstyleid INTEGER REFERENCES swimstyle(swimstyleid), eventnumber INTEGER, gender INTEGER, round INTEGER, sortcode INTEGER, internalevent TEXT DEFAULT 'F', masters TEXT DEFAULT 'F', roundname TEXT, daytime TEXT, splashmecanedit TEXT DEFAULT 'F', pfineignore TEXT DEFAULT 'F', seedbonuslast TEXT DEFAULT 'F', seedexhlast TEXT DEFAULT 'F', seedlateentrylast TEXT DEFAULT 'F', seedingglobal TEXT DEFAULT 'F', twoperlane TEXT DEFAULT 'F', combineagegroups TEXT DEFAULT 'F')`,
    `CREATE TABLE IF NOT EXISTS agegroup (agegroupid INTEGER PRIMARY KEY, swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE, name TEXT, agemin INTEGER, agemax INTEGER, gender INTEGER, heatcount INTEGER, sortcode INTEGER, useformedals TEXT DEFAULT 'F', useforscoring TEXT DEFAULT 'F', allofficial TEXT DEFAULT 'F', agebytotal TEXT DEFAULT 'F', forceprelim TEXT DEFAULT 'F', seedwithtsonly TEXT DEFAULT 'F')`,
    `CREATE TABLE IF NOT EXISTS heat (heatid INTEGER PRIMARY KEY, swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE, heatnumber INTEGER, racestatus INTEGER, sortcode INTEGER, name TEXT)`,
    `CREATE TABLE IF NOT EXISTS swimresult (swimresultid INTEGER PRIMARY KEY, athleteid INTEGER REFERENCES athlete(athleteid), swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE, agegroupid INTEGER, heatid INTEGER, lane INTEGER, entrytime INTEGER, swimtime INTEGER, reactiontime INTEGER, resultstatus INTEGER, usetimetype INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS split (swimresultid INTEGER NOT NULL REFERENCES swimresult(swimresultid) ON DELETE CASCADE, distance INTEGER NOT NULL, swimtime INTEGER, PRIMARY KEY (swimresultid, distance))`,
  ]
  for (const ddl of SCHEMA) db.exec(ddl)

  return {
    db,
    path: dbPath,
    cleanup: () => { db.close(); try { unlinkSync(dbPath) } catch {} },
  }
}

/** Seed a basic meet structure into the test DB. */
export function seedMeet(db: Database.Database) {
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (1, 100, 'Freestyle', 1, 1)`)
  db.exec(`INSERT INTO swimstyle (swimstyleid, distance, name, relaycount, stroke) VALUES (2, 200, 'Backstroke', 1, 2)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (1, 1, 'Session 1', 1)`)
  db.exec(`INSERT INTO swimsession (swimsessionid, sessionnumber, name, course) VALUES (2, 2, 'Session 2', 1)`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (1, 1, 1, 1, 1, 5, 1, 'F')`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (2, 1, 2, 2, 2, 5, 2, 'F')`)
  db.exec(`INSERT INTO swimevent (swimeventid, swimsessionid, swimstyleid, eventnumber, gender, round, sortcode, internalevent) VALUES (3, 2, 1, 3, 1, 1, 1, 'F')`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (1, 1, 'Open', 18, NULL, 1, 1)`)
  db.exec(`INSERT INTO agegroup (agegroupid, swimeventid, name, agemin, agemax, gender, sortcode) VALUES (2, 1, 'Junior', 12, 17, 1, 2)`)
  db.exec(`INSERT INTO club (clubid, code, name, nation) VALUES (1, 'TST', 'Test Club', 'CAN')`)
  db.exec(`INSERT INTO athlete (athleteid, clubid, firstname, lastname, gender, birthdate, nation) VALUES (1, 1, 'John', 'Doe', 1, '2000-01-15', 'CAN')`)
}
