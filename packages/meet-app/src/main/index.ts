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

import { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, Menu, session } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'

// Set app name early so userData path is consistent in dev and production
// Use a separate name in dev to isolate appdata from the installed app
app.setName(app.isPackaged ? 'SauvetageMeet' : 'SauvetageMeet-Dev')

import { QuantumBridge, type ActiveHeat, type ScheduleEvent } from './quantum'
import {
  getHeatListEvents, getHeatListSessions, getSessions, getAthletes,
  saveResult,
  removeFromHeat, assignToHeatLane, swapLanes, addLateEntry,
  getAvailableAthletesForEvent,
  createSession, deleteSession, updateSession,
  createBreak,
  createEvent, deleteEvent, updateEvent,
  createAgeGroup, deleteAgeGroup, updateAgeGroup,
  saveAthlete,
  flushMeet,
  generateHeats,
  getLocalDb, closeLocalDb,
  getMeetValues, setMeetValues,
  getMeetInfo,
  getSwimStyles,
  reorderEvents,
  validateHeat, invalidateHeat,
  validateEvent, invalidateEvent, validateSession, invalidateSession,
  getFinalEvents, getFinalCandidates, setQualification, autoQualify,
  clearFinalSeeding, seedFinals,
  getCombinedResults,
  getBeachNumberReport,
  getEntriesByEvent,
  getPointStandings,
  nextId,
  duplicateEvent,
  type SessionUpdate,
  type EventUpdate,
  type AgeGroupUpdate,
} from './db'
import { importLenex, exportLenexResults, exportMeetLenex } from './lenex'
import { saveSMB, restoreSMB } from './smb'
import { regenerateCombinedEvents } from './combinedEvents'
import { regeneratePointScores } from './pointScores'
import {
  closeScanDb, insertScan, getUnprocessedScans,
  getScansForHeat, getScanById, findExistingScan,
  updateScanOcrResult, validateScan,
  getScanSummary, getValidatedScansForHeat, getScansByStatus,
  clearAllScans, deleteScan,
  type ScanStatus,
} from './timingScanDb'
import { generateTimingSheetsHtml, buildTimingSheetPages } from './timingSheets'
import { type OcrEngine } from './ocrEngine'
import { startGeminiBackground, setGeminiBackgroundEnabled, isGeminiBackgroundEnabled, resetGeminiAttempted } from './geminiBackground'
import { GeminiOcrEngine, getCurrentGeminiTier, loadGeminiKeys, saveGeminiKeys } from './ocrGemini'
import {
  connectToPg, disconnectPg, getConnectionInfo, restoreSavedConnection, isPgConnected,
} from './connectionManager'
import type { PgConnectionConfig } from './pgBackend'
import { livePush } from './livePush'

let quantum: QuantumBridge | null = null

// ── DSQ code seeding ──────────────────────────────────────────────────────────

function getDsqConfigPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'dsq-codes.json')
    : join(__dirname, '../../../../config/dsq-codes.json')
}

/**
 * Seed dsqitem table from config/dsq-codes.json.
 * @param db - database handle (SQLite or PG-like)
 * @param meetType - 'pool' or 'beach'
 * @param lang - app language ('fr' or 'en'); determines which translation goes into the `name` column
 */
function seedDsqCodes(db: ReturnType<typeof getLocalDb>, meetType: string, lang: string = 'fr'): void {
  try {
    const configPath = getDsqConfigPath()

    const { readFileSync, existsSync } = require('fs')
    if (!existsSync(configPath)) {
      console.warn('[DSQ] Config file not found:', configPath)
      return
    }

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const codes: Array<{ code: string; name_fr: string; name_en?: string; options?: string }> =
      meetType === 'beach' ? (config.beach || []) : (config.pool || [])

    if (codes.length === 0) return

    // ID ranges: pool 4001-4099, beach 4101-4199
    const baseId = meetType === 'beach' ? 4101 : 4001

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO dsqitem (dsqitemid, code, lenexcode, name, options, sortcode)
       VALUES (?, ?, ?, ?, ?, ?)`
    )

    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      // Use the language-appropriate name based on the current app toggle
      const name = (lang === 'en' && c.name_en) ? c.name_en : c.name_fr
      stmt.run(baseId + i, c.code, c.code, name, c.options || 'INDIVIDUAL,RELAY', i + 1)
    }


  } catch (e) {
    console.error('[DSQ] Error seeding codes:', e)
  }
}

// ── Quantum IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('quantum:configure', (_event, folder: string) => {
  quantum?.configure(folder)
  return { ok: true }
})

ipcMain.handle('quantum:activate-heat', (_event, data: ActiveHeat) => {
  quantum?.setActiveHeat(data)
  return { ok: true }
})

ipcMain.handle('quantum:set-schedule', (_event, events: ScheduleEvent[]) => {
  quantum?.setSchedule(events)
  return { ok: true }
})

// ── DB IPC ────────────────────────────────────────────────────────────────────

// ── DB IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle('db:heat-list-events', () => getHeatListEvents())

ipcMain.handle('db:heat-list-sessions', () => getHeatListSessions())

ipcMain.handle('db:sessions', () => getSessions())

ipcMain.handle('db:athletes', () => getAthletes())

// Quick fingerprint for change-detection polling (PG mode)
ipcMain.handle('db:fingerprint', () => {
  if (!isPgConnected()) return null
  const db = getLocalDb()
  // Use MAX(xmin) across key tables — xmin changes on any INSERT or UPDATE
  const row = db.prepare(`
    SELECT
      (SELECT MAX(xmin::text::bigint) FROM swimsession) AS s_xmin,
      (SELECT MAX(xmin::text::bigint) FROM swimevent) AS e_xmin,
      (SELECT MAX(xmin::text::bigint) FROM heat) AS h_xmin,
      (SELECT MAX(xmin::text::bigint) FROM swimresult) AS r_xmin,
      (SELECT MAX(xmin::text::bigint) FROM athlete) AS a_xmin,
      (SELECT MAX(xmin::text::bigint) FROM agegroup) AS ag_xmin,
      (SELECT COUNT(*) FROM swimresult) AS r_count,
      (SELECT COUNT(*) FROM heat) AS h_count
  `).get() as Record<string, number>
  return row
})

ipcMain.handle('db:save-result', (
  _event,
  swimresultId: number,
  finalTime: string | undefined,
  reactionTimeSecs: number | null,
  status: 'DNS' | 'DNF' | 'DSQ' | null,
  splits: Record<number, string> | undefined,
  dsqItemId?: number | null,
) => saveResult(swimresultId, finalTime, reactionTimeSecs, status, splits, dsqItemId))

ipcMain.handle('db:create-session', (_event, name: string, number: number) =>
  createSession(name, number).then(id => ({ id }))
)

ipcMain.handle('db:update-session', (_event, sessionId: number, data: SessionUpdate) =>
  updateSession(sessionId, data).then(() => ({ ok: true }))
)

ipcMain.handle('db:delete-session', (_event, sessionId: number) =>
  deleteSession(sessionId).then(() => ({ ok: true }))
)

ipcMain.handle('db:create-break', (_event, sessionId: number, number: number, name: string) =>
  createBreak(sessionId, number, name).then(id => ({ id }))
)

ipcMain.handle('db:create-event', (
  _event,
  sessionId: number, number: number,
  gender: 'M' | 'F' | 'X', distance: number,
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe', styleName: string,
) => createEvent(sessionId, number, gender, distance, phase, styleName).then(id => ({ id })))

ipcMain.handle('db:delete-event', (_event, eventId: number) =>
  deleteEvent(eventId).then(() => ({ ok: true }))
)

ipcMain.handle('db:duplicate-event', (_event, sourceEventId: number, targetSessionId: number) =>
  duplicateEvent(sourceEventId, targetSessionId).then(id => ({ id }))
)

ipcMain.handle('db:update-event', (_event, eventId: number, data: EventUpdate) =>
  updateEvent(eventId, data).then(() => ({ ok: true }))
)

ipcMain.handle('db:create-age-group', (
  _event,
  eventId: number, name: string,
  minAge: number, maxAge: number | null, gender: 'M' | 'F' | 'X',
) => createAgeGroup(eventId, name, minAge, maxAge, gender).then(id => ({ id })))

ipcMain.handle('db:delete-age-group', (_event, agegroupId: number) =>
  deleteAgeGroup(agegroupId).then(() => ({ ok: true }))
)

ipcMain.handle('db:update-age-group', (_event, agegroupId: number, data: AgeGroupUpdate) =>
  updateAgeGroup(agegroupId, data).then(() => ({ ok: true }))
)

ipcMain.handle('db:get-meet-config', () => getMeetValues())

ipcMain.handle('db:set-meet-config', (_event, entries: Record<string, { type: string; value: string }>) => {
  setMeetValues(entries)
  // Reload live push config in case LIVE_URL was changed
  livePush.reload(getLocalDb())
  return { ok: true }
})

// ── Live push IPC ─────────────────────────────────────────────────────────────

ipcMain.handle('live:get-status', () => {
  return { status: livePush.getStatus(), queueSize: livePush.getQueueSize() }
})

ipcMain.handle('live:push-all', () => {
  livePush.pushAll(getLocalDb())
  return { ok: true }
})

ipcMain.handle('live:announce', (_event, payload: { type: 'call_to_marshall' | 'call_to_scratch'; event_id: number; event_number: number; event_name: string; gender: string }) => {
  livePush.notifyAnnouncement(payload)
  return { ok: true }
})

ipcMain.handle('db:get-swim-styles', () => getSwimStyles())

ipcMain.handle('db:get-meet-type', () => {
  const db = getLocalDb()
  const row = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
  return (row?.data || 'POOL').toUpperCase()
})

ipcMain.handle('db:get-dsq-items', () => {
  const db = getLocalDb()
  try {
    return db.prepare(`SELECT dsqitemid, code, name, options, sortcode FROM dsqitem WHERE code IS NOT NULL AND code != '' ORDER BY sortcode`).all()
  } catch {
    return []
  }
})

ipcMain.handle('db:register', (_event, data: { athlete_id: number; event_id: number; entry_time_ms: number | null; age_code: string }) => {
  const db = getLocalDb()
  // Check if already registered
  const existing = db.prepare(
    `SELECT swimresultid FROM swimresult WHERE athleteid = ? AND swimeventid = ?`
  ).get(data.athlete_id, data.event_id) as { swimresultid: number } | undefined
  if (existing) {
    // Update entry time
    db.prepare(`UPDATE swimresult SET entrytime = ? WHERE swimresultid = ?`).run(data.entry_time_ms, existing.swimresultid)
    return { ok: true, id: existing.swimresultid }
  }
  // Find the best matching age group for this event
  // Try to match by age range based on athlete's birthdate
  const athlete = db.prepare(`SELECT birthdate FROM athlete WHERE athleteid = ?`).get(data.athlete_id) as { birthdate: string | number | null } | undefined
  let agegroupId: number | null = null

  const ageGroups = db.prepare(
    `SELECT agegroupid, agemin, agemax FROM agegroup WHERE swimeventid = ? ORDER BY sortcode`
  ).all(data.event_id) as Array<{ agegroupid: number; agemin: number | null; agemax: number | null }>

  if (ageGroups.length === 1) {
    agegroupId = ageGroups[0].agegroupid
  } else if (ageGroups.length > 1 && athlete?.birthdate) {
    // Calculate athlete age
    const bd = typeof athlete.birthdate === 'string' ? new Date(athlete.birthdate) : null
    if (bd && !isNaN(bd.getTime())) {
      const now = new Date()
      let age = now.getFullYear() - bd.getFullYear()
      if (now.getMonth() < bd.getMonth() || (now.getMonth() === bd.getMonth() && now.getDate() < bd.getDate())) age--
      // Find matching age group
      for (const ag of ageGroups) {
        const min = ag.agemin ?? 0
        const max = ag.agemax == null || ag.agemax < 0 ? 999 : ag.agemax
        if (age >= min && age <= max) {
          agegroupId = ag.agegroupid
          break
        }
      }
    }
    if (!agegroupId) agegroupId = ageGroups[0].agegroupid
  } else if (ageGroups.length > 0) {
    agegroupId = ageGroups[0].agegroupid
  }

  const id = nextId('swimresult', 'swimresultid')
  db.prepare(
    `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, usetimetype)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(id, data.athlete_id, data.event_id, agegroupId, data.entry_time_ms)
  return { ok: true, id }
})

