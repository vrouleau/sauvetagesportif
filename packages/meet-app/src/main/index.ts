import { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, Menu } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { QuantumBridge, type ActiveHeat, type ScheduleEvent } from './quantum'
import {
  configureDb, getDbConfig, testConnection,
  getHeatListEvents, getHeatListSessions, getSessions, getAthletes,
  saveResult,
  removeFromHeat, assignToHeatLane, swapLanes, addLateEntry,
  getAvailableAthletesForEvent,
  createSession, deleteSession, updateSession,
  createBreak,
  createEvent, deleteEvent, updateEvent,
  createAgeGroup, deleteAgeGroup, updateAgeGroup,
  saveAthlete,
  syncUp, syncDown,
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
  type DbConfig,
  type SessionUpdate,
  type EventUpdate,
  type AgeGroupUpdate,
} from './db'
import { importLenex } from './lenex'
import { saveSMB, restoreSMB } from './smb'

let quantum: QuantumBridge | null = null

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

ipcMain.handle('db:configure', (_event, cfg: DbConfig) => {
  configureDb(cfg)
  return { ok: true }
})

ipcMain.handle('db:get-config', () => getDbConfig())

ipcMain.handle('db:test-connection', () => testConnection())

ipcMain.handle('db:heat-list-events', () => getHeatListEvents())

ipcMain.handle('db:heat-list-sessions', () => getHeatListSessions())

ipcMain.handle('db:sessions', () => getSessions())

ipcMain.handle('db:athletes', () => getAthletes())

ipcMain.handle('db:save-result', (
  _event,
  swimresultId: number,
  finalTime: string | undefined,
  reactionTimeSecs: number | null,
  status: 'DNS' | 'DNF' | 'DSQ' | null,
  splits: Record<number, string> | undefined,
) => saveResult(swimresultId, finalTime, reactionTimeSecs, status, splits))

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
  return { ok: true }
})

ipcMain.handle('db:get-swim-styles', () => getSwimStyles())

ipcMain.handle('db:reorder-events', (_event, updates: Array<{ eventId: number; sessionId: number; sortcode: number }>) =>
  reorderEvents(updates).then(() => ({ ok: true }))
)

ipcMain.handle('db:generate-heats', async (_event, eventId?: number, sessionId?: number) => {
  try {
    const result = await generateHeats(eventId, sessionId)
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

ipcMain.handle('db:sync-up', async () => {
  try {
    const result = await syncUp()
    return { ok: true, tablesCreated: result.tablesCreated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('db:sync-down', async () => {
  try {
    const result = await syncDown()
    return { ok: true, rowsCopied: result.rowsCopied }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
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
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

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

ipcMain.handle('file:new-meet', async () => {
  try {
    // Flush all meet data
    await flushMeet()

    // Resolve template path (bundled resource or dev path)
    const templatePath = app.isPackaged
      ? join(process.resourcesPath, 'template_juniorsenior.lxf')
      : join(__dirname, '../../../../config/template_juniorsenior.lxf')

    // Import the template lenex file
    const summary = importLenex(templatePath, getLocalDb())
    return { ok: true, summary }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── Report IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('db:get-meet-info', () => getMeetInfo())

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
          label: 'Configurer la base de données…',
          click: () => mainWindow.webContents.send('menu:configure-db'),
        },
        { type: 'separator' },
        {
          label: 'Synchronisation ↓ (BD → app)',
          click: () => mainWindow.webContents.send('menu:sync-down'),
        },
        {
          label: 'Synchronisation ↑ (app → BD)',
          click: () => mainWindow.webContents.send('menu:sync-up'),
        },
        { type: 'separator' },
        {
          label: 'Importer un fichier LENEX…',
          click: () => mainWindow.webContents.send('menu:import-lenex'),
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
          label: 'Créer un nouveau meet…',
          click: () => mainWindow.webContents.send('menu:new-meet'),
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

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.sauvetagemeet')
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeLocalDb()
  if (process.platform !== 'darwin') app.quit()
})
