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
  agegroupid: number
  eventnumber: number
  eventgender: number // event-level gender
  internalevent: string | null
  agemin: number
  agemax: number
  gender: number // age group gender
  relaycount: number
}

export interface MatchedEvent {
  eventId: number
  agegroupId: number
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
  events: MatchedEvent[]
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

  // Combined-event point standings (both per-athlete and per-club) are individual-only —
  // confirmed after our first real beach meet (2026-08): relay results must not contribute
  // combined points. Relay events are excluded here so neither getCombinedResults nor
  // getPointStandings ever sees them, since both are driven off this same event list via
  // the COMBINEDEVENTS XML.
  //
  // This intentionally returns the PRELIM's own swimeventid/agegroupid (not the final's)
  // — it's the stable "event slot" that exists whether or not a final has been created
  // yet, matches what Splash's own COMBINEDEVENTS XML references, and matches what the
  // report UI's event tree lets the user select. Resolving to the final's actual results
  // happens later, at query time — see resolveToFinal() below.
  return db
    .prepare(
      `SELECT e.swimeventid, ag.agegroupid, e.eventnumber, e.gender AS eventgender, e.internalevent,
              ag.agemin, ag.agemax, ag.gender,
              ss.relaycount
       FROM swimevent e
       JOIN agegroup ag ON ag.swimeventid = e.swimeventid
       JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
       WHERE 1=1
         ${distanceFilter}
         AND ss.relaycount <= 1
         AND (e.internalevent IS NULL OR e.internalevent = 'F')
         AND e.eventnumber IS NOT NULL
         AND (e.preveventid IS NULL OR e.preveventid < 1)
       ORDER BY e.eventnumber, ag.sortcode`
    )
    .all() as EventWithAgeGroup[]
}

/**
 * Same event/age-group query as queryEventsWithAgeGroups, but for relay events
 * (relaycount > 1) instead of individual ones.
 *
 * Used only by getPointStandings' club "Classement aux points" report — confirmed
 * against Splash's own real report (2026-08, CQS Plage 2026) that club-level point
 * standings include both individual AND relay placements per age bracket, unlike the
 * per-athlete "Résultat combiné" report (getCombinedResults), which stays individual-only.
 * Kept as a separate query rather than a flag on queryEventsWithAgeGroups so the
 * COMBINEDEVENTS XML (and everything driven off it, including getCombinedResults)
 * stays untouched and individual-only as documented above.
 */
export function queryRelayEventsWithAgeGroups(db: Database.Database): EventWithAgeGroup[] {
  const meetTypeRow = db.prepare(
    `SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`
  ).get() as { data: string } | undefined
  const isBeach = (meetTypeRow?.data || 'POOL').toUpperCase() === 'BEACH'

  const distanceFilter = isBeach ? '' : 'AND ss.distance >= 25'

  return db
    .prepare(
      `SELECT e.swimeventid, ag.agegroupid, e.eventnumber, e.gender AS eventgender, e.internalevent,
              ag.agemin, ag.agemax, ag.gender,
              ss.relaycount
       FROM swimevent e
       JOIN agegroup ag ON ag.swimeventid = e.swimeventid
       JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
       WHERE 1=1
         ${distanceFilter}
         AND ss.relaycount > 1
         AND (e.internalevent IS NULL OR e.internalevent = 'F')
         AND e.eventnumber IS NOT NULL
         AND (e.preveventid IS NULL OR e.preveventid < 1)
       ORDER BY e.eventnumber, ag.sortcode`
    )
    .all() as EventWithAgeGroup[]
}

// ── Prelim → Final Resolution ──────────────────────────────────────────────────

