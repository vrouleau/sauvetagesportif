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
 * RegistrationAPI adapter for the Electron meet-app.
 * Maps the local SQLite data (via IPC) to the RegistrationAPI interface.
 *
 * The meet-app has a different data model than the team-app:
 * - Athletes are stored with entries already assigned
 * - There's no "club PIN" concept (single-user desktop app)
 * - Registration data is built from sessions/events/agegroups + athlete entries
 */
import type { RegistrationAPI, Club, AthleteListItem, RegistrationData, RegistrationStyle, RelayPageData } from '@shared/data/api'

// Track the last athlete ID for unregister (which only receives registrationId/eventId)
let _lastAthleteId = 0

function ipc() {
  return (window as unknown as {
    api?: {
      db?: Record<string, (...args: unknown[]) => Promise<unknown>>
    }
  }).api?.db
}

interface LocalAthlete {
  id: number
  lastName: string
  firstName: string
  birthDate: string
  gender: 'M' | 'F'
  nation: string
  clubId: number | null
  clubCode: string
  clubName: string
  licence?: string
  handicapex?: string
  entries: Array<{ eventId: number; eventName: string; category: string; entryTime?: string }>
}

interface LocalSession {
  id: number
  events: Array<{
    id: number
    number: number
    nameFr: string
    nameEn: string
    gender: 'M' | 'F' | 'X'
    distance: number
    phase: string
    swimstyleId?: number | null
    ageGroups: Array<{
      id: number
      name: string
      minAge: number
      maxAge: number | null
      gender: string
    }>
  }>
}

interface LocalSwimStyle {
  id: number
  distance: number
  stroke: number
  name: string
  relaycount: number
}

function displayToMs(t: string | undefined): number | null {
  if (!t || t === 'NT') return null
  const m = t.match(/^(\d+):(\d{2})\.(\d{2})$/)
  if (m) return parseInt(m[1]) * 60000 + parseInt(m[2]) * 1000 + parseInt(m[3]) * 10
  const m2 = t.match(/^(\d+)\.(\d{2})$/)
  if (m2) return parseInt(m2[1]) * 1000 + parseInt(m2[2]) * 10
  return null
}

function ageCodeFromGroup(name: string, minAge?: number, maxAge?: number | null): string {
  // Try name-based matching first
  if (name) {
    if (/10/.test(name) && /under|moins|-/.test(name.toLowerCase())) return '10-'
    if (/11.*12/.test(name)) return '11-12'
    if (/13.*14/.test(name)) return '13-14'
    if (/15.*18/.test(name)) return '15-18'
    if (/master/i.test(name)) return 'Masters'
  }
  // Fall back to numeric age range
  if (minAge != null && maxAge != null) {
    if (maxAge <= 10) return '10-'
    if (minAge === 11 && maxAge === 12) return '11-12'
    if (minAge === 13 && maxAge === 14) return '13-14'
    if (minAge === 15 && maxAge <= 18) return '15-18'
    if (minAge >= 19) return 'Open'
  }
  if (minAge != null && (maxAge == null || maxAge === -1 || maxAge >= 99)) {
    if (minAge >= 19) return 'Open'
    if (minAge >= 15) return '15-18'
  }
  return 'Open'
}

function calcAge(birthDate: string): number {
  const birth = new Date(birthDate)
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const m = now.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--
  return age
}

function suggestAgeCode(age: number): string {
  if (age <= 10) return '10-'
  if (age <= 12) return '11-12'
  if (age <= 14) return '13-14'
  if (age <= 18) return '15-18'
  return 'Open'
}

