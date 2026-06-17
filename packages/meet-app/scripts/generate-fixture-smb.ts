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
 * Generate two fixture .smb files for documentation screenshots:
 *   - fixture_pool.smb — Pool meet with ~100 athletes, 10 clubs, pool events, heats, results
 *   - fixture_beach.smb — Beach meet with ~100 athletes, 10 clubs, beach events, heats, positions
 *
 * Usage:
 *   cd packages/meet-app
 *   npx tsx scripts/generate-fixture-smb.ts
 *
 * Output: scripts/fixture_pool.smb and scripts/fixture_beach.smb
 */

import { writeFileSync } from 'fs'
import { join } from 'path'

// Import SMB encoding utilities from the app
import { encodeGbin, createZip, D_NULL_SENTINEL } from '../src/main/smb'
import type { ZipEntry } from '../src/main/smb'

// ── Constants ─────────────────────────────────────────────────────────────────

const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)
function dateToOle(d: Date): number {
  return (d.getTime() - OLE_EPOCH_MS) / 86400000
}

const MEET_DATE = new Date(2026, 5, 14) // June 14, 2026
const MEET_DATE_OLE = dateToOle(MEET_DATE)

// ── Club data ─────────────────────────────────────────────────────────────────

const CLUBS = [
  { id: 1001, code: 'AUR', name: 'Club Aurora' },
  { id: 1002, code: 'BLG', name: 'Béluga Sauvetage' },
  { id: 1003, code: 'CCL', name: 'Cedar Creek LSC' },
  { id: 1004, code: 'DDE', name: "Dauphins de l'Est" },
  { id: 1005, code: 'ELR', name: 'Elite Rescue' },
  { id: 1006, code: 'FLM', name: 'Flamingos Aquatiques' },
  { id: 1007, code: 'GAT', name: 'Gatineau Sauvetage' },
  { id: 1008, code: 'HYD', name: 'Hydra Natation' },
  { id: 1009, code: 'IMP', name: 'Impact Sauvetage' },
  { id: 1010, code: 'JET', name: 'Jets de Montréal' },
]

const FIRST_F = ['Alice', 'Béatrice', 'Chloé', 'Diane', 'Emma', 'Frédérique',
  'Gabrielle', 'Héloïse', 'Inès', 'Juliette', 'Karine', 'Léa', 'Maude',
  'Noémie', 'Océane', 'Pénélope', 'Rosalie', 'Sophie', 'Tania', 'Valérie']
const FIRST_M = ['Alexandre', 'Benoît', 'Christophe', 'David', 'Émile',
  'François', 'Gabriel', 'Hugo', 'Isaac', 'Jérôme', 'Kevin', 'Liam',
  'Mathis', 'Olivier', 'Philippe', 'Raphaël', 'Samuel', 'Thomas',
  'Vincent', 'William']
const LAST = ['Tremblay', 'Gagnon', 'Roy', 'Côté', 'Bouchard', 'Gauthier',
  'Morin', 'Lavoie', 'Fortin', 'Gagné', 'Ouellet', 'Pelletier', 'Bélanger',
  'Lévesque', 'Bergeron', 'Leblanc', 'Paquette', 'Girard', 'Simard', 'Boucher']

// Age categories: birth years for age calculation at Dec 31, 2026
const CATEGORIES = [
  { label: '10-', year: 2017, agemin: 1, agemax: 10 },
  { label: '11-12', year: 2014, agemin: 11, agemax: 12 },
  { label: '13-14', year: 2012, agemin: 13, agemax: 14 },
  { label: '15-18', year: 2009, agemin: 15, agemax: 18 },
  { label: 'Open', year: 2002, agemin: 19, agemax: -1 },
]

// ── Pool swim styles (IDs 501-540) ───────────────────────────────────────────

const POOL_STYLES = [
  { id: 501, name: '50m Nage avec obstacles', distance: 50, stroke: 1 },
  { id: 502, name: '100m Nage avec obstacles', distance: 100, stroke: 1 },
  { id: 503, name: '200m Nage avec obstacles', distance: 200, stroke: 1 },
  { id: 504, name: '50m Sauvetage mannequin', distance: 50, stroke: 1 },
  { id: 505, name: '100m Sauvetage mannequin', distance: 100, stroke: 1 },
  { id: 506, name: '50m Remorquage mannequin', distance: 50, stroke: 1 },
  { id: 507, name: '100m Remorquage mannequin', distance: 100, stroke: 1 },
  { id: 508, name: '100m Sauvetage combiné', distance: 100, stroke: 5 },
  { id: 509, name: '200m Sauvetage combiné', distance: 200, stroke: 5 },
  { id: 510, name: '100m Sauvetage avec palmes', distance: 100, stroke: 1 },
  { id: 511, name: '200m Super sauveteur', distance: 200, stroke: 5 },
  { id: 512, name: '4x50m Relais obstacles', distance: 200, stroke: 1, relay: 4 },
  { id: 513, name: '4x50m Relais sauvetage', distance: 200, stroke: 1, relay: 4 },
]

