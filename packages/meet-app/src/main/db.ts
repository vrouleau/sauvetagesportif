import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import pkg from 'pg'
const { Pool } = pkg
import { regenerateCombinedEvents } from './combinedEvents'

// ── Local SQLite database (self-contained, like the .mdb) ─────────────────────

let localDb: Database.Database | null = null

function getLocalDbPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'meet.db')
}

export function getLocalDb(): Database.Database {
  if (!localDb) {
    localDb = new Database(getLocalDbPath())
    localDb.pragma('journal_mode = WAL')
    localDb.pragma('foreign_keys = ON')
    initLocalSchema()
  }
  return localDb
}

export function closeLocalDb(): void {
  localDb?.close()
  localDb = null
}

// ── Remote PG connection (for sync to venue server) ───────────────────────────

export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

const DEFAULT_CONFIG: DbConfig = {
  host: '192.168.1.190',
  port: 5432,
  user: 'meetmgr',
  password: 'meetmgr',
  database: 'meet',
}

let pool: InstanceType<typeof Pool> | null = null
let currentConfig = { ...DEFAULT_CONFIG }

export function configureDb(cfg: DbConfig): void {
  currentConfig = cfg
  pool?.end().catch(() => {})
  pool = new Pool({ ...cfg, max: 5, idleTimeoutMillis: 30000 })
}

function remoteDb(): InstanceType<typeof Pool> {
  if (!pool) pool = new Pool({ ...currentConfig, max: 5, idleTimeoutMillis: 30000 })
  return pool
}

export function getDbConfig(): DbConfig { return { ...currentConfig } }

export function getPool(): InstanceType<typeof Pool> { return remoteDb() }

// ── Time helpers ──────────────────────────────────────────────────────────────
// DB stores times as integer milliseconds.  Display format: "M:SS.cc" or "SS.cc"

export function msToDisplay(ms: number | null | undefined): string | undefined {
  if (ms == null) return undefined
  const totalCs = Math.round(ms / 10)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
  return `${sec}.${String(cs).padStart(2, '0')}`
}

export function displayToMs(t: string | undefined): number | null {
  if (!t || t === 'NT') return null
  const parts = t.split(':')
  let secs: number
  if (parts.length === 3) secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
  else if (parts.length === 2) secs = parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  else secs = parseFloat(parts[0])
  return isNaN(secs) ? null : Math.round(secs * 1000)
}

// ── Decode helpers ─────────────────────────────────────────────────────────────

function decodeGender(g: number | null): 'M' | 'F' | 'X' {
  if (g === 1) return 'M'
  if (g === 2) return 'F'
  return 'X'
}

function decodeHeatStatus(s: number | null): 'empty' | 'assigned' | 'completed' | 'validated' {
  if (s != null && s >= 8) return 'completed'
  if (s != null && s === 5) return 'validated'
  if (s != null && s >= 4) return 'assigned'
  return 'empty'
}

function decodePhase(round: number | null): 'Finale' | 'Eliminatoire' | 'Finale directe' {
  if (round === 1) return 'Eliminatoire'
  if (round === 4) return 'Finale'
  return 'Finale directe'
}

function decodeResultStatus(s: number | null): 'DNS' | 'DNF' | 'DSQ' | null {
  if (s === 1) return 'DNS'
  if (s === 2) return 'DNF'
  if (s === 3) return 'DSQ'
  return null
}

function encodeResultStatus(s: 'DNS' | 'DNF' | 'DSQ' | null | undefined): number | null {
  if (s === 'DNS') return 1
  if (s === 'DNF') return 2
  if (s === 'DSQ') return 3
  return null
}

function formatDaytime(d: string | number | null): string | undefined {
  if (d == null) return undefined
  // If it's a number (OLE Automation date from SMB import), convert fractional part to time
  if (typeof d === 'number') {
    const frac = Math.abs(d) % 1
    if (frac === 0) return undefined
    const totalMinutes = Math.round(frac * 24 * 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}:${String(minutes).padStart(2, '0')}`
  }
  const str = String(d)
  // SQLite stores as text "2000-01-01 HH:MM:00" or ISO string
  const match = str.match(/(\d{2}):(\d{2})/)
  if (match) return `${parseInt(match[1])}:${match[2]}`
  // Could be a stringified OLE double (e.g. "-36522.3125")
  const num = parseFloat(str)
  if (!isNaN(num)) {
    const frac = Math.abs(num) % 1
    if (frac === 0) return undefined
    const totalMinutes = Math.round(frac * 24 * 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}:${String(minutes).padStart(2, '0')}`
  }
  return undefined
}

const STROKE_EN: Record<number, string> = {
  1: 'Freestyle', 2: 'Backstroke', 3: 'Breaststroke',
  4: 'Butterfly', 5: 'Individual Medley', 6: 'Freestyle Relay', 7: 'Medley Relay',
}

function eventName(styleName: string | null, stroke: number | null): string {
  if (styleName) return styleName
  return (stroke && STROKE_EN[stroke]) ? STROKE_EN[stroke] : ''
}

// ── Shared frontend-compatible return types ────────────────────────────────────

export interface LaneEntryRow {
  swimresultId: number
  lane: number
  athleteId: number
  lastName: string
  firstName: string
  birthYear: number
  nation: string
  clubCode: string
  clubName: string
  category: string
  entryTime: string
  finalTime?: string
  splitTimes?: Record<number, string>
  status?: 'DNS' | 'DNF' | 'DSQ' | null
}

export interface HeatRow {
  id: number
  eventId: number
  number: number
  status: 'empty' | 'assigned' | 'completed' | 'validated'
  entries: LaneEntryRow[]
}

export interface HeatListEventRow {
  id: number
  number: number
  nameFr: string
  nameEn: string
  gender: 'M' | 'F' | 'X'
  distance: number
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe'
  isAdmin?: boolean
  scheduledTime?: string
  heats: HeatRow[]
}

export interface HeatListSessionRow {
  id: number
  number: number
  name: string
  time?: string
  laneMin: number
  laneMax: number
  events: HeatListEventRow[]
}

export interface AgeGroupRow {
  id: number
  number: number
  name: string
  minAge: number
  maxAge: number | null
  gender: string
  numHeats: number
  ranking: string
  countForMedalStats: boolean
  usedForCombined: boolean
  alwaysSwimPrelims: boolean
  advanceByTime: boolean
  laneOrderInFinals: string
  finalSeedType: number | null
}

export interface CompetitionEventRow {
  id: number
  sessionId: number
  number: number
  nameFr: string
  nameEn: string
  gender: 'M' | 'F' | 'X'
  distance: number
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe'
  isAdmin?: boolean
  scheduledTime?: string
  duration?: string
  swimstyleId?: number | null
  ageGroups: AgeGroupRow[]
}

export interface SessionRow {
  id: number
  number: number
  name: string
  date?: string
  time?: string
  endTime?: string
  poolSize: number
  laneMin?: number
  laneMax?: number
  warmupFrom?: string
  warmupUntil?: string
  officialMeeting?: string
  remarks?: string
  remarksJury?: string
  maxEntriesAthlete?: number
  maxEntriesRelay?: number
  feeAthlete?: number
  timing?: number
  touchpadMode?: number
  roundToTenths?: boolean
  events: CompetitionEventRow[]
}

export interface AthleteRow {
  id: number
  lastName: string
  firstName: string
  birthDate: string
  gender: 'M' | 'F'
  nation: string
  clubCode: string
  clubName: string
  licence?: string
  birthPlace?: string
  entries: Array<{ eventId: number; eventName: string; category: string; entryTime?: string }>
}

// ── Query: all sessions + events + heats + entries for HeatsPage ──────────────

export async function getHeatListEvents(): Promise<HeatListEventRow[]> {
  const sessions = await getHeatListSessions()
  return sessions.flatMap(s => s.events)
}

