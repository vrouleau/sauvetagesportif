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

/**
 * MeetAPI adapter for the Electron app (IPC → local SQLite via main process).
 * Implements the MeetAPI interface from shared-ui.
 */
import type { MeetAPI, Session, SwimStyle, Athlete } from '@shared/data/api'

function ipc() {
  return (window as unknown as {
    api?: {
      db?: Record<string, (...args: unknown[]) => Promise<unknown>>
    }
  }).api?.db
}

export const meetApiElectron: MeetAPI = {
  async getSessions() {
    return (await ipc()?.getSessions()) as Session[] ?? []
  },
  async createSession(name, number) {
    return (await ipc()?.createSession(name, number)) as { id: number }
  },
  async updateSession(sessionId, data) {
    await ipc()?.updateSession(sessionId, data)
  },
  async deleteSession(sessionId) {
    await ipc()?.deleteSession(sessionId)
  },
  async createEvent(sessionId, number, gender, distance, phase, styleName) {
    return (await ipc()?.createEvent(sessionId, number, gender, distance, phase, styleName)) as { id: number }
  },
  async createBreak(sessionId, number, name) {
    return (await ipc()?.createBreak(sessionId, number, name)) as { id: number }
  },
  async deleteEvent(eventId) {
    await ipc()?.deleteEvent(eventId)
  },
  async duplicateEvent(sourceEventId, targetSessionId) {
    return (await ipc()?.duplicateEvent(sourceEventId, targetSessionId)) as { id: number }
  },
  async updateEvent(eventId, data) {
    await ipc()?.updateEvent(eventId, data)
  },
  async reorderEvents(updates) {
    await ipc()?.reorderEvents(updates)
  },
  async createAgeGroup(eventId, name, minAge, maxAge, gender) {
    return (await ipc()?.createAgeGroup(eventId, name, minAge, maxAge, gender)) as { id: number }
  },
  async deleteAgeGroup(agegroupId) {
    await ipc()?.deleteAgeGroup(agegroupId)
  },
  async updateAgeGroup(agegroupId, data) {
    await ipc()?.updateAgeGroup(agegroupId, data)
  },
  async getAthletes() {
    return (await ipc()?.getAthletes()) as Athlete[] ?? []
  },
  async saveAthlete(athlete) {
    await ipc()?.saveAthlete(athlete)
  },
  async getMeetConfig() {
    return (await ipc()?.getMeetConfig()) as Record<string, string> ?? {}
  },
  async setMeetConfig(entries) {
    await ipc()?.setMeetConfig(entries)
  },
  async getSwimStyles() {
    return (await ipc()?.getSwimStyles()) as SwimStyle[] ?? []
  },
  async generateHeats(eventId?: number, sessionId?: number) {
    const result = (await ipc()?.generateHeats(eventId, sessionId)) as { heatsCreated: number; entriesAssigned: number } | undefined
    return result ?? { heatsCreated: 0, entriesAssigned: 0 }
  },
  async importMeet() {
    const fileApi = (window as unknown as { api?: { file?: { openLxfDialog: () => Promise<string | null>; importLenex: (path: string, lang?: string) => Promise<{ ok: boolean; summary?: { events: number }; error?: string }> } } }).api?.file
    if (!fileApi) return { ok: false, error: 'File API not available' }
    const path = await fileApi.openLxfDialog()
    if (!path) return { ok: false }
    const lang = document.documentElement.lang || 'fr'
    const result = await fileApi.importLenex(path, lang)
    if (result.ok) return { ok: true, events: result.summary?.events }
    return { ok: false, error: result.error }
  },
  async exportMeet() {
    const fileApi = (window as unknown as { api?: { file?: { exportLenexResults: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }> } } }).api?.file
    if (!fileApi) return { ok: false, error: 'File API not available' }
    const result = await fileApi.exportLenexResults()
    if (result.canceled) return { ok: false }
    if (result.ok) return { ok: true }
    return { ok: false, error: result.error }
  },
  async createMeet(meetType) {
    const fileApi = (window as unknown as { api?: { file?: { newMeet: (type: string, lang?: string) => Promise<{ ok: boolean; meetType?: string; error?: string }> } } }).api?.file
    if (!fileApi) return { ok: false, error: 'File API not available' }
    const lang = document.documentElement.lang || 'fr'
    const result = await fileApi.newMeet(meetType, lang)
    return { ok: result.ok, meetType: result.meetType, error: result.error }
  },
}