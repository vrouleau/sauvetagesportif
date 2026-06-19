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
 * Combined Events Definition Generator
 *
 * Auto-generates the COMBINEDEVENTS XML stored in BSGLOBAL.
 * This XML defines cumulative point standings per age group/gender category
 * for Canadian lifesaving competitions.
 *
 * Category definitions (points scales, age groups) are loaded from an external
 * JSON config file bundled with the app, editable at runtime on the installation path.
 */

import { app } from 'electron'
import { existsSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CategoryConfig {
  ageMin: number
  ageMax: number // -1 = no upper limit
  ageRanges?: Array<{ ageMin: number; ageMax: number }> // optional multi-range matching
  gender: number // 0=mixed, 1=male, 2=female
  name: string
  pointsForPlaces: string
  sortbyresfirst: string
  finalusetype: string
  isSpecialNoEvents: boolean
}

export interface CombinedEventsConfig {
  categories: CategoryConfig[]
}

interface EventWithAgeGroup {
  swimeventid: number
  eventnumber: number
  eventgender: number // event-level gender
  internalevent: string | null
  agemin: number
  agemax: number
  gender: number // age group gender
  relaycount: number
}

interface CombinedEventDef {
  combinedeventid: number
  name: string
  titleforprints: string
  sumtype: string
  pointsforplaces: string
  maxresults: string
  sortbyresfirst: string
  penalty: string
  inpercent: string
  completedsq: string
  finalusetype: string
  agegroupeventid: number
  eventIds: number[]
}

// ── Config Loading ────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'combined-events-config.json'

export function loadCombinedEventsConfig(): CombinedEventsConfig {
  const userDataPath = app.getPath('userData')
  const userConfigPath = join(userDataPath, CONFIG_FILENAME)

  // Bundled default: in resources/ directory (packaged) or shared config (dev)
  const bundledConfigPath = app.isPackaged
    ? join(process.resourcesPath, CONFIG_FILENAME)
    : join(__dirname, '../../../../config', CONFIG_FILENAME)

  // Copy bundled default to user data on first run (or if user deleted it)
  if (!existsSync(userConfigPath) && existsSync(bundledConfigPath)) {
    copyFileSync(bundledConfigPath, userConfigPath)
  }

  // Read from user data (allows runtime modifications)
  const configPath = existsSync(userConfigPath) ? userConfigPath : bundledConfigPath

  if (!existsSync(configPath)) {
    throw new Error(
      `Combined events config not found. Expected at:\n` +
        `  User: ${userConfigPath}\n` +
        `  Bundled: ${bundledConfigPath}`
    )
  }

  const raw = readFileSync(configPath, 'utf-8')
  try {
    return JSON.parse(raw) as CombinedEventsConfig
  } catch (e) {
    throw new Error(
      `Failed to parse combined events config at ${configPath}: ${(e as Error).message}`
    )
  }
}

// ── Event Query ───────────────────────────────────────────────────────────────

export function queryEventsWithAgeGroups(db: Database.Database): EventWithAgeGroup[] {
  // Determine meet type: for pool meets, filter out short-distance events (< 25m)
  // like Line Throw. For beach meets, distance represents max participants per heat,
  // not meters, so the distance filter must be skipped.
  const meetTypeRow = db.prepare(
    `SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`
  ).get() as { data: string } | undefined
  const isBeach = (meetTypeRow?.data || 'POOL').toUpperCase() === 'BEACH'

  const distanceFilter = isBeach ? '' : 'AND ss.distance >= 25'

  return db
    .prepare(
      `SELECT e.swimeventid, e.eventnumber, e.gender AS eventgender, e.internalevent,
              ag.agemin, ag.agemax, ag.gender,
              ss.relaycount
       FROM swimevent e
       JOIN agegroup ag ON ag.swimeventid = e.swimeventid
       JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
       WHERE ss.relaycount = 1
         ${distanceFilter}
         AND (e.internalevent IS NULL OR e.internalevent = 'F')
         AND e.eventnumber IS NOT NULL
         AND (e.preveventid IS NULL OR e.preveventid < 1)
       ORDER BY e.eventnumber, ag.sortcode`
    )
    .all() as EventWithAgeGroup[]
}

// ── Event Matching ────────────────────────────────────────────────────────────

export function findMatchingEvents(
  events: EventWithAgeGroup[],
  category: CategoryConfig
): number[] {
  const matchedIds = new Set<number>()

  // Build list of age ranges to match against
  const ranges = category.ageRanges && category.ageRanges.length > 0
    ? category.ageRanges
    : [{ ageMin: category.ageMin, ageMax: category.ageMax }]

  for (const event of events) {
    // Check if event matches any of the age ranges
    let ageMatch = false
    for (const range of ranges) {
      const ageMinMatch = event.agemin === range.ageMin
      const ageMaxMatch =
        range.ageMax === -1
          ? event.agemax === -1 || event.agemax === 99 || event.agemax === null
          : event.agemax === range.ageMax

      if (ageMinMatch && ageMaxMatch) {
        ageMatch = true
        break
      }
    }

    if (!ageMatch) continue

    // Check gender match
    // Mixed category (gender=0): matches events with event-level gender=0 (mixed)
    // Gendered category: matches age groups with same gender
    if (category.gender === 0) {
      if (event.eventgender === 0 || event.eventgender === 3) {
        matchedIds.add(event.swimeventid)
      }
    } else {
      if (event.gender === category.gender) {
        matchedIds.add(event.swimeventid)
      }
    }
  }

  return Array.from(matchedIds)
}

// ── XML Serialization ─────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildCombinedEventsXml(definitions: CombinedEventDef[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-16"?>')
  lines.push('<COMBINEDEVENTDEFINITION>')
  lines.push('  <COMBINEDEVENTS>')

  for (const def of definitions) {
    const attrs = [
      `combinedeventid="${def.combinedeventid}"`,
      `name="${escapeXml(def.name)}"`,
      `titleforprints="${escapeXml(def.titleforprints)}"`,
      `sumtype="${def.sumtype}"`,
      `pointsforplaces="${def.pointsforplaces}"`,
      `maxresults="${def.maxresults}"`,
      `sortbyresfirst="${def.sortbyresfirst}"`,
      `penalty="${def.penalty}"`,
      `inpercent="${def.inpercent}"`,
      `completedsq="${def.completedsq}"`,
      `finalusetype="${def.finalusetype}"`,
    ]

    // Only include agegroupeventid when there are events
    if (def.eventIds.length > 0) {
      attrs.push(`agegroupeventid="${def.agegroupeventid}"`)
    }

    const attrStr = attrs.join(' ')

    if (def.eventIds.length === 0) {
      // Special case: self-closing tag with no EVENTS child
      lines.push(`    <COMBINEDEVENT ${attrStr} />`)
    } else {
      lines.push(`    <COMBINEDEVENT ${attrStr}>`)
      lines.push('      <EVENTS>')
      for (const eventId of def.eventIds) {
        lines.push(`        <EVENT eventid="${eventId}" mandatory="F" />`)
      }
      lines.push('      </EVENTS>')
      lines.push('    </COMBINEDEVENT>')
    }
  }

  lines.push('  </COMBINEDEVENTS>')
  lines.push('</COMBINEDEVENTDEFINITION>')
  return lines.join('\r\n')
}