// ── Beach swim styles (IDs 601-605) ──────────────────────────────────────────

const BEACH_STYLES = [
  { id: 601, name: 'Sprint plage', distance: 90, stroke: 1 },
  { id: 602, name: 'Drapeaux de plage', distance: 20, stroke: 1 },
  { id: 603, name: 'Sauvetage planche', distance: 120, stroke: 1 },
  { id: 604, name: 'Nage en mer', distance: 200, stroke: 1 },
  { id: 605, name: 'Sauvetage bouée tube', distance: 120, stroke: 1 },
]

// ── Seeded random ─────────────────────────────────────────────────────────────

let seed = 20260614
function rng(): number {
  seed = (seed * 1664525 + 1013904223) & 0x7fffffff
  return seed / 0x7fffffff
}
function rngInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── Generate athletes ─────────────────────────────────────────────────────────

interface Athlete {
  id: number; clubid: number; firstname: string; lastname: string
  gender: number; birthdate: number; license: string
}

function generateAthletes(): Athlete[] {
  const athletes: Athlete[] = []
  let id = 5001
  for (const club of CLUBS) {
    // 10 athletes per club: 5 categories × 2 genders = 10, but we want ~100 total
    // So 2 per (category, gender) for first 5 clubs, 1 for rest → ~100
    for (const cat of CATEGORIES) {
      for (const gender of [1, 2]) { // 1=M, 2=F
        const count = club.id <= 1005 ? 2 : 1
        for (let i = 0; i < count; i++) {
          const names = gender === 1 ? FIRST_M : FIRST_F
          const first = names[(id + i) % names.length]
          const last = LAST[(id * 3 + i) % LAST.length]
          const month = rngInt(1, 12)
          const day = rngInt(1, 28)
          const bd = new Date(cat.year, month - 1, day)
          athletes.push({
            id, clubid: club.id, firstname: first, lastname: last,
            gender, birthdate: dateToOle(bd),
            license: `NRA${String(id).padStart(5, '0')}`,
          })
          id++
        }
      }
    }
  }
  return athletes
}

// ── SMB table definitions (must match smb.ts SMB_TABLES) ──────────────────────