export async function getHeatListSessions(): Promise<HeatListSessionRow[]> {
  const db = getLocalDb()

  const sessions = db.prepare(
    `SELECT swimsessionid, sessionnumber, name, daytime, lanemin, lanemax FROM swimsession ORDER BY sessionnumber`
  ).all() as Array<{ swimsessionid: number; sessionnumber: number | null; name: string | null; daytime: string | number | null; lanemin: number | null; lanemax: number | null }>

  if (sessions.length === 0) return []
  const sessionIds = sessions.map(r => r.swimsessionid)
  const ph = sessionIds.map(() => '?').join(',')

  const events = db.prepare(`
    SELECT e.swimeventid, e.swimsessionid, e.eventnumber, e.gender, e.round, e.sortcode, e.daytime, e.internalevent,
           e.roundname, e.comment, e.swimstyleid,
           ss.distance, ss.stroke, ss.name AS stylename
    FROM swimevent e
    LEFT JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE e.swimsessionid IN (${ph})
    ORDER BY e.swimsessionid, e.sortcode, e.swimeventid
  `).all(...sessionIds) as Array<{
    swimeventid: number; swimsessionid: number; eventnumber: number | null; gender: number | null
    round: number | null; sortcode: number | null; daytime: string | number | null
    internalevent: string | null; distance: number | null; stroke: number | null
    stylename: string | null; roundname: string | null; comment: string | null; swimstyleid: number | null
  }>

  if (events.length === 0) return sessions.map(s => ({
    id: s.swimsessionid, number: s.sessionnumber ?? 0, name: s.name ?? '',
    time: formatDaytime(s.daytime), laneMin: s.lanemin ?? 1, laneMax: s.lanemax ?? 8, events: [],
  }))

  const eventIds = events.map(r => r.swimeventid)
  const eph = eventIds.map(() => '?').join(',')

  const heats = db.prepare(`
    SELECT heatid, heatnumber, name, racestatus, sortcode, swimeventid
    FROM heat WHERE swimeventid IN (${eph})
    ORDER BY swimeventid, sortcode, heatnumber
  `).all(...eventIds) as Array<{
    heatid: number; heatnumber: number | null; name: string | null
    racestatus: number | null; sortcode: number | null; swimeventid: number
  }>

  const allHeatIds = heats.map(r => r.heatid)

  let entries: Array<{
    swimresultid: number; heatid: number; lane: number | null
    entrytime: number | null; swimtime: number | null
    reactiontime: number | null; resultstatus: number | null; agegroupid: number | null
    athleteid: number; firstname: string | null; lastname: string | null
    birthdate: string | null; nation: string | null
    clubcode: string | null; clubname: string | null; agegroupname: string | null
  }> = []

  if (allHeatIds.length > 0) {
    const hph = allHeatIds.map(() => '?').join(',')
    entries = db.prepare(`
      SELECT r.swimresultid, r.heatid, r.lane,
             r.entrytime, r.swimtime, r.reactiontime, r.resultstatus, r.agegroupid,
             a.athleteid, a.firstname, a.lastname, a.birthdate, a.nation,
             c.code AS clubcode, c.name AS clubname,
             ag.name AS agegroupname
      FROM swimresult r
      JOIN athlete a ON r.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
      WHERE r.heatid IN (${hph}) AND r.lane IS NOT NULL
      ORDER BY r.heatid, r.lane
    `).all(...allHeatIds) as typeof entries
  }

  const resultIds = entries.map(r => r.swimresultid)
  let splits: Array<{ swimresultid: number; distance: number; swimtime: number | null }> = []
  if (resultIds.length > 0) {
    const rph = resultIds.map(() => '?').join(',')
    splits = db.prepare(
      `SELECT swimresultid, distance, swimtime FROM split WHERE swimresultid IN (${rph})`
    ).all(...resultIds) as typeof splits
  }

  // Build split map
  const splitMap = new Map<number, Record<number, string>>()
  for (const s of splits) {
    if (!splitMap.has(s.swimresultid)) splitMap.set(s.swimresultid, {})
    const t = msToDisplay(s.swimtime)
    if (t) splitMap.get(s.swimresultid)![s.distance] = t
  }

  // Build entry map keyed by heatId
  const entryMap = new Map<number, LaneEntryRow[]>()
  for (const r of entries) {
    if (!entryMap.has(r.heatid)) entryMap.set(r.heatid, [])
    const status = decodeResultStatus(r.resultstatus)
    const birthYear = r.birthdate ? parseInt(r.birthdate.slice(0, 4), 10) || 2000 : 2000
    entryMap.get(r.heatid)!.push({
      swimresultId: r.swimresultid,
      lane: r.lane ?? 0,
      athleteId: r.athleteid,
      lastName: r.lastname ?? '',
      firstName: r.firstname ?? '',
      birthYear,
      nation: r.nation ?? '',
      clubCode: r.clubcode ?? '',
      clubName: r.clubname ?? '',
      category: r.agegroupname ?? '',
      entryTime: msToDisplay(r.entrytime) ?? 'NT',
      finalTime: status ? undefined : msToDisplay(r.swimtime),
      splitTimes: splitMap.get(r.swimresultid),
      status,
    })
  }

  // Build heat map keyed by eventId
  const heatMap = new Map<number, HeatRow[]>()
  for (const h of heats) {
    if (!heatMap.has(h.swimeventid)) heatMap.set(h.swimeventid, [])
    heatMap.get(h.swimeventid)!.push({
      id: h.heatid,
      eventId: h.swimeventid,
      number: h.heatnumber ?? 0,
      status: decodeHeatStatus(h.racestatus),
      entries: entryMap.get(h.heatid) ?? [],
    })
  }

  // Build event map keyed by sessionId
  const evMap = new Map<number, HeatListEventRow[]>()
  for (const e of events) {
    if (!evMap.has(e.swimsessionid)) evMap.set(e.swimsessionid, [])
    const isAdm = e.internalevent === 'T' || e.swimstyleid == null
    const name = isAdm ? (e.comment || 'Pause') : eventName(e.stylename, e.stroke)
    evMap.get(e.swimsessionid)!.push({
      id: e.swimeventid,
      number: e.eventnumber ?? 0,
      nameFr: name,
      nameEn: name,
      gender: decodeGender(e.gender),
      distance: e.distance ?? 0,
      phase: decodePhase(e.round),
      isAdmin: isAdm,
      scheduledTime: formatDaytime(e.daytime),
      heats: heatMap.get(e.swimeventid) ?? [],
    })
  }

  return sessions.map(s => ({
    id: s.swimsessionid,
    number: s.sessionnumber ?? 0,
    name: s.name ?? '',
    time: formatDaytime(s.daytime),
    laneMin: s.lanemin ?? 1,
    laneMax: s.lanemax ?? 8,
    events: evMap.get(s.swimsessionid) ?? [],
  }))
}

// ── Query: sessions + events + age groups for EventsPage ─────────────────────

export async function getSessions(): Promise<SessionRow[]> {
  const db = getLocalDb()

  const sessions = db.prepare(`
    SELECT swimsessionid, sessionnumber, name, daytime, endtime, course,
           lanemin, lanemax, warmupfrom, warmupuntil, officialmeeting,
           remarks, remarksjury, maxentriesathlete, maxentriesrelay,
           feeathlete, timing, touchpadmode, roundtotenths
    FROM swimsession ORDER BY sessionnumber
  `).all() as Array<{
    swimsessionid: number; sessionnumber: number | null; name: string | null
    daytime: string | number | null; endtime: string | number | null; course: number | null
    lanemin: number | null; lanemax: number | null
    warmupfrom: string | number | null; warmupuntil: string | number | null
    officialmeeting: string | number | null
    remarks: string | null; remarksjury: string | null
    maxentriesathlete: number | null; maxentriesrelay: number | null
    feeathlete: number | null; timing: number | null; touchpadmode: number | null
    roundtotenths: string | null
  }>

  if (sessions.length === 0) return []
  const sessionIds = sessions.map(r => r.swimsessionid)
  const ph = sessionIds.map(() => '?').join(',')

  const events = db.prepare(`
    SELECT e.swimeventid, e.swimsessionid, e.eventnumber, e.gender, e.round,
           e.internalevent, e.daytime, e.duration, e.roundname AS eventname, e.comment, e.swimstyleid,
           ss.distance, ss.stroke, ss.name AS stylename
    FROM swimevent e
    LEFT JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE e.swimsessionid IN (${ph})
    ORDER BY e.swimsessionid, e.sortcode
  `).all(...sessionIds) as Array<{
    swimeventid: number; swimsessionid: number; eventnumber: number | null
    gender: number | null; round: number | null; distance: number | null
    stroke: number | null; stylename: string | null; swimstyleid: number | null
    internalevent: string | null; daytime: string | number | null; duration: string | number | null
    eventname: string | null; comment: string | null
  }>

  const eventIds = events.map(r => r.swimeventid)
  let ageGroups: Array<{
    agegroupid: number; swimeventid: number; name: string | null
    agemin: number | null; agemax: number | null; gender: number | null
    heatcount: number | null; useformedals: string | null; sortcode: number | null
    finalseedtype: number | null
  }> = []
  if (eventIds.length > 0) {
    const eph = eventIds.map(() => '?').join(',')
    ageGroups = db.prepare(`
      SELECT agegroupid, swimeventid, name, agemin, agemax, gender, heatcount, useformedals, sortcode, finalseedtype
      FROM agegroup WHERE swimeventid IN (${eph})
      ORDER BY swimeventid, sortcode
    `).all(...eventIds) as typeof ageGroups
  }

  const agMap = new Map<number, AgeGroupRow[]>()
  let agSeq = 0
  for (const ag of ageGroups) {
    if (!agMap.has(ag.swimeventid)) { agMap.set(ag.swimeventid, []); agSeq = 0 }
    agSeq++
    agMap.get(ag.swimeventid)!.push({
      id: ag.agegroupid, number: agSeq, name: ag.name ?? '',
      minAge: ag.agemin ?? 0, maxAge: ag.agemax ?? null,
      gender: decodeGender(ag.gender),
      numHeats: ag.heatcount ?? 1, ranking: 'Selon temps nagé',
      countForMedalStats: ag.useformedals === 'T', usedForCombined: false,
      alwaysSwimPrelims: true, advanceByTime: false, laneOrderInFinals: 'Selon temps nagé',
      finalSeedType: ag.finalseedtype ?? null,
    })
  }

  const evMap = new Map<number, CompetitionEventRow[]>()
  for (const e of events) {
    if (!evMap.has(e.swimsessionid)) evMap.set(e.swimsessionid, [])
    const isAdm = e.internalevent === 'T' || e.swimstyleid == null
    const name = isAdm ? (e.comment || 'Pause') : eventName(e.stylename, e.stroke)
    evMap.get(e.swimsessionid)!.push({
      id: e.swimeventid, sessionId: e.swimsessionid, number: e.eventnumber ?? 0,
      nameFr: name, nameEn: name,
      gender: decodeGender(e.gender), distance: e.distance ?? 0,
      phase: decodePhase(e.round),
      isAdmin: isAdm,
      scheduledTime: formatDaytime(e.daytime),
      duration: formatDaytime(e.duration),
      swimstyleId: e.swimstyleid ?? null,
      ageGroups: agMap.get(e.swimeventid) ?? [],
    })
  }

  return sessions.map(s => ({
    id: s.swimsessionid, number: s.sessionnumber ?? 0, name: s.name ?? '',
    date: s.daytime ? s.daytime.slice(0, 10) : undefined,
    time: formatDaytime(s.daytime),
    endTime: formatDaytime(s.endtime),
    poolSize: s.course === 3 ? 25 : s.course === 2 ? 25 : 50,
    laneMin: s.lanemin ?? undefined,
    laneMax: s.lanemax ?? undefined,
    warmupFrom: formatDaytime(s.warmupfrom),
    warmupUntil: formatDaytime(s.warmupuntil),
    officialMeeting: formatDaytime(s.officialmeeting),
    remarks: s.remarks ?? undefined,
    remarksJury: s.remarksjury ?? undefined,
    maxEntriesAthlete: s.maxentriesathlete ?? undefined,
    maxEntriesRelay: s.maxentriesrelay ?? undefined,
    feeAthlete: s.feeathlete ?? undefined,
    timing: s.timing ?? undefined,
    touchpadMode: s.touchpadmode ?? undefined,
    roundToTenths: s.roundtotenths === 'T',
    events: evMap.get(s.swimsessionid) ?? [],
  }))
}

// ── Query: athletes for AthletesPage ──────────────────────────────────────────

export async function getAthletes(): Promise<AthleteRow[]> {
  const db = getLocalDb()

  const athletes = db.prepare(`
    SELECT a.athleteid, a.firstname, a.lastname, a.birthdate, a.gender, a.nation, a.license, a.domicile,
           c.code AS clubcode, c.name AS clubname
    FROM athlete a
    LEFT JOIN club c ON a.clubid = c.clubid
    ORDER BY a.lastname, a.firstname
  `).all() as Array<{
    athleteid: number; firstname: string | null; lastname: string | null
    birthdate: string | null; gender: number | null; nation: string | null
    license: string | null; domicile: string | null
    clubcode: string | null; clubname: string | null
  }>

  if (athletes.length === 0) return []
  const athleteIds = athletes.map(r => r.athleteid)
  const aph = athleteIds.map(() => '?').join(',')

  const entries = db.prepare(`
    SELECT r.athleteid, r.swimeventid, r.entrytime,
           ag.name AS agegroupname, e.eventnumber,
           ss.distance, ss.stroke, ss.name AS stylename
    FROM swimresult r
    JOIN swimevent e ON r.swimeventid = e.swimeventid
    LEFT JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
    WHERE r.athleteid IN (${aph})
    ORDER BY r.athleteid, e.eventnumber
  `).all(...athleteIds) as Array<{
    athleteid: number; swimeventid: number; entrytime: number | null
    agegroupname: string | null; eventnumber: number | null
    distance: number | null; stroke: number | null; stylename: string | null
  }>

  const entMap = new Map<number, AthleteRow['entries']>()
  for (const e of entries) {
    if (!entMap.has(e.athleteid)) entMap.set(e.athleteid, [])
    entMap.get(e.athleteid)!.push({
      eventId: e.swimeventid,
      eventName: `${e.distance ?? '?'}m ${eventName(e.stylename, e.stroke)}`.trim(),
      category: e.agegroupname ?? '',
      entryTime: msToDisplay(e.entrytime),
    })
  }

  return athletes.map(a => ({
    id: a.athleteid,
    lastName: a.lastname ?? '',
    firstName: a.firstname ?? '',
    birthDate: a.birthdate ? a.birthdate.slice(0, 10) : '2000-01-01',
    gender: (a.gender === 2 ? 'F' : 'M') as 'M' | 'F',
    nation: a.nation ?? '',
    clubCode: a.clubcode ?? '',
    clubName: a.clubname ?? '',
    licence: a.license ?? undefined,
    birthPlace: a.domicile ?? undefined,
    entries: entMap.get(a.athleteid) ?? [],
  }))
}

