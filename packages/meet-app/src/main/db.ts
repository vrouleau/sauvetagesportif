import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { regenerateCombinedEvents } from './combinedEvents'
import { regeneratePointScores } from './pointScores'

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

export function getPool(): InstanceType<typeof Pool> { return remoteDb() }

// ── Time helpers ──────────────────────────────────────────────────────────────
// DB stores times as integer milliseconds.  Display format: "M:SS.cc" or "SS.cc"

export function msToDisplay(ms: number | null | undefined): string | undefined {
  if (ms == null || ms === 0) return undefined
  // Treat max-int sentinel (2147483647) and unreasonably large values as "no time"
  if (ms >= 2147483647 || ms < 0) return undefined
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

/** OLE Automation epoch: 1899-12-30 in milliseconds since Unix epoch */
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30) // month is 0-indexed

/**
 * Parse an OLE Automation date (or ISO date string) into a YYYY-MM-DD string.
 * Returns undefined if the value is null, zero, or the null sentinel.
 */
function parseOleDate(d: string | number | null): string | undefined {
  if (d == null) return undefined

  if (typeof d === 'number') {
    if (d <= 0 || d === -36522) return undefined // null sentinel or invalid
    const ms = OLE_EPOCH_MS + d * 86400000
    const dt = new Date(ms)
    const y = dt.getUTCFullYear()
    if (y < 1900 || y > 2100) return undefined
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(dt.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const str = String(d).trim()
  // Already an ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10)
  // Stringified OLE double
  const num = parseFloat(str)
  if (!isNaN(num) && num > 0 && num < 200000) {
    const ms = OLE_EPOCH_MS + num * 86400000
    const dt = new Date(ms)
    const y = dt.getUTCFullYear()
    if (y < 1900 || y > 2100) return undefined
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(dt.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return undefined
}

/**
 * Extract birth year from a birthdate value that may be:
 * - An ISO date string like "1978-08-23" or "1978-08-23 00:00:00" (from Lenex import)
 * - A numeric string representing an OLE Automation date (days since 1899-12-30) from SMB restore
 * Returns the 4-digit year, or 2000 as fallback.
 */
function parseBirthYear(birthdate: string | number | null): number {
  if (birthdate == null) return 2000

  // If it's already a number (SQLite may return OLE double as number)
  if (typeof birthdate === 'number') {
    if (birthdate > 0 && birthdate < 200000) {
      const ms = OLE_EPOCH_MS + birthdate * 86400000
      const d = new Date(ms)
      const y = d.getUTCFullYear()
      if (y > 1900 && y < 2100) return y
    }
    return 2000
  }

  const s = String(birthdate).trim()
  // If it looks like an ISO date (starts with 4-digit year followed by '-')
  if (/^\d{4}-/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10)
    if (y > 1900 && y < 2100) return y
  }
  // Otherwise try to interpret as OLE Automation double
  const dbl = parseFloat(s)
  if (!isNaN(dbl) && dbl > 0 && dbl < 200000) {
    const ms = OLE_EPOCH_MS + dbl * 86400000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    if (y > 1900 && y < 2100) return y
  }
  return 2000
}

/**
 * Parse a birthdate value into an ISO date string (YYYY-MM-DD).
 * Handles both ISO strings and OLE Automation doubles.
 */
function parseBirthDate(birthdate: string | number | null): string {
  if (birthdate == null) return '2000-01-01'

  // If it's already a number (SQLite may return OLE double as number)
  if (typeof birthdate === 'number') {
    if (birthdate > 0 && birthdate < 200000) {
      const ms = OLE_EPOCH_MS + birthdate * 86400000
      const d = new Date(ms)
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
    return '2000-01-01'
  }

  const s = String(birthdate).trim()
  // If it looks like an ISO date already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10)
  }
  // Otherwise try to interpret as OLE Automation double
  const dbl = parseFloat(s)
  if (!isNaN(dbl) && dbl > 0 && dbl < 200000) {
    const ms = OLE_EPOCH_MS + dbl * 86400000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return '2000-01-01'
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
  handicapex?: string
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
  finalOrder?: number | null
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
  handicapex?: string
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
    birthdate: string | number | null; nation: string | null; handicapex: string | null
    clubcode: string | null; clubname: string | null; agegroupname: string | null
  }> = []

  if (allHeatIds.length > 0) {
    const hph = allHeatIds.map(() => '?').join(',')
    entries = db.prepare(`
      SELECT r.swimresultid, r.heatid, r.lane,
             r.entrytime, r.swimtime, r.reactiontime, r.resultstatus, r.agegroupid,
             a.athleteid, a.firstname, a.lastname, a.birthdate, a.nation, a.handicapex,
             c.code AS clubcode, c.name AS clubname,
             COALESCE(NULLIF(ag.name, ''), CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || COALESCE(ag.agemax, '+') END, '???') AS agegroupname
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
  const meetTypeRow2 = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  const isBeachMeet = (meetTypeRow2?.data || 'POOL').toUpperCase() === 'BEACH'

  const entryMap = new Map<number, LaneEntryRow[]>()
  for (const r of entries) {
    if (!entryMap.has(r.heatid)) entryMap.set(r.heatid, [])
    const status = decodeResultStatus(r.resultstatus)
    const birthYear = parseBirthYear(r.birthdate)
    // For beach meets, display position as plain integer instead of time format
    const finalTimeDisplay = status ? undefined : (
      isBeachMeet && r.swimtime != null
        ? String(Math.round(r.swimtime / 1000))
        : msToDisplay(r.swimtime)
    )
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
      entryTime: isBeachMeet ? '' : (msToDisplay(r.entrytime) ?? 'NT'),
      finalTime: finalTimeDisplay,
      splitTimes: splitMap.get(r.swimresultid),
      status,
      handicapex: r.handicapex ?? undefined,
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
    SELECT swimsessionid, sessionnumber, name, daytime, startdate, endtime, course,
           lanemin, lanemax, warmupfrom, warmupuntil, officialmeeting,
           remarks, remarksjury, maxentriesathlete, maxentriesrelay,
           feeathlete, timing, touchpadmode, roundtotenths
    FROM swimsession ORDER BY sessionnumber
  `).all() as Array<{
    swimsessionid: number; sessionnumber: number | null; name: string | null
    daytime: string | number | null; startdate: string | number | null
    endtime: string | number | null; course: number | null
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
           e.finalorder, e.maxentries,
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
    eventname: string | null; comment: string | null; finalorder: number | null; maxentries: number | null
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
      id: ag.agegroupid, number: agSeq, name: ag.name || (ag.agemin != null ? `${ag.agemin}-${ag.agemax}` : '???'),
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
      finalOrder: e.finalorder,
      maxEntries: e.maxentries ?? null,
      ageGroups: agMap.get(e.swimeventid) ?? [],
    })
  }

  return sessions.map(s => ({
    id: s.swimsessionid, number: s.sessionnumber ?? 0, name: s.name ?? '',
    date: parseOleDate(s.startdate),
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
           a.handicapex, c.code AS clubcode, c.name AS clubname
    FROM athlete a
    LEFT JOIN club c ON a.clubid = c.clubid
    ORDER BY a.lastname, a.firstname
  `).all() as Array<{
    athleteid: number; firstname: string | null; lastname: string | null
    birthdate: string | number | null; gender: number | null; nation: string | null
    license: string | null; domicile: string | null; handicapex: string | null
    clubcode: string | null; clubname: string | null
  }>

  if (athletes.length === 0) return []
  const athleteIds = athletes.map(r => r.athleteid)
  const aph = athleteIds.map(() => '?').join(',')

  const entries = db.prepare(`
    SELECT r.athleteid, r.swimeventid, r.entrytime,
           COALESCE(NULLIF(ag.name, ''), CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || COALESCE(ag.agemax, '+') END, '???') AS agegroupname,
           e.eventnumber,
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
    birthDate: parseBirthDate(a.birthdate),
    gender: (a.gender === 2 ? 'F' : 'M') as 'M' | 'F',
    nation: a.nation ?? '',
    clubCode: a.clubcode ?? '',
    clubName: a.clubname ?? '',
    licence: a.license ?? undefined,
    birthPlace: a.domicile ?? undefined,
    handicapex: a.handicapex ?? undefined,
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

export function nextId(table: string, pkCol: string): number {
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
  startdate?: string | null
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
  if (data.startdate !== undefined) { sets.push('startdate=?'); vals.push(data.startdate) }
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
  regeneratePointScores(db)
  return id
}

export async function deleteEvent(eventId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(`DELETE FROM swimevent WHERE swimeventid=?`).run(eventId)
  regenerateCombinedEvents(db)
  regeneratePointScores(db)
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
  // Default heatcount: 2 for finals (A+B), 1 otherwise
  const evRound = db.prepare(`SELECT round FROM swimevent WHERE swimeventid=?`).get(eventId) as { round: number | null } | undefined
  const heatcount = evRound?.round === 4 ? 2 : 1
  db.prepare(
    `INSERT INTO agegroup
       (agegroupid, swimeventid, name, agemin, agemax, gender, heatcount, sortcode,
        useformedals, useforscoring, allofficial, agebytotal, forceprelim, seedwithtsonly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'T','T','T','F','F','F')`
  ).run(id, eventId, name, minAge, maxAge, gNum, heatcount, sortcode)
  regenerateCombinedEvents(db)
  regeneratePointScores(db)
  return id
}

export async function deleteAgeGroup(agegroupId: number): Promise<void> {
  const db = getLocalDb()
  db.prepare(`DELETE FROM agegroup WHERE agegroupid=?`).run(agegroupId)
  regenerateCombinedEvents(db)
  regeneratePointScores(db)
}

// ── Write: athlete ────────────────────────────────────────────────────────────

export async function saveAthlete(a: {
  id: number; lastName: string; firstName: string; birthDate: string
  gender: 'M' | 'F'; nation: string; clubCode: string; clubName: string
  licence?: string; birthPlace?: string; handicapex?: string
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
         license=?, domicile=?, clubid=?, handicapex=?
     WHERE athleteid=?`
  ).run(a.firstName, a.lastName, a.birthDate || null, gNum, a.nation,
        a.licence || null, a.birthPlace || null, clubId, a.handicapex || null, a.id)
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

function initLocalSchema(): void {
  const db = getLocalDb()
  for (const ddl of SCHEMA_DDL) {
    db.exec(ddl)
  }
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

  // ── Check if this is a beach meet ──
  const meetTypeRow = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  const isBeachMeet = (meetTypeRow?.data || 'POOL').toUpperCase() === 'BEACH'

  if (isBeachMeet) {
    // Beach mode: random heat assignment, no lanes, max participants from swimstyle.distance
    return generateHeatsBeach(db, eventIds)
  }

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

// ── Beach heat generation ─────────────────────────────────────────────────────

/**
 * Beach mode heat generation:
 * - Max participants per heat = swimstyle.distance
 * - Random assignment (no seeding by time, no lanes)
 * - Athletes are shuffled and distributed into heats
 */
function generateHeatsBeach(
  db: ReturnType<typeof getLocalDb>,
  eventIds: number[],
): GenerateHeatsResult {
  let totalHeats = 0
  let totalAssigned = 0

  for (const evId of eventIds) {
    // Skip events that have any validated heats
    const validatedCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM heat WHERE swimeventid = ? AND racestatus = 5`
    ).get(evId) as { c: number }).c
    if (validatedCount > 0) continue

    // Get max participants from swimevent.maxentries (override) or swimstyle.distance (default)
    const styleRow = db.prepare(`
      SELECT e.maxentries, ss.distance FROM swimevent e
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE e.swimeventid = ?
    `).get(evId) as { maxentries: number | null; distance: number | null } | undefined
    const maxPerHeat = styleRow?.maxentries ?? styleRow?.distance ?? 16

    // Delete existing heats for this event
    db.prepare(`DELETE FROM heat WHERE swimeventid=?`).run(evId)
    db.prepare(`UPDATE swimresult SET heatid=NULL, lane=NULL WHERE swimeventid=?`).run(evId)

    // Get all entries for this event
    const entries = db.prepare(`
      SELECT swimresultid FROM swimresult WHERE swimeventid=? ORDER BY swimresultid
    `).all(evId) as Array<{ swimresultid: number }>

    if (entries.length === 0) continue

    // Shuffle entries randomly (Fisher-Yates)
    const shuffled = [...entries]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    // Distribute into heats
    const numHeats = Math.ceil(shuffled.length / maxPerHeat)
    // Distribute evenly: each heat gets roughly the same number
    const baseSize = Math.floor(shuffled.length / numHeats)
    const remainder = shuffled.length % numHeats

    let idx = 0
    for (let h = 0; h < numHeats; h++) {
      const heatSize = baseSize + (h < remainder ? 1 : 0)
      const heatId = nextId('heat', 'heatid')
      const heatNumber = h + 1

      db.prepare(
        `INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode)
         VALUES (?, ?, ?, 4, ?)`
      ).run(heatId, evId, heatNumber, heatNumber * 100)
      totalHeats++

      for (let i = 0; i < heatSize; i++) {
        const entry = shuffled[idx++]
        // No lane assignment for beach — use sequential number as placeholder
        db.prepare(
          `UPDATE swimresult SET heatid=?, lane=? WHERE swimresultid=?`
        ).run(heatId, i + 1, entry.swimresultid)
        totalAssigned++
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
  qtdate: string | number | null
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
        const qtd = parseOleDate(e.qtdate) // handles both OLE doubles and ISO strings
        if (!qtd) continue
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
  db.exec(`DELETE FROM athlete`)
  db.exec(`DELETE FROM club`)
  // Clear bsglobal but preserve Gemini keys
  const preserved = db.prepare(
    `SELECT name, data FROM bsglobal WHERE name IN ('GEMINI_KEY_FREE', 'GEMINI_KEY_PAID')`
  ).all() as Array<{ name: string; data: string | null }>
  db.exec(`DELETE FROM bsglobal`)
  // Restore preserved keys + set default age_base_date
  const upsert = db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  )
  for (const row of preserved) {
    if (row.data) upsert.run(row.name, row.data)
  }
  const year = new Date().getFullYear()
  upsert.run('AGEDATE', `D;${year}1231000000000`)
}


// ── bsglobal: meet-level key-value store ──────────────────────────────────────

export function getMeetInfo(): { name: string; city: string; nation: string } {
  const db = getLocalDb()
  // Primary source: MEETVALUES (same as real Splash Meet Manager)
  const mv = readMeetValuesFromDb(db)
  if (mv['NAME']) {
    return {
      name: mv['NAME'] ?? '',
      city: mv['CITY'] ?? '',
      nation: mv['NATION'] ?? '',
    }
  }

  // Fall back to separate bsglobal keys (set by Lenex import when no MEETVALUES exists)
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

  // Sync individual bsglobal keys used by getMeetInfo (set by LENEX import)
  const syncStmt = db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  )
  if (updates.NAME) syncStmt.run('MeetName', updates.NAME.value)
  if (updates.CITY) syncStmt.run('MeetCity', updates.CITY.value)
  if (updates.NATION) syncStmt.run('MeetNation', updates.NATION.value)
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
  finalorder?: number | null
  maxentries?: number | null
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
  if (data.finalorder !== undefined) { sets.push('finalorder=?'); vals.push(data.finalorder) }
  if (data.maxentries !== undefined) { sets.push('maxentries=?'); vals.push(data.maxentries) }

  if (sets.length === 0) return
  vals.push(eventId)
  db.prepare(`UPDATE swimevent SET ${sets.join(', ')} WHERE swimeventid=?`).run(...vals)

  // Regenerate combined events when relevant fields change
  if (data.gender !== undefined || data.swimstyleid !== undefined) {
    regenerateCombinedEvents(db)
    regeneratePointScores(db)
  }
}

// ── Write: update age group ───────────────────────────────────────────────────

export interface AgeGroupUpdate {
  name?: string
  agemin?: number
  agemax?: number | null
  gender?: number
  finalseedtype?: number | null
  heatcount?: number
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
  if (data.heatcount !== undefined) { sets.push('heatcount=?'); vals.push(data.heatcount) }

  if (sets.length === 0) return
  vals.push(agegroupId)
  db.prepare(`UPDATE agegroup SET ${sets.join(', ')} WHERE agegroupid=?`).run(...vals)

  // Regenerate combined events when relevant fields change
  if (data.agemin !== undefined || data.agemax !== undefined || data.gender !== undefined) {
    regenerateCombinedEvents(db)
    regeneratePointScores(db)
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

// ── Finals Page ───────────────────────────────────────────────────────────────

export interface FinalEventRow {
  eventId: number
  eventNumber: number
  eventName: string
  gender: 'M' | 'F' | 'X'
  sessionId: number
  sessionNumber: number
  sessionName: string
  prelimEventId: number
  laneCount: number
  heatCount: number          // from agegroup.heatcount (number of final heats: A, B, C...)
  finalOrder: number         // 0=fast-to-slow (A=fastest, swum last), 1=slow-to-fast (A=slowest, swum first)
  qualByPlace: number | null
  /** Summary counts of current qualification state */
  counts: Record<string, number>  // e.g. { A: 8, B: 8, R: 2 }
}

export interface FinalCandidateRow {
  swimresultId: number   // prelim result row
  athleteId: number
  lastName: string
  firstName: string
  clubCode: string
  ageGroupName: string
  prelimTime: string | null   // formatted display time
  prelimTimeMs: number | null // raw ms for sorting
  prelimRank: number
  resultStatus: 'DNS' | 'DNF' | 'DSQ' | null
  qualCode: string | null     // 'A' | 'B' | 'R' | null
  noAdvance: boolean
  finalFix: boolean
}

/** Get all final events (round=4) with their linked prelim event info */
export function getFinalEvents(): FinalEventRow[] {
  const db = getLocalDb()

  const rows = db.prepare(`
    SELECT e.swimeventid, e.eventnumber, e.gender, e.preveventid, e.finalorder,
           e.swimsessionid, e.qualbyplace,
           s.sessionnumber, s.name AS sessionname, s.lanemin, s.lanemax,
           ss.distance, ss.stroke, ss.name AS stylename
    FROM swimevent e
    JOIN swimsession s ON e.swimsessionid = s.swimsessionid
    LEFT JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE e.round = 4 AND e.internalevent = 'F'
    ORDER BY s.sessionnumber, e.sortcode
  `).all() as Array<{
    swimeventid: number; eventnumber: number | null; gender: number | null
    preveventid: number | null; finalorder: number | null
    swimsessionid: number; qualbyplace: number | null
    sessionnumber: number | null; sessionname: string | null
    lanemin: number | null; lanemax: number | null
    distance: number | null; stroke: number | null; stylename: string | null
  }>

  // Get heatcount from the first age group of each final event
  const heatCountStmt = db.prepare(`
    SELECT heatcount FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1
  `)

  // Get qualification counts for each final event (grouped by qualcode letter)
  const countStmt = db.prepare(`
    SELECT qualcode, COUNT(*) AS cnt
    FROM swimresult WHERE swimeventid = ? AND qualcode IS NOT NULL
    GROUP BY qualcode
  `)

  return rows.map(r => {
    const hcRow = heatCountStmt.get(r.swimeventid) as { heatcount: number | null } | undefined
    const heatCount = hcRow?.heatcount ?? 1

    const countRows = countStmt.all(r.swimeventid) as Array<{ qualcode: string; cnt: number }>
    const counts: Record<string, number> = {}
    for (const cr of countRows) {
      counts[cr.qualcode] = cr.cnt
    }

    const laneCount = (r.lanemax ?? 8) - (r.lanemin ?? 1) + 1
    return {
      eventId: r.swimeventid,
      eventNumber: r.eventnumber ?? 0,
      eventName: `${r.distance ?? '?'}m ${eventName(r.stylename, r.stroke)}`.trim(),
      gender: decodeGender(r.gender),
      sessionId: r.swimsessionid,
      sessionNumber: r.sessionnumber ?? 0,
      sessionName: r.sessionname ?? '',
      prelimEventId: r.preveventid ?? 0,
      laneCount,
      heatCount,
      finalOrder: r.finalorder ?? 0,
      qualByPlace: r.qualbyplace,
      counts,
    }
  })
}

/** Get all candidates for a final event (prelim finishers ranked by time) */
export function getFinalCandidates(finalEventId: number): FinalCandidateRow[] {
  const db = getLocalDb()
  const meetTypeRow3 = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  const isBeachMeet3 = (meetTypeRow3?.data || 'POOL').toUpperCase() === 'BEACH'

  // Get the prelim event linked to this final
  const finalEvent = db.prepare(
    `SELECT preveventid FROM swimevent WHERE swimeventid = ?`
  ).get(finalEventId) as { preveventid: number | null } | undefined

  if (!finalEvent?.preveventid) return []
  const prelimEventId = finalEvent.preveventid

  // Get all prelim results with athlete info
  const prelimResults = db.prepare(`
    SELECT r.swimresultid, r.athleteid, r.swimtime, r.resultstatus, r.agegroupid,
           a.lastname, a.firstname, a.birthdate,
           c.code AS clubcode,
           COALESCE(NULLIF(ag.name, ''), CASE WHEN ag.agemin IS NOT NULL THEN ag.agemin || '-' || COALESCE(ag.agemax, '+') END, '???') AS agegroupname
    FROM swimresult r
    JOIN athlete a ON r.athleteid = a.athleteid
    LEFT JOIN club c ON a.clubid = c.clubid
    LEFT JOIN agegroup ag ON r.agegroupid = ag.agegroupid
    WHERE r.swimeventid = ?
    ORDER BY
      CASE WHEN r.resultstatus IS NOT NULL AND r.resultstatus > 0 THEN 1 ELSE 0 END,
      CASE WHEN r.swimtime IS NULL THEN 1 ELSE 0 END,
      r.swimtime ASC
  `).all(prelimEventId) as Array<{
    swimresultid: number; athleteid: number; swimtime: number | null
    resultstatus: number | null; agegroupid: number | null
    lastname: string | null; firstname: string | null; birthdate: string | null
    clubcode: string | null; agegroupname: string | null
  }>

  // Get qualification state from the FINAL event's swimresult rows
  const finalResults = db.prepare(`
    SELECT athleteid, qualcode, noadvance, finalfix
    FROM swimresult WHERE swimeventid = ?
  `).all(finalEventId) as Array<{
    athleteid: number; qualcode: string | null; noadvance: string | null; finalfix: string | null
  }>

  const qualMap = new Map<number, { qualCode: string | null; noAdvance: boolean; finalFix: boolean }>()
  for (const fr of finalResults) {
    qualMap.set(fr.athleteid, {
      qualCode: fr.qualcode || null,
      noAdvance: fr.noadvance === 'T',
      finalFix: fr.finalfix === 'T',
    })
  }

  // Build ranked list
  let rank = 0
  return prelimResults.map(r => {
    const status = decodeResultStatus(r.resultstatus)
    if (!status && r.swimtime != null) rank++
    const qual = qualMap.get(r.athleteid)
    return {
      swimresultId: r.swimresultid,
      athleteId: r.athleteid,
      lastName: r.lastname ?? '',
      firstName: r.firstname ?? '',
      clubCode: r.clubcode ?? '',
      ageGroupName: r.agegroupname ?? '',
      prelimTime: isBeachMeet3 && r.swimtime != null ? String(Math.round(r.swimtime / 1000)) : (msToDisplay(r.swimtime) ?? null),
      prelimTimeMs: r.swimtime,
      prelimRank: status ? 0 : (r.swimtime != null ? rank : 0),
      resultStatus: status,
      qualCode: qual?.qualCode ?? null,
      noAdvance: qual?.noAdvance ?? false,
      finalFix: qual?.finalFix ?? false,
    }
  })
}

/** Set qualification status for an athlete in a final event */
export function setQualification(
  finalEventId: number,
  athleteId: number,
  qualCode: string | null,
  noAdvance: boolean = false,
): void {
  const db = getLocalDb()

  // Check if a swimresult row exists for this athlete on the final event
  const existing = db.prepare(
    `SELECT swimresultid FROM swimresult WHERE swimeventid = ? AND athleteid = ?`
  ).get(finalEventId, athleteId) as { swimresultid: number } | undefined

  if (existing) {
    // Also ensure agegroupid is set if missing
    const currentRow = db.prepare(
      `SELECT agegroupid FROM swimresult WHERE swimresultid = ?`
    ).get(existing.swimresultid) as { agegroupid: number | null } | undefined

    if (!currentRow?.agegroupid) {
      const evRow = db.prepare(
        `SELECT preveventid FROM swimevent WHERE swimeventid = ?`
      ).get(finalEventId) as { preveventid: number | null } | undefined

      let agId: number | null = null
      if (evRow?.preveventid) {
        const pRes = db.prepare(
          `SELECT agegroupid FROM swimresult WHERE swimeventid = ? AND athleteid = ?`
        ).get(evRow.preveventid, athleteId) as { agegroupid: number | null } | undefined
        agId = pRes?.agegroupid ?? null
      }
      if (!agId) {
        const fAg = db.prepare(
          `SELECT agegroupid FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1`
        ).get(finalEventId) as { agegroupid: number } | undefined
        agId = fAg?.agegroupid ?? null
      }

      db.prepare(
        `UPDATE swimresult SET qualcode = ?, noadvance = ?, agegroupid = ? WHERE swimresultid = ?`
      ).run(qualCode || null, noAdvance ? 'T' : 'F', agId, existing.swimresultid)
    } else {
      db.prepare(
        `UPDATE swimresult SET qualcode = ?, noadvance = ? WHERE swimresultid = ?`
      ).run(qualCode || null, noAdvance ? 'T' : 'F', existing.swimresultid)
    }
  } else {
    // Create a new swimresult row on the final event
    // Copy entry time and agegroupid from the prelim result
    const finalEvent = db.prepare(
      `SELECT preveventid FROM swimevent WHERE swimeventid = ?`
    ).get(finalEventId) as { preveventid: number | null } | undefined

    let entryTime: number | null = null
    let agegroupId: number | null = null
    if (finalEvent?.preveventid) {
      const prelimResult = db.prepare(
        `SELECT swimtime, agegroupid FROM swimresult WHERE swimeventid = ? AND athleteid = ?`
      ).get(finalEvent.preveventid, athleteId) as { swimtime: number | null; agegroupid: number | null } | undefined
      entryTime = prelimResult?.swimtime ?? null
      agegroupId = prelimResult?.agegroupid ?? null
    }

    // If no agegroupid from prelim, try to get it from the final event's own age groups
    if (!agegroupId) {
      const finalAg = db.prepare(
        `SELECT agegroupid FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1`
      ).get(finalEventId) as { agegroupid: number } | undefined
      agegroupId = finalAg?.agegroupid ?? null
    }

    const id = nextId('swimresult', 'swimresultid')
    db.prepare(
      `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, entrytime, qualcode, noadvance, agegroupid, usetimetype)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(id, athleteId, finalEventId, entryTime, qualCode || null, noAdvance ? 'T' : 'F', agegroupId)
  }
}

/** Auto-qualify top N athletes into Final A, next N into Final B, etc. based on heatcount, plus 2 reserves */
export function autoQualify(finalEventId: number): { counts: Record<string, number> } {
  const db = getLocalDb()

  // Check if beach meet
  const meetTypeRow4 = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  const isBeachMeet4 = (meetTypeRow4?.data || 'POOL').toUpperCase() === 'BEACH'

  // Get lane count and heat count from event + age group
  const evInfo = db.prepare(`
    SELECT s.lanemin, s.lanemax, e.qualbyplace
    FROM swimevent e
    JOIN swimsession s ON e.swimsessionid = s.swimsessionid
    WHERE e.swimeventid = ?
  `).get(finalEventId) as { lanemin: number | null; lanemax: number | null; qualbyplace: number | null } | undefined

  const hcRow = db.prepare(
    `SELECT heatcount FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1`
  ).get(finalEventId) as { heatcount: number | null } | undefined

  // For beach: capacity per heat comes from swimstyle.distance
  let slotsPerHeat: number
  if (isBeachMeet4) {
    const styleRow = db.prepare(`
      SELECT e.maxentries, ss.distance FROM swimevent e
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE e.swimeventid = ?
    `).get(finalEventId) as { maxentries: number | null; distance: number | null } | undefined
    slotsPerHeat = styleRow?.maxentries ?? styleRow?.distance ?? 16
  } else {
    slotsPerHeat = (evInfo?.lanemax ?? 8) - (evInfo?.lanemin ?? 1) + 1
  }

  const heatCount = hcRow?.heatcount ?? 1
  const reserveCount = 2

  // Heat labels: A, B, C, D, ...
  const HEAT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

  // Get candidates sorted by prelim time
  const candidates = getFinalCandidates(finalEventId)
  const eligible = candidates.filter(c => !c.resultStatus && c.prelimTimeMs != null)

  const counts: Record<string, number> = {}

  const updateOrCreate = db.transaction(() => {
    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i]
      let qualCode: string | null = null

      const heatIndex = Math.floor(i / slotsPerHeat)
      if (heatIndex < heatCount) {
        qualCode = HEAT_LETTERS[heatIndex]
        counts[qualCode] = (counts[qualCode] ?? 0) + 1
      } else if (i < heatCount * slotsPerHeat + reserveCount) {
        qualCode = 'R'
        counts['R'] = (counts['R'] ?? 0) + 1
      } else {
        break // remaining athletes get no qualification
      }

      setQualification(finalEventId, c.athleteId, qualCode, false)
    }
  })

  updateOrCreate()
  return { counts }
}

/** Clear final heats (delete heats, reset lane assignments) but keep qualcode */
export function clearFinalSeeding(finalEventId: number): void {
  const db = getLocalDb()
  db.prepare(`DELETE FROM heat WHERE swimeventid = ?`).run(finalEventId)
  db.prepare(
    `UPDATE swimresult SET heatid = NULL, lane = NULL WHERE swimeventid = ?`
  ).run(finalEventId)
}

/** Seed finals: create heats from qualified athletes using pyramid seeding (center-out) */
export function seedFinals(finalEventId: number): { ok: boolean; heatsCreated: number; assigned: number; overflow: number } {
  const db = getLocalDb()

  // Check if beach meet
  const meetTypeRow5 = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  const isBeachMeet5 = (meetTypeRow5?.data || 'POOL').toUpperCase() === 'BEACH'

  // Get session lane config and final order
  const evInfo = db.prepare(`
    SELECT s.lanemin, s.lanemax, s.lanesbyplace, e.finalorder
    FROM swimevent e
    JOIN swimsession s ON e.swimsessionid = s.swimsessionid
    WHERE e.swimeventid = ?
  `).get(finalEventId) as { lanemin: number | null; lanemax: number | null; lanesbyplace: string | null; finalorder: number | null } | undefined

  const laneMin = evInfo?.lanemin ?? 1
  const laneMax = evInfo?.lanemax ?? 8
  const laneCount = laneMax - laneMin + 1
  const customLaneOrder = parseLanesbyplace(evInfo?.lanesbyplace)
  const finalOrder = evInfo?.finalorder ?? 2 // 1=fast-first (A swum first), 2=slow-first (A swum last, standard)

  // For beach: capacity per heat comes from swimevent.maxentries or swimstyle.distance
  let capacity: number
  if (isBeachMeet5) {
    const styleRow = db.prepare(`
      SELECT e.maxentries, ss.distance FROM swimevent e
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE e.swimeventid = ?
    `).get(finalEventId) as { maxentries: number | null; distance: number | null } | undefined
    capacity = styleRow?.maxentries ?? styleRow?.distance ?? 16
  } else {
    capacity = laneCount
  }

  // Get heat count from age group
  const hcRow = db.prepare(
    `SELECT heatcount FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1`
  ).get(finalEventId) as { heatcount: number | null } | undefined
  const heatCount = hcRow?.heatcount ?? 1

  // Clear existing heats
  clearFinalSeeding(finalEventId)

  // Heat labels: A, B, C, D, ...
  const HEAT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

  // Get qualified athletes for each heat letter, sorted by entry time
  let heatsCreated = 0
  let assigned = 0
  let overflow = 0

  // Determine swimming order based on finalOrder:
  // finalOrder=0 (fast-to-slow): A is fastest, swum LAST → heat numbers: A gets highest heatnumber
  // finalOrder=1 (slow-to-fast): A is slowest, swum FIRST → heat numbers: A gets lowest heatnumber
  const heatLetters: string[] = []
  for (let i = 0; i < heatCount; i++) {
    heatLetters.push(HEAT_LETTERS[i])
  }

  // Determine swimming order based on finalOrder:
  // finalOrder=2 (slow-first): slowest final swum first, A (fastest) swum LAST → standard championship
  // finalOrder=1 (fast-first): A (fastest) swum FIRST, slowest final swum last
  const swimOrder = finalOrder === 1 ? heatLetters : [...heatLetters].reverse()

  for (let swimIdx = 0; swimIdx < swimOrder.length; swimIdx++) {
    const letter = swimOrder[swimIdx]
    const heatNumber = swimIdx + 1 // heat 1 is swum first

    const qualified = db.prepare(`
      SELECT swimresultid, entrytime FROM swimresult
      WHERE swimeventid = ? AND qualcode = ?
      ORDER BY CASE WHEN entrytime IS NULL THEN 1 ELSE 0 END, entrytime ASC
    `).all(finalEventId, letter) as Array<{ swimresultid: number; entrytime: number | null }>

    if (qualified.length === 0) continue

    const heatId = nextId('heat', 'heatid')
    heatsCreated++

    db.prepare(
      `INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode, finalcode)
       VALUES (?, ?, ?, 4, ?, ?)`
    ).run(heatId, finalEventId, heatNumber, heatNumber * 100, letter)

    // Lane assignment: center-out for pool, sequential for beach
    const maxAssign = Math.min(qualified.length, capacity)
    if (qualified.length > capacity) {
      overflow += qualified.length - capacity
    }

    if (isBeachMeet5) {
      // Beach: sequential numbering (no lanes)
      for (let i = 0; i < maxAssign; i++) {
        db.prepare(
          `UPDATE swimresult SET heatid = ?, lane = ? WHERE swimresultid = ?`
        ).run(heatId, i + 1, qualified[i].swimresultid)
        assigned++
      }
    } else {
      // Pool: center-out lane assignment
      const laneOrder = customLaneOrder ?? buildCenterOutLanes(laneMin, laneMax)
      for (let i = 0; i < maxAssign; i++) {
        const lane = laneOrder[i]
        db.prepare(
          `UPDATE swimresult SET heatid = ?, lane = ? WHERE swimresultid = ?`
        ).run(heatId, lane, qualified[i].swimresultid)
        assigned++
      }
    }
  }

  return { ok: overflow === 0, heatsCreated, assigned, overflow }
}

// ── Combined Results Report ───────────────────────────────────────────────────

export interface CombinedResultCategory {
  name: string           // e.g. "Cumulatif 11-12 ans - filles"
  subtitle: string       // e.g. "Filles, 11 - 12 ans"
  athletes: CombinedResultAthlete[]
}

export interface CombinedResultAthlete {
  athleteId: number
  lastName: string
  firstName: string
  age: number
  clubName: string
  totalPoints: number
  eventCount: number
}

/**
 * Parse the COMBINEDEVENTS XML from bsglobal and compute cumulative point
 * standings for each category based on selected event IDs.
 *
 * Algorithm:
 * - Parse COMBINEDEVENTS XML to get category definitions (name, pointsforplaces, event list)
 * - For each category, for each event in the category that is also in selectedEventIds:
 *   - Rank athletes by swimtime (only valid results: no DNS/DNF/DSQ)
 *   - Award points based on place using the pointsforplaces scale
 * - Sum points per athlete, count events completed
 * - Sort by total points descending
 */
export function getCombinedResults(selectedEventIds: number[]): CombinedResultCategory[] {
  const db = getLocalDb()
  const meetYear = new Date().getFullYear()

  // Read COMBINEDEVENTS XML from bsglobal
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name = 'COMBINEDEVENTS'`).get() as { data: string } | undefined
  if (!row || !row.data) return []

  const xml = row.data

  // Parse the XML to extract combined event definitions
  // Each COMBINEDEVENT has: name, pointsforplaces, sortbyresfirst, finalusetype, and child EVENT elements
  const categories: CombinedResultCategory[] = []

  // Simple regex-based XML parsing (no external dep needed)
  const ceRegex = /<COMBINEDEVENT\s([^>]*?)(?:\/>|>([\s\S]*?)<\/COMBINEDEVENT>)/g
  let ceMatch: RegExpExecArray | null

  while ((ceMatch = ceRegex.exec(xml)) !== null) {
    const attrs = ceMatch[1]
    const body = ceMatch[2] ?? ''

    const nameMatch = attrs.match(/name="([^"]*)"/)
    const pointsMatch = attrs.match(/pointsforplaces="([^"]*)"/)
    const sortbyresfirstMatch = attrs.match(/sortbyresfirst="([^"]*)"/)

    if (!nameMatch || !pointsMatch) continue

    const categoryName = nameMatch[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    const pointsScale = pointsMatch[1].split(',').map(Number)
    const sortByResFirst = sortbyresfirstMatch?.[1] === 'T'

    // Extract event IDs from child EVENT elements
    const eventIds: number[] = []
    const evRegex = /eventid="(\d+)"/g
    let evMatch: RegExpExecArray | null
    while ((evMatch = evRegex.exec(body)) !== null) {
      eventIds.push(Number(evMatch[1]))
    }

    // Filter to only selected events
    const filteredEventIds = eventIds.filter(id => selectedEventIds.includes(id))

    // If no events match (either no events defined or none selected), still show the category header
    // but with empty athletes (like "Cumulatif 10 ans et moins - garçons" which is a special no-events category)
    if (filteredEventIds.length === 0 && eventIds.length === 0) {
      // Special category with no events — just show the title
      categories.push({ name: categoryName, subtitle: '', athletes: [] })
      continue
    }

    if (filteredEventIds.length === 0) {
      // Category has events but none are selected — skip
      continue
    }

    // Build subtitle from the age group of the first event
    const firstEventId = filteredEventIds[0]
    const agRow = db.prepare(
      `SELECT ag.agemin, ag.agemax, ag.gender
       FROM agegroup ag WHERE ag.swimeventid = ? ORDER BY ag.sortcode LIMIT 1`
    ).get(firstEventId) as { agemin: number; agemax: number; gender: number } | undefined

    let subtitle = ''
    if (agRow) {
      const genderPrefix = agRow.gender === 2
        ? (agRow.agemin >= 15 ? 'Dames' : 'Filles')
        : agRow.gender === 1
          ? (agRow.agemin >= 15 ? 'Messieurs' : 'Garçons')
          : (agRow.agemin >= 15 ? 'Mixte' : 'Tous')
      const ageRange = (agRow.agemax === -1 || agRow.agemax === 99)
        ? `${agRow.agemin} ans et plus`
        : `${agRow.agemin} - ${agRow.agemax} ans`
      subtitle = `${genderPrefix}, ${ageRange}`
    }

    // For each event, compute places and award points
    const athletePoints = new Map<number, { totalPoints: number; eventCount: number }>()
    const athleteInfo = new Map<number, { lastName: string; firstName: string; birthdate: string | number | null; clubName: string }>()

    for (const eventId of filteredEventIds) {
      // Get all valid results for this event, ordered by time
      const results = db.prepare(`
        SELECT r.athleteid, r.swimtime, r.resultstatus,
               a.lastname, a.firstname, a.birthdate,
               COALESCE(c.shortname, c.code, c.name, '') AS clubname
        FROM swimresult r
        JOIN athlete a ON r.athleteid = a.athleteid
        LEFT JOIN club c ON a.clubid = c.clubid
        WHERE r.swimeventid = ?
          AND r.swimtime IS NOT NULL
          AND r.swimtime > 0
          AND (r.resultstatus IS NULL OR r.resultstatus = 0)
        ORDER BY r.swimtime ASC
      `).all(eventId) as Array<{
        athleteid: number; swimtime: number; resultstatus: number | null
        lastname: string; firstname: string; birthdate: string | number | null
        clubname: string
      }>

      // Award points based on place
      let place = 0
      let lastTime: number | null = null
      let sameTimeCount = 0

      for (let i = 0; i < results.length; i++) {
        const r = results[i]

        if (r.swimtime !== lastTime) {
          place = i + 1
          sameTimeCount = 1
          lastTime = r.swimtime
        } else {
          sameTimeCount++
        }

        // Points for this place (0-indexed in the scale)
        const pts = (place - 1 < pointsScale.length) ? pointsScale[place - 1] : 0

        if (pts > 0) {
          const existing = athletePoints.get(r.athleteid) ?? { totalPoints: 0, eventCount: 0 }
          existing.totalPoints += pts
          existing.eventCount += 1
          athletePoints.set(r.athleteid, existing)
        } else {
          // Still count the event even if 0 points
          const existing = athletePoints.get(r.athleteid) ?? { totalPoints: 0, eventCount: 0 }
          existing.eventCount += 1
          athletePoints.set(r.athleteid, existing)
        }

        // Store athlete info
        if (!athleteInfo.has(r.athleteid)) {
          athleteInfo.set(r.athleteid, {
            lastName: r.lastname ?? '',
            firstName: r.firstname ?? '',
            birthdate: r.birthdate,
            clubName: r.clubname ?? '',
          })
        }
      }
    }

    // Build sorted athlete list (exclude athletes with 0 points)
    const athletes: CombinedResultAthlete[] = []
    for (const [athleteId, pts] of athletePoints) {
      if (pts.totalPoints <= 0) continue
      const info = athleteInfo.get(athleteId)!
      const age = meetYear - parseBirthYear(info.birthdate)
      athletes.push({
        athleteId,
        lastName: info.lastName,
        firstName: info.firstName,
        age,
        clubName: info.clubName,
        totalPoints: pts.totalPoints,
        eventCount: pts.eventCount,
      })
    }

    // Sort: by total points descending, then by name for ties
    if (sortByResFirst) {
      // sortbyresfirst = T means sort by results first (used for special categories)
      athletes.sort((a, b) => b.totalPoints - a.totalPoints || a.lastName.localeCompare(b.lastName))
    } else {
      athletes.sort((a, b) => b.totalPoints - a.totalPoints || a.lastName.localeCompare(b.lastName))
    }

    categories.push({ name: categoryName, subtitle, athletes })
  }

  return categories
}

/** Build center-out lane order for a given lane range */
function buildCenterOutLanes(laneMin: number, laneMax: number): number[] {
  const laneCount = laneMax - laneMin + 1
  const center = Math.floor((laneMin + laneMax) / 2)
  const lanes: number[] = [center]
  let left = center - 1
  let right = center + 1

  // If even number of lanes, start with right of center
  if (laneCount % 2 === 0) {
    lanes.push(center + 1)
    right = center + 2
  }

  while (lanes.length < laneCount) {
    if (left >= laneMin) lanes.push(left--)
    if (right <= laneMax && lanes.length < laneCount) lanes.push(right++)
  }

  return lanes
}