ipcMain.handle('db:unregister', (_event, athleteId: number, eventId: number) => {
  const db = getLocalDb()
  db.prepare(
    `DELETE FROM swimresult WHERE athleteid = ? AND swimeventid = ? AND heatid IS NULL`
  ).run(athleteId, eventId)
  return { ok: true }
})

ipcMain.handle('db:get-relay-members', (_event, relayId: number) => {
  const db = getLocalDb()
  const rows = db.prepare(
    `SELECT rp.relaynumber, rp.athleteid, a.firstname, a.lastname, a.nameprefix
     FROM relayposition rp
     LEFT JOIN athlete a ON rp.athleteid = a.athleteid
     WHERE rp.relayid = ?
     ORDER BY rp.relaynumber`
  ).all(relayId) as Array<{ relaynumber: number; athleteid: number; firstname: string | null; lastname: string | null; nameprefix: string | null }>
  return rows.map(r => ({ position: r.relaynumber, athleteId: r.athleteid, name: `${r.lastname}, ${r.firstname}`, beachNumber: r.nameprefix || undefined }))
})

ipcMain.handle('db:get-relay-members-by-event', (_event, eventId: number, athleteId: number) => {
  const db = getLocalDb()
  const athRow = db.prepare(`SELECT clubid FROM athlete WHERE athleteid = ?`).get(athleteId) as { clubid: number | null } | undefined
  const clubId = athRow?.clubid ?? 0
  const relay = db.prepare(
    `SELECT relayid FROM relay WHERE swimeventid = ? AND clubid = ?`
  ).get(eventId, clubId) as { relayid: number } | undefined
  if (!relay) return []
  const rows = db.prepare(
    `SELECT rp.relaynumber, rp.athleteid
     FROM relayposition rp
     WHERE rp.relayid = ?
     ORDER BY rp.relaynumber`
  ).all(relay.relayid) as Array<{ relaynumber: number; athleteid: number }>
  return rows.map(r => ({ position: r.relaynumber, athleteId: r.athleteid }))
})

ipcMain.handle('db:set-relay-member', (_event, eventId: number, athleteId: number, position: number, memberAthleteId: number | null) => {
  const db = getLocalDb()

  // Get the club from the athlete
  const athRow = db.prepare(`SELECT clubid FROM athlete WHERE athleteid = ?`).get(athleteId) as { clubid: number | null } | undefined
  const clubId = athRow?.clubid ?? 0

  // Find or create the relay entry for this club+event
  let relay = db.prepare(
    `SELECT relayid FROM relay WHERE swimeventid = ? AND clubid = ?`
  ).get(eventId, clubId) as { relayid: number } | undefined

  if (!relay) {
    const relayId = nextId('relay', 'relayid')
    const agRow = db.prepare(
      `SELECT agegroupid FROM agegroup WHERE swimeventid = ? ORDER BY sortcode LIMIT 1`
    ).get(eventId) as { agegroupid: number } | undefined
    db.prepare(
      `INSERT INTO relay (relayid, clubid, swimeventid, agegroupid, teamnumber) VALUES (?, ?, ?, ?, 1)`
    ).run(relayId, clubId, eventId, agRow?.agegroupid ?? null)
    relay = { relayid: relayId }
  }

  // Remove existing position entry
  db.prepare(
    `DELETE FROM relayposition WHERE relayid = ? AND relaynumber = ?`
  ).run(relay.relayid, position)

  // Insert new member if provided
  if (memberAthleteId) {
    db.prepare(
      `INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (?, ?, ?)`
    ).run(relay.relayid, position, memberAthleteId)
  }

  return { ok: true, relayId: relay.relayid }
})

// ── Relay Team Management (new team-centric handlers) ─────────────────────────

/**
 * Parse DEADLINE from MEETVALUES. Returns ISO date string (YYYY-MM-DD) or null.
 */
function parseDeadline(raw: string | undefined): string | null {
  if (!raw || raw.length < 8) return null
  const y = raw.slice(0, 4)
  const m = raw.slice(4, 6)
  const d = raw.slice(6, 8)
  return `${y}-${m}-${d}`
}

/**
 * Convert team number (1-based) to letter: 1=A, 2=B, etc.
 */
function teamNumberToLetter(n: number): string {
  return String.fromCharCode(64 + n) // 65='A'
}

/**
 * Build the ageCode string from agemin/agemax.
 */
function buildAgeCode(agemin: number | null, agemax: number | null): string {
  const min = agemin ?? 0
  if (agemax == null || agemax < 0 || agemax >= 99) return `${min}+`
  return `${min}-${agemax}`
}

/**
 * Decode event gender: 1=M 2=F 3=X
 */
function decodeRelayGender(g: number | null): 'M' | 'F' | 'X' {
  if (g === 1) return 'M'
  if (g === 2) return 'F'
  return 'X'
}

ipcMain.handle('db:get-clubs', () => {
  const db = getLocalDb()
  const rows = db.prepare(
    `SELECT c.clubid, c.name, c.code,
            (SELECT COUNT(*) FROM athlete a WHERE a.clubid = c.clubid) AS athlete_count
     FROM club c ORDER BY c.name, c.code`
  ).all() as Array<{ clubid: number; name: string | null; code: string | null; athlete_count: number }>
  return rows.map(r => ({
    id: r.clubid,
    name: r.name || r.code || String(r.clubid),
    athlete_count: r.athlete_count,
  }))
})

