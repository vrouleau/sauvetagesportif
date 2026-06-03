/**
 * Schema DDL — extracted to avoid circular dependency between db.ts and connectionManager.ts.
 *
 * This file has NO imports from db.ts or connectionManager.ts.
 */

import type { DbBackend } from './dbBackend'

export const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS bsglobal (
    name TEXT NOT NULL DEFAULT '' PRIMARY KEY,
    data TEXT
  )`,
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
    comment TEXT, daytime TEXT, duration TEXT,
    entrytimeconversion INTEGER, entrytimepercent INTEGER,
    eventnumber INTEGER, externalid TEXT, fee REAL, finalorder INTEGER,
    gender INTEGER, lanemax INTEGER,
    lytentrylist INTEGER, lytstartlist INTEGER,
    lytresult2column INTEGER, lytresult2split INTEGER,
    lytresult4split INTEGER, lytresultnosplit INTEGER, lytresulthtml INTEGER,
    masters TEXT DEFAULT 'F', maxentries INTEGER,
    pfineignore TEXT DEFAULT 'F', preveventid INTEGER,
    qualbyplace INTEGER, round INTEGER,
    seedbonuslast TEXT DEFAULT 'F', seedexhlast TEXT DEFAULT 'F',
    seedlateentrylast TEXT DEFAULT 'F', seedingglobal TEXT DEFAULT 'F',
    singleheats INTEGER, sortcode INTEGER,
    splashmecanedit TEXT DEFAULT 'F', sponsor TEXT,
    swimsessionid INTEGER REFERENCES swimsession(swimsessionid),
    swimstyleid INTEGER REFERENCES swimstyle(swimstyleid),
    twoperlane TEXT DEFAULT 'F',
    roundname TEXT, combineagegroups TEXT DEFAULT 'F',
    roundone TEXT, internalevent TEXT DEFAULT 'F'
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
    mpoints INTEGER, padtime INTEGER,
    qtcity TEXT, qtcourse INTEGER, qtdate TEXT, qtname TEXT,
    qtnation TEXT, qttime INTEGER, qualcode TEXT,
    reactiontime INTEGER, resultstatus INTEGER,
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
  `CREATE TABLE IF NOT EXISTS relay (
    relayid INTEGER PRIMARY KEY,
    clubid INTEGER REFERENCES club(clubid),
    swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
    agegroupid INTEGER,
    heatid INTEGER,
    lane INTEGER,
    name TEXT,
    gender INTEGER,
    athletes INTEGER,
    relaycode INTEGER,
    teamnumber INTEGER,
    agemin INTEGER,
    agemax INTEGER,
    agetotal INTEGER,
    entrytime INTEGER,
    entrycourse INTEGER,
    swimtime INTEGER,
    reactiontime INTEGER,
    resultstatus INTEGER,
    dsqitemid INTEGER,
    dsqdaytime TEXT,
    dsqnotified TEXT DEFAULT 'F',
    dsqnumber INTEGER,
    dsqofficialid INTEGER,
    padtime INTEGER,
    backuptime1 INTEGER,
    backuptime2 INTEGER,
    backuptime3 INTEGER,
    usetimetype INTEGER,
    qualcode TEXT,
    infocode TEXT,
    reservecode TEXT,
    comment TEXT,
    mpoints INTEGER,
    finalfix TEXT DEFAULT 'F',
    lateentry TEXT DEFAULT 'F',
    bonusentry TEXT DEFAULT 'F',
    noadvance TEXT DEFAULT 'F',
    finishjudge INTEGER,
    officialsplits TEXT,
    qttiming INTEGER,
    qttime INTEGER,
    qtdate TEXT,
    qtcity TEXT,
    qtname TEXT,
    qtnation TEXT,
    qtcourse INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS relayposition (
    relayid INTEGER REFERENCES relay(relayid) ON DELETE CASCADE,
    relaynumber INTEGER,
    athleteid INTEGER REFERENCES athlete(athleteid),
    reactiontime INTEGER,
    resultstatus INTEGER,
    qttiming INTEGER,
    qttime INTEGER,
    qtdate TEXT,
    qtcity TEXT,
    qtname TEXT,
    qtnation TEXT,
    qtcourse INTEGER,
    qtislap TEXT DEFAULT 'F'
  )`,
  `CREATE TABLE IF NOT EXISTS relaysplit (
    relayid INTEGER NOT NULL REFERENCES relay(relayid) ON DELETE CASCADE,
    distance INTEGER NOT NULL,
    swimtime INTEGER,
    PRIMARY KEY (relayid, distance)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_relay_club ON relay (clubid)`,
  `CREATE INDEX IF NOT EXISTS ix_relay_swimevent ON relay (swimeventid)`,
  `CREATE INDEX IF NOT EXISTS ix_relayposition_athlete ON relayposition (athleteid)`,
  `CREATE INDEX IF NOT EXISTS ix_relayposition_relay ON relayposition (relayid)`,
]

/** Run schema DDL on a backend (SQLite or PG). */
export function runSchemaInit(backend: DbBackend): void {
  for (const ddl of SCHEMA_DDL) {
    backend.exec(ddl)
  }
}
