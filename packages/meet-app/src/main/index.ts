import { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, Menu, session } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'

// Set app name early so userData path is consistent in dev and production
app.setName('SauvetageMeet')

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
  nextId,
  type SessionUpdate,
  type EventUpdate,
  type AgeGroupUpdate,
} from './db'
import { importLenex, exportLenexResults, exportMeetLenex } from './lenex'
import { saveSMB, restoreSMB } from './smb'
import {
  getScanDb, closeScanDb, insertScan, getUnprocessedScans,
  getScansForHeat, getScanById, findExistingScan,
  updateScanOcrResult, validateScan, markScanError,
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

function seedDsqCodes(db: ReturnType<typeof getLocalDb>, meetType: string): void {
  try {
    const configPath = app.isPackaged
      ? join(process.resourcesPath, 'dsq-codes.json')
      : join(__dirname, '../../../../config/dsq-codes.json')

    const { readFileSync, existsSync } = require('fs')
    if (!existsSync(configPath)) {
      console.warn('[DSQ] Config file not found:', configPath)
      return
    }

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const codes: Array<{ code: string; name_fr: string; name_en?: string }> =
      meetType === 'beach' ? (config.beach || []) : (config.pool || [])

    if (codes.length === 0) return

    // ID ranges: pool 4001-4099, beach 4101-4199
    const baseId = meetType === 'beach' ? 4101 : 4001

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO dsqitem (dsqitemid, code, lenexcode, name, name_en, sortcode)
       VALUES (?, ?, ?, ?, ?, ?)`
    )

    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      stmt.run(baseId + i, c.code, c.code, c.name_fr, c.name_en || '', i + 1)
    }

    console.log(`[DSQ] Seeded ${codes.length} ${meetType} DSQ codes`)
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
    // Try with name_en first (our schema), fall back without it (Splash schema)
    try {
      return db.prepare(`SELECT dsqitemid, code, name, name_en, sortcode FROM dsqitem WHERE code IS NOT NULL AND code != '' ORDER BY sortcode`).all()
    } catch {
      return db.prepare(`SELECT dsqitemid, code, name, '' as name_en, sortcode FROM dsqitem WHERE code IS NOT NULL AND code != '' ORDER BY sortcode`).all()
    }
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
    `SELECT rp.relaynumber, rp.athleteid, a.firstname, a.lastname
     FROM relayposition rp
     LEFT JOIN athlete a ON rp.athleteid = a.athleteid
     WHERE rp.relayid = ?
     ORDER BY rp.relaynumber`
  ).all(relayId) as Array<{ relaynumber: number; athleteid: number; firstname: string | null; lastname: string | null }>
  return rows.map(r => ({ position: r.relaynumber, athleteId: r.athleteid, name: `${r.lastname}, ${r.firstname}` }))
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

ipcMain.handle('file:import-lenex', async (_event, filePath: string) => {
  try {
    const summary = importLenex(filePath, getLocalDb())
    livePush.reload(getLocalDb())
    return { ok: true, summary }
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
    return { ok: true, ...summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('file:new-meet', async (_event, meetType?: string) => {
  try {
    const type = (meetType || 'pool').toLowerCase()
    const db = getLocalDb()

    // Wipe event structure only (preserve clubs and athletes)
    db.exec(`DELETE FROM split`)
    db.exec(`DELETE FROM swimresult`)
    db.exec(`DELETE FROM heat`)
    db.exec(`DELETE FROM agegroup`)
    db.exec(`DELETE FROM swimevent`)
    db.exec(`DELETE FROM swimsession`)
    db.exec(`DELETE FROM swimstyle`)
    db.exec(`DELETE FROM dsqitem`)
    db.exec(`DELETE FROM bsglobal`)

    // Resolve template path based on meet type
    const templateFile = type === 'beach' ? 'template_beach.lxf' : 'template_pool.lxf'
    const templatePath = app.isPackaged
      ? join(process.resourcesPath, templateFile)
      : join(__dirname, '../../../../config', templateFile)

    // Import the template lenex file
    const summary = importLenex(templatePath, db)

    // Set MEET_TYPE in BSGLOBAL
    db.prepare(
      `INSERT INTO bsglobal (name, data) VALUES ('MEET_TYPE', ?)
       ON CONFLICT(name) DO UPDATE SET data = excluded.data`
    ).run(type.toUpperCase())

    // Seed DSQ codes from config/dsq-codes.json
    seedDsqCodes(db, type)

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
      const eventName = `${heat.distance}m ${heat.stylename}`

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

/** Get or create the Gemini OCR engine instance */
async function getOcrEngine(name: string): Promise<OcrEngine | null> {
  if (activeOcrEngine) return activeOcrEngine

  try {
    const engine = new GeminiOcrEngine()
    await engine.initialize()
    activeOcrEngine = engine as unknown as OcrEngine
    return activeOcrEngine
  } catch (e) {
    console.error('Failed to load Gemini OCR engine:', e)
    return null
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