// ── Write: save result ────────────────────────────────────────────────────────

/** Check that the heat containing a swimresult is not validated; throws if it is */
function assertHeatNotValidated(db: ReturnType<typeof getLocalDb>, swimresultId: number): void {
  const row = db.prepare(
    `SELECT h.racestatus FROM swimresult r JOIN heat h ON r.heatid = h.heatid WHERE r.swimresultid=?`
  ).get(swimresultId) as { racestatus: number | null } | undefined
  if (row && row.racestatus === 5) {
    throw new Error('Heat is validated — modifications are not allowed.')
  }
}

/** Check that a specific heat is not validated */
function assertHeatIdNotValidated(db: ReturnType<typeof getLocalDb>, heatId: number): void {
  const row = db.prepare(`SELECT racestatus FROM heat WHERE heatid=?`).get(heatId) as { racestatus: number | null } | undefined
  if (row && row.racestatus === 5) {
    throw new Error('Heat is validated — modifications are not allowed.')
  }
}

export async function saveResult(
  swimresultId: number,
  finalTime: string | undefined,
  reactionTimeSecs: number | null,
  status: 'DNS' | 'DNF' | 'DSQ' | null,
  splits: Record<number, string> | undefined,
): Promise<void> {
  const db = getLocalDb()
  assertHeatNotValidated(db, swimresultId)
  const swimtime = finalTime ? displayToMs(finalTime) : null
  const resultstatus = encodeResultStatus(status)
  const reactiontime = reactionTimeSecs != null ? Math.round(reactionTimeSecs * 1000) : null

  db.prepare(
    `UPDATE swimresult SET swimtime=?, reactiontime=?, resultstatus=?, usetimetype=0 WHERE swimresultid=?`
  ).run(swimtime, reactiontime, resultstatus, swimresultId)

  db.prepare(`DELETE FROM split WHERE swimresultid=?`).run(swimresultId)
  if (splits) {
    const ins = db.prepare(`INSERT INTO split (swimresultid, distance, swimtime) VALUES (?, ?, ?)`)
    for (const [dist, t] of Object.entries(splits)) {
      const ms = displayToMs(t)
      if (ms != null) ins.run(swimresultId, Number(dist), ms)
    }
  }
}

// ── Write: heat lane management ───────────────────────────────────────────────

/** Get athletes available for late entry in a specific event (not already seeded in any heat) */
export async function getAvailableAthletesForEvent(eventId: number): Promise<Array<{
  id: number; lastName: string; firstName: string; clubCode: string; clubName: string; nation: string; entryTime: string | undefined
}>> {
  const db = getLocalDb()
  // Athletes who have an entry for this event but are NOT assigned to a heat,
  // OR athletes who have no entry at all for this event (truly late arrivals)
  const rows = db.prepare(`
    SELECT a.athleteid, a.firstname, a.lastname, a.nation,
           c.code AS clubcode, c.name AS clubname,
           r.entrytime
    FROM athlete a
    LEFT JOIN club c ON a.clubid = c.clubid
    LEFT JOIN swimresult r ON r.athleteid = a.athleteid AND r.swimeventid = ?
    WHERE a.athleteid NOT IN (
      SELECT sr.athleteid FROM swimresult sr
      WHERE sr.swimeventid = ? AND sr.heatid IS NOT NULL
    )
    ORDER BY a.lastname, a.firstname
  `).all(eventId, eventId) as Array<{
    athleteid: number; firstname: string | null; lastname: string | null
    nation: string | null; clubcode: string | null; clubname: string | null
    entrytime: number | null
  }>

  return rows.map(r => ({
    id: r.athleteid,
    lastName: r.lastname ?? '',
    firstName: r.firstname ?? '',
    clubCode: r.clubcode ?? '',
    clubName: r.clubname ?? '',
    nation: r.nation ?? '',
    entryTime: msToDisplay(r.entrytime),
  }))
}

/** Remove an entry from its heat/lane (unseed it, don't delete the entry) */
export async function removeFromHeat(swimresultId: number): Promise<void> {
  const db = getLocalDb()
  assertHeatNotValidated(db, swimresultId)
  db.prepare(`UPDATE swimresult SET heatid=NULL, lane=NULL WHERE swimresultid=?`).run(swimresultId)
}

/** Assign an entry to a specific heat and lane */
export async function assignToHeatLane(swimresultId: number, heatId: number, lane: number): Promise<void> {
  const db = getLocalDb()
  assertHeatIdNotValidated(db, heatId)
  db.prepare(`UPDATE swimresult SET heatid=?, lane=? WHERE swimresultid=?`).run(heatId, lane, swimresultId)
}

/** Swap two entries' lanes (can be in same or different heats) */
export async function swapLanes(
  resultIdA: number, heatIdA: number, laneA: number,
  resultIdB: number, heatIdB: number, laneB: number,
): Promise<void> {
  const db = getLocalDb()
  assertHeatIdNotValidated(db, heatIdA)
  assertHeatIdNotValidated(db, heatIdB)
  const swap = db.transaction(() => {
    db.prepare(`UPDATE swimresult SET heatid=?, lane=? WHERE swimresultid=?`).run(heatIdB, laneB, resultIdA)
    db.prepare(`UPDATE swimresult SET heatid=?, lane=? WHERE swimresultid=?`).run(heatIdA, laneA, resultIdB)
  })
  swap()
}

/** Add a late entry: create a swimresult row and assign to heat/lane */
export async function addLateEntry(
  athleteId: number, eventId: number, heatId: number, lane: number, entryTime: number | null,
): Promise<number> {
  const db = getLocalDb()
  assertHeatIdNotValidated(db, heatId)
  const id = nextId('swimresult', 'swimresultid')
  db.prepare(
    `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, entrytime, lateentry, usetimetype)
     VALUES (?, ?, ?, ?, ?, ?, 'T', 0)`
  ).run(id, athleteId, eventId, heatId, lane, entryTime)
  return id
}

// ── Write: session CRUD ───────────────────────────────────────────────────────

function nextId(table: string, pkCol: string): number {
  const db = getLocalDb()
  const row = db.prepare(`SELECT COALESCE(MAX(${pkCol}), 0) + 1 AS next FROM ${table}`).get() as { next: number }
  return row.next
}

export async function createSession(name: string, sessionNumber: number): Promise<number> {
  const db = getLocalDb()
  const id = nextId('swimsession', 'swimsessionid')
  db.prepare(
    `INSERT INTO swimsession (swimsessionid, sessionnumber, name, course, following, poolglobal, roundtotenths)
     VALUES (?, ?, ?, 1, 'F', 'F', 'F')`
  ).run(id, sessionNumber, name)
  return id
}

export interface SessionUpdate {
  name?: string
  sessionnumber?: number
  daytime?: string | null
  endtime?: string | null
  course?: number
  lanemin?: number | null
  lanemax?: number | null
  warmupfrom?: string | null
  warmupuntil?: string | null
  officialmeeting?: string | null
  remarks?: string | null
  remarksjury?: string | null
  maxentriesathlete?: number | null
  maxentriesrelay?: number | null
  feeathlete?: number | null
  timing?: number | null
  touchpadmode?: number | null
  roundtotenths?: boolean
}

export async function updateSession(sessionId: number, data: SessionUpdate): Promise<void> {
  const db = getLocalDb()
  const sets: string[] = []
  const vals: unknown[] = []

  function timeToTimestamp(t: string | null | undefined): string | null {
    if (!t) return null
    if (t.includes('-') || t.includes('T')) return t
    return `2000-01-01 ${t}:00`
  }

  if (data.name !== undefined) { sets.push('name=?'); vals.push(data.name) }
  if (data.sessionnumber !== undefined) { sets.push('sessionnumber=?'); vals.push(data.sessionnumber) }
  if (data.daytime !== undefined) { sets.push('daytime=?'); vals.push(timeToTimestamp(data.daytime)) }
  if (data.endtime !== undefined) { sets.push('endtime=?'); vals.push(timeToTimestamp(data.endtime)) }
  if (data.course !== undefined) { sets.push('course=?'); vals.push(data.course) }
  if (data.lanemin !== undefined) { sets.push('lanemin=?'); vals.push(data.lanemin) }
  if (data.lanemax !== undefined) { sets.push('lanemax=?'); vals.push(data.lanemax) }
  if (data.warmupfrom !== undefined) { sets.push('warmupfrom=?'); vals.push(timeToTimestamp(data.warmupfrom)) }
  if (data.warmupuntil !== undefined) { sets.push('warmupuntil=?'); vals.push(timeToTimestamp(data.warmupuntil)) }
  if (data.officialmeeting !== undefined) { sets.push('officialmeeting=?'); vals.push(timeToTimestamp(data.officialmeeting)) }
  if (data.remarks !== undefined) { sets.push('remarks=?'); vals.push(data.remarks) }
  if (data.remarksjury !== undefined) { sets.push('remarksjury=?'); vals.push(data.remarksjury) }
  if (data.maxentriesathlete !== undefined) { sets.push('maxentriesathlete=?'); vals.push(data.maxentriesathlete) }
  if (data.maxentriesrelay !== undefined) { sets.push('maxentriesrelay=?'); vals.push(data.maxentriesrelay) }
  if (data.feeathlete !== undefined) { sets.push('feeathlete=?'); vals.push(data.feeathlete) }
  if (data.timing !== undefined) { sets.push('timing=?'); vals.push(data.timing) }
  if (data.touchpadmode !== undefined) { sets.push('touchpadmode=?'); vals.push(data.touchpadmode) }
  if (data.roundtotenths !== undefined) { sets.push('roundtotenths=?'); vals.push(data.roundtotenths ? 'T' : 'F') }

  if (sets.length === 0) return
  vals.push(sessionId)
  db.prepare(`UPDATE swimsession SET ${sets.join(', ')} WHERE swimsessionid=?`).run(...vals)
}

