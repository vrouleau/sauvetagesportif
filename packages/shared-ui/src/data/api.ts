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
  /** LENEX course name — each backend stores its own number (meet-app: Splash's) */
  course?: 'LCM' | 'SCM' | 'SCY'
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
  /** Individual events: 'ALL' | 'M' | 'F'. Relay events: 'X' (Mixed) | 'M' | 'F'. */
  gender: 'ALL' | 'M' | 'F' | 'X'
  distance: number
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe'
  isAdmin?: boolean
  scheduledTime?: string
  duration?: string
  swimstyleId?: number | null
  prevEventId?: number | null // for a 'Finale' event, the id of its paired 'Eliminatoire' prelim
  finalOrder?: number | null  // 1=fast-first (A swum first), 2=slow-first (A swum last, standard)
  maxEntries?: number | null  // beach: max participants per heat (overrides swimstyle.distance)
  fee?: number | null         // per-event entry fee in dollars (e.g., 5.00)
  masters?: boolean
  ageGroups: AgeGroup[]
}

export interface AgeGroup {
  id: number
  number: number
  name: string
  minAge: number
  maxAge: number | null
  /** Always mirrors the parent event's gender — never independently editable. */
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
  /** Move an age group (and all its entries) to a different event of the same swim style. */
  moveAgeGroup?(agegroupId: number, targetEventId: number): Promise<void>

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
  /** This member's relay best time (ms) for the event's style and the meet's course: the
   *  fastest total of any past relay team they swam on. Team-app only; drives the suggested
   *  team entry time (average of members who have one). */
  relayBestTimeMs?: number | null
}

export interface RelayTeam {
  id: number                // relaysid (team-app) or relayid (meet-app)
  teamNumber: string        // "A", "B", "C"... (letter based on teamnumb)
  teamName: string | null   // Custom name or null (auto-generated from members)
  ageGroup?: string         // Age group code from the relay record (e.g., "15-18", "19+")
  members: RelayTeamMember[]
  clubId?: number           // Owning club ID (included in admin all-clubs view)
  clubName?: string         // Owning club name (included in admin all-clubs view)
  /** Hors concours / exhibition — bypasses age/gender composition rules, same as SERC.
   *  Stored as resultstatus=4 (Splash encoding), exported as LXF ENTRY status="EXH". */
  hc?: boolean
  /** Team entry (seed) time in ms, null = NT. Pool relays only — beach relays are ranked. */
  entryTimeMs?: number | null
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
  /** Current meet type; entry times are shown for POOL only. Missing = POOL. */
  meetType?: 'POOL' | 'BEACH'
}

export interface EligibleAthlete {
  id: number
  name: string             // "LastName, FirstName"
  gender: 'M' | 'F'
  ageGroup?: string        // Registration age code (e.g., "15-18", "19+") from individual entries
}

// ─── Registration API (used by IndividualEntryPage and its panels) ────────────

export interface Club {
  id: number
  name: string
  athlete_count?: number
  registered_athlete_count?: number
}

export interface AthleteListItem {
  id: number
  first_name: string
  last_name: string
  gender: string
  birthdate: string
  license: string
  /** Individual entries in the current meet (team-app / meet-app); used to
   *  mark athletes whose entries are done on the Individual entries page. */
  entry_count?: number
}

export interface RegistrationCategory {
  age_code: string
  event_id: number
  registered: boolean
  registration_id?: number
  entry_time_ms?: number | null
  /** Hors concours / exhibition — result kept but excluded from points/standings/finals qualification. */
  hc?: boolean
}

export interface RegistrationStyle {
  style_uid: string
  style_name: string
  best_time_lcm_ms: number | null
  best_time_scm_ms: number | null
  /** Date (YYYY-MM-DD) and origin of each best time — team-app only, for the
   *  entry-time help bubble. 'coach' = a time a coach typed at a previous meet. */
  best_time_lcm_date?: string | null
  best_time_scm_date?: string | null
  best_time_lcm_source?: 'result' | 'coach' | null
  best_time_scm_source?: 'result' | 'coach' | null
  /** Throw from the deck (pool style < 25 m): one best time whatever the
   *  course — shown as a single box instead of BT 50 / BT 25 (team-app). */
  course_free?: boolean
  relay_count?: number
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
    club_id?: number
    handicapex: string
  }
  individual_events: RegistrationStyle[]
  relay_events: RegistrationStyle[]
  suggested_age_code: string
  meet_course: string
  meet_type?: string
  closure_date?: string | null
  /** Team-app only (meet-app keeps no best times): how long a best time stays
   *  valid, and the date (YYYY-MM-DD, the meet's start) a typed entry time is
   *  stored with as the athlete's new best time when the meet is closed. */
  best_time_policy?: { max_age_months: number; typed_time_date: string }
}

export interface RegistrationAPI {
  getClubs(): Promise<Club[]>
  getAthletesByClub(clubId: string): Promise<AthleteListItem[]>
  /** Bulk fetch: returns all athletes keyed by club ID. Avoids N+1 requests. */
  getAllAthletesGrouped?(): Promise<Record<string, AthleteListItem[]>>
  addAthlete(data: { first_name: string; last_name: string; gender: string; birthdate: string | null; license: string; club_id: number; force?: boolean }): Promise<void>
  /** team-app only: move an already-registered athlete into the caller's club (duplicate guard). */
  moveAthleteToClub?(athleteId: number, clubId: number): Promise<void>
  deleteAthlete(id: number): Promise<void>
  getRegistration(athleteId: number): Promise<RegistrationData>
  updateAthlete(athleteId: number, data: Record<string, unknown>): Promise<void>
  register(data: { athlete_id: number; event_id: number; entry_time_ms: number | null; age_code: string; is_hc?: boolean }): Promise<void>
  unregister(registrationId: number): Promise<void>
  resetClubPin?(clubId: string): Promise<{ pin: string }>

  // Relay team management
  getRelayPageData(clubId?: number): Promise<RelayPageData>
  createRelayTeam(eventId: number, ageCode: string, clubId?: number): Promise<{ teamId: number; teamNumber: string }>
  deleteRelayTeam(teamId: number): Promise<void>
  setRelayTeamMember(teamId: number, position: number, athleteId: number | null): Promise<void>
  setRelayTeamName(teamId: number, name: string | null): Promise<void>
  /** Hors concours / exhibition for a relay team (resultstatus=4). */
  setRelayTeamHC?(teamId: number, isHC: boolean): Promise<void>
  /** Pool relay team entry time (ms, null = NT). */
  setRelayTeamEntryTime?(teamId: number, entryTimeMs: number | null): Promise<void>
}
