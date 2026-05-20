import { app, BrowserWindow, shell, ipcMain, dialog, nativeImage, Menu } from 'electron'
import { join } from 'path'
import { QuantumBridge, type ActiveHeat, type ScheduleEvent } from './quantum'
import {
  configureDb, getDbConfig, testConnection,
  getHeatListEvents, getHeatListSessions, getSessions, getAthletes,
  saveResult,
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
  getSwimStyles,
  reorderEvents,
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

ipcMain.handle('db:sessions', () => getSessions().then(r => { console.log('[db:sessions]', r.length, 'sessions, events:', r.map(s => s.events.length)); return r }))

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

ipcMain.handle('db:save-athlete', (_event, athlete: Parameters<typeof saveAthlete>[0]) =>
  saveAthlete(athlete).then(() => ({ ok: true }))
)

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
