import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  menu: {
    onConfigureDb: (cb: () => void) => {
      ipcRenderer.on('menu:configure-db', cb)
      return () => { ipcRenderer.removeListener('menu:configure-db', cb) }
    },
    onSyncDown: (cb: () => void) => {
      ipcRenderer.on('menu:sync-down', cb)
      return () => { ipcRenderer.removeListener('menu:sync-down', cb) }
    },
    onSyncUp: (cb: () => void) => {
      ipcRenderer.on('menu:sync-up', cb)
      return () => { ipcRenderer.removeListener('menu:sync-up', cb) }
    },
    onImportLenex: (cb: () => void) => {
      ipcRenderer.on('menu:import-lenex', cb)
      return () => { ipcRenderer.removeListener('menu:import-lenex', cb) }
    },
    onSaveSMB: (cb: () => void) => {
      ipcRenderer.on('menu:save-smb', cb)
      return () => { ipcRenderer.removeListener('menu:save-smb', cb) }
    },
    onRestoreSMB: (cb: () => void) => {
      ipcRenderer.on('menu:restore-smb', cb)
      return () => { ipcRenderer.removeListener('menu:restore-smb', cb) }
    },
    onNewMeet: (cb: () => void) => {
      ipcRenderer.on('menu:new-meet', cb)
      return () => { ipcRenderer.removeListener('menu:new-meet', cb) }
    },
  },
  quantum: {
    configure: (folder: string) =>
      ipcRenderer.invoke('quantum:configure', folder),
    activateHeat: (data: unknown) =>
      ipcRenderer.invoke('quantum:activate-heat', data),
    setSchedule: (events: unknown) =>
      ipcRenderer.invoke('quantum:set-schedule', events),
    onConnected: (cb: (version: string) => void) =>
      ipcRenderer.on('quantum:connected', (_e, v) => cb(v)),
    onResult: (cb: (result: unknown) => void) =>
      ipcRenderer.on('quantum:result', (_e, r) => cb(r)),
    onHeatStatus: (cb: (status: unknown) => void) =>
      ipcRenderer.on('quantum:heat-status', (_e, s) => cb(s)),
    removeAllListeners: (channel: string) =>
      ipcRenderer.removeAllListeners(channel),
  },
  db: {
    configure: (cfg: unknown) =>
      ipcRenderer.invoke('db:configure', cfg),
    getConfig: () =>
      ipcRenderer.invoke('db:get-config'),
    testConnection: () =>
      ipcRenderer.invoke('db:test-connection'),
    getHeatListEvents: () =>
      ipcRenderer.invoke('db:heat-list-events'),
    getHeatListSessions: () =>
      ipcRenderer.invoke('db:heat-list-sessions'),
    getSessions: () =>
      ipcRenderer.invoke('db:sessions'),
    getAthletes: () =>
      ipcRenderer.invoke('db:athletes'),
    saveResult: (
      swimresultId: number,
      finalTime: string | undefined,
      reactionTimeSecs: number | null,
      status: string | null,
      splits: Record<number, string> | undefined,
    ) => ipcRenderer.invoke('db:save-result', swimresultId, finalTime, reactionTimeSecs, status, splits),
    createSession: (name: string, number: number) =>
      ipcRenderer.invoke('db:create-session', name, number),
    updateSession: (sessionId: number, data: unknown) =>
      ipcRenderer.invoke('db:update-session', sessionId, data),
    deleteSession: (sessionId: number) =>
      ipcRenderer.invoke('db:delete-session', sessionId),
    createEvent: (
      sessionId: number, number: number,
      gender: string, distance: number,
      phase: string, styleName: string,
    ) => ipcRenderer.invoke('db:create-event', sessionId, number, gender, distance, phase, styleName),
    createBreak: (sessionId: number, number: number, name: string) =>
      ipcRenderer.invoke('db:create-break', sessionId, number, name),
    deleteEvent: (eventId: number) =>
      ipcRenderer.invoke('db:delete-event', eventId),
    updateEvent: (eventId: number, data: unknown) =>
      ipcRenderer.invoke('db:update-event', eventId, data),
    createAgeGroup: (
      eventId: number, name: string,
      minAge: number, maxAge: number | null, gender: string,
    ) => ipcRenderer.invoke('db:create-age-group', eventId, name, minAge, maxAge, gender),
    deleteAgeGroup: (agegroupId: number) =>
      ipcRenderer.invoke('db:delete-age-group', agegroupId),
    updateAgeGroup: (agegroupId: number, data: unknown) =>
      ipcRenderer.invoke('db:update-age-group', agegroupId, data),
    getMeetConfig: () =>
      ipcRenderer.invoke('db:get-meet-config'),
    setMeetConfig: (entries: Record<string, { type: string; value: string }>) =>
      ipcRenderer.invoke('db:set-meet-config', entries),
    getSwimStyles: () =>
      ipcRenderer.invoke('db:get-swim-styles'),
    reorderEvents: (updates: Array<{ eventId: number; sessionId: number; sortcode: number }>) =>
      ipcRenderer.invoke('db:reorder-events', updates),
    saveAthlete: (athlete: unknown) =>
      ipcRenderer.invoke('db:save-athlete', athlete),
    syncUp: () =>
      ipcRenderer.invoke('db:sync-up'),
    syncDown: () =>
      ipcRenderer.invoke('db:sync-down'),
    flushMeet: () =>
      ipcRenderer.invoke('db:flush-meet'),
  },
  file: {
    openLxfDialog: () =>
      ipcRenderer.invoke('file:open-lenex-dialog'),
    importLenex: (path: string) =>
      ipcRenderer.invoke('file:import-lenex', path),
    saveSMB: () =>
      ipcRenderer.invoke('file:save-smb'),
    restoreSMB: () =>
      ipcRenderer.invoke('file:restore-smb'),
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