export async function deleteSession(sessionId: number): Promise<void> {
  getLocalDb().prepare(`DELETE FROM swimsession WHERE swimsessionid=?`).run(sessionId)
}

export async function createBreak(
  sessionId: number,
  eventnumber: number,
  name: string,
): Promise<number> {
  const db = getLocalDb()
  const id = nextId('swimevent', 'swimeventid')
  const row = db.prepare(
    `SELECT MAX(sortcode) AS maxsort FROM swimevent WHERE swimsessionid=?`
  ).get(sessionId) as { maxsort: number | null }
  const sortcode = (row.maxsort ?? 0) + 1

  db.prepare(
    `INSERT INTO swimevent
       (swimeventid, swimsessionid, eventnumber, gender, round, sortcode,
        splashmecanedit, masters, pfineignore, seedbonuslast,
        seedexhlast, seedlateentrylast, seedingglobal, twoperlane, combineagegroups, comment)
     VALUES (?, ?, ?, NULL, 11, ?,
             'F','F','F','F','F','F','F','F','F', ?)`
  ).run(id, sessionId, eventnumber, sortcode, name)
  return id
}

export async function createEvent(
  sessionId: number,
  eventnumber: number,
  gender: 'M' | 'F' | 'X',
  distance: number,
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe',
  styleName: string,
): Promise<number> {
  const db = getLocalDb()
  const id = nextId('swimevent', 'swimeventid')
  const gNum = gender === 'M' ? 1 : gender === 'F' ? 2 : 3
  const round = phase === 'Eliminatoire' ? 1 : phase === 'Finale' ? 4 : 5

  const styleRow = db.prepare(
    `SELECT swimstyleid FROM swimstyle WHERE distance=? AND relaycount=1 ORDER BY swimstyleid LIMIT 1`
  ).get(distance) as { swimstyleid: number } | undefined

  let swimstyleid: number
  if (styleRow) {
    swimstyleid = styleRow.swimstyleid
  } else {
    swimstyleid = nextId('swimstyle', 'swimstyleid')
    db.prepare(
      `INSERT INTO swimstyle (swimstyleid, distance, relaycount, name, stroke) VALUES (?, ?, 1, ?, 1)`
    ).run(swimstyleid, distance, styleName)
  }

  const sortRow = db.prepare(
    `SELECT MAX(sortcode) AS maxsort FROM swimevent WHERE swimsessionid=?`
  ).get(sessionId) as { maxsort: number | null }
  const sortcode = (sortRow.maxsort ?? 0) + 1

  db.prepare(
    `INSERT INTO swimevent
       (swimeventid, swimsessionid, eventnumber, gender, round, swimstyleid, sortcode,
        internalevent, splashmecanedit, masters, pfineignore, seedbonuslast,
        seedexhlast, seedlateentrylast, seedingglobal, twoperlane, combineagegroups)
     VALUES (?, ?, ?, ?, ?, ?, ?,
             'F','F','F','F','F','F','F','F','F','F')`
  ).run(id, sessionId, eventnumber, gNum, round, swimstyleid, sortcode)
  regenerateCombinedEvents(db)
  return id
}

export async function deleteEvent(eventId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(`DELETE FROM swimevent WHERE swimeventid=?`).run(eventId)
  regenerateCombinedEvents(db)
}

export async function createAgeGroup(
  eventId: number,
  name: string,
  minAge: number,
  maxAge: number | null,
  gender: 'M' | 'F' | 'X',
): Promise<number> {
  const db = getLocalDb()
  const id = nextId('agegroup', 'agegroupid')
  const gNum = gender === 'M' ? 1 : gender === 'F' ? 2 : 3
  const sortRow = db.prepare(
    `SELECT MAX(sortcode) AS maxsort FROM agegroup WHERE swimeventid=?`
  ).get(eventId) as { maxsort: number | null }
  const sortcode = (sortRow.maxsort ?? 0) + 1
  db.prepare(
    `INSERT INTO agegroup
       (agegroupid, swimeventid, name, agemin, agemax, gender, heatcount, sortcode,
        useformedals, useforscoring, allofficial, agebytotal, forceprelim, seedwithtsonly)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'T','T','T','F','F','F')`
  ).run(id, eventId, name, minAge, maxAge, gNum, sortcode)
  regenerateCombinedEvents(db)
  return id
}

export async function deleteAgeGroup(agegroupId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(`DELETE FROM agegroup WHERE agegroupid=?`).run(agegroupId)
  regenerateCombinedEvents(db)
}

// ── Write: athlete ────────────────────────────────────────────────────────────

export async function saveAthlete(a: {
  id: number; lastName: string; firstName: string; birthDate: string
  gender: 'M' | 'F'; nation: string; clubCode: string; clubName: string
  licence?: string; birthPlace?: string
}): Promise<void> {
  const db = getLocalDb()
  const gNum = a.gender === 'F' ? 2 : 1

  let clubId: number | null = null
  if (a.clubCode) {
    const clubRow = db.prepare(`SELECT clubid FROM club WHERE code=?`).get(a.clubCode) as { clubid: number } | undefined
    if (clubRow) {
      clubId = clubRow.clubid
      db.prepare(`UPDATE club SET name=? WHERE clubid=?`).run(a.clubName, clubId)
    } else {
      clubId = nextId('club', 'clubid')
      db.prepare(`INSERT INTO club (clubid, code, name) VALUES (?, ?, ?)`).run(clubId, a.clubCode, a.clubName)
    }
  }

  db.prepare(
    `UPDATE athlete
     SET firstname=?, lastname=?, birthdate=?, gender=?, nation=?,
         license=?, domicile=?, clubid=?
     WHERE athleteid=?`
  ).run(a.firstName, a.lastName, a.birthDate || null, gNum, a.nation,
        a.licence || null, a.birthPlace || null, clubId, a.id)
}

// ── Local SQLite schema (same tables/columns as PG, SQLite-compatible DDL) ───

const SCHEMA_DDL: string[] = [
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
]

const CORE_TABLES = [
  'bsglobal', 'swimstyle', 'club', 'swimsession', 'athlete',
  'swimevent', 'agegroup', 'heat', 'swimresult', 'split',
]

function initLocalSchema(): void {
  const db = getLocalDb()
  for (const ddl of SCHEMA_DDL) {
    db.exec(ddl)
  }
}

// ── Sync-Up: push local SQLite → remote PG ───────────────────────────────────