const TABLE_DEFS = {
  BSGLOBAL: {
    name: 'BSGLOBAL', cols: [
      { name: 'NAME', type: 'S' as const, size: 50 },
      { name: 'DATA', type: 'M' as const, size: 0 },
    ]
  },
  SWIMSTYLE: {
    name: 'SWIMSTYLE', cols: [
      { name: 'SWIMSTYLEID', type: 'I' as const, size: 32 },
      { name: 'CODE', type: 'S' as const, size: 10 },
      { name: 'DISTANCE', type: 'I' as const, size: 16 },
      { name: 'NAME', type: 'S' as const, size: 50 },
      { name: 'RELAYCOUNT', type: 'I' as const, size: 16 },
      { name: 'STROKE', type: 'I' as const, size: 16 },
      { name: 'SORTCODE', type: 'I' as const, size: 32 },
      { name: 'TECHNIQUE', type: 'I' as const, size: 16 },
      { name: 'UNIQUEID', type: 'I' as const, size: 16 },
    ]
  },
  SWIMSESSION: {
    name: 'SWIMSESSION', cols: [
      { name: 'SWIMSESSIONID', type: 'I' as const, size: 32 },
      { name: 'COURSE', type: 'I' as const, size: 16 },
      { name: 'DAYTIME', type: 'D' as const, size: 32 },
      { name: 'ENDTIME', type: 'D' as const, size: 32 },
      { name: 'FEEATHLETE', type: 'F' as const, size: 0 },
      { name: 'FOLLOWING', type: 'S' as const, size: 1 },
      { name: 'LANEMIN', type: 'I' as const, size: 16 },
      { name: 'LANEMAX', type: 'I' as const, size: 16 },
      { name: 'LANESBYPLACE', type: 'S' as const, size: 100 },
      { name: 'MAXENTRIESATHLETE', type: 'I' as const, size: 16 },
      { name: 'MAXENTRIESRELAY', type: 'I' as const, size: 16 },
      { name: 'NAME', type: 'S' as const, size: 100 },
      { name: 'OFFICIALMEETING', type: 'D' as const, size: 32 },
      { name: 'POOLGLOBAL', type: 'S' as const, size: 1 },
      { name: 'POOLTYPE', type: 'I' as const, size: 16 },
      { name: 'REMARKS', type: 'M' as const, size: 0 },
      { name: 'REMARKSJURY', type: 'M' as const, size: 0 },
      { name: 'ROUNDTOTENTHS', type: 'S' as const, size: 1 },
      { name: 'SESSIONNUMBER', type: 'I' as const, size: 16 },
      { name: 'STARTDATE', type: 'D' as const, size: 32 },
      { name: 'TIMING', type: 'I' as const, size: 16 },
      { name: 'TLMEETING', type: 'D' as const, size: 32 },
      { name: 'TOUCHPADMODE', type: 'I' as const, size: 16 },
      { name: 'WARMUPFROM', type: 'D' as const, size: 32 },
      { name: 'WARMUPUNTIL', type: 'D' as const, size: 32 },
    ]
  },
  CLUB: {
    name: 'CLUB', cols: [
      { name: 'CLUBID', type: 'I' as const, size: 32 },
      { name: 'BONUSPOINTS', type: 'I' as const, size: 32 },
      { name: 'CLUBTYPE', type: 'I' as const, size: 16 },
      { name: 'CODE', type: 'S' as const, size: 10 },
      { name: 'CONTACTNAME', type: 'S' as const, size: 50 },
      { name: 'CONTACTINTERNET', type: 'S' as const, size: 150 },
      { name: 'CONTACTCITY', type: 'S' as const, size: 30 },
      { name: 'CONTACTCOUNTRY', type: 'S' as const, size: 2 },
      { name: 'CONTACTEMAIL', type: 'S' as const, size: 50 },
      { name: 'CONTACTFAX', type: 'S' as const, size: 20 },
      { name: 'CONTACTPHONE', type: 'S' as const, size: 20 },
      { name: 'CONTACTSTATE', type: 'S' as const, size: 5 },
      { name: 'CONTACTSTREET', type: 'S' as const, size: 50 },
      { name: 'CONTACTSTREET2', type: 'S' as const, size: 50 },
      { name: 'CONTACTZIP', type: 'S' as const, size: 10 },
      { name: 'EXTERNALID', type: 'S' as const, size: 40 },
      { name: 'LONGCODE', type: 'S' as const, size: 20 },
      { name: 'ENTRYCLUBID', type: 'I' as const, size: 32 },
      { name: 'ENTRYEMAILS', type: 'S' as const, size: 255 },
      { name: 'NAME', type: 'S' as const, size: 80 },
      { name: 'NAMEEN', type: 'S' as const, size: 80 },
      { name: 'NATION', type: 'S' as const, size: 3 },
      { name: 'REGION', type: 'S' as const, size: 10 },
      { name: 'SHORTNAME', type: 'S' as const, size: 30 },
      { name: 'SHORTNAMEEN', type: 'S' as const, size: 30 },
      { name: 'SWRID', type: 'I' as const, size: 32 },
      { name: 'TEAMNUMBER', type: 'I' as const, size: 16 },
    ]
  },
  ATHLETE: {
    name: 'ATHLETE', cols: [
      { name: 'ATHLETEID', type: 'I' as const, size: 32 },
      { name: 'CLUBID', type: 'I' as const, size: 32 },
      { name: 'FIRSTNAME', type: 'S' as const, size: 30 },
      { name: 'FIRSTNAME_UPPER', type: 'S' as const, size: 5 },
      { name: 'GENDER', type: 'I' as const, size: 16 },
      { name: 'LASTNAME', type: 'S' as const, size: 50 },
      { name: 'LASTNAME_UPPER', type: 'S' as const, size: 10 },
      { name: 'NAMEPREFIX', type: 'S' as const, size: 20 },
      { name: 'BIRTHDATE', type: 'D' as const, size: 32 },
      { name: 'DOMICILE', type: 'S' as const, size: 50 },
      { name: 'EXTERNALID', type: 'S' as const, size: 40 },
      { name: 'FIRSTNAMEEN', type: 'S' as const, size: 30 },
      { name: 'HANDICAPEX', type: 'S' as const, size: 20 },
      { name: 'HANDICAPS', type: 'I' as const, size: 16 },
      { name: 'HANDICAPSB', type: 'I' as const, size: 16 },
      { name: 'HANDICAPSM', type: 'I' as const, size: 16 },
      { name: 'LASTNAMEEN', type: 'S' as const, size: 50 },
      { name: 'LICENSE', type: 'S' as const, size: 20 },
      { name: 'NATION', type: 'S' as const, size: 3 },
      { name: 'SDMSID', type: 'I' as const, size: 32 },
      { name: 'STATUS', type: 'I' as const, size: 32 },
      { name: 'SWIMLEVEL', type: 'S' as const, size: 10 },
      { name: 'SWRID', type: 'I' as const, size: 32 },
      { name: 'SWRHASHKEY', type: 'I' as const, size: 32 },
      { name: 'CLUBCODE2', type: 'S' as const, size: 10 },
      { name: 'COACHNAME', type: 'S' as const, size: 80 },
      { name: 'SCHOOLYEAR', type: 'S' as const, size: 10 },
      { name: 'MIDDLENAME', type: 'S' as const, size: 50 },
      { name: 'MIDDLENAMEEN', type: 'S' as const, size: 50 },
    ]
  },
  SWIMEVENT: {
    name: 'SWIMEVENT', cols: [
      { name: 'SWIMEVENTID', type: 'I' as const, size: 32 },
      { name: 'COMMENT', type: 'M' as const, size: 0 },
      { name: 'DAYTIME', type: 'D' as const, size: 32 },
      { name: 'DURATION', type: 'D' as const, size: 32 },
      { name: 'ENTRYTIMECONVERSION', type: 'I' as const, size: 16 },
      { name: 'ENTRYTIMEPERCENT', type: 'I' as const, size: 16 },
      { name: 'EVENTNUMBER', type: 'I' as const, size: 16 },
      { name: 'EXTERNALID', type: 'S' as const, size: 40 },
      { name: 'FEE', type: 'F' as const, size: 0 },
      { name: 'FINALORDER', type: 'I' as const, size: 16 },
      { name: 'GENDER', type: 'I' as const, size: 16 },
      { name: 'LANEMAX', type: 'I' as const, size: 16 },
      { name: 'LYTENTRYLIST', type: 'I' as const, size: 32 },
      { name: 'LYTSTARTLIST', type: 'I' as const, size: 32 },
      { name: 'LYTRESULT2COLUMN', type: 'I' as const, size: 32 },
      { name: 'LYTRESULT2SPLIT', type: 'I' as const, size: 32 },
      { name: 'LYTRESULT4SPLIT', type: 'I' as const, size: 32 },
      { name: 'LYTRESULTNOSPLIT', type: 'I' as const, size: 32 },
      { name: 'LYTRESULTHTML', type: 'I' as const, size: 32 },
      { name: 'MASTERS', type: 'S' as const, size: 1 },
      { name: 'MAXENTRIES', type: 'I' as const, size: 16 },
      { name: 'PFINEIGNORE', type: 'S' as const, size: 1 },
      { name: 'PREVEVENTID', type: 'I' as const, size: 32 },
      { name: 'QUALBYPLACE', type: 'I' as const, size: 16 },
      { name: 'ROUND', type: 'I' as const, size: 16 },
      { name: 'SEEDBONUSLAST', type: 'S' as const, size: 1 },
      { name: 'SEEDEXHLAST', type: 'S' as const, size: 1 },
      { name: 'SEEDLATEENTRYLAST', type: 'S' as const, size: 1 },
      { name: 'SEEDINGGLOBAL', type: 'S' as const, size: 1 },
      { name: 'SINGLEHEATS', type: 'I' as const, size: 16 },
      { name: 'SORTCODE', type: 'I' as const, size: 32 },
      { name: 'SPLASHMECANEDIT', type: 'S' as const, size: 1 },
      { name: 'SPONSOR', type: 'S' as const, size: 50 },
      { name: 'SWIMSESSIONID', type: 'I' as const, size: 32 },
      { name: 'SWIMSTYLEID', type: 'I' as const, size: 32 },
      { name: 'TWOPERLANE', type: 'S' as const, size: 1 },
      { name: 'ROUNDNAME', type: 'S' as const, size: 50 },
      { name: 'COMBINEAGEGROUPS', type: 'S' as const, size: 1 },
      { name: 'ROUNDONE', type: 'S' as const, size: 20 },
      { name: 'INTERNALEVENT', type: 'S' as const, size: 1 },
    ]
  },
  AGEGROUP: {
    name: 'AGEGROUP', cols: [
      { name: 'AGEGROUPID', type: 'I' as const, size: 32 },
      { name: 'AGEBYTOTAL', type: 'S' as const, size: 1 },
      { name: 'AGEMAX', type: 'I' as const, size: 16 },
      { name: 'AGEMAX2', type: 'I' as const, size: 16 },
      { name: 'AGEMIN', type: 'I' as const, size: 16 },
      { name: 'AGEMIN2', type: 'I' as const, size: 16 },
      { name: 'ALLOFFICIAL', type: 'S' as const, size: 1 },
      { name: 'ATHLETESTATUSES', type: 'I' as const, size: 32 },
      { name: 'CLUBIDS', type: 'M' as const, size: 0 },
      { name: 'CODE', type: 'S' as const, size: 10 },
      { name: 'EXTERNALID', type: 'S' as const, size: 40 },
      { name: 'FASTHEATCOUNT', type: 'I' as const, size: 16 },
      { name: 'FORCEPRELIM', type: 'S' as const, size: 1 },
      { name: 'GENDER', type: 'I' as const, size: 16 },
      { name: 'HANDICAPS', type: 'S' as const, size: 100 },
      { name: 'HEATCOUNT', type: 'I' as const, size: 16 },
      { name: 'HEATQUALIPRIORITY', type: 'S' as const, size: 50 },
      { name: 'LEVELMAX', type: 'S' as const, size: 5 },
      { name: 'LEVELMIN', type: 'S' as const, size: 5 },
      { name: 'NAME', type: 'S' as const, size: 50 },
      { name: 'NATIONALITY', type: 'S' as const, size: 3 },
      { name: 'NATIONREGIONS', type: 'M' as const, size: 0 },
      { name: 'RESULTCOUNT', type: 'I' as const, size: 16 },
      { name: 'SCORETYPE', type: 'I' as const, size: 16 },
      { name: 'SEEDWITHTSONLY', type: 'S' as const, size: 1 },
      { name: 'SORTCODE', type: 'I' as const, size: 32 },
      { name: 'SWIMEVENTID', type: 'I' as const, size: 32 },
      { name: 'SWIMLEVELS', type: 'S' as const, size: 255 },
      { name: 'USEFORMEDALS', type: 'S' as const, size: 1 },
      { name: 'USEFORSCORING', type: 'S' as const, size: 1 },
      { name: 'WINNERTITLE', type: 'S' as const, size: 100 },
      { name: 'FOREIGNCOUNT', type: 'I' as const, size: 16 },
      { name: 'FINALSEEDTYPE', type: 'I' as const, size: 16 },
    ]
  },
  HEAT: {
    name: 'HEAT', cols: [
      { name: 'HEATID', type: 'I' as const, size: 32 },
      { name: 'AGEGROUPID', type: 'I' as const, size: 32 },
      { name: 'AGEGROUPORDER', type: 'I' as const, size: 32 },
      { name: 'DAYTIME', type: 'D' as const, size: 32 },
      { name: 'FINALCODE', type: 'S' as const, size: 2 },
      { name: 'HEATNUMBER', type: 'I' as const, size: 16 },
      { name: 'RACESTATUS', type: 'I' as const, size: 16 },
      { name: 'REMARKS', type: 'M' as const, size: 0 },
      { name: 'SORTCODE', type: 'I' as const, size: 32 },
      { name: 'SWIMEVENTID', type: 'I' as const, size: 32 },
      { name: 'NAME', type: 'S' as const, size: 50 },
      { name: 'SEEDEVENTID', type: 'I' as const, size: 32 },
      { name: 'CODE', type: 'S' as const, size: 10 },
      { name: 'RESERVECOUNT', type: 'I' as const, size: 16 },
      { name: 'FOREIGNCOUNT', type: 'I' as const, size: 16 },
    ]
  },
  SWIMRESULT: {
    name: 'SWIMRESULT', cols: [
      { name: 'SWIMRESULTID', type: 'I' as const, size: 32 },
      { name: 'ATHLETEID', type: 'I' as const, size: 32 },
      { name: 'SWRABESTID', type: 'I' as const, size: 32 },
      { name: 'SWRABESTTIME', type: 'I' as const, size: 32 },
      { name: 'SWRSBESTID', type: 'I' as const, size: 32 },
      { name: 'SWRSBESTTIME', type: 'I' as const, size: 32 },
      { name: 'AGEGROUPID', type: 'I' as const, size: 32 },
      { name: 'BACKUPTIME1', type: 'I' as const, size: 32 },
      { name: 'BACKUPTIME2', type: 'I' as const, size: 32 },
      { name: 'BACKUPTIME3', type: 'I' as const, size: 32 },
      { name: 'BONUSENTRY', type: 'S' as const, size: 1 },
      { name: 'COMMENT', type: 'S' as const, size: 250 },
      { name: 'DSQITEMID', type: 'I' as const, size: 32 },
      { name: 'DSQDAYTIME', type: 'D' as const, size: 32 },
      { name: 'DSQNOTIFIED', type: 'S' as const, size: 1 },
      { name: 'DSQNUMBER', type: 'I' as const, size: 16 },
      { name: 'ENTRYCOURSE', type: 'I' as const, size: 16 },
      { name: 'ENTRYTIME', type: 'I' as const, size: 32 },
      { name: 'FINALFIX', type: 'S' as const, size: 1 },
      { name: 'FINISHJUDGE', type: 'I' as const, size: 16 },
      { name: 'HEATID', type: 'I' as const, size: 32 },
      { name: 'INFOCODE', type: 'S' as const, size: 5 },
      { name: 'LANE', type: 'I' as const, size: 16 },
      { name: 'LATEENTRY', type: 'S' as const, size: 1 },
      { name: 'MPOINTS', type: 'I' as const, size: 16 },
      { name: 'PADTIME', type: 'I' as const, size: 32 },
      { name: 'QTCITY', type: 'S' as const, size: 30 },
      { name: 'QTCOURSE', type: 'I' as const, size: 16 },
      { name: 'QTDATE', type: 'D' as const, size: 32 },
      { name: 'QTNAME', type: 'S' as const, size: 100 },
      { name: 'QTNATION', type: 'S' as const, size: 3 },
      { name: 'QTTIME', type: 'I' as const, size: 32 },
      { name: 'QUALCODE', type: 'S' as const, size: 2 },
      { name: 'REACTIONTIME', type: 'I' as const, size: 16 },
      { name: 'RESULTSTATUS', type: 'I' as const, size: 16 },
      { name: 'SWIMEVENTID', type: 'I' as const, size: 32 },
      { name: 'SWIMTIME', type: 'I' as const, size: 32 },
      { name: 'USETIMETYPE', type: 'I' as const, size: 16 },
      { name: 'DSQOFFICIALID', type: 'I' as const, size: 32 },
      { name: 'RESERVECODE', type: 'S' as const, size: 20 },
      { name: 'NOADVANCE', type: 'S' as const, size: 1 },
      { name: 'OFFICIALSPLITS', type: 'S' as const, size: 100 },
      { name: 'QTTIMING', type: 'I' as const, size: 16 },
    ]
  },
  SPLIT: {
    name: 'SPLIT', cols: [
      { name: 'SWIMRESULTID', type: 'I' as const, size: 32 },
      { name: 'DISTANCE', type: 'I' as const, size: 16 },
      { name: 'SWIMTIME', type: 'I' as const, size: 32 },
    ]
  },
}

