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
    generateHeats: (eventId?: number, sessionId?: number) =>
      ipcRenderer.invoke('db:generate-heats', eventId, sessionId),
    validateEvent: (eventId: number) =>
      ipcRenderer.invoke('db:validate-event', eventId),
    invalidateEvent: (eventId: number) =>
      ipcRenderer.invoke('db:invalidate-event', eventId),
    validateHeat: (heatId: number) =>
      ipcRenderer.invoke('db:validate-heat', heatId),
    invalidateHeat: (heatId: number) =>
      ipcRenderer.invoke('db:invalidate-heat', heatId),
    validateSession: (sessionId: number) =>
      ipcRenderer.invoke('db:validate-session', sessionId),
    invalidateSession: (sessionId: number) =>
      ipcRenderer.invoke('db:invalidate-session', sessionId),
    removeFromHeat: (swimresultId: number) =>
      ipcRenderer.invoke('db:remove-from-heat', swimresultId),
    assignToHeatLane: (swimresultId: number, heatId: number, lane: number) =>
      ipcRenderer.invoke('db:assign-to-heat-lane', swimresultId, heatId, lane),
    swapLanes: (resultIdA: number, heatIdA: number, laneA: number, resultIdB: number, heatIdB: number, laneB: number) =>
      ipcRenderer.invoke('db:swap-lanes', resultIdA, heatIdA, laneA, resultIdB, heatIdB, laneB),
    addLateEntry: (athleteId: number, eventId: number, heatId: number, lane: number, entryTime: number | null) =>
      ipcRenderer.invoke('db:add-late-entry', athleteId, eventId, heatId, lane, entryTime),
    getAvailableAthletesForEvent: (eventId: number) =>
      ipcRenderer.invoke('db:available-athletes-for-event', eventId),
    saveAthlete: (athlete: unknown) =>
      ipcRenderer.invoke('db:save-athlete', athlete),
    syncUp: () =>
      ipcRenderer.invoke('db:sync-up'),
    syncDown: () =>
      ipcRenderer.invoke('db:sync-down'),
    flushMeet: () =>
      ipcRenderer.invoke('db:flush-meet'),
    getMeetInfo: () =>
      ipcRenderer.invoke('db:get-meet-info'),
    // Finals
    getFinalEvents: () =>
      ipcRenderer.invoke('db:get-final-events'),
    getFinalCandidates: (finalEventId: number) =>
      ipcRenderer.invoke('db:get-final-candidates', finalEventId),
    setQualification: (finalEventId: number, athleteId: number, qualCode: string | null, noAdvance: boolean) =>
      ipcRenderer.invoke('db:set-qualification', finalEventId, athleteId, qualCode, noAdvance),
    autoQualify: (finalEventId: number) =>
      ipcRenderer.invoke('db:auto-qualify', finalEventId),
    clearFinalSeeding: (finalEventId: number) =>
      ipcRenderer.invoke('db:clear-final-seeding', finalEventId),
    seedFinals: (finalEventId: number) =>
      ipcRenderer.invoke('db:seed-finals', finalEventId),
  },
  report: {
    previewPdf: (html: string, headerInfo: unknown) =>
      ipcRenderer.invoke('report:preview-pdf', html, headerInfo),
    saveHtml: (html: string) =>
      ipcRenderer.invoke('report:save-html', html),
    savePdf: (html: string, headerInfo: unknown) =>
      ipcRenderer.invoke('report:save-pdf', html, headerInfo),
    print: (html: string, headerInfo: unknown) =>
      ipcRenderer.invoke('report:print', html, headerInfo),
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
    newMeet: () =>
      ipcRenderer.invoke('file:new-meet'),
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