const PG_SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS bsglobal (
    name VARCHAR(50) NOT NULL DEFAULT '' PRIMARY KEY,
    data TEXT)`,
  `CREATE TABLE IF NOT EXISTS swimstyle (
    swimstyleid INTEGER NOT NULL,
    code VARCHAR(10), distance SMALLINT, name VARCHAR(50), relaycount SMALLINT,
    stroke SMALLINT, sortcode INTEGER, technique SMALLINT, uniqueid SMALLINT,
    CONSTRAINT pk_swimstyle PRIMARY KEY (swimstyleid))`,
  `CREATE TABLE IF NOT EXISTS club (
    clubid INTEGER NOT NULL,
    bonuspoints INTEGER, clubtype SMALLINT, code VARCHAR(10),
    contactname VARCHAR(50), contactinternet VARCHAR(150),
    contactcity VARCHAR(30), contactcountry VARCHAR(2), contactemail VARCHAR(50),
    contactfax VARCHAR(20), contactphone VARCHAR(20), contactstate VARCHAR(5),
    contactstreet VARCHAR(50), contactstreet2 VARCHAR(50), contactzip VARCHAR(10),
    externalid VARCHAR(40), longcode VARCHAR(20), entryclubid INTEGER,
    entryemails VARCHAR(255), name VARCHAR(80), nameen VARCHAR(80),
    nation VARCHAR(3), region VARCHAR(10), shortname VARCHAR(30),
    shortnameen VARCHAR(30), swrid INTEGER, teamnumber SMALLINT,
    CONSTRAINT pk_club PRIMARY KEY (clubid))`,
  `CREATE TABLE IF NOT EXISTS swimsession (
    swimsessionid INTEGER NOT NULL,
    course SMALLINT, daytime TIMESTAMP WITHOUT TIME ZONE,
    endtime TIMESTAMP WITHOUT TIME ZONE, feeathlete DOUBLE PRECISION,
    following CHAR(1) DEFAULT 'F', lanemin SMALLINT, lanemax SMALLINT,
    lanesbyplace VARCHAR(100), maxentriesathlete SMALLINT,
    maxentriesrelay SMALLINT, name VARCHAR(100),
    officialmeeting TIMESTAMP WITHOUT TIME ZONE,
    poolglobal CHAR(1) DEFAULT 'F', pooltype SMALLINT,
    remarks TEXT, remarksjury TEXT, roundtotenths CHAR(1) DEFAULT 'F',
    sessionnumber SMALLINT, startdate TIMESTAMP WITHOUT TIME ZONE,
    timing SMALLINT, tlmeeting TIMESTAMP WITHOUT TIME ZONE,
    touchpadmode SMALLINT,
    warmupfrom TIMESTAMP WITHOUT TIME ZONE,
    warmupuntil TIMESTAMP WITHOUT TIME ZONE,
    CONSTRAINT pk_swimsession PRIMARY KEY (swimsessionid))`,
  `CREATE TABLE IF NOT EXISTS athlete (
    athleteid INTEGER NOT NULL,
    clubid INTEGER REFERENCES club(clubid),
    firstname VARCHAR(30), firstname_upper VARCHAR(5), gender SMALLINT,
    lastname VARCHAR(50), lastname_upper VARCHAR(10), nameprefix VARCHAR(20),
    birthdate TIMESTAMP WITHOUT TIME ZONE, domicile VARCHAR(50),
    externalid VARCHAR(40), firstnameen VARCHAR(30), handicapex VARCHAR(20),
    handicaps SMALLINT, handicapsb SMALLINT, handicapsm SMALLINT,
    lastnameen VARCHAR(50), license VARCHAR(20), nation VARCHAR(3),
    sdmsid INTEGER, status INTEGER, swimlevel VARCHAR(10),
    swrid INTEGER, swrhashkey INTEGER, clubcode2 VARCHAR(10),
    coachname VARCHAR(80), schoolyear VARCHAR(10),
    middlename VARCHAR(50), middlenameen VARCHAR(50),
    CONSTRAINT pk_athlete PRIMARY KEY (athleteid))`,
  `CREATE TABLE IF NOT EXISTS swimevent (
    swimeventid INTEGER NOT NULL,
    comment TEXT, daytime TIMESTAMP WITHOUT TIME ZONE,
    duration TIMESTAMP WITHOUT TIME ZONE, entrytimeconversion SMALLINT,
    entrytimepercent SMALLINT, eventnumber SMALLINT, externalid VARCHAR(40),
    fee DOUBLE PRECISION, finalorder SMALLINT, gender SMALLINT,
    lanemax SMALLINT, lytentrylist INTEGER, lytstartlist INTEGER,
    lytresult2column INTEGER, lytresult2split INTEGER,
    lytresult4split INTEGER, lytresultnosplit INTEGER, lytresulthtml INTEGER,
    masters CHAR(1) DEFAULT 'F', maxentries SMALLINT,
    pfineignore CHAR(1) DEFAULT 'F', preveventid INTEGER,
    qualbyplace SMALLINT, round SMALLINT,
    seedbonuslast CHAR(1) DEFAULT 'F', seedexhlast CHAR(1) DEFAULT 'F',
    seedlateentrylast CHAR(1) DEFAULT 'F', seedingglobal CHAR(1) DEFAULT 'F',
    singleheats SMALLINT, sortcode INTEGER,
    splashmecanedit CHAR(1) DEFAULT 'F', sponsor VARCHAR(50),
    swimsessionid INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE,
    swimstyleid INTEGER REFERENCES swimstyle(swimstyleid),
    twoperlane CHAR(1) DEFAULT 'F', roundname VARCHAR(50),
    combineagegroups CHAR(1) DEFAULT 'F', roundone VARCHAR(20),
    internalevent CHAR(1) DEFAULT 'F',
    CONSTRAINT pk_swimevent PRIMARY KEY (swimeventid))`,
  `CREATE TABLE IF NOT EXISTS agegroup (
    agegroupid INTEGER NOT NULL,
    agebytotal CHAR(1) DEFAULT 'F', agemax SMALLINT, agemax2 SMALLINT,
    agemin SMALLINT, agemin2 SMALLINT, allofficial CHAR(1) DEFAULT 'F',
    athletestatuses INTEGER, clubids TEXT, code VARCHAR(10),
    externalid VARCHAR(40), fastheatcount SMALLINT,
    forceprelim CHAR(1) DEFAULT 'F', gender SMALLINT,
    handicaps VARCHAR(100), heatcount SMALLINT,
    heatqualipriority VARCHAR(50), levelmax VARCHAR(5), levelmin VARCHAR(5),
    name VARCHAR(50), nationality VARCHAR(3), nationregions TEXT,
    resultcount SMALLINT, scoretype SMALLINT,
    seedwithtsonly CHAR(1) DEFAULT 'F', sortcode INTEGER,
    swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
    swimlevels VARCHAR(255), useformedals CHAR(1) DEFAULT 'F',
    useforscoring CHAR(1) DEFAULT 'F', winnertitle VARCHAR(100),
    foreigncount SMALLINT, finalseedtype SMALLINT,
    CONSTRAINT pk_agegroup PRIMARY KEY (agegroupid))`,
  `CREATE TABLE IF NOT EXISTS heat (
    heatid INTEGER NOT NULL,
    agegroupid INTEGER, agegrouporder INTEGER,
    daytime TIMESTAMP WITHOUT TIME ZONE, finalcode VARCHAR(2),
    heatnumber SMALLINT, racestatus SMALLINT, remarks TEXT,
    sortcode INTEGER,
    swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
    name VARCHAR(50), seedeventid INTEGER, code VARCHAR(10),
    reservecount SMALLINT, foreigncount SMALLINT,
    CONSTRAINT pk_heat PRIMARY KEY (heatid))`,
  `CREATE TABLE IF NOT EXISTS swimresult (
    swimresultid INTEGER NOT NULL,
    athleteid INTEGER REFERENCES athlete(athleteid),
    swrabestid INTEGER, swrabesttime INTEGER,
    swrsbestid INTEGER, swrsbesttime INTEGER,
    agegroupid INTEGER, backuptime1 INTEGER, backuptime2 INTEGER,
    backuptime3 INTEGER, bonusentry CHAR(1) DEFAULT 'F',
    comment VARCHAR(250), dsqitemid INTEGER,
    dsqdaytime TIMESTAMP WITHOUT TIME ZONE,
    dsqnotified CHAR(1) DEFAULT 'F', dsqnumber SMALLINT,
    entrycourse SMALLINT, entrytime INTEGER,
    finalfix CHAR(1) DEFAULT 'F', finishjudge SMALLINT, heatid INTEGER,
    infocode VARCHAR(5), lane SMALLINT, lateentry CHAR(1) DEFAULT 'F',
    mpoints SMALLINT, padtime INTEGER, qtcity VARCHAR(30),
    qtcourse SMALLINT, qtdate TIMESTAMP WITHOUT TIME ZONE,
    qtname VARCHAR(100), qtnation VARCHAR(3), qttime INTEGER,
    qualcode VARCHAR(2), reactiontime SMALLINT, resultstatus SMALLINT,
    swimeventid INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
    swimtime INTEGER, usetimetype SMALLINT DEFAULT 0,
    dsqofficialid INTEGER, reservecode VARCHAR(20),
    noadvance CHAR(1) DEFAULT 'F', officialsplits VARCHAR(100),
    qttiming SMALLINT,
    CONSTRAINT pk_swimresult PRIMARY KEY (swimresultid))`,
  `CREATE TABLE IF NOT EXISTS split (
    swimresultid INTEGER NOT NULL REFERENCES swimresult(swimresultid) ON DELETE CASCADE,
    distance SMALLINT NOT NULL, swimtime INTEGER,
    CONSTRAINT pk_split PRIMARY KEY (swimresultid, distance))`,
]

export async function syncUp(): Promise<{ tablesCreated: string[] }> {
  const local = getLocalDb()
  const pg = remoteDb()

  // Ensure remote schema exists
  for (const ddl of PG_SCHEMA_DDL) {
    await pg.query(ddl)
  }

  // Check which tables were created
  const before = await pg.query<{ tablename: string }>(
    `SELECT tablename FROM information_schema.tables WHERE table_schema='public' AND tablename=ANY($1)`,
    [CORE_TABLES]
  )
  const tablesCreated = CORE_TABLES.filter(t => !before.rows.find(r => r.tablename === t))

  // Push data table by table (full replace on remote)
  const tables = [
    { name: 'bsglobal', pk: 'name', cols: ['name','data'] },
    { name: 'swimstyle', pk: 'swimstyleid', cols: ['swimstyleid','code','distance','name','relaycount','stroke','sortcode','technique','uniqueid'] },
    { name: 'club', pk: 'clubid', cols: ['clubid','bonuspoints','clubtype','code','contactname','contactinternet','contactcity','contactcountry','contactemail','contactfax','contactphone','contactstate','contactstreet','contactstreet2','contactzip','externalid','longcode','entryclubid','entryemails','name','nameen','nation','region','shortname','shortnameen','swrid','teamnumber'] },
    { name: 'swimsession', pk: 'swimsessionid', cols: ['swimsessionid','course','daytime','endtime','feeathlete','following','lanemin','lanemax','lanesbyplace','maxentriesathlete','maxentriesrelay','name','officialmeeting','poolglobal','pooltype','remarks','remarksjury','roundtotenths','sessionnumber','startdate','timing','tlmeeting','touchpadmode','warmupfrom','warmupuntil'] },
    { name: 'athlete', pk: 'athleteid', cols: ['athleteid','clubid','firstname','firstname_upper','gender','lastname','lastname_upper','nameprefix','birthdate','domicile','externalid','firstnameen','handicapex','handicaps','handicapsb','handicapsm','lastnameen','license','nation','sdmsid','status','swimlevel','swrid','swrhashkey','clubcode2','coachname','schoolyear','middlename','middlenameen'] },
    { name: 'swimevent', pk: 'swimeventid', cols: ['swimeventid','comment','daytime','duration','entrytimeconversion','entrytimepercent','eventnumber','externalid','fee','finalorder','gender','lanemax','lytentrylist','lytstartlist','lytresult2column','lytresult2split','lytresult4split','lytresultnosplit','lytresulthtml','masters','maxentries','pfineignore','preveventid','qualbyplace','round','seedbonuslast','seedexhlast','seedlateentrylast','seedingglobal','singleheats','sortcode','splashmecanedit','sponsor','swimsessionid','swimstyleid','twoperlane','roundname','combineagegroups','roundone','internalevent'] },
    { name: 'agegroup', pk: 'agegroupid', cols: ['agegroupid','agebytotal','agemax','agemax2','agemin','agemin2','allofficial','athletestatuses','clubids','code','externalid','fastheatcount','forceprelim','gender','handicaps','heatcount','heatqualipriority','levelmax','levelmin','name','nationality','nationregions','resultcount','scoretype','seedwithtsonly','sortcode','swimeventid','swimlevels','useformedals','useforscoring','winnertitle','foreigncount','finalseedtype'] },
    { name: 'heat', pk: 'heatid', cols: ['heatid','agegroupid','agegrouporder','daytime','finalcode','heatnumber','racestatus','remarks','sortcode','swimeventid','name','seedeventid','code','reservecount','foreigncount'] },
    { name: 'swimresult', pk: 'swimresultid', cols: ['swimresultid','athleteid','swrabestid','swrabesttime','swrsbestid','swrsbesttime','agegroupid','backuptime1','backuptime2','backuptime3','bonusentry','comment','dsqitemid','dsqdaytime','dsqnotified','dsqnumber','entrycourse','entrytime','finalfix','finishjudge','heatid','infocode','lane','lateentry','mpoints','padtime','qtcity','qtcourse','qtdate','qtname','qtnation','qttime','qualcode','reactiontime','resultstatus','swimeventid','swimtime','usetimetype','dsqofficialid','reservecode','noadvance','officialsplits','qttiming'] },
    { name: 'split', pk: 'swimresultid,distance', cols: ['swimresultid','distance','swimtime'] },
  ]

  for (const table of tables) {
    const rows = local.prepare(`SELECT ${table.cols.join(',')} FROM ${table.name}`).all() as Record<string, unknown>[]
    if (rows.length === 0) continue

    // Delete remote data for this table, then insert
    await pg.query(`DELETE FROM ${table.name}`)
    for (const row of rows) {
      const vals = table.cols.map(c => row[c] ?? null)
      const placeholders = table.cols.map((_, i) => `$${i + 1}`).join(',')
      await pg.query(
        `INSERT INTO ${table.name} (${table.cols.join(',')}) VALUES (${placeholders})`,
        vals
      )
    }
  }

  return { tablesCreated }
}

// ── Sync-Down: pull remote PG → local SQLite ─────────────────────────────────

export async function syncDown(): Promise<{ rowsCopied: number }> {
  const local = getLocalDb()
  const pg = remoteDb()
  let totalRows = 0

  const tables = [
    { name: 'bsglobal', cols: ['name','data'] },
    { name: 'swimstyle', cols: ['swimstyleid','code','distance','name','relaycount','stroke','sortcode','technique','uniqueid'] },
    { name: 'club', cols: ['clubid','bonuspoints','clubtype','code','contactname','contactinternet','contactcity','contactcountry','contactemail','contactfax','contactphone','contactstate','contactstreet','contactstreet2','contactzip','externalid','longcode','entryclubid','entryemails','name','nameen','nation','region','shortname','shortnameen','swrid','teamnumber'] },
    { name: 'swimsession', cols: ['swimsessionid','course','daytime','endtime','feeathlete','following','lanemin','lanemax','lanesbyplace','maxentriesathlete','maxentriesrelay','name','officialmeeting','poolglobal','pooltype','remarks','remarksjury','roundtotenths','sessionnumber','startdate','timing','tlmeeting','touchpadmode','warmupfrom','warmupuntil'] },
    { name: 'athlete', cols: ['athleteid','clubid','firstname','firstname_upper','gender','lastname','lastname_upper','nameprefix','birthdate','domicile','externalid','firstnameen','handicapex','handicaps','handicapsb','handicapsm','lastnameen','license','nation','sdmsid','status','swimlevel','swrid','swrhashkey','clubcode2','coachname','schoolyear','middlename','middlenameen'] },
    { name: 'swimevent', cols: ['swimeventid','comment','daytime','duration','entrytimeconversion','entrytimepercent','eventnumber','externalid','fee','finalorder','gender','lanemax','lytentrylist','lytstartlist','lytresult2column','lytresult2split','lytresult4split','lytresultnosplit','lytresulthtml','masters','maxentries','pfineignore','preveventid','qualbyplace','round','seedbonuslast','seedexhlast','seedlateentrylast','seedingglobal','singleheats','sortcode','splashmecanedit','sponsor','swimsessionid','swimstyleid','twoperlane','roundname','combineagegroups','roundone','internalevent'] },
    { name: 'agegroup', cols: ['agegroupid','agebytotal','agemax','agemax2','agemin','agemin2','allofficial','athletestatuses','clubids','code','externalid','fastheatcount','forceprelim','gender','handicaps','heatcount','heatqualipriority','levelmax','levelmin','name','nationality','nationregions','resultcount','scoretype','seedwithtsonly','sortcode','swimeventid','swimlevels','useformedals','useforscoring','winnertitle','foreigncount','finalseedtype'] },
    { name: 'heat', cols: ['heatid','agegroupid','agegrouporder','daytime','finalcode','heatnumber','racestatus','remarks','sortcode','swimeventid','name','seedeventid','code','reservecount','foreigncount'] },
    { name: 'swimresult', cols: ['swimresultid','athleteid','swrabestid','swrabesttime','swrsbestid','swrsbesttime','agegroupid','backuptime1','backuptime2','backuptime3','bonusentry','comment','dsqitemid','dsqdaytime','dsqnotified','dsqnumber','entrycourse','entrytime','finalfix','finishjudge','heatid','infocode','lane','lateentry','mpoints','padtime','qtcity','qtcourse','qtdate','qtname','qtnation','qttime','qualcode','reactiontime','resultstatus','swimeventid','swimtime','usetimetype','dsqofficialid','reservecode','noadvance','officialsplits','qttiming'] },
    { name: 'split', cols: ['swimresultid','distance','swimtime'] },
  ]

  // Wipe local and pull from remote
  // Reverse order for FK safety
  const reversed = [...tables].reverse()
  for (const table of reversed) {
    local.prepare(`DELETE FROM ${table.name}`).run()
  }

  for (const table of tables) {
    const res = await pg.query(`SELECT ${table.cols.join(',')} FROM ${table.name}`)
    if (res.rows.length === 0) continue

    const placeholders = table.cols.map(() => '?').join(',')
    const ins = local.prepare(
      `INSERT INTO ${table.name} (${table.cols.join(',')}) VALUES (${placeholders})`
    )

    const insertMany = local.transaction((rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const vals = table.cols.map(c => {
          const v = row[c]
          // Convert PG Date objects to ISO strings for SQLite
          if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
          return v ?? null
        })
        ins.run(...vals)
      }
    })

    insertMany(res.rows)
    totalRows += res.rows.length
  }

  return { rowsCopied: totalRows }
}

// ── Heat generation ───────────────────────────────────────────────────────────

/** Read MEETVALUES from a given db instance (avoids getLocalDb() dependency for testing). */
function readMeetValuesFromDb(db: ReturnType<typeof getLocalDb>): Record<string, string> {
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
  if (!row?.data) return {}
  const result: Record<string, string> = {}
  for (const line of row.data.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const rest = line.slice(eq + 1)
    const semi = rest.indexOf(';')
    result[key] = semi >= 0 ? rest.slice(semi + 1) : rest
  }
  return result
}

export interface GenerateHeatsResult {
  heatsCreated: number
  entriesAssigned: number
}

/**
 * Generate heats for a given event (or all events in a session).
 *
 * Implements FINA/World Aquatics SW 3.1 seeding rules:
 * - Circle seeding (prelims): distribute swimmers evenly across heats
 * - Pyramid seeding (finals): fastest swimmers in last heat
 * - Straight seeding: fastest in heat 1, sequential fill
 * - "Last N heats" rule (fastheatcount): only circle-seed the last N heats
 * - Qualification period filtering (QUALIFROM/QUALITO)
 * - Seed bonus/exhibition/late entries last
 * - Combine age groups option
 * - Minimum swimmers per heat enforcement
 * - Center-out lane assignment (or custom via lanesbyplace)
 */
export async function generateHeats(eventId?: number, sessionId?: number, injectedDb?: ReturnType<typeof getLocalDb>): Promise<GenerateHeatsResult> {
  const db = injectedDb ?? getLocalDb()
  let totalHeats = 0
  let totalAssigned = 0

  // ── Load meet-level seeding config from MEETVALUES ──
  const meetCfg = readMeetValuesFromDb(db)
  const globalSeedMethod = parseInt(meetCfg.SEEDMETHOD ?? '0', 10) // 0=circle, 1=pyramid, 2=straight
  const globalFastHeatCount = parseInt(meetCfg.FASTHEATCOUNT ?? '0', 10) // FINA last-N-heats rule
  const globalSeedBonusLast = meetCfg.SEEDBONUSLAST === 'T'
  const globalSeedExhLast = meetCfg.SEEDEXHLAST === 'T'
  const globalSeedLateLast = meetCfg.SEEDLATELAST === 'T'
  const globalCombineAgeGroups = meetCfg.COMBINEAGEGROUPS === 'T'
  const globalMinPerHeat = parseInt(meetCfg.MINPERHEAT ?? '3', 10)
  const qualiFrom = meetCfg.QUALIFROM || null // date string e.g. "2024-01-01"
  const qualiTo = meetCfg.QUALITO || null
  const qualiCourse = parseInt(meetCfg.QUALICOURSE ?? '0', 10) // 0=all, 1=same course only

  // Determine which events to process
  let eventIds: number[]
  if (eventId) {
    eventIds = [eventId]
  } else if (sessionId) {
    eventIds = (db.prepare(
      `SELECT swimeventid FROM swimevent WHERE swimsessionid=? AND internalevent='F' ORDER BY sortcode`
    ).all(sessionId) as Array<{ swimeventid: number }>).map(r => r.swimeventid)
  } else {
    eventIds = (db.prepare(
      `SELECT swimeventid FROM swimevent WHERE internalevent='F' ORDER BY sortcode`
    ).all() as Array<{ swimeventid: number }>).map(r => r.swimeventid)
  }

  if (eventIds.length === 0) return { heatsCreated: 0, entriesAssigned: 0 }

  // Get session lane config (use first session's config as default)
  const sessionRow = db.prepare(`
    SELECT lanemin, lanemax, lanesbyplace, course FROM swimsession ORDER BY sessionnumber LIMIT 1
  `).get() as { lanemin: number | null; lanemax: number | null; lanesbyplace: string | null; course: number | null } | undefined

  const defaultLaneMin = sessionRow?.lanemin ?? 1
  const defaultLaneMax = sessionRow?.lanemax ?? 8
  const meetCourse = sessionRow?.course ?? 1

  for (const evId of eventIds) {
    // Get event-specific config
    const evRow = db.prepare(`
      SELECT e.seedbonuslast, e.seedexhlast, e.seedlateentrylast, e.combineagegroups,
             s.lanemin, s.lanemax, s.lanesbyplace, s.course
      FROM swimevent e
      JOIN swimsession s ON e.swimsessionid = s.swimsessionid
      WHERE e.swimeventid=?
    `).get(evId) as {
      seedbonuslast: string | null; seedexhlast: string | null; seedlateentrylast: string | null
      combineagegroups: string | null
      lanemin: number | null; lanemax: number | null; lanesbyplace: string | null; course: number | null
    } | undefined

    const laneMin = evRow?.lanemin ?? defaultLaneMin
    const laneMax = evRow?.lanemax ?? defaultLaneMax
    const laneCount = laneMax - laneMin + 1
    const eventCourse = evRow?.course ?? meetCourse

    // Event-level overrides (fall back to global config)
    const seedBonusLast = evRow?.seedbonuslast === 'T' || globalSeedBonusLast
    const seedExhLast = evRow?.seedexhlast === 'T' || globalSeedExhLast
    const seedLateLast = evRow?.seedlateentrylast === 'T' || globalSeedLateLast
    const combineAgeGroups = evRow?.combineagegroups === 'T' || globalCombineAgeGroups

    // Parse custom lane order from session
    const customLaneOrder = parseLanesbyplace(evRow?.lanesbyplace ?? sessionRow?.lanesbyplace)

    // Get age groups for this event
    const ageGroups = db.prepare(`
      SELECT agegroupid, heatcount, finalseedtype, fastheatcount FROM agegroup WHERE swimeventid=? ORDER BY sortcode
    `).all(evId) as Array<{ agegroupid: number; heatcount: number | null; finalseedtype: number | null; fastheatcount: number | null }>

    // Skip events that have any validated heats (racestatus = 5)
    const validatedCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM heat WHERE swimeventid = ? AND racestatus = 5`
    ).get(evId) as { c: number }).c
    if (validatedCount > 0) continue

    // Delete existing heats for this event
    db.prepare(`DELETE FROM heat WHERE swimeventid=?`).run(evId)
    // Reset heat assignments for all results in this event
    db.prepare(`UPDATE swimresult SET heatid=NULL, lane=NULL WHERE swimeventid=?`).run(evId)

    // Determine groups to process
    if (combineAgeGroups || ageGroups.length === 0) {
      // Combine all entries into one pool
      const seedType = ageGroups.length > 0 ? (ageGroups[0].finalseedtype ?? globalSeedMethod) : globalSeedMethod
      const fastCount = ageGroups.length > 0 ? (ageGroups[0].fastheatcount ?? globalFastHeatCount) : globalFastHeatCount
      const minHeats = ageGroups.length > 0 ? (ageGroups[0].heatcount ?? 1) : 1

      const entries = loadEntries(db, evId, null, seedBonusLast, seedExhLast, seedLateLast, qualiFrom, qualiTo, qualiCourse, eventCourse)
      if (entries.length > 0) {
        const result = seedAndAssignHeats(db, evId, null, entries, laneCount, laneMin, laneMax, minHeats, seedType, fastCount, globalMinPerHeat, customLaneOrder)
        totalHeats += result.heats
        totalAssigned += result.assigned
      }
    } else {
      // Check if entries actually have agegroupid assigned
      const hasAgAssigned = (db.prepare(
        `SELECT COUNT(*) as c FROM swimresult WHERE swimeventid=? AND agegroupid IS NOT NULL`
      ).get(evId) as { c: number }).c > 0

      if (!hasAgAssigned) {
        // Entries don't have agegroupid set — treat as combined (use first age group's config)
        const seedType = ageGroups[0].finalseedtype ?? globalSeedMethod
        const fastCount = ageGroups[0].fastheatcount ?? globalFastHeatCount
        const minHeats = ageGroups[0].heatcount ?? 1

        const entries = loadEntries(db, evId, null, seedBonusLast, seedExhLast, seedLateLast, qualiFrom, qualiTo, qualiCourse, eventCourse)
        if (entries.length > 0) {
          const result = seedAndAssignHeats(db, evId, null, entries, laneCount, laneMin, laneMax, minHeats, seedType, fastCount, globalMinPerHeat, customLaneOrder)
          totalHeats += result.heats
          totalAssigned += result.assigned
        }
      } else {
        // Process each age group separately
        for (const ag of ageGroups) {
          const seedType = ag.finalseedtype ?? globalSeedMethod
          const fastCount = ag.fastheatcount ?? globalFastHeatCount
          const minHeats = ag.heatcount ?? 1

          const entries = loadEntries(db, evId, ag.agegroupid, seedBonusLast, seedExhLast, seedLateLast, qualiFrom, qualiTo, qualiCourse, eventCourse)
          if (entries.length > 0) {
            const result = seedAndAssignHeats(db, evId, ag.agegroupid, entries, laneCount, laneMin, laneMax, minHeats, seedType, fastCount, globalMinPerHeat, customLaneOrder)
            totalHeats += result.heats
            totalAssigned += result.assigned
          }
        }
      }
    }
  }

  return { heatsCreated: totalHeats, entriesAssigned: totalAssigned }
}