ipcMain.handle('db:get-relay-page-data', (_event, clubId?: number) => {
  const db = getLocalDb()
  const meetValues = getMeetValues()
  const closureDate = parseDeadline(meetValues['DEADLINE'])
  const isClosed = closureDate ? new Date() > new Date(closureDate + 'T23:59:59') : false

  // 1. Get all relay events (relaycount > 1) with their swim styles
  const relayEvents = db.prepare(`
    SELECT e.swimeventid, e.eventnumber, e.gender AS eventgender, e.swimstyleid,
           ss.distance, ss.relaycount, ss.name AS stylename
    FROM swimevent e
    JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE ss.relaycount > 1
      AND (e.internalevent IS NULL OR e.internalevent = 'F')
    ORDER BY e.eventnumber
  `).all() as Array<{
    swimeventid: number; eventnumber: number; eventgender: number; swimstyleid: number
    distance: number | null; relaycount: number; stylename: string | null
  }>

  if (relayEvents.length === 0) {
    return {
      ageCategories: [],
      teamsByEvent: {},
      eligibleAthletes: {},
      closureDate,
      isClosed,
    }
  }

  // 2. Get all age groups for these relay events
  const eventIds = relayEvents.map(e => e.swimeventid)
  const placeholders = eventIds.map(() => '?').join(',')
  const ageGroups = db.prepare(`
    SELECT agegroupid, swimeventid, name, agemin, agemax, gender, sortcode
    FROM agegroup
    WHERE swimeventid IN (${placeholders})
    ORDER BY swimeventid, sortcode
  `).all(...eventIds) as Array<{
    agegroupid: number; swimeventid: number; name: string | null
    agemin: number | null; agemax: number | null; gender: number | null; sortcode: number | null
  }>

  // 3. Build age categories and event groups
  // Group age groups by their age range to form categories
  const ageCategoryMap = new Map<string, {
    ageCode: string; ageMin: number; ageMax: number | null
    events: Array<{
      eventId: number; eventName: string; swimstyleId: number
      relaycount: number; gender: 'M' | 'F' | 'X'; eventNumber: number
      agegroupid: number
    }>
  }>()

  for (const ag of ageGroups) {
    const ev = relayEvents.find(e => e.swimeventid === ag.swimeventid)
    if (!ev) continue

    const ageCode = buildAgeCode(ag.agemin, ag.agemax)
    if (!ageCategoryMap.has(ageCode)) {
      ageCategoryMap.set(ageCode, {
        ageCode,
        ageMin: ag.agemin ?? 0,
        ageMax: (ag.agemax == null || ag.agemax < 0 || ag.agemax >= 99) ? null : ag.agemax,
        events: [],
      })
    }

    const category = ageCategoryMap.get(ageCode)!
    // Avoid duplicates (same event in same category)
    if (!category.events.some(e => e.eventId === ev.swimeventid)) {
      category.events.push({
        eventId: ev.swimeventid,
        eventName: ev.stylename || `${ev.distance}m Relay`,
        swimstyleId: ev.swimstyleid,
        relaycount: ev.relaycount,
        gender: decodeRelayGender(ev.eventgender),
        eventNumber: ev.eventnumber ?? 0,
        agegroupid: ag.agegroupid,
      })
    }
  }

  // Sort age categories by ageMin ascending
  const ageCategories = Array.from(ageCategoryMap.values())
    .sort((a, b) => a.ageMin - b.ageMin)
    .map(cat => ({
      ageCode: cat.ageCode,
      ageMin: cat.ageMin,
      ageMax: cat.ageMax,
      events: cat.events
        .sort((a, b) => a.eventNumber - b.eventNumber)
        .map(e => ({
          eventId: e.eventId,
          eventName: e.eventName,
          swimstyleId: e.swimstyleId,
          relaycount: e.relaycount,
          gender: e.gender,
          eventNumber: e.eventNumber,
        })),
    }))

  // 4. Load existing relay teams
  const teamsByEvent: Record<string, Array<{
    id: number; teamNumber: string; teamName: string | null
    ageGroup?: string
    members: Array<{ position: number; athleteId: number | null; athleteName: string | null }>
    clubId?: number; clubName?: string
  }>> = {}

  // Build a lookup for agegroupid -> ageCode
  const agegroupToAgeCode = new Map<number, string>()
  for (const ag of ageGroups) {
    agegroupToAgeCode.set(ag.agegroupid, buildAgeCode(ag.agemin, ag.agemax))
  }

  // Query relays
  let relayQuery = `
    SELECT r.relayid, r.clubid, r.swimeventid, r.agegroupid, r.teamnumber, r.name
    FROM relay r
    WHERE r.swimeventid IN (${placeholders})
  `
  const relayParams: unknown[] = [...eventIds]
  if (clubId != null) {
    relayQuery += ` AND r.clubid = ?`
    relayParams.push(clubId)
  }
  relayQuery += ` ORDER BY r.swimeventid, r.teamnumber`

  const relays = db.prepare(relayQuery).all(...relayParams) as Array<{
    relayid: number; clubid: number; swimeventid: number
    agegroupid: number | null; teamnumber: number | null; name: string | null
  }>

  // Load all relay positions for these relays
  const relayIds = relays.map(r => r.relayid)
  let positions: Array<{ relayid: number; relaynumber: number; athleteid: number; firstname: string | null; lastname: string | null }> = []
  if (relayIds.length > 0) {
    const rph = relayIds.map(() => '?').join(',')
    positions = db.prepare(`
      SELECT rp.relayid, rp.relaynumber, rp.athleteid, a.firstname, a.lastname
      FROM relayposition rp
      LEFT JOIN athlete a ON rp.athleteid = a.athleteid
      WHERE rp.relayid IN (${rph})
      ORDER BY rp.relayid, rp.relaynumber
    `).all(...relayIds) as typeof positions
  }

  // Group positions by relayid
  const positionsByRelay = new Map<number, typeof positions>()
  for (const p of positions) {
    if (!positionsByRelay.has(p.relayid)) positionsByRelay.set(p.relayid, [])
    positionsByRelay.get(p.relayid)!.push(p)
  }

  // Build club names lookup for admin all-clubs view
  const clubNamesMap = new Map<number, string>()
  if (clubId == null) {
    const clubIds = [...new Set(relays.map(r => r.clubid).filter(Boolean))]
    if (clubIds.length > 0) {
      const cph = clubIds.map(() => '?').join(',')
      const clubs = db.prepare(`SELECT clubid, name, code FROM club WHERE clubid IN (${cph})`).all(...clubIds) as Array<{ clubid: number; name: string | null; code: string | null }>
      for (const c of clubs) {
        clubNamesMap.set(c.clubid, c.name || c.code || String(c.clubid))
      }
    }
  }

  // Build teamsByEvent
  // First, compute each athlete's registered age group from their individual entries
  const athleteAgeGroupMap = new Map<number, string>() // athleteId → age code
  {
    // Get the dominant age group per athlete (from their individual swimresult registrations)
    const regRows = db.prepare(`
      SELECT sr.athleteid, ag.agemin, ag.agemax, COUNT(*) as cnt
      FROM swimresult sr
      JOIN agegroup ag ON sr.agegroupid = ag.agegroupid
      JOIN swimevent e ON sr.swimeventid = e.swimeventid
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE ss.relaycount = 1
      GROUP BY sr.athleteid, ag.agemin, ag.agemax
      ORDER BY sr.athleteid, cnt DESC
    `).all() as Array<{ athleteid: number; agemin: number | null; agemax: number | null; cnt: number }>

    // For each athlete, take their most common age group registration
    const seen = new Set<number>()
    for (const row of regRows) {
      if (seen.has(row.athleteid)) continue // already picked most common (ORDER BY cnt DESC)
      seen.add(row.athleteid)
      athleteAgeGroupMap.set(row.athleteid, buildAgeCode(row.agemin, row.agemax))
    }
  }

  for (const r of relays) {
    const ageCode = r.agegroupid ? (agegroupToAgeCode.get(r.agegroupid) ?? 'Open') : 'Open'
    const key = `${r.swimeventid}-${ageCode}`
    if (!teamsByEvent[key]) teamsByEvent[key] = []

    // Find relaycount for this event
    const ev = relayEvents.find(e => e.swimeventid === r.swimeventid)
    const relaycount = ev?.relaycount ?? 4

    // Build members list (fill empty positions)
    const relayPositions = positionsByRelay.get(r.relayid) ?? []
    const members: Array<{ position: number; athleteId: number | null; athleteName: string | null }> = []
    for (let pos = 1; pos <= relaycount; pos++) {
      const rp = relayPositions.find(p => p.relaynumber === pos)
      if (rp) {
        members.push({
          position: pos,
          athleteId: rp.athleteid,
          athleteName: rp.lastname || rp.firstname ? `${rp.lastname ?? ''}, ${rp.firstname ?? ''}` : null,
        })
      } else {
        members.push({ position: pos, athleteId: null, athleteName: null })
      }
    }

    // Compute team age group from members' individual registrations (majority rule)
    const memberAgeCodes: string[] = []
    for (const m of members) {
      if (m.athleteId) {
        const ac = athleteAgeGroupMap.get(m.athleteId)
        if (ac) memberAgeCodes.push(ac)
      }
    }
    let computedAgeGroup = ageCode // fallback to event agegroup
    if (memberAgeCodes.length > 0) {
      // Find the most common age code
      const counts = new Map<string, number>()
      for (const ac of memberAgeCodes) counts.set(ac, (counts.get(ac) ?? 0) + 1)
      let maxCount = 0
      for (const [ac, cnt] of counts) {
        if (cnt > maxCount) { maxCount = cnt; computedAgeGroup = ac }
      }
    }

    teamsByEvent[key].push({
      id: r.relayid,
      teamNumber: teamNumberToLetter(r.teamnumber ?? 1),
      teamName: r.name ?? null,
      ageGroup: computedAgeGroup,
      members,
      clubId: r.clubid,
      clubName: clubNamesMap.get(r.clubid) ?? undefined,
    })
  }

  // 5. Compute eligible athletes per event/ageCode
  const eligibleAthletes: Record<string, Array<{ id: number; name: string; gender: 'M' | 'F'; ageGroup?: string }>> = {}

  // Get all athletes (filtered by club if specified)
  let athleteQuery = `SELECT athleteid, clubid, firstname, lastname, gender, birthdate FROM athlete`
  const athleteParams: unknown[] = []
  if (clubId != null) {
    athleteQuery += ` WHERE clubid = ?`
    athleteParams.push(clubId)
  }
  athleteQuery += ` ORDER BY lastname, firstname`

  const athletes = db.prepare(athleteQuery).all(...athleteParams) as Array<{
    athleteid: number; clubid: number | null; firstname: string | null; lastname: string | null
    gender: number | null; birthdate: string | number | null
  }>

  for (const cat of ageCategories) {
    for (const ev of cat.events) {
      const key = `${ev.eventId}-${cat.ageCode}`
      if (eligibleAthletes[key]) continue // already computed

      const eligible: Array<{ id: number; name: string; gender: 'M' | 'F'; ageGroup?: string }> = []
      for (const ath of athletes) {
        // Gender filter only — age group is determined by team composition, not pre-filtered
        const athGender: 'M' | 'F' = ath.gender === 1 ? 'M' : 'F'
        if (ev.gender !== 'X' && athGender !== ev.gender) continue

        eligible.push({
          id: ath.athleteid,
          name: `${ath.lastname ?? ''}, ${ath.firstname ?? ''}`,
          gender: athGender,
          ageGroup: athleteAgeGroupMap.get(ath.athleteid) ?? undefined,
        })
      }

      eligibleAthletes[key] = eligible
    }
  }

  return {
    ageCategories,
    teamsByEvent,
    eligibleAthletes,
    closureDate,
    isClosed,
  }
})

