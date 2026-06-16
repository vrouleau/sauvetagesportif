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
  duration?: string
  swimstyleId?: number | null
  finalOrder?: number | null  // 1=fast-first (A swum first), 2=slow-first (A swum last, standard)
  maxEntries?: number | null  // beach: max participants per heat (overrides swimstyle.distance)
  fee?: number | null         // per-event entry fee in dollars (e.g., 5.00)
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
  finalSeedType?: number | null
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
  duplicateEvent?(sourceEventId: number, targetSessionId: number): Promise<{ id: number }>
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

  // Heat generation
  generateHeats(eventId?: number, sessionId?: number): Promise<{ heatsCreated: number; entriesAssigned: number }>

  // Meet import/export (optional — not all hosts support these)
  importMeet?(): Promise<{ ok: boolean; events?: number; error?: string }>
  exportMeet?(): Promise<{ ok: boolean; error?: string }>

  // Create a new meet from template, wiping all current data (optional)
  createMeet?(meetType: 'pool' | 'beach'): Promise<{ ok: boolean; meetType?: string; error?: string }>
}

// ─── Relay Team Types ─────────────────────────────────────────────────────────

export interface RelayTeamMember {
  position: number          // 1-based position (1 through relaycount)
  athleteId: number | null  // null = unassigned
  athleteName: string | null // "LastName, FirstName" or null
}

export interface RelayTeam {
  id: number                // relaysid (team-app) or relayid (meet-app)
  teamNumber: string        // "A", "B", "C"... (letter based on teamnumb)
  teamName: string | null   // Custom name or null (auto-generated from members)
  ageGroup?: string         // Age group code from the relay record (e.g., "15-18", "19+")
  members: RelayTeamMember[]
  clubId?: number           // Owning club ID (included in admin all-clubs view)
  clubName?: string         // Owning club name (included in admin all-clubs view)
}

export interface RelayEventGroup {
  eventId: number
  eventName: string
  swimstyleId: number
  relaycount: number        // number of positions per team (typically 4)
  gender: 'M' | 'F' | 'X'
  eventNumber: number       // for sorting
}

export interface RelayAgeCategory {
  ageCode: string           // "10-", "11-12", etc.
  ageMin: number
  ageMax: number | null
  events: RelayEventGroup[]
}

export interface RelayPageData {
  ageCategories: RelayAgeCategory[]       // sorted by age range ascending
  teamsByEvent: Record<string, RelayTeam[]> // key: `${eventId}-${ageCode}`
  eligibleAthletes: Record<string, EligibleAthlete[]> // key: `${eventId}-${ageCode}`
  closureDate: string | null
  isClosed: boolean
}

export interface EligibleAthlete {
  id: number
  name: string             // "LastName, FirstName"
  gender: 'M' | 'F'
  ageGroup?: string        // Registration age code (e.g., "15-18", "19+") from individual entries
}

// ─── Registration API (used by AthletesListPage & RegistrationPage) ───────────

export interface Club {
  id: number
  name: string
  athlete_count?: number
}

export interface AthleteListItem {
  id: number
  first_name: string
  last_name: string
  gender: string
  birthdate: string
  license: string
}

export interface RegistrationCategory {
  age_code: string
  event_id: number
  registered: boolean
  registration_id?: number
  entry_time_ms?: number | null
}

export interface RegistrationStyle {
  style_uid: string
  style_name: string
  best_time_lcm_ms: number | null
  best_time_scm_ms: number | null
  relay_count?: number
  locked_by_name?: string
  relay_members?: Array<{ position: number; athleteId: number | null }>
  categories: RegistrationCategory[]
}

export interface RegistrationData {
  athlete: {
    first_name: string
    last_name: string
    gender: string
    birthdate: string
    license: string
    club: string
    handicapex: string
  }
  individual_events: RegistrationStyle[]
  relay_events: RegistrationStyle[]
  club_athletes: Array<{ id: number; name: string }>
  suggested_age_code: string
  meet_course: string
  meet_type?: string
  closure_date?: string | null
}

export interface RegistrationAPI {
  getClubs(): Promise<Club[]>
  getAthletesByClub(clubId: string): Promise<AthleteListItem[]>
  getAllAthletes(): Promise<AthleteListItem[]>
  addAthlete(data: { first_name: string; last_name: string; gender: string; birthdate: string | null; license: string; club_id: number }): Promise<void>
  deleteAthlete(id: number): Promise<void>
  getRegistration(athleteId: number): Promise<RegistrationData>
  updateAthlete(athleteId: number, data: Record<string, unknown>): Promise<void>
  register(data: { athlete_id: number; event_id: number; entry_time_ms: number | null; age_code: string }): Promise<void>
  unregister(registrationId: number): Promise<void>
  setRelayMember?(eventId: number, position: number, athleteId: number | null): Promise<void>
  resetClubPin?(clubId: string): Promise<{ pin: string }>

  // Relay team management
  getRelayPageData(clubId?: number): Promise<RelayPageData>
  createRelayTeam(eventId: number, ageCode: string, clubId?: number): Promise<{ teamId: number; teamNumber: string }>
  deleteRelayTeam(teamId: number): Promise<void>
  setRelayTeamMember(teamId: number, position: number, athleteId: number | null): Promise<void>
  setRelayTeamName(teamId: number, name: string | null): Promise<void>
}