/**
 * Resolves a (prelim eventId, agegroupId) pair to the FINAL's swimeventid/agegroupid
 * when one exists, falling back to the prelim's own pair otherwise.
 *
 * Verified against a real Splash .mdb for an actual competition (CanadienMai2026_S40):
 * when an event has been split into Prelim + Final, Splash's own combined-events point
 * totals are computed from the FINAL's placements, not the prelim's heat times — scoring
 * off the prelim would use slower/irrelevant times once finals have been swum. Splash's
 * COMBINEDEVENTS XML itself always references the prelim as the stable "event slot" (it's
 * the one that exists before any final is created), so this resolution has to happen at
 * query time rather than when the category-to-event list is built.
 */
export function resolveToFinal(
  db: Database.Database,
  eventId: number,
  agegroupId: number
): { eventId: number; agegroupId: number } {
  const finalEvent = db.prepare(
    `SELECT swimeventid FROM swimevent WHERE preveventid = ?`
  ).get(eventId) as { swimeventid: number } | undefined
  if (!finalEvent) return { eventId, agegroupId }

  const prelimAg = db.prepare(
    `SELECT agemin, agemax, gender FROM agegroup WHERE agegroupid = ?`
  ).get(agegroupId) as { agemin: number | null; agemax: number | null; gender: number | null } | undefined
  if (!prelimAg) return { eventId, agegroupId }

  // Match the final's own age group by (agemin, agemax, gender) — treating -1/99 as the
  // same "no upper limit" sentinel, since they're used interchangeably (see CLAUDE.md).
  const finalAg = db.prepare(
    `SELECT agegroupid FROM agegroup
     WHERE swimeventid = ?
       AND agemin = ?
       AND gender = ?
       AND (agemax = ? OR (COALESCE(agemax, -1) IN (-1, 99) AND COALESCE(?, -1) IN (-1, 99)))`
  ).get(finalEvent.swimeventid, prelimAg.agemin, prelimAg.gender, prelimAg.agemax, prelimAg.agemax) as { agegroupid: number } | undefined

  // If the final's age-group brackets don't line up with the prelim's, fall back to the
  // prelim rather than guess — better to under-score than to silently mix brackets.
  if (!finalAg) return { eventId, agegroupId }

  return { eventId: finalEvent.swimeventid, agegroupId: finalAg.agegroupid }
}

// ── Event Matching ────────────────────────────────────────────────────────────

export function findMatchingEvents(
  events: EventWithAgeGroup[],
  category: CategoryConfig
): MatchedEvent[] {
  // Keyed by "eventId:agegroupId" to dedupe while keeping the pairing
  const matched = new Map<string, MatchedEvent>()

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
    const genderMatch = category.gender === 0
      ? (event.eventgender === 0 || event.eventgender === 3)
      : (event.gender === category.gender)

    if (!genderMatch) continue

    // A category matches a specific age group *within* an event, not the whole
    // event — an event can host multiple age groups (e.g. 11-12 and 13-14 in the
    // same swimeventid), and only the matching age group's results should count.
    const key = `${event.swimeventid}:${event.agegroupid}`
    matched.set(key, { eventId: event.swimeventid, agegroupId: event.agegroupid })
  }

  return Array.from(matched.values())
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
    if (def.events.length > 0) {
      attrs.push(`agegroupeventid="${def.agegroupeventid}"`)
    }

    const attrStr = attrs.join(' ')

    if (def.events.length === 0) {
      // Special case: self-closing tag with no EVENTS child
      lines.push(`    <COMBINEDEVENT ${attrStr} />`)
    } else {
      lines.push(`    <COMBINEDEVENT ${attrStr}>`)
      lines.push('      <EVENTS>')
      for (const ev of def.events) {
        lines.push(`        <EVENT eventid="${ev.eventId}" agegroupid="${ev.agegroupId}" mandatory="F" />`)
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
        events: [],
      })
      continue
    }

    // Find all (event, agegroup) pairs that match this category
    const matchingEvents = findMatchingEvents(eventsWithAgeGroups, category)

    if (matchingEvents.length === 0) continue // Skip categories with no events

    // Sort by event ID for deterministic ordering
    matchingEvents.sort((a, b) => a.eventId - b.eventId)

    const firstEventId = matchingEvents[0].eventId

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
      events: matchingEvents,
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