export const registrationApiElectron: RegistrationAPI = {
  async getClubs(): Promise<Club[]> {
    return (await ipc()?.getClubsReal()) as Club[] ?? []
  },

  async getAthletesByClub(clubId: string): Promise<AthleteListItem[]> {
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    const numericId = parseInt(clubId, 10)
    return athletes
      .filter(a => a.clubId === numericId)
      .map(a => ({
        id: a.id,
        first_name: a.firstName,
        last_name: a.lastName,
        gender: a.gender,
        birthdate: a.birthDate,
        license: a.licence ?? '',
      }))
  },

  async getAllAthletes(): Promise<AthleteListItem[]> {
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    return athletes.map(a => ({
      id: a.id,
      first_name: a.firstName,
      last_name: a.lastName,
      gender: a.gender,
      birthdate: a.birthDate,
      license: a.licence ?? '',
    }))
  },

  async addAthlete(data) {
    const created = await ipc()?.saveAthlete({
      id: 0, // new
      lastName: data.last_name,
      firstName: data.first_name,
      gender: data.gender,
      birthDate: data.birthdate || '2000-01-01',
      nation: 'CAN',
      clubCode: '',
      clubName: '',
      licence: data.license,
    }) as { id: number } | undefined
    // Assign the real club by ID directly — the club may not have any existing
    // athletes yet, so resolving clubCode/clubName by scanning other athletes
    // wouldn't work for a brand-new/empty club.
    if (created?.id) {
      await ipc()?.setAthleteClub(created.id, data.club_id)
    }
  },

  async deleteAthlete(_id) {
    // Not directly supported in meet-app IPC — no-op for now
  },

  async getRegistration(athleteId: number): Promise<RegistrationData> {
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    const sessions = (await ipc()?.getSessions()) as LocalSession[] ?? []
    const swimStyles = (await ipc()?.getSwimStyles()) as LocalSwimStyle[] ?? []
    const meetConfig = (await ipc()?.getMeetConfig()) as Record<string, string> ?? {}

    const athlete = athletes.find(a => a.id === athleteId)
    if (!athlete) throw new Error('Athlete not found')
    _lastAthleteId = athleteId

    const course = meetConfig.COURSE === '3' ? 'SCM' : 'LCM'
    const age = calcAge(athlete.birthDate)
    const suggestedAgeCode = suggestAgeCode(age)

    // Build registration styles from events
    const individualEvents: RegistrationStyle[] = []
    const relayEvents: RegistrationStyle[] = []

    // Map swimstyle id to relay count
    const styleRelayMap = new Map<number, number>()
    for (const ss of swimStyles) {
      styleRelayMap.set(ss.id, ss.relaycount)
    }

    // Group events by swim style
    const styleMap = new Map<string, RegistrationStyle>()

    for (const session of sessions) {
      for (const event of session.events) {
        if (event.gender !== 'X' && event.gender !== athlete.gender) continue

        const relayCount = event.swimstyleId ? (styleRelayMap.get(event.swimstyleId) ?? 1) : 1
        const styleUid = `${event.distance}-${event.swimstyleId ?? event.nameFr}`

        if (!styleMap.has(styleUid)) {
          styleMap.set(styleUid, {
            style_uid: styleUid,
            style_name: event.nameFr || event.nameEn || `${event.distance}m`,
            best_time_lcm_ms: null,
            best_time_scm_ms: null,
            relay_count: relayCount,
            categories: [],
          })
        }

        const style = styleMap.get(styleUid)!

        for (const ag of event.ageGroups) {
          const ageCode = ageCodeFromGroup(ag.name, ag.minAge, ag.maxAge)
          // Check if athlete is registered for this event
          const entry = athlete.entries.find(e => e.eventId === event.id)
          style.categories.push({
            age_code: ageCode,
            event_id: event.id,
            registered: !!entry,
            registration_id: entry ? event.id : undefined,
            entry_time_ms: entry ? displayToMs(entry.entryTime) : null,
          })
        }
      }
    }

    for (const [, style] of styleMap) {
      if ((style.relay_count ?? 1) > 1) {
        // Load relay members for this event
        const reg = style.categories.find(c => c.registered)
        if (reg) {
          const members = (await ipc()?.getRelayMembersByEvent(reg.event_id, athleteId)) as Array<{ position: number; athleteId: number }> ?? []
          style.relay_members = members.map(m => ({ position: m.position, athleteId: m.athleteId }))
        }
        relayEvents.push(style)
      } else {
        individualEvents.push(style)
      }
    }

    // Club athletes for relay teammate selection
    const clubAthletes = athletes
      .filter(a => a.clubCode === athlete.clubCode && a.id !== athleteId)
      .map(a => ({ id: a.id, name: `${a.lastName}, ${a.firstName}` }))

    return {
      athlete: {
        first_name: athlete.firstName,
        last_name: athlete.lastName,
        gender: athlete.gender,
        birthdate: athlete.birthDate,
        license: athlete.licence ?? '',
        club: athlete.clubName,
        club_id: athlete.clubId ?? undefined,
        handicapex: athlete.handicapex ?? '',
      },
      individual_events: individualEvents,
      relay_events: relayEvents,
      club_athletes: clubAthletes,
      suggested_age_code: suggestedAgeCode,
      meet_course: course,
      meet_type: ((await ipc()?.getMeetType()) as string) || 'POOL',
    }
  },

  async updateAthlete(athleteId, data) {
    if (data.club_id != null) {
      await ipc()?.setAthleteClub(athleteId, Number(data.club_id))
      return
    }
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    const athlete = athletes.find(a => a.id === athleteId)
    if (!athlete) return
    await ipc()?.saveAthlete({
      id: athleteId,
      lastName: data.last_name ?? athlete.lastName,
      firstName: data.first_name ?? athlete.firstName,
      gender: data.gender ?? athlete.gender,
      birthDate: data.birthdate ?? athlete.birthDate,
      nation: athlete.nation,
      clubCode: athlete.clubCode,
      clubName: athlete.clubName,
      licence: data.license ?? athlete.licence,
      handicapex: data.handicapex ?? athlete.handicapex,
    })
  },

  async register(data) {
    await ipc()?.register(data)
  },

  async unregister(registrationId) {
    await ipc()?.unregister(_lastAthleteId, registrationId)
  },

  async setRelayMember(eventId, position, athleteId) {
    await ipc()?.setRelayMember(eventId, _lastAthleteId, position, athleteId)
  },

  // Relay team management (new team-centric API)
  async getRelayPageData(clubId?: number): Promise<RelayPageData> {
    return (await ipc()?.getRelayPageData(clubId)) as RelayPageData
  },

  async createRelayTeam(eventId: number, ageCode: string, clubId?: number): Promise<{ teamId: number; teamNumber: string }> {
    return (await ipc()?.createRelayTeam(eventId, ageCode, clubId)) as { teamId: number; teamNumber: string }
  },

  async deleteRelayTeam(teamId: number): Promise<void> {
    await ipc()?.deleteRelayTeam(teamId)
  },

  async setRelayTeamMember(teamId: number, position: number, athleteId: number | null): Promise<void> {
    await ipc()?.setRelayTeamMember(teamId, position, athleteId)
  },

  async setRelayTeamName(teamId: number, name: string | null): Promise<void> {
    await ipc()?.setRelayTeamName(teamId, name)
  },
}