// ── Entry loading with priority ordering ──────────────────────────────────────

interface EntryRow {
  swimresultid: number
  entrytime: number | null
  bonusentry: string | null
  lateentry: string | null
  infocode: string | null
  qtdate: string | null
  entrycourse: number | null
}

function loadEntries(
  db: ReturnType<typeof getLocalDb>,
  eventId: number,
  agegroupId: number | null,
  seedBonusLast: boolean,
  seedExhLast: boolean,
  seedLateLast: boolean,
  qualiFrom: string | null,
  qualiTo: string | null,
  qualiCourse: number,
  eventCourse: number,
): EntryRow[] {
  let entries: EntryRow[]
  if (agegroupId != null) {
    entries = db.prepare(`
      SELECT swimresultid, entrytime, bonusentry, lateentry, infocode, qtdate, entrycourse
      FROM swimresult
      WHERE swimeventid=? AND agegroupid=?
      ORDER BY swimresultid
    `).all(eventId, agegroupId) as EntryRow[]
  } else {
    entries = db.prepare(`
      SELECT swimresultid, entrytime, bonusentry, lateentry, infocode, qtdate, entrycourse
      FROM swimresult
      WHERE swimeventid=?
      ORDER BY swimresultid
    `).all(eventId) as EntryRow[]
  }

  // Apply qualification period filter: entries outside the period lose their time
  if (qualiFrom || qualiTo) {
    for (const e of entries) {
      if (e.entrytime != null && e.qtdate) {
        const qtd = e.qtdate.slice(0, 10) // normalize to YYYY-MM-DD
        if (qualiFrom && qtd < qualiFrom) e.entrytime = null
        if (qualiTo && qtd > qualiTo) e.entrytime = null
      }
      // Course filter: if qualiCourse=1 (same course only), reject times from different course
      if (qualiCourse === 1 && e.entrytime != null && e.entrycourse != null && e.entrycourse !== eventCourse) {
        e.entrytime = null
      }
    }
  }

  // Sort entries by priority groups, then by time within each group
  // Priority: 1=regular timed, 2=late (if seedLateLast), 3=bonus (if seedBonusLast),
  //           4=exhibition (if seedExhLast), 5=NTs
  entries.sort((a, b) => {
    const pa = entryPriority(a, seedBonusLast, seedExhLast, seedLateLast)
    const pb = entryPriority(b, seedBonusLast, seedExhLast, seedLateLast)
    if (pa !== pb) return pa - pb
    // Within same priority, sort by time (NTs last)
    if (a.entrytime == null && b.entrytime == null) return 0
    if (a.entrytime == null) return 1
    if (b.entrytime == null) return -1
    return a.entrytime - b.entrytime
  })

  return entries
}

