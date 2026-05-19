/**
 * MeetAPI — abstract data layer interface.
 *
 * Each app (Electron / Web) provides its own implementation:
 * - Electron: wraps window.api.db.* (IPC to local SQLite)
 * - Web: wraps fetch('/api/...') (HTTP to FastAPI backend)
 */

export interface Session {
  id: number
  number: number
  name: string
  date?: string
  time?: string
  endTime?: string
  poolSize: number
  laneMin?: number
  laneMax?: number
  warmupFrom?: string
  warmupUntil?: string
  officialMeeting?: string
  remarks?: string
  remarksJury?: string
  maxEntriesAthlete?: number
  maxEntriesRelay?: number
  feeAthlete?: number
  timing?: number
  touchpadMode?: number
  roundToTenths?: boolean
  events: CompetitionEvent[]
}

export interface CompetitionEvent {
  id: number
  sessionId: number
  number: number
  nameFr: string
  nameEn: string
  gender: 'M' | 'F' | 'X'
  distance: number
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe'
  isAdmin?: boolean
  scheduledTime?: string
  swimstyleId?: number | null
  ageGroups: AgeGroup[]
}

export interface AgeGroup {
  id: number
  number: number
  name: string
  minAge: number
  maxAge: number | null
  gender: string
  numHeats: number
  ranking: string
  countForMedalStats: boolean
  usedForCombined: boolean
  alwaysSwimPrelims: boolean
  advanceByTime: boolean
  laneOrderInFinals: string
}

export interface SwimStyle {
  id: number
  distance: number
  stroke: number
  name: string
  relaycount: number
}

export interface Athlete {
  id: number
  lastName: string
  firstName: string
  birthDate: string
  gender: 'M' | 'F'
  nation: string
  clubCode: string
  clubName: string
  licence?: string
  birthPlace?: string
  entries: Array<{ eventId: number; eventName: string; category: string; entryTime?: string }>
}

export interface SessionUpdate {
  name?: string
  sessionnumber?: number
  daytime?: string | null
  endtime?: string | null
  course?: number
  lanemin?: number | null
  lanemax?: number | null
  warmupfrom?: string | null
  warmupuntil?: string | null
  officialmeeting?: string | null
  remarks?: string | null
  remarksjury?: string | null
  maxentriesathlete?: number | null
  maxentriesrelay?: number | null
  feeathlete?: number | null
  timing?: number | null
  touchpadmode?: number | null
  roundtotenths?: boolean
}

export interface MeetAPI {
  // Sessions
  getSessions(): Promise<Session[]>
  createSession(name: string, number: number): Promise<{ id: number }>
  updateSession(sessionId: number, data: SessionUpdate): Promise<void>
  deleteSession(sessionId: number): Promise<void>

  // Events
  createEvent(sessionId: number, number: number, gender: string, distance: number, phase: string, styleName: string): Promise<{ id: number }>
  createBreak(sessionId: number, number: number, name: string): Promise<{ id: number }>
  deleteEvent(eventId: number): Promise<void>
  updateEvent(eventId: number, data: Record<string, unknown>): Promise<void>
  reorderEvents(updates: Array<{ eventId: number; sessionId: number; sortcode: number }>): Promise<void>

  // Age groups
  createAgeGroup(eventId: number, name: string, minAge: number, maxAge: number | null, gender: string): Promise<{ id: number }>
  deleteAgeGroup(agegroupId: number): Promise<void>
  updateAgeGroup(agegroupId: number, data: Record<string, unknown>): Promise<void>

  // Athletes
  getAthletes(): Promise<Athlete[]>
  saveAthlete(athlete: Record<string, unknown>): Promise<void>

  // Meet config (MEETVALUES in bsglobal)
  getMeetConfig(): Promise<Record<string, string>>
  setMeetConfig(entries: Record<string, { type: string; value: string }>): Promise<void>

  // Swim styles
  getSwimStyles(): Promise<SwimStyle[]>
}