ipcMain.handle('db:create-relay-team', (_event, eventId: number, ageCode: string, clubId?: number) => {
  const db = getLocalDb()

  // Meet-app is admin/organizer context — no closure enforcement
  // (Closure is only enforced for coach role; meet-app desktop user is always admin)

  // Find the age group id for the given event and ageCode
  const ageGroups = db.prepare(
    `SELECT agegroupid, agemin, agemax FROM agegroup WHERE swimeventid = ? ORDER BY sortcode`
  ).all(eventId) as Array<{ agegroupid: number; agemin: number | null; agemax: number | null }>

  let agegroupId: number | null = null
  for (const ag of ageGroups) {
    const code = buildAgeCode(ag.agemin, ag.agemax)
    if (code === ageCode) {
      agegroupId = ag.agegroupid
      break
    }
  }
  if (!agegroupId && ageGroups.length > 0) {
    agegroupId = ageGroups[0].agegroupid
  }

  // Determine next team number for this event + agegroup + club
  let teamQuery = `SELECT COALESCE(MAX(teamnumber), 0) AS maxnum FROM relay WHERE swimeventid = ?`
  const teamParams: unknown[] = [eventId]
  if (agegroupId) {
    teamQuery += ` AND agegroupid = ?`
    teamParams.push(agegroupId)
  }
  if (clubId != null) {
    teamQuery += ` AND clubid = ?`
    teamParams.push(clubId)
  }
  const maxRow = db.prepare(teamQuery).get(...teamParams) as { maxnum: number }
  const teamNumber = (maxRow?.maxnum ?? 0) + 1

  if (teamNumber > 26) {
    throw new Error('Maximum of 26 teams per event/category/club')
  }

  const relayId = nextId('relay', 'relayid')
  db.prepare(
    `INSERT INTO relay (relayid, clubid, swimeventid, agegroupid, teamnumber) VALUES (?, ?, ?, ?, ?)`
  ).run(relayId, clubId ?? null, eventId, agegroupId, teamNumber)

  return { teamId: relayId, teamNumber: teamNumberToLetter(teamNumber) }
})

ipcMain.handle('db:delete-relay-team', (_event, teamId: number) => {
  const db = getLocalDb()

  // Delete relay positions first (CASCADE should handle it, but be explicit)
  db.prepare(`DELETE FROM relayposition WHERE relayid = ?`).run(teamId)
  // Delete the relay team itself
  db.prepare(`DELETE FROM relay WHERE relayid = ?`).run(teamId)

  return { ok: true }
})

ipcMain.handle('db:set-relay-team-member', (_event, teamId: number, position: number, athleteId: number | null) => {
  const db = getLocalDb()

  // Validate position
  const relay = db.prepare(
    `SELECT r.relayid, r.swimeventid, r.agegroupid, r.clubid
     FROM relay r WHERE r.relayid = ?`
  ).get(teamId) as { relayid: number; swimeventid: number; agegroupid: number | null; clubid: number | null } | undefined
  if (!relay) throw new Error('Relay team not found')

  // Get relaycount for position validation
  const eventStyle = db.prepare(`
    SELECT ss.relaycount FROM swimevent e
    JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE e.swimeventid = ?
  `).get(relay.swimeventid) as { relaycount: number } | undefined
  const relaycount = eventStyle?.relaycount ?? 4

  if (position < 1 || position > relaycount) {
    throw new Error(`Invalid position: must be between 1 and ${relaycount}`)
  }

  // Remove existing position entry
  db.prepare(
    `DELETE FROM relayposition WHERE relayid = ? AND relaynumber = ?`
  ).run(teamId, position)

  // Insert new member if provided
  if (athleteId != null) {
    // Uniqueness check: athlete cannot be on another team for the same event + agegroup + club
    const existingAssignment = db.prepare(`
      SELECT r.relayid, r.teamnumber
      FROM relay r
      JOIN relayposition rp ON r.relayid = rp.relayid
      WHERE r.swimeventid = ? AND r.agegroupid = ? AND r.clubid = ?
        AND rp.athleteid = ? AND r.relayid != ?
    `).get(relay.swimeventid, relay.agegroupid, relay.clubid, athleteId, teamId) as { relayid: number; teamnumber: number } | undefined

    if (existingAssignment) {
      const teamLetter = teamNumberToLetter(existingAssignment.teamnumber ?? 1)
      throw new Error(`Athlete is already assigned to Team ${teamLetter} for this event`)
    }

    // Intra-team uniqueness: athlete cannot already be in another position on the same team
    const sameTeamDup = db.prepare(`
      SELECT relaynumber FROM relayposition
      WHERE relayid = ? AND athleteid = ? AND relaynumber != ?
    `).get(teamId, athleteId, position) as { relaynumber: number } | undefined

    if (sameTeamDup) {
      throw new Error(`Athlete is already assigned to position ${sameTeamDup.relaynumber} on this team`)
    }

    // Gender balance validation for mixed (X) events:
    // Exactly N/2 men and N/2 women required (e.g., 2M+2F for 4-person relay)
    // SERC events (swimstyle 530) have NO gender/age restrictions
    const eventInfo = db.prepare(`
      SELECT e.gender AS eventGender, ss.relaycount, e.swimstyleid
      FROM swimevent e
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE e.swimeventid = ?
    `).get(relay.swimeventid) as { eventGender: number | null; relaycount: number; swimstyleid: number | null } | undefined

    const isSERC = eventInfo?.swimstyleid === 530
    const eventGenderVal = eventInfo?.eventGender ?? 0
    // gender 3 = mixed (X)
    if (!isSERC && eventGenderVal === 3) {
      const rc = eventInfo?.relaycount ?? 4
      const maxPerGender = Math.floor(rc / 2)

      // Get athlete's gender
      const athlete = db.prepare(`SELECT gender FROM athlete WHERE athleteid = ?`).get(athleteId) as { gender: number | null } | undefined
      const athleteGender = athlete?.gender // 1=M, 2=F

      // Count current genders on this team (excluding current position)
      const currentMembers = db.prepare(`
        SELECT a.gender FROM relayposition rp
        JOIN athlete a ON rp.athleteid = a.athleteid
        WHERE rp.relayid = ? AND rp.relaynumber != ?
      `).all(teamId, position) as Array<{ gender: number | null }>

      let mCount = 0
      let fCount = 0
      for (const cm of currentMembers) {
        if (cm.gender === 1) mCount++
        else if (cm.gender === 2) fCount++
      }

      if (athleteGender === 1 && mCount >= maxPerGender) {
        throw new Error(`Cannot add another man: mixed relay requires exactly ${maxPerGender} men and ${maxPerGender} women`)
      }
      if (athleteGender === 2 && fCount >= maxPerGender) {
        throw new Error(`Cannot add another woman: mixed relay requires exactly ${maxPerGender} men and ${maxPerGender} women`)
      }
    }

    // Age group majority validation:
    // Adding this athlete must not make it impossible for any single age group
    // to achieve a strict majority (≥ relaycount/2 + 1) once all positions are filled.
    // SERC events skip this check.
    if (!isSERC) {
    const requiredMajority = Math.floor(relaycount / 2) + 1

    // Get the new athlete's dominant registration age group (from individual entries)
    const newAthleteAgRow = db.prepare(`
      SELECT ag.agemin, ag.agemax, COUNT(*) as cnt
      FROM swimresult sr
      JOIN agegroup ag ON sr.agegroupid = ag.agegroupid
      JOIN swimevent e ON sr.swimeventid = e.swimeventid
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE sr.athleteid = ? AND ss.relaycount = 1
      GROUP BY ag.agemin, ag.agemax
      ORDER BY cnt DESC
      LIMIT 1
    `).get(athleteId) as { agemin: number | null; agemax: number | null } | undefined

    if (newAthleteAgRow) {
      const newAthleteAgeCode = buildAgeCode(newAthleteAgRow.agemin, newAthleteAgRow.agemax)

      // Get age groups of other assigned team members (excluding current position)
      const otherMembers = db.prepare(`
        SELECT rp.athleteid FROM relayposition rp
        WHERE rp.relayid = ? AND rp.relaynumber != ? AND rp.athleteid IS NOT NULL
      `).all(teamId, position) as Array<{ athleteid: number }>

      if (otherMembers.length > 0) {
        const memberAgeCodes: string[] = []
        for (const om of otherMembers) {
          const agRow = db.prepare(`
            SELECT ag.agemin, ag.agemax, COUNT(*) as cnt
            FROM swimresult sr
            JOIN agegroup ag ON sr.agegroupid = ag.agegroupid
            JOIN swimevent e ON sr.swimeventid = e.swimeventid
            JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
            WHERE sr.athleteid = ? AND ss.relaycount = 1
            GROUP BY ag.agemin, ag.agemax
            ORDER BY cnt DESC
            LIMIT 1
          `).get(om.athleteid) as { agemin: number | null; agemax: number | null } | undefined
          if (agRow) {
            memberAgeCodes.push(buildAgeCode(agRow.agemin, agRow.agemax))
          }
        }

        // Simulate adding the new athlete
        const allAgeCodes = [...memberAgeCodes, newAthleteAgeCode]
        const remainingPositions = relaycount - allAgeCodes.length

        // Count occurrences
        const counts = new Map<string, number>()
        for (const ac of allAgeCodes) counts.set(ac, (counts.get(ac) ?? 0) + 1)
        let maxCount = 0
        for (const c of counts.values()) { if (c > maxCount) maxCount = c }

        if (maxCount + remainingPositions < requiredMajority) {
          throw new Error(
            `Cannot assign: adding this athlete would make it impossible to achieve an age group majority (${requiredMajority} of ${relaycount} required)`
          )
        }
      }
    }
    } // end if (!isSERC)

    db.prepare(
      `INSERT INTO relayposition (relayid, relaynumber, athleteid) VALUES (?, ?, ?)`
    ).run(teamId, position, athleteId)
  }

  return { ok: true }
})