function entryPriority(e: EntryRow, seedBonusLast: boolean, seedExhLast: boolean, seedLateLast: boolean): number {
  // Exhibition entries (identified by infocode containing 'EXH')
  if (seedExhLast && e.infocode && e.infocode.toUpperCase().includes('EXH')) return 4
  // Bonus entries
  if (seedBonusLast && e.bonusentry === 'T') return 3
  // Late entries
  if (seedLateLast && e.lateentry === 'T') return 2
  // NT entries always last within their priority group
  if (e.entrytime == null) return 5
  // Regular timed entries
  return 1
}

// ── Core seeding and lane assignment ──────────────────────────────────────────

function seedAndAssignHeats(
  db: ReturnType<typeof getLocalDb>,
  eventId: number,
  agegroupId: number | null,
  entries: EntryRow[],
  laneCount: number,
  laneMin: number,
  laneMax: number,
  minHeats: number,
  seedType: number,
  fastHeatCount: number,
  minPerHeat: number,
  customLaneOrder: number[] | null,
): { heats: number; assigned: number } {
  let totalHeats = 0
  let totalAssigned = 0

  const requiredHeats = Math.max(minHeats, Math.ceil(entries.length / laneCount))
  const laneOrder = customLaneOrder ?? generateLaneOrder(laneMin, laneMax)

  // Distribute entries into heats based on seeding method
  const heats: EntryRow[][] = []
  for (let i = 0; i < requiredHeats; i++) heats.push([])

  if (seedType === 1) {
    // ── Pyramid seeding: fastest in last heat ──
    // Fill from last heat backward
    let heatIdx = requiredHeats - 1
    let count = 0
    for (const entry of entries) {
      heats[heatIdx].push(entry)
      count++
      if (count >= laneCount) {
        count = 0
        heatIdx--
        if (heatIdx < 0) heatIdx = 0
      }
    }
  } else if (seedType === 2) {
    // ── Straight seeding: fastest in heat 1, fill sequentially ──
    let heatIdx = 0
    let count = 0
    for (const entry of entries) {
      heats[heatIdx].push(entry)
      count++
      if (count >= laneCount) {
        count = 0
        heatIdx++
        if (heatIdx >= requiredHeats) heatIdx = requiredHeats - 1
      }
    }
  } else {
    // ── Circle seeding (default, FINA SW 3.1) ──
    // If fastHeatCount > 0: only circle-seed the last N heats, fill earlier heats sequentially
    const effectiveFastCount = fastHeatCount > 0 ? Math.min(fastHeatCount, requiredHeats) : requiredHeats

    if (effectiveFastCount >= requiredHeats) {
      // Circle-seed all heats
      for (let i = 0; i < entries.length; i++) {
        const heatIdx = i % requiredHeats
        heats[heatIdx].push(entries[i])
      }
    } else {
      // FINA "last N heats" rule:
      // - The fastest (effectiveFastCount × laneCount) swimmers are circle-seeded across the last N heats
      // - Remaining swimmers fill earlier heats sequentially (slowest first → heat 1)
      const fastSlots = effectiveFastCount * laneCount
      const fastEntries = entries.slice(0, Math.min(fastSlots, entries.length))
      const slowEntries = entries.slice(fastEntries.length)

      // Fill earlier heats sequentially with slow entries (slowest in heat 1)
      // slowEntries are already sorted fastest-first, so reverse for sequential fill
      const earlyHeatCount = requiredHeats - effectiveFastCount
      let heatIdx = 0
      let count = 0
      // Distribute slow entries across early heats
      for (let i = slowEntries.length - 1; i >= 0; i--) {
        heats[heatIdx].push(slowEntries[i])
        count++
        if (count >= laneCount) {
          count = 0
          heatIdx++
          if (heatIdx >= earlyHeatCount) heatIdx = earlyHeatCount - 1
        }
      }

      // Circle-seed fast entries across the last N heats
      const fastStartHeat = earlyHeatCount
      for (let i = 0; i < fastEntries.length; i++) {
        const targetHeat = fastStartHeat + (i % effectiveFastCount)
        heats[targetHeat].push(fastEntries[i])
      }
    }
  }

  // ── Enforce minimum swimmers per heat (FINA SW 3.1.4) ──
  // If the first heat has fewer than minPerHeat swimmers, redistribute
  if (minPerHeat > 0 && heats.length > 1) {
    for (let h = 0; h < heats.length - 1; h++) {
      if (heats[h].length > 0 && heats[h].length < minPerHeat && heats[h + 1].length > minPerHeat) {
        // Move swimmers from next heat to this one until minimum is met
        while (heats[h].length < minPerHeat && heats[h + 1].length > minPerHeat) {
          const moved = heats[h + 1].shift()!
          heats[h].push(moved)
        }
      }
    }
  }

  // ── Create heat rows and assign lanes ──
  const insertHeat = db.prepare(
    `INSERT INTO heat (heatid, swimeventid, agegroupid, heatnumber, racestatus, sortcode)
     VALUES (?, ?, ?, ?, 4, ?)`
  )
  const updateResult = db.prepare(
    `UPDATE swimresult SET heatid=?, lane=? WHERE swimresultid=?`
  )

  // Get current max heat number for this event (so multiple age groups get sequential numbers)
  const maxHeatRow = db.prepare(
    `SELECT COALESCE(MAX(heatnumber), 0) AS maxn FROM heat WHERE swimeventid=?`
  ).get(eventId) as { maxn: number }
  const heatNumberOffset = maxHeatRow.maxn

  for (let h = 0; h < heats.length; h++) {
    if (heats[h].length === 0) continue
    const heatIdRow = db.prepare(`SELECT COALESCE(MAX(heatid), 0) + 1 AS next FROM heat`).get() as { next: number }
    const heatId = heatIdRow.next
    const heatNumber = heatNumberOffset + h + 1
    insertHeat.run(heatId, eventId, agegroupId, heatNumber, heatNumber)
    totalHeats++

    // Sort entries within this heat by entrytime for lane assignment (fastest gets center lane)
    const sorted = [...heats[h]].sort((a, b) => {
      if (a.entrytime == null && b.entrytime == null) return 0
      if (a.entrytime == null) return 1
      if (b.entrytime == null) return -1
      return a.entrytime - b.entrytime
    })

    for (let i = 0; i < sorted.length; i++) {
      const lane = laneOrder[i] ?? (laneMin + i)
      updateResult.run(heatId, lane, sorted[i].swimresultid)
      totalAssigned++
    }
  }

  return { heats: totalHeats, assigned: totalAssigned }
}

