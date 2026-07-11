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

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  menu: {
    onImportLenex: (cb: () => void) => {
      ipcRenderer.on('menu:import-lenex', cb)
      return () => { ipcRenderer.removeListener('menu:import-lenex', cb) }
    },
    onExportMeetLenex: (cb: () => void) => {
      ipcRenderer.on('menu:export-meet-lenex', cb)
      return () => { ipcRenderer.removeListener('menu:export-meet-lenex', cb) }
    },
    onExportLenexResults: (cb: () => void) => {
      ipcRenderer.on('menu:export-lenex-results', cb)
      return () => { ipcRenderer.removeListener('menu:export-lenex-results', cb) }
    },
    onSaveSMB: (cb: () => void) => {
      ipcRenderer.on('menu:save-smb', cb)
      return () => { ipcRenderer.removeListener('menu:save-smb', cb) }
    },
    onRestoreSMB: (cb: () => void) => {
      ipcRenderer.on('menu:restore-smb', cb)
      return () => { ipcRenderer.removeListener('menu:restore-smb', cb) }
    },
    onNewMeet: (cb: (meetType: string) => void) => {
      const handler = (_e: unknown, meetType: string) => cb(meetType)
      ipcRenderer.on('menu:new-meet', handler)
      return () => { ipcRenderer.removeListener('menu:new-meet', handler) }
    },
    onConfigureGemini: (cb: () => void) => {
      ipcRenderer.on('menu:configure-gemini', cb)
      return () => { ipcRenderer.removeListener('menu:configure-gemini', cb) }
    },
    onOpenGuide: (cb: (guideType: string) => void) => {
      const handler = (_e: unknown, guideType: string) => cb(guideType)
      ipcRenderer.on('menu:open-guide', handler)
      return () => { ipcRenderer.removeListener('menu:open-guide', handler) }
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
      dsqItemId?: number | null,
    ) => ipcRenderer.invoke('db:save-result', swimresultId, finalTime, reactionTimeSecs, status, splits, dsqItemId),
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
    duplicateEvent: (sourceEventId: number, targetSessionId: number) =>
      ipcRenderer.invoke('db:duplicate-event', sourceEventId, targetSessionId),
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
    getMeetType: () =>
      ipcRenderer.invoke('db:get-meet-type'),
    getDsqItems: () =>
      ipcRenderer.invoke('db:get-dsq-items'),
    register: (data: { athlete_id: number; event_id: number; entry_time_ms: number | null; age_code: string }) =>
      ipcRenderer.invoke('db:register', data),
    unregister: (athleteId: number, eventId: number) =>
      ipcRenderer.invoke('db:unregister', athleteId, eventId),
    getRelayMembers: (relayId: number) =>
      ipcRenderer.invoke('db:get-relay-members', relayId),
    getRelayMembersByEvent: (eventId: number, athleteId: number) =>
      ipcRenderer.invoke('db:get-relay-members-by-event', eventId, athleteId),
    setRelayMember: (eventId: number, athleteId: number, position: number, memberAthleteId: number | null) =>
      ipcRenderer.invoke('db:set-relay-member', eventId, athleteId, position, memberAthleteId),
    // Relay team management (new team-centric API)
    getClubsReal: () =>
      ipcRenderer.invoke('db:get-clubs'),
    getRelayPageData: (clubId?: number) =>
      ipcRenderer.invoke('db:get-relay-page-data', clubId),
    createRelayTeam: (eventId: number, ageCode: string, clubId?: number) =>
      ipcRenderer.invoke('db:create-relay-team', eventId, ageCode, clubId),
    deleteRelayTeam: (teamId: number) =>
      ipcRenderer.invoke('db:delete-relay-team', teamId),
    setRelayTeamMember: (teamId: number, position: number, athleteId: number | null) =>
      ipcRenderer.invoke('db:set-relay-team-member', teamId, position, athleteId),
    setRelayTeamName: (teamId: number, name: string | null) =>
      ipcRenderer.invoke('db:set-relay-team-name', teamId, name),
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
    flushMeet: () =>
      ipcRenderer.invoke('db:flush-meet'),
    getMeetInfo: () =>
      ipcRenderer.invoke('db:get-meet-info'),
    getCombinedResults: (selectedEventIds: number[]) =>
      ipcRenderer.invoke('db:get-combined-results', selectedEventIds),
    getBeachNumberReport: () =>
      ipcRenderer.invoke('db:get-beach-number-report'),
    getEntriesByEvent: (selectedEventIds: number[]) =>
      ipcRenderer.invoke('db:get-entries-by-event', selectedEventIds),
    getPointStandings: (selectedEventIds: number[]) =>
      ipcRenderer.invoke('db:get-point-standings', selectedEventIds),
    getResultsList: (selectedEventIds: number[]) =>
      ipcRenderer.invoke('db:get-results-list', selectedEventIds),
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
  pg: {
    connect: (config: { host: string; port: number; database: string; user: string; password: string }) =>
      ipcRenderer.invoke('pg:connect', config),
    disconnect: () =>
      ipcRenderer.invoke('pg:disconnect'),
    status: () =>
      ipcRenderer.invoke('pg:status'),
    fingerprint: () =>
      ipcRenderer.invoke('db:fingerprint'),
    onConnectPg: (cb: () => void) => {
      ipcRenderer.on('menu:connect-pg', cb)
      return () => { ipcRenderer.removeListener('menu:connect-pg', cb) }
    },
    onDisconnectPg: (cb: () => void) => {
      ipcRenderer.on('menu:disconnect-pg', cb)
      return () => { ipcRenderer.removeListener('menu:disconnect-pg', cb) }
    },
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
  timing: {
    saveScan: (data: {
      eventNumber: number; heatNumber: number; lane: number;
      barcodeRaw: string; imageBase64: string
    }) => ipcRenderer.invoke('timing:save-scan', data),
    getUnprocessed: () =>
      ipcRenderer.invoke('timing:get-unprocessed'),
    getScansForHeat: (eventNumber: number, heatNumber: number) =>
      ipcRenderer.invoke('timing:get-scans-for-heat', eventNumber, heatNumber),
    getScanSummary: () =>
      ipcRenderer.invoke('timing:get-scan-summary'),
    getScansForProcessing: (filter: string) =>
      ipcRenderer.invoke('timing:get-scans-for-processing', filter),
    runOcr: (scanId: number, engine: string) =>
      ipcRenderer.invoke('timing:run-ocr', scanId, engine),
    validateScan: (scanId: number, time1: string, timeMs1: number, time2: string, timeMs2: number) =>
      ipcRenderer.invoke('timing:validate-scan', scanId, time1, timeMs1, time2, timeMs2),
    markError: (scanId: number, notes: string) =>
      ipcRenderer.invoke('timing:mark-error', scanId, notes),
    commitHeatResults: (eventNumber: number, heatNumber: number) =>
      ipcRenderer.invoke('timing:commit-heat-results', eventNumber, heatNumber),
    generateSheets: (sessionId: number) =>
      ipcRenderer.invoke('timing:generate-sheets', sessionId),
    saveDebugImage: (imageBase64: string) =>
      ipcRenderer.invoke('timing:save-debug-image', imageBase64),
    getGeminiKey: () =>
      ipcRenderer.invoke('timing:get-gemini-key'),
    setGeminiKey: (freeKey: string | null, paidKey: string | null) =>
      ipcRenderer.invoke('timing:set-gemini-key', freeKey, paidKey),
    clearAllScans: () =>
      ipcRenderer.invoke('timing:clear-all-scans'),
    setGeminiBackground: (enabled: boolean) =>
      ipcRenderer.invoke('timing:set-gemini-background', enabled),
    getGeminiBackground: () =>
      ipcRenderer.invoke('timing:get-gemini-background'),
  },
  file: {
    openLxfDialog: () =>
      ipcRenderer.invoke('file:open-lenex-dialog'),
    importLenex: (path: string, lang?: string) =>
      ipcRenderer.invoke('file:import-lenex', path, lang),
    exportMeetLenex: () =>
      ipcRenderer.invoke('file:export-meet-lenex'),
    exportLenexResults: () =>
      ipcRenderer.invoke('file:export-lenex-results'),
    saveSMB: () =>
      ipcRenderer.invoke('file:save-smb'),
    restoreSMB: () =>
      ipcRenderer.invoke('file:restore-smb'),
    newMeet: (meetType?: string, lang?: string) =>
      ipcRenderer.invoke('file:new-meet', meetType, lang),
    onMeetTypeChanged: (cb: (meetType: string) => void) => {
      const handler = (_e: unknown, meetType: string) => cb(meetType)
      ipcRenderer.on('file:meet-type-changed', handler)
      return () => { ipcRenderer.removeListener('file:meet-type-changed', handler) }
    },
  },
  live: {
    getStatus: () =>
      ipcRenderer.invoke('live:get-status'),
    pushAll: () =>
      ipcRenderer.invoke('live:push-all'),
    announce: (payload: { type: 'call_to_marshall' | 'call_to_scratch'; event_id: number; event_number: number; event_name: string; gender: string }) =>
      ipcRenderer.invoke('live:announce', payload),
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
