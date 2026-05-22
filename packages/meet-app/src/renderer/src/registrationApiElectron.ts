/**
 * RegistrationAPI adapter for the Electron meet-app.
 * Maps the local SQLite data (via IPC) to the RegistrationAPI interface.
 *
 * The meet-app has a different data model than the team-app:
 * - Athletes are stored with entries already assigned
 * - There's no "club PIN" concept (single-user desktop app)
 * - Registration data is built from sessions/events/agegroups + athlete entries
 */
import type { RegistrationAPI, Club, AthleteListItem, RegistrationData, RegistrationStyle } from '@shared/data/api'

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

function ageCodeFromGroup(name: string): string {
  if (/10/.test(name) && /under|moins|-/.test(name.toLowerCase())) return '10-'
  if (/11.*12/.test(name)) return '11-12'
  if (/13.*14/.test(name)) return '13-14'
  if (/15.*18/.test(name)) return '15-18'
  if (/master/i.test(name)) return 'Masters'
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

/**
 * Generate a stable numeric ID from a club code string.
 * Uses a simple hash so that getClubs() and getAthletesByClub() produce consistent IDs.
 */
function clubCodeToId(code: string): number {
  let hash = 0
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) - hash + code.charCodeAt(i)) | 0
  }
  // Ensure positive
  return Math.abs(hash) || 1
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
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    const clubMap = new Map<string, { name: string; count: number }>()
    for (const a of athletes) {
      const key = a.clubCode || a.clubName || 'Unknown'
      const existing = clubMap.get(key)
      if (existing) existing.count++
      else clubMap.set(key, { name: a.clubName || a.clubCode || 'Unknown', count: 1 })
    }
    // Use a stable hash of the club code as the ID so getAthletesByClub can match
    return Array.from(clubMap.entries()).map(([code, { name, count }]) => ({
      id: clubCodeToId(code),
      name: `${name} (${code})`,
      athlete_count: count,
    }))
  },

  async getAthletesByClub(clubId: string): Promise<AthleteListItem[]> {
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    const numericId = parseInt(clubId, 10)
    // Filter athletes whose club code hashes to the requested clubId
    return athletes
      .filter(a => clubCodeToId(a.clubCode || a.clubName || 'Unknown') === numericId)
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
    // Resolve the club code from the numeric club_id (hash-based)
    const athletes = (await ipc()?.getAthletes()) as LocalAthlete[] ?? []
    let clubCode = ''
    let clubName = ''
    for (const a of athletes) {
      const key = a.clubCode || a.clubName || 'Unknown'
      if (clubCodeToId(key) === data.club_id) {
        clubCode = a.clubCode
        clubName = a.clubName
        break
      }
    }
    await ipc()?.saveAthlete({
      id: 0, // new
      lastName: data.last_name,
      firstName: data.first_name,
      gender: data.gender,
      birthDate: data.birthdate || '2000-01-01',
      nation: 'CAN',
      clubCode,
      clubName,
      licence: data.license,
    })
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
          const ageCode = ageCodeFromGroup(ag.name)
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
        handicapex: athlete.handicapex ?? '',
      },
      individual_events: individualEvents,
      relay_events: relayEvents,
      club_athletes: clubAthletes,
      suggested_age_code: suggestedAgeCode,
      meet_course: course,
    }
  },

  async updateAthlete(athleteId, data) {
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

  async register(_data) {
    // Registration in meet-app would require creating a swimresult entry
    // This is a complex operation — stub for now
    console.warn('register() not yet implemented for meet-app local DB')
  },

  async unregister(_registrationId) {
    // Would require deleting a swimresult entry
    console.warn('unregister() not yet implemented for meet-app local DB')
  },
}