// ── Lane order helpers ────────────────────────────────────────────────────────

/**
 * Generate preferred lane order (center-out) for a given lane range.
 * E.g. for lanes 1-8: [4, 5, 3, 6, 2, 7, 1, 8]
 * E.g. for lanes 1-6: [3, 4, 2, 5, 1, 6]
 */
function generateLaneOrder(laneMin: number, laneMax: number): number[] {
  const count = laneMax - laneMin + 1
  const center = Math.floor(count / 2) // 0-indexed center
  const order: number[] = []
  // Start from center, alternate left and right
  order.push(laneMin + center)
  for (let offset = 1; order.length < count; offset++) {
    const right = laneMin + center + offset
    const left = laneMin + center - offset
    if (right <= laneMax) order.push(right)
    if (left >= laneMin) order.push(left)
  }
  return order
}

/**
 * Parse the lanesbyplace field (comma-separated lane numbers) into an array.
 * Returns null if empty/invalid (use default center-out order).
 */
function parseLanesbyplace(s: string | null | undefined): number[] | null {
  if (!s || !s.trim()) return null
  const parts = s.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n))
  return parts.length > 0 ? parts : null
}

// ── Flush: delete all meet data ───────────────────────────────────────────────

export async function flushMeet(): Promise<void> {
  const db = getLocalDb()
  db.exec(`DELETE FROM split`)
  db.exec(`DELETE FROM swimresult`)
  db.exec(`DELETE FROM heat`)
  db.exec(`DELETE FROM agegroup`)
  db.exec(`DELETE FROM swimevent`)
  db.exec(`DELETE FROM swimsession`)
  db.exec(`DELETE FROM swimstyle`)
  db.exec(`DELETE FROM athlete`)
  db.exec(`DELETE FROM club`)
  db.exec(`DELETE FROM bsglobal`)
}

// ── Health check (remote PG) ──────────────────────────────────────────────────

export async function testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const res = await remoteDb().query<{ version: string }>(`SELECT version()`)
    return { ok: true, version: res.rows[0].version }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── bsglobal: meet-level key-value store ──────────────────────────────────────

export function getMeetInfo(): { name: string; city: string; nation: string } {
  const db = getLocalDb()
  const rows = db.prepare(
    `SELECT name, data FROM bsglobal WHERE name IN ('MeetName','MeetCity','MeetNation')`
  ).all() as Array<{ name: string; data: string | null }>
  const m: Record<string, string> = {}
  for (const r of rows) m[r.name] = r.data ?? ''
  return { name: m['MeetName'] ?? '', city: m['MeetCity'] ?? '', nation: m['MeetNation'] ?? '' }
}

export function getMeetConfig(): Record<string, string> {
  const db = getLocalDb()
  const rows = db.prepare(`SELECT name, data FROM bsglobal`).all() as Array<{ name: string; data: string | null }>
  const result: Record<string, string> = {}
  for (const r of rows) {
    result[r.name] = r.data ?? ''
  }
  return result
}

export function setMeetConfig(key: string, value: string | null): void {
  const db = getLocalDb()
  db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  ).run(key, value)
}

export function setMeetConfigBatch(entries: Record<string, string | null>): void {
  const db = getLocalDb()
  const stmt = db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  )
  const tx = db.transaction((items: [string, string | null][]) => {
    for (const [k, v] of items) stmt.run(k, v)
  })
  tx(Object.entries(entries))
}

// ── MEETVALUES parser/writer (Splash format: KEY=TYPE;VALUE\r\n) ──────────────

export interface MeetValues {
  [key: string]: string
}

export function getMeetValues(): MeetValues {
  const db = getLocalDb()
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
  if (!row?.data) return {}
  const result: MeetValues = {}
  for (const line of row.data.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const rest = line.slice(eq + 1)
    // Strip type prefix (I;, S;, B;, D;, F;)
    const semi = rest.indexOf(';')
    result[key] = semi >= 0 ? rest.slice(semi + 1) : rest
  }
  return result
}

export function setMeetValues(updates: Record<string, { type: string; value: string }>): void {
  const db = getLocalDb()
  // Read existing
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
  const existing: Record<string, string> = {}
  if (row?.data) {
    for (const line of row.data.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq < 0) continue
      existing[line.slice(0, eq)] = line.slice(eq + 1)
    }
  }
  // Apply updates
  for (const [key, { type, value }] of Object.entries(updates)) {
    existing[key] = `${type};${value}`
  }
  // Serialize back
  const data = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\r\n')
  db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  ).run(data)
}

// ── Query: all swimstyles (for event style dropdown) ──────────────────────────

export interface SwimStyleRow {
  id: number
  distance: number
  stroke: number
  name: string
  relaycount: number
}

export function getSwimStyles(): SwimStyleRow[] {
  const db = getLocalDb()
  return (db.prepare(
    `SELECT swimstyleid, distance, stroke, name, relaycount FROM swimstyle ORDER BY distance, stroke`
  ).all() as Array<{ swimstyleid: number; distance: number | null; stroke: number | null; name: string | null; relaycount: number | null }>)
    .map(r => ({
      id: r.swimstyleid,
      distance: r.distance ?? 0,
      stroke: r.stroke ?? 1,
      name: r.name ?? '',
      relaycount: r.relaycount ?? 1,
    }))
}

// ── Write: reorder events within/between sessions ────────────────────────────

export async function reorderEvent(eventId: number, targetSessionId: number, newSortcode: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(`UPDATE swimevent SET swimsessionid=?, sortcode=? WHERE swimeventid=?`).run(targetSessionId, newSortcode, eventId)
}

export async function reorderEvents(updates: Array<{ eventId: number; sessionId: number; sortcode: number }>): Promise<void> {
  const db = getLocalDb()
  const stmt = db.prepare(`UPDATE swimevent SET swimsessionid=?, sortcode=? WHERE swimeventid=?`)
  const tx = db.transaction((items: typeof updates) => {
    for (const u of items) stmt.run(u.sessionId, u.sortcode, u.eventId)
  })
  tx(updates)
}

export interface EventUpdate {
  eventnumber?: number
  gender?: number
  round?: number
  swimstyleid?: number | null
  daytime?: string | null
  duration?: string | null
  masters?: boolean
  roundname?: string | null
  comment?: string | null
}

export async function updateEvent(eventId: number, data: EventUpdate): Promise<void> {
  const db = getLocalDb()
  const sets: string[] = []
  const vals: unknown[] = []

  if (data.eventnumber !== undefined) { sets.push('eventnumber=?'); vals.push(data.eventnumber) }
  if (data.gender !== undefined) { sets.push('gender=?'); vals.push(data.gender) }
  if (data.round !== undefined) { sets.push('round=?'); vals.push(data.round) }
  if (data.swimstyleid !== undefined) { sets.push('swimstyleid=?'); vals.push(data.swimstyleid) }
  if (data.daytime !== undefined) {
    const t = data.daytime
    const ts = t ? (t.includes('-') || t.includes('T') ? t : `2000-01-01 ${t}:00`) : null
    sets.push('daytime=?'); vals.push(ts)
  }
  if (data.duration !== undefined) {
    const d = data.duration
    const ds = d ? (d.includes('-') || d.includes('T') ? d : `2000-01-01 ${d}:00`) : null
    sets.push('duration=?'); vals.push(ds)
  }
  if (data.masters !== undefined) { sets.push('masters=?'); vals.push(data.masters ? 'T' : 'F') }
  if (data.roundname !== undefined) { sets.push('roundname=?'); vals.push(data.roundname) }
  if (data.comment !== undefined) { sets.push('comment=?'); vals.push(data.comment) }

  if (sets.length === 0) return
  vals.push(eventId)
  db.prepare(`UPDATE swimevent SET ${sets.join(', ')} WHERE swimeventid=?`).run(...vals)

  // Regenerate combined events when relevant fields change
  if (data.gender !== undefined || data.swimstyleid !== undefined) {
    regenerateCombinedEvents(db)
  }
}

// ── Write: update age group ───────────────────────────────────────────────────

export interface AgeGroupUpdate {
  name?: string
  agemin?: number
  agemax?: number | null
  gender?: number
  finalseedtype?: number | null
}

export async function updateAgeGroup(agegroupId: number, data: AgeGroupUpdate): Promise<void> {
  const db = getLocalDb()
  const sets: string[] = []
  const vals: unknown[] = []

  if (data.name !== undefined) { sets.push('name=?'); vals.push(data.name) }
  if (data.agemin !== undefined) { sets.push('agemin=?'); vals.push(data.agemin) }
  if (data.agemax !== undefined) { sets.push('agemax=?'); vals.push(data.agemax) }
  if (data.gender !== undefined) { sets.push('gender=?'); vals.push(data.gender) }
  if (data.finalseedtype !== undefined) { sets.push('finalseedtype=?'); vals.push(data.finalseedtype) }

  if (sets.length === 0) return
  vals.push(agegroupId)
  db.prepare(`UPDATE agegroup SET ${sets.join(', ')} WHERE agegroupid=?`).run(...vals)

  // Regenerate combined events when relevant fields change
  if (data.agemin !== undefined || data.agemax !== undefined || data.gender !== undefined) {
    regenerateCombinedEvents(db)
  }
}

// ── Validation: lock/unlock heats via racestatus ──────────────────────────────

/** Validate a single heat (racestatus → 5) */
export async function validateHeat(heatId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 5 WHERE heatid = ? AND racestatus != 5`
  ).run(heatId)
}

/** Invalidate a single heat (racestatus 5 → 4) */
export async function invalidateHeat(heatId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 4 WHERE heatid = ? AND racestatus = 5`
  ).run(heatId)
}

/** Validate all heats in an event (racestatus → 5) */
export async function validateEvent(eventId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 5 WHERE swimeventid = ? AND racestatus != 5`
  ).run(eventId)
}

/** Invalidate all validated heats in an event (racestatus 5 → 4) */
export async function invalidateEvent(eventId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 4 WHERE swimeventid = ? AND racestatus = 5`
  ).run(eventId)
}

/** Validate all heats in all events of a session */
export async function validateSession(sessionId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 5
     WHERE swimeventid IN (SELECT swimeventid FROM swimevent WHERE swimsessionid = ? AND internalevent = 'F')
       AND racestatus != 5`
  ).run(sessionId)
}

/** Invalidate all validated heats in all events of a session */
export async function invalidateSession(sessionId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(
    `UPDATE heat SET racestatus = 4
     WHERE swimeventid IN (SELECT swimeventid FROM swimevent WHERE swimsessionid = ? AND internalevent = 'F')
       AND racestatus = 5`
  ).run(sessionId)
}
