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

// ─── Re-exported types from shared-ui ─────────────────────────────────────────
// Session, CompetitionEvent, AgeGroup, and Athlete are defined in @shared/data/api.
// Re-export them here so existing consumers don't need to change their imports.

export type { Session, CompetitionEvent, AgeGroup, Athlete } from '@shared/data/api'

// ─── Heat-specific types (unique to meet-app renderer) ────────────────────────
// These describe the heat/lane structures returned by the main process IPC
// and are not part of the shared MeetAPI interface.

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
