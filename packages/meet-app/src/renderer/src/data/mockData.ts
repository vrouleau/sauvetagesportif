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

// ─── Types ────────────────────────────────────────────────────────────────────
// These match the row shapes returned by src/main/db.ts.
// All data is loaded from the real Splash Meet Manager PostgreSQL database.

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

export interface LaneEntry {
  swimresultId: number   // DB primary key — used for writing results back
  lane: number
  athleteId: number
  lastName: string
  firstName: string
  birthYear: number
  nation: string
  clubCode: string
  clubName: string
  category: string
  entryTime?: string
  finalTime?: string
  splitTimes?: Record<number, string>
  status?: 'DNS' | 'DNF' | 'DSQ' | null
  dsqCode?: string
  dsqReason?: string
  dsqItemId?: number
  handicapex?: string
  beachNumber?: string
  relayMembers?: Array<{ position: number; lastName: string; beachNumber?: string }>
  relayTeamName?: string
}

export interface Heat {
  id: number
  eventId: number
  number: number
  status: 'empty' | 'assigned' | 'completed' | 'validated'
  entries: LaneEntry[]
}

export interface HeatListEvent {
  id: number
  number: number
  nameFr: string
  nameEn: string
  gender: 'M' | 'F' | 'X'
  distance: number
  phase: 'Finale' | 'Eliminatoire' | 'Finale directe'
  timingConnected?: boolean
  scheduledTime?: string
  isAdmin?: boolean
  relaycount?: number
  heats: Heat[]
}

export interface HeatListSession {
  id: number
  number: number
  name: string
  time?: string
  laneMin: number
  laneMax: number
  events: HeatListEvent[]
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
  beachNumber?: string
  entries: Array<{ eventId: number; eventName: string; category: string; entryTime?: string }>
}

// ─── Static competition info ──────────────────────────────────────────────────
// Competition-level metadata (name, city, dates) is not stored in the shared
// PostgreSQL database — it lives in Splash's local .mdb file.
// Set these values to match the meet you are running.

export const competition = {
  nameFr: 'Compétition',
  nameEn: 'Competition',
  city: '',
  nation: 'CAN',
  poolSize: 50,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatTime(t: string | undefined): string {
  return t ?? ''
}

export function calcAge(birthYear: number): number {
  return new Date().getFullYear() - birthYear
}