// ── Build SMB ─────────────────────────────────────────────────────────────────

function buildSmb(meetType: 'POOL' | 'BEACH'): Buffer {
  const isPool = meetType === 'POOL'
  const styles = isPool ? POOL_STYLES : BEACH_STYLES
  const meetName = isPool
    ? 'Championnats régionaux de sauvetage 2026 — Piscine'
    : 'Championnats régionaux de sauvetage 2026 — Plage'

  const athletes = generateAthletes()

  // ── BSGLOBAL ────────────────────────────────────────────────────────────
  const meetvalues = [
    'SEEDMETHOD=I;1', 'FASTHEATCOUNT=I;2', 'MINPERHEAT=I;3',
    'SEEDBONUSLAST=B;F', 'SEEDEXHLAST=B;F', 'SEEDLATELAST=B;F',
    'COMBINEAGEGROUPS=B;F',
  ].join('\r\n')

  const bsglobalRows = [
    { name: 'MeetName', data: meetName },
    { name: 'MeetCity', data: 'Gatineau' },
    { name: 'MeetCourse', data: isPool ? '3' : '1' }, // SCM for pool
    { name: 'MEET_TYPE', data: meetType },
    { name: 'MEETVALUES', data: meetvalues },
    { name: 'PoolLanes', data: '8' },
    { name: 'PoolLaneMin', data: '1' },
    { name: 'PoolLaneMax', data: '8' },
  ]

  // ── SWIMSTYLE ───────────────────────────────────────────────────────────
  const swimstyleRows = styles.map((s, i) => ({
    swimstyleid: s.id, code: '', distance: s.distance,
    name: s.name, relaycount: (s as any).relay || 1,
    stroke: s.stroke, sortcode: i + 1, technique: 0, uniqueid: 0,
  }))

  // ── SWIMSESSION ────────────────────────────────────────────────────────
  const sessions = [
    { swimsessionid: 1, course: isPool ? 3 : 1, daytime: MEET_DATE_OLE + 0.375,
      endtime: MEET_DATE_OLE + 0.5, feeathlete: 25.0, following: 'F',
      lanemin: 1, lanemax: 8, lanesbyplace: '', maxentriesathlete: 4,
      maxentriesrelay: 2, name: 'Session 1 — Samedi matin',
      officialmeeting: null, poolglobal: 'F', pooltype: 0,
      remarks: '', remarksjury: '', roundtotenths: 'F',
      sessionnumber: 1, startdate: MEET_DATE_OLE, timing: 0,
      tlmeeting: null, touchpadmode: 0, warmupfrom: null, warmupuntil: null },
    { swimsessionid: 2, course: isPool ? 3 : 1, daytime: MEET_DATE_OLE + 0.5625,
      endtime: MEET_DATE_OLE + 0.75, feeathlete: 0, following: 'F',
      lanemin: 1, lanemax: 8, lanesbyplace: '', maxentriesathlete: 4,
      maxentriesrelay: 2, name: 'Session 2 — Samedi après-midi',
      officialmeeting: null, poolglobal: 'F', pooltype: 0,
      remarks: '', remarksjury: '', roundtotenths: 'F',
      sessionnumber: 2, startdate: MEET_DATE_OLE, timing: 0,
      tlmeeting: null, touchpadmode: 0, warmupfrom: null, warmupuntil: null },
  ]

  // ── SWIMEVENT + AGEGROUP ────────────────────────────────────────────────
  const eventRows: Record<string, unknown>[] = []
  const agegroupRows: Record<string, unknown>[] = []
  let eventId = isPool ? 1065 : 6001
  let agId = isPool ? 1066 : 6002
  let sortcode = 1

  // Individual events: each style × mixed gender (gender=3)
  const indivStyles = styles.filter(s => !(s as any).relay)
  for (const style of indivStyles) {
    const sessionId = sortcode <= Math.ceil(indivStyles.length / 2) ? 1 : 2
    eventRows.push({
      swimeventid: eventId, comment: '', daytime: null, duration: null,
      entrytimeconversion: 0, entrytimepercent: 0, eventnumber: sortcode,
      externalid: '', fee: 5.0, finalorder: 0, gender: 0, // all genders
      lanemax: 0, lytentrylist: 0, lytstartlist: 0, lytresult2column: 0,
      lytresult2split: 0, lytresult4split: 0, lytresultnosplit: 0,
      lytresulthtml: 0, masters: 'F', maxentries: isPool ? 0 : 16,
      pfineignore: 'F', preveventid: 0, qualbyplace: 0,
      round: 5, // TIM (direct finals)
      seedbonuslast: 'F', seedexhlast: 'F', seedlateentrylast: 'F',
      seedingglobal: 'F', singleheats: 0, sortcode,
      splashmecanedit: 'F', sponsor: '', swimsessionid: sessionId,
      swimstyleid: style.id, twoperlane: 'F', roundname: style.name,
      combineagegroups: 'F', roundone: '', internalevent: 'F',
    })

    // Age groups for this event
    for (const cat of CATEGORIES) {
      for (const g of [1, 2]) { // M and F age groups
        const agName = `${cat.label} ${g === 1 ? 'M' : 'F'}`
        agegroupRows.push({
          agegroupid: agId, agebytotal: 'F',
          agemax: cat.agemax, agemax2: 0,
          agemin: cat.agemin, agemin2: 0, allofficial: 'T',
          athletestatuses: 0, clubids: '', code: '',
          externalid: '', fastheatcount: 0, forceprelim: 'F',
          gender: g, handicaps: '', heatcount: 1,
          heatqualipriority: '', levelmax: '', levelmin: '',
          name: agName, nationality: '', nationregions: '',
          resultcount: 0, scoretype: 0, seedwithtsonly: 'F',
          sortcode: agId, swimeventid: eventId, swimlevels: '',
          useformedals: 'T', useforscoring: 'T', winnertitle: '',
          foreigncount: 0, finalseedtype: 0,
        })
        agId++
      }
    }
    eventId++
    sortcode++
  }

  // ── SWIMRESULT (entries with times for pool, no times for beach) ────────
  const resultRows: Record<string, unknown>[] = []
  let resId = 10001

  // For each athlete, register them in 3 random events matching their gender
  // (age group matching is simplified — just pick the first matching AG)
  for (const ath of athletes) {
    // Find the category this athlete belongs to based on clubid position
    const athIdx = athletes.indexOf(ath)
    const catIdx = Math.floor((athIdx % (CATEGORIES.length * 2)) / 2)
    const athCat = CATEGORIES[catIdx]

    // Find events that have an age group matching this athlete's gender
    const matchingEvents = eventRows.filter(ev => {
      const evAgs = agegroupRows.filter(ag =>
        (ag.swimeventid as number) === (ev.swimeventid as number) &&
        (ag.gender as number) === ath.gender
      )
      return evAgs.length > 0
    })

    const chosen = shuffle(matchingEvents).slice(0, 3)
    for (const ev of chosen) {
      // Find the age group for this athlete's category and gender
      const evAgs = agegroupRows.filter(ag =>
        (ag.swimeventid as number) === (ev.swimeventid as number) &&
        (ag.gender as number) === ath.gender &&
        (ag.agemin as number) === athCat.agemin
      )
      const agGroup = evAgs[0] || agegroupRows.find(ag =>
        (ag.swimeventid as number) === (ev.swimeventid as number) &&
        (ag.gender as number) === ath.gender
      )
      const entryTime = isPool ? rngInt(30000, 180000) : null // 30s to 3min
      resultRows.push({
        swimresultid: resId, athleteid: ath.id,
        swrabestid: 0, swrabesttime: 0, swrsbestid: 0, swrsbesttime: 0,
        agegroupid: agGroup ? agGroup.agegroupid as number : 0,
        backuptime1: 0, backuptime2: 0, backuptime3: 0,
        bonusentry: 'F', comment: '', dsqitemid: 0, dsqdaytime: null,
        dsqnotified: 'F', dsqnumber: 0, entrycourse: isPool ? 3 : 0,
        entrytime: entryTime, finalfix: 'F', finishjudge: 0,
        heatid: 0, infocode: '', lane: 0, lateentry: 'F',
        mpoints: 0, padtime: 0, qtcity: '', qtcourse: 0,
        qtdate: null, qtname: '', qtnation: '', qttime: 0,
        qualcode: '', reactiontime: 0, resultstatus: 0,
        swimeventid: ev.swimeventid as number, swimtime: 0,
        usetimetype: 0, dsqofficialid: 0, reservecode: '',
        noadvance: 'F', officialsplits: '', qttiming: 0,
      })
      resId++
    }
  }

  // ── CLUB rows ───────────────────────────────────────────────────────────
  const clubRows = CLUBS.map(c => ({
    clubid: c.id, bonuspoints: 0, clubtype: 0, code: c.code,
    contactname: '', contactinternet: '', contactcity: '', contactcountry: 'CA',
    contactemail: `${c.code.toLowerCase()}@example.com`, contactfax: '',
    contactphone: '', contactstate: 'QC', contactstreet: '', contactstreet2: '',
    contactzip: '', externalid: '', longcode: '', entryclubid: 0,
    entryemails: '', name: c.name, nameen: c.name, nation: 'CAN',
    region: 'QC', shortname: c.code, shortnameen: c.code, swrid: 0, teamnumber: 0,
  }))

  // ── ATHLETE rows ────────────────────────────────────────────────────────
  const athleteRows = athletes.map(a => ({
    athleteid: a.id, clubid: a.clubid, firstname: a.firstname,
    firstname_upper: a.firstname.slice(0, 5).toUpperCase(),
    gender: a.gender, lastname: a.lastname,
    lastname_upper: a.lastname.slice(0, 10).toUpperCase(),
    nameprefix: '', birthdate: a.birthdate, domicile: '',
    externalid: '', firstnameen: '', handicapex: '',
    handicaps: 0, handicapsb: 0, handicapsm: 0, lastnameen: '',
    license: a.license, nation: 'CAN', sdmsid: 0, status: 0,
    swimlevel: '', swrid: 0, swrhashkey: 0, clubcode2: '',
    coachname: '', schoolyear: '', middlename: '', middlenameen: '',
  }))

  // ── Encode all tables ───────────────────────────────────────────────────
  const entries: ZipEntry[] = []
  const recordCounts: Record<string, number> = {}

  function addTable(def: typeof TABLE_DEFS.BSGLOBAL, rows: Record<string, unknown>[]) {
    recordCounts[def.name] = rows.length
    entries.push({ name: `${def.name}-0001.gbin`, data: encodeGbin(def, rows) })
  }

  addTable(TABLE_DEFS.BSGLOBAL, bsglobalRows)
  addTable(TABLE_DEFS.SWIMSTYLE, swimstyleRows)
  addTable(TABLE_DEFS.SWIMSESSION, sessions as any)
  addTable(TABLE_DEFS.CLUB, clubRows)
  addTable(TABLE_DEFS.ATHLETE, athleteRows)
  addTable(TABLE_DEFS.SWIMEVENT, eventRows)
  addTable(TABLE_DEFS.AGEGROUP, agegroupRows)
  addTable(TABLE_DEFS.HEAT, []) // No heats yet (user will generate them)
  addTable(TABLE_DEFS.SWIMRESULT, resultRows)
  addTable(TABLE_DEFS.SPLIT, [])

  // ── geologix.ini ────────────────────────────────────────────────────────
  const allTableNames = [
    'BSGLOBAL', 'BSSWKATALOGITEM', 'BSPICTURE', 'DSQITEM',
    'SWIMSTYLE', 'SWIMSESSION', 'SWIMEVENT', 'AGEGROUP',
    'RECORDLIST', 'RECORDAGEGROUP', 'RECORDLISTAGEGROUP',
    'RECORD', 'RECORDSPLIT', 'RECORDPOSITION',
    'TIMESTANDARDLIST', 'TIMESTANDARD',
    'CLUB', 'ATHLETE', 'OFFICIAL', 'EVENTRECORD',
    'HEAT', 'JUDGE', 'SWIMRESULT', 'SPLIT',
    'RELAY', 'RELAYPOSITION', 'RELAYSPLIT',
    'RESULTPLACE', 'TIMINGDATA', 'SPLASHMEMESSAGE',
  ]

  const ini = [
    '[Geologix]',
    'Application=Meet Manager 11',
    'Version=11.84087',
    'Identification=BACKUP_MM_MEET_11',
    'NullDateYear=1800',
    'ExtraFiles=0',
    '',
    '[BSGLOBAL]',
    'BSDB_DDL_VERSION_APPLICATION=20260101',
    'BSDB_DDL_VERSION_PICTURE=01.01',
    'BSDB_DDL_VERSION_SW_KATALOG=01.00',
    '',
    '[RecordCount]',
    ...allTableNames.map(t => `${t}=${recordCounts[t] ?? 0}`),
    '',
    '[Tables]',
    ...allTableNames.map(t => `${t}=${(recordCounts[t] ?? 0) > 0 ? 1 : 0}`),
    '',
  ].join('\r\n')

  entries.push({ name: 'geologix.ini', data: Buffer.from(ini, 'ascii') })

  return createZip(entries)
}

// ── Main ──────────────────────────────────────────────────────────────────────

const outDir = join(__dirname)

const poolSmb = buildSmb('POOL')
writeFileSync(join(outDir, 'fixture_pool.smb'), poolSmb)
console.log(`✓ fixture_pool.smb written (${poolSmb.length} bytes)`)

// Reset seed for beach
seed = 20260615
const beachSmb = buildSmb('BEACH')
writeFileSync(join(outDir, 'fixture_beach.smb'), beachSmb)
console.log(`✓ fixture_beach.smb written (${beachSmb.length} bytes)`)

const athletes = generateAthletes()
console.log(`  ${CLUBS.length} clubs, ${athletes.length} athletes`)