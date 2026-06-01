import Database from 'better-sqlite3'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { unlinkSync } from 'fs'

/**
 * Create a temporary SQLite database with the meet schema initialized.
 * Returns the db instance and a cleanup function.
 *
 * Schema matches the full SCHEMA_DDL from src/main/db.ts so that SMB
 * save/restore (which queries all columns) works correctly in tests.
 */
export function createTestDb(): { db: Database.Database; cleanup: () => void; path: string } {
  const dbPath = join(tmpdir(), `sauvetagemeet-test-${randomBytes(4).toString('hex')}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Full schema — must include every column referenced by SMB_TABLES in smb.ts
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS bsglobal (name TEXT NOT NULL DEFAULT '' PRIMARY KEY, data TEXT)`,
    `CREATE TABLE IF NOT EXISTS swimstyle (
      swimstyleid INTEGER PRIMARY KEY,
      code TEXT, distance INTEGER, name TEXT, relaycount INTEGER,
      stroke INTEGER, sortcode INTEGER, technique INTEGER, uniqueid INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS club (
      clubid INTEGER PRIMARY KEY,
      bonuspoints INTEGER, clubtype INTEGER, code TEXT, contactname TEXT,
      contactinternet TEXT, contactcity TEXT, contactcountry TEXT, contactemail TEXT,
      contactfax TEXT, contactphone TEXT, contactstate TEXT, contactstreet TEXT,
      contactstreet2 TEXT, contactzip TEXT, externalid TEXT, longcode TEXT,
      entryclubid INTEGER, entryemails TEXT, name TEXT, nameen TEXT, nation TEXT,
      region TEXT, shortname TEXT, shortnameen TEXT, swrid INTEGER, teamnumber INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS swimsession (
      swimsessionid INTEGER PRIMARY KEY,
      course INTEGER, daytime TEXT, endtime TEXT, feeathlete REAL,
      following TEXT DEFAULT 'F', lanemin INTEGER, lanemax INTEGER,
      lanesbyplace TEXT, maxentriesathlete INTEGER, maxentriesrelay INTEGER,
      name TEXT, officialmeeting TEXT, poolglobal TEXT DEFAULT 'F',
      pooltype INTEGER, remarks TEXT, remarksjury TEXT,
      roundtotenths TEXT DEFAULT 'F', sessionnumber INTEGER, startdate TEXT,
      timing INTEGER, tlmeeting TEXT, touchpadmode INTEGER,
      warmupfrom TEXT, warmupuntil TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS athlete (
      athleteid INTEGER PRIMARY KEY,
      clubid INTEGER REFERENCES club(clubid),
      firstname TEXT, firstname_upper TEXT, gender INTEGER, lastname TEXT,
      lastname_upper TEXT, nameprefix TEXT, birthdate TEXT, domicile TEXT,
      externalid TEXT, firstnameen TEXT, handicapex TEXT, handicaps INTEGER,
      handicapsb INTEGER, handicapsm INTEGER, lastnameen TEXT, license TEXT,
      nation TEXT, sdmsid INTEGER, status INTEGER, swimlevel TEXT,
      swrid INTEGER, swrhashkey INTEGER, clubcode2 TEXT, coachname TEXT,
      schoolyear TEXT, middlename TEXT, middlenameen TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS swimevent (
      swimeventid INTEGER PRIMARY KEY,
      comment TEXT, daytime TEXT, duration TEXT, entrytimeconversion INTEGER,
      entrytimepercent INTEGER, eventnumber INTEGER, externalid TEXT,
      fee REAL, finalorder INTEGER, gender INTEGER, lanemax INTEGER,
      lytentrylist INTEGER, lytstartlist INTEGER, lytresult2column INTEGER,
      lytresult2split INTEGER, lytresult4split INTEGER, lytresultnosplit INTEGER,
      lytresulthtml INTEGER, masters TEXT DEFAULT 'F', maxentries INTEGER,
      pfineignore TEXT DEFAULT 'F', preveventid INTEGER, qualbyplace INTEGER,
      round INTEGER, seedbonuslast TEXT DEFAULT 'F', seedexhlast TEXT DEFAULT 'F',
      seedlateentrylast TEXT DEFAULT 'F', seedingglobal TEXT DEFAULT 'F',
      singleheats INTEGER, sortcode INTEGER, splashmecanedit TEXT DEFAULT 'F',
      sponsor TEXT, swimsessionid INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE,
      swimstyleid INTEGER REFERENCES swimstyle(swimstyleid),
      twoperlane TEXT DEFAULT 'F', roundname TEXT,
      combineagegroups TEXT DEFAULT 'F', roundone TEXT, internalevent TEXT DEFAULT 'F'
    )`,
    `CREATE TABLE IF NOT EXISTS agegroup (
      agegroupid INTEGER PRIMARY KEY,
      agebytotal TEXT DEFAULT 'F', agemax INTEGER, agemax2 INTEGER,
      agemin INTEGER, agemin2 INTEGER, allofficial TEXT DEFAULT 'F',
      athletestatuses INTEGER, clubids TEXT, code TEXT, externalid TEXT,
      fastheatcount INTEGER, forceprelim TEXT DEFAULT 'F', gender INTEGER,
      handicaps TEXT, heatcount INTEGER, heatqualipriority TEXT,
      levelmax TEXT, levelmin TEXT, name TEXT, nationality TEXT,
      nationregions TEXT, resultcount INTEGER, scoretype INTEGER,
      seedwithtsonly TEXT DEFAULT 'F', sortcode INTEGER,
      swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
      swimlevels TEXT, useformedals TEXT DEFAULT 'F',
      useforscoring TEXT DEFAULT 'F', winnertitle TEXT,
      foreigncount INTEGER, finalseedtype INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS heat (
      heatid INTEGER PRIMARY KEY,
      agegroupid INTEGER, agegrouporder INTEGER, daytime TEXT,
      finalcode TEXT, heatnumber INTEGER, racestatus INTEGER,
      remarks TEXT, sortcode INTEGER,
      swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
      name TEXT, seedeventid INTEGER, code TEXT,
      reservecount INTEGER, foreigncount INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS swimresult (
      swimresultid INTEGER PRIMARY KEY,
      athleteid INTEGER REFERENCES athlete(athleteid),
      swrabestid INTEGER, swrabesttime INTEGER, swrsbestid INTEGER, swrsbesttime INTEGER,
      agegroupid INTEGER, backuptime1 INTEGER, backuptime2 INTEGER, backuptime3 INTEGER,
      bonusentry TEXT DEFAULT 'F', comment TEXT, dsqitemid INTEGER,
      dsqdaytime TEXT, dsqnotified TEXT DEFAULT 'F', dsqnumber INTEGER,
      entrycourse INTEGER, entrytime INTEGER, finalfix TEXT DEFAULT 'F',
      finishjudge INTEGER, heatid INTEGER,
      infocode TEXT, lane INTEGER, lateentry TEXT DEFAULT 'F',
      mpoints INTEGER, padtime INTEGER, qtcity TEXT, qtcourse INTEGER,
      qtdate TEXT, qtname TEXT, qtnation TEXT, qttime INTEGER,
      qualcode TEXT, reactiontime INTEGER, resultstatus INTEGER,
      swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
      swimtime INTEGER, usetimetype INTEGER DEFAULT 0,
      dsqofficialid INTEGER, reservecode TEXT, noadvance TEXT DEFAULT 'F',
      officialsplits TEXT, qttiming INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS split (
      swimresultid INTEGER NOT NULL REFERENCES swimresult(swimresultid) ON DELETE CASCADE,
      distance INTEGER NOT NULL,
      swimtime INTEGER,
      PRIMARY KEY (swimresultid, distance)
    )`,
    `CREATE TABLE IF NOT EXISTS dsqitem (
      dsqitemid INTEGER PRIMARY KEY,
      code TEXT,
      lenexcode TEXT,
      name TEXT,
      name_en TEXT,
      options TEXT,
      sortcode INTEGER
    )`,
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