ipcMain.handle('db:set-relay-team-name', (_event, teamId: number, name: string | null) => {
  const db = getLocalDb()

  // Update the relay team name
  db.prepare(`UPDATE relay SET name = ? WHERE relayid = ?`).run(name, teamId)

  return { ok: true }
})

ipcMain.handle('db:reorder-events', (_event, updates: Array<{ eventId: number; sessionId: number; sortcode: number }>) =>
  reorderEvents(updates).then(() => ({ ok: true }))
)

ipcMain.handle('db:generate-heats', async (_event, eventId?: number, sessionId?: number) => {
  try {
    const result = await generateHeats(eventId, sessionId)
    // Push start lists to team-app for live spectator view
    _pushStartListsAfterGeneration(eventId, sessionId)
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:validate-event', async (_event, eventId: number) => {
  try {
    await validateEvent(eventId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:invalidate-event', async (_event, eventId: number) => {
  try {
    await invalidateEvent(eventId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:validate-heat', async (_event, heatId: number) => {
  try {
    await validateHeat(heatId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:invalidate-heat', async (_event, heatId: number) => {
  try {
    await invalidateHeat(heatId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:validate-session', async (_event, sessionId: number) => {
  try {
    await validateSession(sessionId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:invalidate-session', async (_event, sessionId: number) => {
  try {
    await invalidateSession(sessionId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:remove-from-heat', async (_event, swimresultId: number) => {
  await removeFromHeat(swimresultId)
  return { ok: true }
})

ipcMain.handle('db:assign-to-heat-lane', async (_event, swimresultId: number, heatId: number, lane: number) => {
  await assignToHeatLane(swimresultId, heatId, lane)
  return { ok: true }
})

ipcMain.handle('db:swap-lanes', async (_event, resultIdA: number, heatIdA: number, laneA: number, resultIdB: number, heatIdB: number, laneB: number) => {
  await swapLanes(resultIdA, heatIdA, laneA, resultIdB, heatIdB, laneB)
  return { ok: true }
})

ipcMain.handle('db:add-late-entry', async (_event, athleteId: number, eventId: number, heatId: number, lane: number, entryTime: number | null) => {
  const id = await addLateEntry(athleteId, eventId, heatId, lane, entryTime)
  return { ok: true, swimresultId: id }
})

ipcMain.handle('db:available-athletes-for-event', async (_event, eventId: number) => {
  return getAvailableAthletesForEvent(eventId)
})

ipcMain.handle('db:save-athlete', (_event, athlete: Parameters<typeof saveAthlete>[0]) =>
  saveAthlete(athlete).then(() => ({ ok: true }))
)

// ── Finals IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('db:get-final-events', () => getFinalEvents())

ipcMain.handle('db:get-final-candidates', (_event, finalEventId: number) =>
  getFinalCandidates(finalEventId)
)

ipcMain.handle('db:set-qualification', (_event, finalEventId: number, athleteId: number, qualCode: string | null, noAdvance: boolean) => {
  setQualification(finalEventId, athleteId, qualCode, noAdvance)
  return { ok: true }
})

ipcMain.handle('db:auto-qualify', (_event, finalEventId: number) => {
  const result = autoQualify(finalEventId)
  return { ok: true, ...result }
})

ipcMain.handle('db:clear-final-seeding', (_event, finalEventId: number) => {
  clearFinalSeeding(finalEventId)
  return { ok: true }
})

ipcMain.handle('db:seed-finals', (_event, finalEventId: number) => {
  return seedFinals(finalEventId)
})

ipcMain.handle('db:flush-meet', async () => {
  try {
    await flushMeet()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── File IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('file:open-lenex-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Ouvrir un fichier LENEX',
    filters: [{ name: 'LENEX', extensions: ['lxf'] }],
    properties: ['openFile'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('file:import-lenex', async (event, filePath: string, lang?: string) => {
  try {
    const db = getLocalDb()

    // Wipe all meet data (clubs, athletes, and event structure)
    db.exec(`DELETE FROM relaysplit`)
    db.exec(`DELETE FROM relayposition`)
    db.exec(`DELETE FROM relay`)
    db.exec(`DELETE FROM split`)
    db.exec(`DELETE FROM swimresult`)
    db.exec(`DELETE FROM heat`)
    db.exec(`DELETE FROM agegroup`)
    db.exec(`DELETE FROM swimevent`)
    db.exec(`DELETE FROM swimsession`)
    db.exec(`DELETE FROM swimstyle`)
    db.exec(`DELETE FROM athlete`)
    db.exec(`DELETE FROM club`)
    db.exec(`DELETE FROM dsqitem`)
    db.exec(`DELETE FROM bsglobal`)

    const summary = importLenex(filePath, db)

    // Seed DSQ codes if the dsqitem table is empty after import
    const dsqCount = db.prepare(`SELECT COUNT(*) AS c FROM dsqitem`).get() as { c: number }
    if (dsqCount.c === 0) {
      const meetTypeRow = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
      const meetType = (meetTypeRow?.data || 'pool').toLowerCase()
      seedDsqCodes(db, meetType, lang || 'fr')
    }

    // Generate combined events & point scores definitions for imported meet
    regenerateCombinedEvents(db)
    regeneratePointScores(db)

    livePush.reload(db)
    const meetTypeRow2 = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
    const detectedMeetType = (meetTypeRow2?.data || 'POOL').toUpperCase()
    event.sender.send('file:meet-type-changed', detectedMeetType)
    return { ok: true, summary, meetType: detectedMeetType }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('file:export-meet-lenex', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Exporter la structure du meet LENEX',
    filters: [{ name: 'LENEX', extensions: ['lxf'] }],
    defaultPath: 'meet.lxf',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    const summary = exportMeetLenex(result.filePath, getLocalDb())
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('file:export-lenex-results', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Exporter les résultats LENEX',
    filters: [{ name: 'LENEX', extensions: ['lxf'] }],
    defaultPath: 'results.lxf',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    const summary = exportLenexResults(result.filePath, getLocalDb())
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── PostgreSQL connection IPC ─────────────────────────────────────────────────

ipcMain.handle('pg:connect', async (_event, config: PgConnectionConfig) => {
  try {
    await connectToPg(config)
    return { ok: true, info: getConnectionInfo() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('pg:disconnect', () => {
  disconnectPg()
  return { ok: true, info: getConnectionInfo() }
})

ipcMain.handle('pg:status', () => {
  return getConnectionInfo()
})

// ── File IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('file:save-smb', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Sauvegarder la compétition',
    filters: [{ name: 'Splash Meet Backup', extensions: ['smb'] }],
    defaultPath: 'meet.smb',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    const summary = saveSMB(result.filePath, getLocalDb())
    return { ok: true, ...summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('file:restore-smb', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Restaurer une compétition',
    filters: [{ name: 'Splash Meet Backup', extensions: ['smb'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
  try {
    const summary = restoreSMB(result.filePaths[0], getLocalDb())
    // Regenerate combined events & point scores after restore
    regenerateCombinedEvents(getLocalDb())
    regeneratePointScores(getLocalDb())
    return { ok: true, ...summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('file:new-meet', async (_event, meetType?: string, lang?: string) => {
  try {
    const type = (meetType || 'pool').toLowerCase()
    const db = getLocalDb()

    // Wipe all meet data (clubs, athletes, and event structure)
    db.exec(`DELETE FROM relaysplit`)
    db.exec(`DELETE FROM relayposition`)
    db.exec(`DELETE FROM relay`)
    db.exec(`DELETE FROM split`)
    db.exec(`DELETE FROM swimresult`)
    db.exec(`DELETE FROM heat`)
    db.exec(`DELETE FROM agegroup`)
    db.exec(`DELETE FROM swimevent`)
    db.exec(`DELETE FROM swimsession`)
    db.exec(`DELETE FROM swimstyle`)
    db.exec(`DELETE FROM athlete`)
    db.exec(`DELETE FROM club`)
    db.exec(`DELETE FROM dsqitem`)
    db.exec(`DELETE FROM bsglobal`)

    // Resolve template path based on meet type
    const templateFile = type === 'beach' ? 'template_beach.lxf' : 'template_pool.lxf'
    const templatePath = app.isPackaged
      ? join(process.resourcesPath, templateFile)
      : join(__dirname, '../../../../config', templateFile)

    // Import the template lenex file — this seeds the swimstyle catalog (each style is
    // declared via a stub EVENT, since Lenex has no standalone style catalog outside of
    // events) but we don't want the template's stub session/events in the new meet.
    const summary = importLenex(templatePath, db)
    db.exec(`DELETE FROM agegroup`)
    db.exec(`DELETE FROM swimevent`)
    db.exec(`DELETE FROM swimsession`)
    summary.sessions = 0
    summary.events = 0
    summary.ageGroups = 0

    // Set MEET_TYPE in BSGLOBAL
    db.prepare(
      `INSERT INTO bsglobal (name, data) VALUES ('MEET_TYPE', ?)
       ON CONFLICT(name) DO UPDATE SET data = excluded.data`
    ).run(type.toUpperCase())

    // Seed DSQ codes from config/dsq-codes.json
    seedDsqCodes(db, type, lang || 'fr')

    // Generate combined events & point scores definitions for new meet
    regenerateCombinedEvents(db)
    regeneratePointScores(db)

    return { ok: true, summary, meetType: type.toUpperCase() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── Report IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('db:get-meet-info', () => getMeetInfo())

ipcMain.handle('db:get-combined-results', (_event, selectedEventIds: number[]) =>
  getCombinedResults(selectedEventIds)
)

ipcMain.handle('db:get-beach-number-report', () => getBeachNumberReport())

ipcMain.handle('db:get-entries-by-event', (_event, selectedEventIds: number[]) =>
  getEntriesByEvent(selectedEventIds)
)

ipcMain.handle('db:get-point-standings', (_event, selectedEventIds: number[]) =>
  getPointStandings(selectedEventIds)
)

interface PdfHeaderInfo { line1: string; line2: string; today: string }

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildHeaderTemplate(h: PdfHeaderInfo): string {
  if (!h.line1 && !h.line2) return '<span></span>'
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:10pt;` +
    `text-align:center;padding:0 0.6in 4pt;box-sizing:border-box;` +
    `border-bottom:1px solid black;line-height:1.5">` +
    `${escHtml(h.line1)}<br>` +
    `<span style="font-size:8pt">${escHtml(h.line2)}</span></div>`
}

function buildFooterTemplate(h: PdfHeaderInfo): string {
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:8pt;` +
    `display:flex;justify-content:space-between;padding:0 0.6in;box-sizing:border-box">` +
    `<span>SauvetageMeet</span><span></span><span>${escHtml(h.today)}</span></div>`
}

async function htmlToPdfBuffer(html: string, h: PdfHeaderInfo): Promise<Buffer> {
  const tmpPath = join(tmpdir(), `mm_rpt_${Date.now()}.html`)
  writeFileSync(tmpPath, html, 'utf-8')
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  try {
    await hidden.loadFile(tmpPath)
    const useHeader = !!(h.line1 || h.line2)
    const pdf = await hidden.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: false,
      margins: useHeader
        ? { marginType: 'custom', top: 1.1, bottom: 0.65, left: 0.6, right: 0.6 }
        : { marginType: 'custom', top: 0.4, bottom: 0.5, left: 0.6, right: 0.6 },
      displayHeaderFooter: useHeader,
      ...(useHeader ? {
        headerTemplate: buildHeaderTemplate(h),
        footerTemplate: buildFooterTemplate(h),
      } : {}),
    })
    return Buffer.from(pdf)
  } finally {
    hidden.destroy()
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

async function printHtml(html: string, h: PdfHeaderInfo): Promise<void> {
  const tmpPath = join(tmpdir(), `mm_rpt_${Date.now()}.html`)
  writeFileSync(tmpPath, html, 'utf-8')
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  try {
    await hidden.loadFile(tmpPath)
    const useHeader = !!(h.line1 || h.line2)
    await new Promise<void>((resolve, reject) => {
      hidden.webContents.print({
        silent: false,
        printBackground: false,
        pageSize: 'Letter',
        margins: useHeader
          ? { marginType: 'custom', top: 1.1, bottom: 0.65, left: 0.6, right: 0.6 }
          : { marginType: 'custom', top: 0.4, bottom: 0.5, left: 0.6, right: 0.6 },
        ...(useHeader ? {
          headerTemplate: buildHeaderTemplate(h),
          footerTemplate: buildFooterTemplate(h),
        } : {}),
      } as any, (success, errType) => {
        if (success) resolve()
        else reject(new Error(errType ?? 'print-error'))
      })
    })
  } finally {
    hidden.destroy()
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

ipcMain.handle('report:preview-pdf', async (_event, html: string, h: PdfHeaderInfo) => {
  try {
    const buf = await htmlToPdfBuffer(html, h)
    return { ok: true, data: buf.toString('base64') }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('report:save-html', async (event, html: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Sauvegarder le rapport HTML',
    filters: [{ name: 'HTML', extensions: ['htm', 'html'] }],
    defaultPath: 'Liste des séries.htm',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    writeFileSync(result.filePath, html, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('report:save-pdf', async (event, html: string, h: PdfHeaderInfo) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Sauvegarder le rapport PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: 'Liste des séries.pdf',
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    const buf = await htmlToPdfBuffer(html, h)
    writeFileSync(result.filePath, buf)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('report:print', async (_event, html: string, h: PdfHeaderInfo) => {
  try {
    await printHtml(html, h)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── Timing Sheet IPC ──────────────────────────────────────────────────────────

// Active OCR engine instance (lazy-loaded)
let activeOcrEngine: OcrEngine | null = null

ipcMain.handle('timing:save-scan', async (_event, data: {
  eventNumber: number
  heatNumber: number
  lane: number
  barcodeRaw: string
  imageBase64: string
}) => {
  try {
    const imageBlob = Buffer.from(data.imageBase64, 'base64')

    // If this barcode was already scanned, delete the old one (rescan)
    const existing = findExistingScan(data.barcodeRaw)
    if (existing) {
      deleteScan(existing.scanId)
    }

    const scanId = insertScan({
      eventNumber: data.eventNumber,
      heatNumber: data.heatNumber,
      lane: data.lane,
      barcodeRaw: data.barcodeRaw,
      imageBlob,
      scannedAt: new Date().toISOString(),
    })
    return { ok: true, scanId, duplicate: false }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:get-unprocessed', () => {
  return getUnprocessedScans().map(scanToDto)
})

ipcMain.handle('timing:get-scans-for-heat', (_event, eventNumber: number, heatNumber: number) => {
  return getScansForHeat(eventNumber, heatNumber).map(scanToDto)
})

ipcMain.handle('timing:get-scan-summary', () => {
  return getScanSummary()
})

ipcMain.handle('timing:get-scans-for-processing', (_event, filter: ScanStatus | 'all') => {
  if (filter === 'all') {
    const unprocessed = getScansByStatus('unprocessed')
    const recognized = getScansByStatus('recognized')
    const validated = getScansByStatus('validated')
    return [...unprocessed, ...recognized, ...validated].map(scanToDto)
  }
  if (filter === 'unprocessed') {
    // "Non traités" = unprocessed + recognized (not yet confirmed by operator)
    const unprocessed = getScansByStatus('unprocessed')
    const recognized = getScansByStatus('recognized')
    return [...unprocessed, ...recognized].map(scanToDto)
  }
  return getScansByStatus(filter).map(scanToDto)
})

ipcMain.handle('timing:run-ocr', async (_event, scanId: number, _engineName: string) => {
  try {
    const scan = getScanById(scanId)
    if (!scan) return { ok: false, error: 'Scan not found' }

    // Use Gemini vision (only engine)
    let geminiEngine = activeOcrEngine as InstanceType<typeof GeminiOcrEngine> | null
    if (!geminiEngine || (geminiEngine as any).name !== 'gemini') {
      geminiEngine = new GeminiOcrEngine()
      await geminiEngine.initialize()
      if (activeOcrEngine) await activeOcrEngine.dispose()
      activeOcrEngine = geminiEngine as unknown as OcrEngine
    }

    const visionResult = await geminiEngine.recognizeFullImage(scan.imageBlob)

    updateScanOcrResult(scanId, {
      recognizedTime1: visionResult.time1,
      recognizedTime2: visionResult.time2,
      ocrEngine: 'gemini',
      ocrConfidence: visionResult.confidence,
    })

    return {
      ok: true,
      result: {
        time1: visionResult.time1,
        time2: visionResult.time2,
        overallConfidence: visionResult.confidence,
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:validate-scan', (_event, scanId: number, time1: string, timeMs1: number, time2: string, timeMs2: number) => {
  try {
    validateScan(scanId, time1, timeMs1, time2, timeMs2)

    // Also write directly to the meet database
    const scan = getScanById(scanId)
    if (scan) {
      const db = getLocalDb()
      const avgTime = Math.round((timeMs1 + timeMs2) / 2)

      const row = db.prepare(`
        SELECT sr.swimresultid
        FROM swimresult sr
        JOIN heat h ON sr.heatid = h.heatid
        JOIN swimevent e ON h.swimeventid = e.swimeventid
        WHERE e.eventnumber = ? AND h.heatnumber = ? AND sr.lane = ?
        LIMIT 1
      `).get(scan.eventNumber, scan.heatNumber, scan.lane) as { swimresultid: number } | undefined

      if (row) {
        db.prepare(`
          UPDATE swimresult
          SET backuptime1 = ?, backuptime2 = ?, swimtime = ?
          WHERE swimresultid = ?
        `).run(timeMs1, timeMs2, avgTime, row.swimresultid)

        // Live push notification for single scan validation
        _notifyLivePushFromScan(db, row.swimresultid, avgTime)
      }
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:mark-error', (_event, scanId: number, _notes: string) => {
  try {
    deleteScan(scanId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:commit-heat-results', async (_event, eventNumber: number, heatNumber: number) => {
  try {
    const scans = getValidatedScansForHeat(eventNumber, heatNumber)
    if (scans.length === 0) {
      return { ok: false, error: 'No validated scans for this heat' }
    }

    // Each scan is one lane with both chrono times
    const db = getLocalDb()
    for (const scan of scans) {
      const time1 = scan.timeMs1
      const time2 = scan.timeMs2

      // Average if both present
      const avgTime = (time1 !== null && time2 !== null)
        ? Math.round((time1 + time2) / 2)
        : (time1 ?? time2)

      // Find the swimresult row for this event/heat/lane
      const row = db.prepare(`
        SELECT sr.swimresultid
        FROM swimresult sr
        JOIN heat h ON sr.heatid = h.heatid
        JOIN swimevent e ON h.swimeventid = e.swimeventid
        WHERE e.eventnumber = ? AND h.heatnumber = ? AND sr.lane = ?
        LIMIT 1
      `).get(eventNumber, heatNumber, scan.lane) as { swimresultid: number } | undefined

      if (row) {
        db.prepare(`
          UPDATE swimresult
          SET backuptime1 = ?, backuptime2 = ?, swimtime = ?
          WHERE swimresultid = ?
        `).run(time1, time2, avgTime, row.swimresultid)

        // Live push notification for timing scan result
        _notifyLivePushFromScan(db, row.swimresultid, avgTime)
      }
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:save-debug-image', (_event, imageBase64: string) => {
  try {
    const filePath = join(app.getPath('userData'), 'debug_capture.png')
    writeFileSync(filePath, Buffer.from(imageBase64, 'base64'))
    console.log('[Timing] Debug image saved to:', filePath)
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('timing:clear-all-scans', () => {
  const deleted = clearAllScans()
  resetGeminiAttempted()
  return { ok: true, deleted }
})

ipcMain.handle('timing:set-gemini-background', (_event, value: boolean) => {
  setGeminiBackgroundEnabled(value)
  return { ok: true }
})

ipcMain.handle('timing:get-gemini-background', () => {
  return { enabled: isGeminiBackgroundEnabled(), tier: getCurrentGeminiTier() }
})

ipcMain.handle('timing:get-gemini-key', () => {
  const keys = loadGeminiKeys()
  return {
    freeKey: keys.freeKey ? '***' + keys.freeKey.slice(-4) : '',
    paidKey: keys.paidKey ? '***' + keys.paidKey.slice(-4) : '',
    hasFreeKey: !!keys.freeKey,
    hasPaidKey: !!keys.paidKey,
  }
})

ipcMain.handle('timing:set-gemini-key', (_event, freeKey: string | null, paidKey: string | null) => {
  const current = loadGeminiKeys()
  saveGeminiKeys(
    freeKey !== null ? freeKey : current.freeKey,
    paidKey !== null ? paidKey : current.paidKey
  )
  // Reset engine so it picks up the new keys
  if (activeOcrEngine && (activeOcrEngine as any).name === 'gemini') {
    activeOcrEngine.dispose()
    activeOcrEngine = null
  }
  return { ok: true }
})

ipcMain.handle('timing:generate-sheets', async (_event, sessionId: number) => {
  try {
    const db = getLocalDb()
    // Get all heats for the session
    const heats = db.prepare(`
      SELECT e.eventnumber, e.swimeventid, h.heatnumber, h.heatid,
             ss.name as stylename, ss.distance
      FROM heat h
      JOIN swimevent e ON h.swimeventid = e.swimeventid
      JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
      WHERE e.swimsessionid = ?
      ORDER BY e.eventnumber, h.heatnumber
    `).all(sessionId) as Array<{
      eventnumber: number; swimeventid: number; heatnumber: number; heatid: number
      stylename: string; distance: number
    }>

    const allPages: ReturnType<typeof buildTimingSheetPages> = []

    for (const heat of heats) {
      // Get lanes for this heat (exclude lane 0 = unseeded)
      const lanes = db.prepare(`
        SELECT DISTINCT sr.lane FROM swimresult sr WHERE sr.heatid = ? AND sr.lane > 0 ORDER BY sr.lane
      `).all(heat.heatid) as Array<{ lane: number }>

      const laneNumbers = lanes.map((l) => l.lane)
      if (laneNumbers.length === 0) continue // skip heats with no seeded lanes
      const meetTypeTS = db.prepare(`SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`).get() as { data: string } | undefined
      const isBeachTS = (meetTypeTS?.data || 'POOL').toUpperCase() === 'BEACH'
      const eventName = isBeachTS ? heat.stylename : `${heat.distance}m ${heat.stylename}`

      // Get athlete names and club codes for each lane
      const entries = db.prepare(`
        SELECT sr.lane, a.firstname, a.lastname, c.code as clubcode
        FROM swimresult sr
        LEFT JOIN athlete a ON sr.athleteid = a.athleteid
        LEFT JOIN club c ON a.clubid = c.clubid
        WHERE sr.heatid = ? AND sr.lane > 0
        ORDER BY sr.lane
      `).all(heat.heatid) as Array<{ lane: number; firstname: string | null; lastname: string | null; clubcode: string | null }>

      const athleteNames = new Map<number, string>()
      const clubCodes = new Map<number, string>()
      for (const entry of entries) {
        const name = [entry.lastname, entry.firstname].filter(Boolean).join(', ')
        if (name) athleteNames.set(entry.lane, name)
        if (entry.clubcode) clubCodes.set(entry.lane, entry.clubcode)
      }

      // One strip per lane (both chronos on same strip)
      const pages = buildTimingSheetPages(
        heat.eventnumber, eventName, heat.heatnumber, laneNumbers, undefined, athleteNames, clubCodes
      )
      allPages.push(...pages)
    }

    const html = generateTimingSheetsHtml(allPages)
    return { ok: true, html }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

/** Convert a scan record to a DTO (with base64 image for renderer) */
function scanToDto(scan: ReturnType<typeof getScanById> & {}) {
  return {
    scanId: scan.scanId,
    eventNumber: scan.eventNumber,
    heatNumber: scan.heatNumber,
    lane: scan.lane,
    barcodeRaw: scan.barcodeRaw,
    imageBase64: scan.imageBlob.toString('base64'),
    scannedAt: scan.scannedAt,
    status: scan.status,
    recognizedTime1: scan.recognizedTime1,
    recognizedTime2: scan.recognizedTime2,
    validatedTime1: scan.validatedTime1,
    validatedTime2: scan.validatedTime2,
    timeMs1: scan.timeMs1,
    timeMs2: scan.timeMs2,
    ocrEngine: scan.ocrEngine,
    ocrConfidence: scan.ocrConfidence,
    notes: scan.notes,
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'SauvetageMeet',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    quantum = new QuantumBridge(mainWindow.webContents)
  })

  // ── Native application menu ─────────────────────────────────────────────────
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Exporter la structure du meet LENEX…',
          click: () => mainWindow.webContents.send('menu:export-meet-lenex'),
        },
        {
          label: 'Exporter les résultats LENEX…',
          click: () => mainWindow.webContents.send('menu:export-lenex-results'),
        },
        { type: 'separator' },
        {
          label: 'Sauvegarder le meet (.smb)…',
          click: () => mainWindow.webContents.send('menu:save-smb'),
        },
        {
          label: 'Restaurer un meet (.smb)…',
          click: () => mainWindow.webContents.send('menu:restore-smb'),
        },
        { type: 'separator' },
        {
          label: 'Connecter à PostgreSQL…',
          click: () => mainWindow.webContents.send('menu:connect-pg'),
        },
        {
          label: 'Déconnecter PostgreSQL',
          click: () => mainWindow.webContents.send('menu:disconnect-pg'),
        },
        { type: 'separator' },
        { label: 'Quitter', role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Outils',
      submenu: [
        {
          label: 'Clés API Gemini…',
          click: () => mainWindow.webContents.send('menu:configure-gemini'),
        },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'Guide — Compétition piscine',
          click: () => mainWindow.webContents.send('menu:open-guide', 'pool'),
        },
        {
          label: 'Guide — Compétition plage',
          click: () => mainWindow.webContents.send('menu:open-guide', 'beach'),
        },
        { type: 'separator' },
        {
          label: `À propos de SauvetageMeet v${app.getVersion()}`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'SauvetageMeet',
              message: `SauvetageMeet v${app.getVersion()}`,
              detail: 'Logiciel de gestion de compétitions de sauvetage sportif.\n\n© Société de sauvetage',
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  mainWindow.on('closed', () => {
    quantum?.destroy()
    quantum = null
  })

  // F12 opens/closes dev tools in development
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.code === 'F12') {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'undocked' })
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Live push helper (used by timing scan handlers) ───────────────────────────

function _notifyLivePushFromScan(db: ReturnType<typeof getLocalDb>, swimresultId: number, swimtime: number | null): void {
  if (!swimtime) return
  try {
    const row = db.prepare(`
      SELECT sr.swimeventid, sr.lane, sr.athleteid, sr.resultstatus,
             a.lastname, a.firstname, c.name AS clubname,
             h.heatnumber
      FROM swimresult sr
      LEFT JOIN athlete a ON sr.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      LEFT JOIN heat h ON sr.heatid = h.heatid
      WHERE sr.swimresultid = ?
    `).get(swimresultId) as {
      swimeventid: number; lane: number; athleteid: number | null
      resultstatus: number | null; lastname: string; firstname: string
      clubname: string; heatnumber: number
    } | undefined

    if (!row || !row.heatnumber) return

    const statusStr = row.resultstatus === 1 ? 'DNS' : row.resultstatus === 2 ? 'DNF' : row.resultstatus === 3 ? 'DSQ' : ''

    livePush.notifyResultWrite({
      event_id: row.swimeventid,
      heat_number: row.heatnumber,
      lane: row.lane,
      athlete_id: row.athleteid,
      athlete_name: `${row.lastname || ''}, ${row.firstname || ''}`.replace(/^, |, $/g, ''),
      club_name: row.clubname || '',
      swimtime_ms: swimtime,
      reaction_time_ms: null,
      status: statusStr,
    })
  } catch (e) {
    console.error('[LivePush] Error in scan notification:', e)
  }
}

/**
 * Push start lists to team-app after heat generation.
 * Also pushes event metadata so spectators can see the event list.
 */
function _pushStartListsAfterGeneration(eventId?: number, sessionId?: number): void {
  try {
    const db = getLocalDb()

    // Determine which events to push
    let eventFilter = ''
    const params: unknown[] = []
    if (eventId) {
      eventFilter = 'AND e.swimeventid = ?'
      params.push(eventId)
    } else if (sessionId) {
      eventFilter = 'AND e.swimsessionid = ?'
      params.push(sessionId)
    }

    // Push event metadata
    const events = db.prepare(`
      SELECT e.swimeventid, e.eventnumber, e.gender, e.swimsessionid,
             s.sessionnumber, s.name AS sessionname,
             st.distance, st.name AS stylename,
             e.round, e.daytime,
             (SELECT COUNT(*) FROM heat h WHERE h.swimeventid = e.swimeventid) AS total_heats
      FROM swimevent e
      LEFT JOIN swimsession s ON e.swimsessionid = s.swimsessionid
      LEFT JOIN swimstyle st ON e.swimstyleid = st.swimstyleid
      WHERE e.internalevent != 'T' ${eventFilter}
      ORDER BY s.sessionnumber, e.sortcode
    `).all(...params) as Array<{
      swimeventid: number; eventnumber: number; gender: number; swimsessionid: number
      sessionnumber: number; sessionname: string; distance: number; stylename: string
      round: number; daytime: string | null; total_heats: number
    }>

    if (events.length > 0) {
      const genderMap: Record<number, string> = { 1: 'M', 2: 'F', 3: 'X' }
      const roundMap: Record<number, string> = { 1: 'PRE', 2: 'SEM', 4: 'FIN', 5: 'TIM' }

      const eventsPayload = events.map(e => ({
        event_id: e.swimeventid,
        session_number: e.sessionnumber,
        session_name: e.sessionname || '',
        event_number: e.eventnumber,
        event_name: e.stylename || '',
        gender: genderMap[e.gender] || 'X',
        distance: e.distance,
        round: roundMap[e.round] || 'TIM',
        scheduled_time: e.daytime ? new Date(e.daytime).toTimeString().slice(0, 5) : '',
        total_heats: e.total_heats,
      }))

      livePush.notifyEvents({ events: eventsPayload })
    }

    // Push start list entries
    const startlistRows = db.prepare(`
      SELECT sr.swimeventid AS event_id, h.heatnumber AS heat_number, sr.lane,
             sr.athleteid AS athlete_id, sr.entrytime AS entry_time_ms,
             a.lastname, a.firstname, c.name AS clubname
      FROM swimresult sr
      JOIN heat h ON sr.heatid = h.heatid
      LEFT JOIN athlete a ON sr.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      WHERE sr.heatid IS NOT NULL AND sr.lane IS NOT NULL
        ${eventId ? 'AND sr.swimeventid = ?' : sessionId ? 'AND sr.swimeventid IN (SELECT swimeventid FROM swimevent WHERE swimsessionid = ?)' : ''}
      ORDER BY sr.swimeventid, h.heatnumber, sr.lane
    `).all(...params) as Array<{
      event_id: number; heat_number: number; lane: number
      athlete_id: number | null; entry_time_ms: number | null
      lastname: string; firstname: string; clubname: string
    }>

    if (startlistRows.length > 0) {
      const entries = startlistRows.map(r => ({
        event_id: r.event_id,
        heat_number: r.heat_number,
        lane: r.lane,
        athlete_id: r.athlete_id,
        athlete_name: `${r.lastname || ''}, ${r.firstname || ''}`.replace(/^, |, $/g, ''),
        club_name: r.clubname || '',
        entry_time_ms: r.entry_time_ms,
      }))

      livePush.notifyStartlist({ entries })
    }
  } catch (e) {
    console.error('[LivePush] Error pushing start lists:', e)
  }
}


app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.sauvetagemeet')
  }

  // macOS blocks getUserMedia without this — grant camera permission explicitly
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  // Try to restore saved PG connection (falls back to SQLite silently)
  await restoreSavedConnection()

  // Start background Gemini OCR processing
  startGeminiBackground()

  // Initialize live push module (reads config from bsglobal)
  livePush.initialize(getLocalDb())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  livePush.destroy()
  closeLocalDb()
  closeScanDb()
  if (activeOcrEngine) {
    activeOcrEngine.dispose().catch(() => {})
    activeOcrEngine = null
  }
  if (process.platform !== 'darwin') app.quit()
})