// ── Main Orchestrator ─────────────────────────────────────────────────────────

export function regenerateCombinedEvents(db: Database.Database): void {
  // Step 1: Load category config from external JSON file
  const config = loadCombinedEventsConfig()

  // Step 2: Query all individual events with their age groups
  const eventsWithAgeGroups = queryEventsWithAgeGroups(db)

  // Step 3: For each category config, find matching events
  const definitions: CombinedEventDef[] = []

  for (const category of config.categories) {
    if (category.isSpecialNoEvents) {
      // Special case: e.g. "10 ans et moins - garçons" has no event list
      definitions.push({
        combinedeventid: 0,
        name: category.name,
        titleforprints: category.name,
        sumtype: '2',
        pointsforplaces: category.pointsForPlaces,
        maxresults: '100',
        sortbyresfirst: category.sortbyresfirst,
        penalty: '10',
        inpercent: 'T',
        completedsq: 'F',
        finalusetype: category.finalusetype,
        agegroupeventid: 0,
        eventIds: [],
      })
      continue
    }

    // Find all events that have an age group matching this category
    const matchingEventIds = findMatchingEvents(eventsWithAgeGroups, category)

    if (matchingEventIds.length === 0) continue // Skip categories with no events

    // Sort by event ID for deterministic ordering
    matchingEventIds.sort((a, b) => a - b)

    const firstEventId = matchingEventIds[0]

    definitions.push({
      combinedeventid: firstEventId,
      name: category.name,
      titleforprints: category.name,
      sumtype: '2',
      pointsforplaces: category.pointsForPlaces,
      maxresults: '100',
      sortbyresfirst: category.sortbyresfirst,
      penalty: '10',
      inpercent: 'T',
      completedsq: 'F',
      finalusetype: category.finalusetype,
      agegroupeventid: firstEventId,
      eventIds: matchingEventIds,
    })
  }

  // Step 4: Build XML
  const xml = buildCombinedEventsXml(definitions)

  // Step 5: Upsert into BSGLOBAL
  db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES ('COMBINEDEVENTS', ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data`
  ).run(xml)
}
