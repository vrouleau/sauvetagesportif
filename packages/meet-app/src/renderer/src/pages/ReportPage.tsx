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

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { HeatListSession, HeatListEvent, Session, AgeGroup } from '../data/mockData'

// Local aliases matching the IPC return shapes (structurally compatible)
type HeatListSessionRow = HeatListSession
type HeatListEventRow = HeatListEvent
type SessionRow = Session
type AgeGroupRow = AgeGroup

// ── API helpers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbApi = () => (window as any).api?.db
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reportApi = () => (window as any).api?.report

// ── Types ─────────────────────────────────────────────────────────────────────

interface MeetInfo { name: string; city: string; nation: string }

interface FlatItem {
  key: string
  type: 'session' | 'event'
  id: number          // sessionId or eventId
  sessionId: number
  label: string
  isAdmin: boolean
}

interface ReportEventSection {
  eventId: number
  eventNumber: number
  eventName: string     // style name only
  gender: 'M' | 'F' | 'X'
  ageMin: number
  ageMax: number | null
  sessionDate: string   // YYYY-MM-DD
  scheduledTime: string // HH:MM or ''
  heats: HeatListEventRow['heats']
}

type ReportType = 'heatList' | 'startList' | 'combinedResults' | 'beachNumbers' | 'entriesByEvent' | 'pointStandings'

// ── HTML generator ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;')
}

function formatAgeRange(minAge: number, maxAge: number | null): string {
  if (maxAge == null || maxAge < 0) return `${minAge} ans et plus`
  return `${minAge} - ${maxAge} ans`
}

function genderPrefix(gender: 'M' | 'F' | 'X', minAge: number): string {
  const adult = minAge >= 15
  if (gender === 'X') return adult ? 'Mixte' : 'Tous'
  if (gender === 'F') return adult ? 'Dames' : 'Filles'
  return adult ? 'Messieurs' : 'Garçons'
}

function computeAge(birthYear: number, meetYear: number): number {
  return meetYear - birthYear
}

// ── PDF header info (passed to main process for displayHeaderFooter) ─────────

export interface PdfHeaderInfo {
  line1: string   // meet name
  line2: string   // city + date range
  today: string   // formatted date for footer
}

function buildPdfHeaderInfo(meetInfo: MeetInfo, sections: ReportEventSection[]): PdfHeaderInfo {
  const dates = [...new Set(sections.map(s => s.sessionDate).filter(Boolean))].sort()
  const dateRange = dates.length > 1
    ? `${dates[0]} - ${dates[dates.length - 1]}`
    : (dates[0] ?? '')
  return {
    line1: meetInfo.name || 'Compétition',
    line2: `${meetInfo.city}${dateRange ? ', ' + dateRange : ''}`,
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── PDF / Print generator (no TOC, no links, one <tr> per entry) ─────────────

function generatePdfHtml(
  sections: ReportEventSection[],
): string {
  const meetYear = new Date().getFullYear()

  function buildEventHtml(s: ReportEventSection): string {
    const totalHeats = s.heats.length
    const prefix = genderPrefix(s.gender, s.ageMin)
    const centerName = s.gender === 'X'
      ? esc(s.eventName)
      : `${esc(prefix)},&nbsp;${esc(s.eventName)}`
    const ageRange = esc(formatAgeRange(s.ageMin, s.ageMax))
    const dateTimeStr = s.sessionDate
      ? esc(`${s.sessionDate} - ${s.scheduledTime}`)
      : esc(s.scheduledTime)

    let html = `<div class="ev">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr valign="top">
  <td width="25%">Epreuve ${s.eventNumber}<br>${dateTimeStr}</td>
  <td width="50%" align="center">${centerName}<br><br></td>
  <td width="25%" align="right">${ageRange}<br>Liste des s&eacute;ries</td>
</tr>
</table>
<hr class="ev-rule">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr>
  <td width="2%"><em class="f8">Ex</em></td><td width="1%"></td><td width="3%"></td><td width="1%"></td><td width="32%"></td>
  <td width="5%"><em class="f8">Age</em></td>
  <td width="35%"></td><td width="20%"></td><td width="1%"></td>
</tr>
</table>
`
    for (const heat of s.heats) {
      if (heat.entries.length === 0) continue
      const sorted = [...heat.entries].sort((a, b) => a.lane - b.lane)
      html += `<div class="hb">
<div class="hl">S&eacute;rie&nbsp;${heat.number}&nbsp;de&nbsp;${totalHeats}</div>
<table width="100%" cellspacing="0" cellpadding="0" border="0">
${sorted.map(e => {
  const age = computeAge(e.birthYear, meetYear)
  const t = e.status ? e.status : (e.finalTime ?? e.entryTime ?? 'NT')
  const ex = e.handicapex ? esc(e.handicapex) : ''
  return `<tr>
  <td width="2%"><i><b>${ex}</b></i></td>
  <td width="1%"></td>
  <td width="3%" align="right"><i><b>${e.lane}</b></i></td>
  <td width="1%"></td>
  <td width="32%"><i><b>${esc(e.lastName + ', ' + e.firstName)}</b></i></td>
  <td width="5%"><i><b>${age}</b></i></td>
  <td width="35%"><i><b>${esc(e.clubName || e.clubCode)}</b></i></td>
  <td width="20%" align="right"><i><b>${esc(t)}</b></i></td>
  <td width="1%"></td>
</tr>`
}).join('\n')}
</table>
</div>
`
    }

    html += `</div>\n`
    return html
  }

  const eventsHtml = sections.map(buildEventHtml).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
.f8 { font-size: 8pt; }
body { margin: 0; padding: 0; }
.ev { margin-bottom: 10pt; }
hr.ev-rule { border: none; border-top: 1px solid black; margin: 2px 0 4px 0; }
.hb { break-inside: avoid; page-break-inside: avoid; margin-bottom: 8pt; }
.hl { text-decoration: underline; margin-bottom: 2pt; }
@page { size: Letter portrait; }
</style>
</head>
<body>
<center>
${eventsHtml}
</center>
</body>
</html>`
}

// ── Start List (Fiche de Départs) PDF generator ──────────────────────────────

/** Rows-per-page capacity (tunable). Accounts for page header taking ~3 rows. */
const STARTLIST_ROWS_PER_PAGE = 36

interface StartListLaneEvent {
  eventNumber: number
  eventName: string
  gender: 'M' | 'F' | 'X'
  ageMin: number
  ageMax: number | null
  /** Heats that have an entry in this lane */
  heats: Array<{
    heatNumber: number
    totalHeats: number
    lastName: string
    firstName: string
    birthYear: number
    clubCode: string
    entryTime: string
  }>
}

/**
 * Compute how many "rows" an event occupies for a given lane.
 * Always at least 1 row for the event header (even if no swimmer in this lane).
 * Plus 1 row per heat entry.
 */
function eventRowCount(ev: StartListLaneEvent): number {
  return 1 + ev.heats.length
}

/**
 * Build per-lane event data from the report sections.
 */
function buildLaneData(
  sections: ReportEventSection[],
  laneMin: number,
  laneMax: number,
): Map<number, StartListLaneEvent[]> {
  const laneData = new Map<number, StartListLaneEvent[]>()
  for (let lane = laneMin; lane <= laneMax; lane++) {
    const events: StartListLaneEvent[] = []
    for (const section of sections) {
      const laneHeats: StartListLaneEvent['heats'] = []
      for (const heat of section.heats) {
        const entry = heat.entries.find(e => e.lane === lane)
        if (entry) {
          laneHeats.push({
            heatNumber: heat.number,
            totalHeats: section.heats.length,
            lastName: entry.lastName,
            firstName: entry.firstName,
            birthYear: entry.birthYear,
            clubCode: entry.clubCode || entry.clubName,
            entryTime: entry.status ? entry.status : (entry.entryTime ?? 'NT'),
          })
        }
      }
      events.push({
        eventNumber: section.eventNumber,
        eventName: section.eventName,
        gender: section.gender,
        ageMin: section.ageMin,
        ageMax: section.ageMax,
        heats: laneHeats,
      })
    }
    laneData.set(lane, events)
  }
  return laneData
}

/**
 * Compute synchronized page breaks.
 *
 * Algorithm: walk through events one by one. For each event, compute its row
 * count for EVERY lane (always >= 1 since we print the header even if empty).
 * Accumulate rows per lane. As soon as ANY lane would overflow the page
 * capacity by adding the next event, ALL lanes page-break.
 */
function computePageBreaks(
  laneData: Map<number, StartListLaneEvent[]>,
): number[] {
  if (laneData.size === 0) return []

  const numEvents = laneData.values().next().value!.length
  const lanes = [...laneData.values()]

  const pageBreaks: number[] = []
  const rowsOnPage = new Array(lanes.length).fill(0)

  for (let i = 0; i < numEvents; i++) {
    const eventRows = lanes.map(events => eventRowCount(events[i]))

    let wouldOverflow = false
    for (let l = 0; l < lanes.length; l++) {
      if (rowsOnPage[l] > 0 && rowsOnPage[l] + eventRows[l] > STARTLIST_ROWS_PER_PAGE) {
        wouldOverflow = true
        break
      }
    }

    if (wouldOverflow) {
      pageBreaks.push(i)
      for (let l = 0; l < lanes.length; l++) {
        rowsOnPage[l] = eventRows[l]
      }
    } else {
      for (let l = 0; l < lanes.length; l++) {
        rowsOnPage[l] += eventRows[l]
      }
    }
  }

  return pageBreaks
}

/**
 * Per-lane merge pass: given the global page breaks, determine which breaks
 * this lane actually needs. If two consecutive pages can be combined for THIS
 * lane without overflowing, merge them (skip the break).
 */
function mergeLanePageBreaks(
  events: StartListLaneEvent[],
  globalBreaks: number[],
): number[] {
  if (globalBreaks.length === 0) return []

  const boundaries = [0, ...globalBreaks, events.length]
  const merged: number[] = []

  let p = 0
  while (p < boundaries.length - 1) {
    const pageStart = boundaries[p]

    // Try to merge with the next page
    if (p + 2 < boundaries.length) {
      const nextEnd = boundaries[p + 2]
      // Compute total rows for this lane across both pages
      let total = 0
      for (let i = pageStart; i < nextEnd; i++) {
        total += eventRowCount(events[i])
      }

      if (total <= STARTLIST_ROWS_PER_PAGE) {
        // Merge: remove the boundary between them
        boundaries.splice(p + 1, 1)
        // Don't advance — try to merge again with the next page
        continue
      }
    }

    // Can't merge — keep the break
    if (p + 1 < boundaries.length - 1) {
      merged.push(boundaries[p + 1])
    }
    p++
  }

  return merged
}

function generateStartListPdfHtml(
  sections: ReportEventSection[],
  laneMin: number,
  laneMax: number,
  meetInfo: MeetInfo,
): string {
  const laneData = buildLaneData(sections, laneMin, laneMax)
  const globalBreaks = computePageBreaks(laneData)
  const currentYear = new Date().getFullYear()

  let html = ''

  for (let lane = laneMin; lane <= laneMax; lane++) {
    const events = laneData.get(lane)!

    // Per-lane merge: collapse pages that fit for this lane
    const laneBreaks = mergeLanePageBreaks(events, globalBreaks)
    const laneBreakSet = new Set(laneBreaks)
    const totalPages = 1 + laneBreaks.length
    let pageNum = 1

    // Lane start (page break between lanes, not before first)
    if (html.length > 0) {
      html += `<div class="lane-break"></div>\n`
    }

    // Page header for first page of this lane
    html += buildStartListPageHeader(meetInfo, lane, pageNum, totalPages)

    for (let i = 0; i < events.length; i++) {
      // Check if we need a page break before this event
      if (laneBreakSet.has(i)) {
        pageNum++
        html += `<div class="page-break"></div>\n`
        html += buildStartListPageHeader(meetInfo, lane, pageNum, totalPages)
      }

      const ev = events[i]
      const prefix = genderPrefix(ev.gender, ev.ageMin)
      const evLabel = ev.gender === 'X'
        ? esc(ev.eventName)
        : `${esc(prefix)}, ${esc(ev.eventName)}`
      const ageRange = esc(formatAgeRange(ev.ageMin, ev.ageMax))

      // Always print event header (even if no swimmer in this lane)
      html += `<div class="sl-event">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr>
  <td width="15%"><b>&Eacute;pr. ${ev.eventNumber}</b></td>
  <td width="55%"><b>${evLabel}</b></td>
  <td width="30%" align="right"><em class="f8">${ageRange}</em></td>
</tr>
</table>\n`

      if (ev.heats.length > 0) {
        html += `<table width="100%" cellspacing="0" cellpadding="1" border="0" class="sl-heats">
<tr class="sl-hdr">
  <td width="7%"><em class="f8">S&eacute;rie</em></td>
  <td width="28%"><em class="f8">Nom</em></td>
  <td width="5%"><em class="f8">Age</em></td>
  <td width="9%"><em class="f8">Club</em></td>
  <td width="12%" align="right"><em class="f8">Inscr.</em></td>
  <td width="20%" align="right"><em class="f8">Temps 1</em></td>
  <td width="19%" align="right"><em class="f8">Temps 2</em></td>
</tr>
`
        for (const h of ev.heats) {
          const age = currentYear - h.birthYear
          const ageStr = (age > 0 && age < 120) ? String(age) : '?'
          html += `<tr class="sl-row">
  <td>${h.heatNumber}/${h.totalHeats}</td>
  <td><b>${esc(h.lastName + ', ' + h.firstName)}</b></td>
  <td>${ageStr}</td>
  <td>${esc(h.clubCode)}</td>
  <td align="right">${esc(h.entryTime)}</td>
  <td align="right" class="sl-time-cell"></td>
  <td align="right" class="sl-time-cell"></td>
</tr>\n`
        }
        html += `</table>\n`
      } else {
        html += `<hr class="sl-empty-sep">\n`
      }

      html += `</div>\n`
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
.f8 { font-size: 8pt; }
body { margin: 0; padding: 0; }
.sl-event { margin-bottom: 4pt; break-inside: avoid; page-break-inside: avoid; }
.sl-heats { border-collapse: collapse; }
.sl-heats td { border-bottom: 1px solid #ccc; padding: 1px 3px; }
.sl-hdr td { border-bottom: 2px solid #333; padding: 1px 3px; }
.sl-time-cell { min-width: 70px; height: 18px; }
.sl-empty-sep { border: none; border-top: 1px solid #ccc; margin: 2px 0 0 0; }
.sl-page-hdr { margin-bottom: 10pt; border-bottom: 2px solid black; padding-bottom: 4pt; margin-top: 0; }
.page-break { break-before: page; page-break-before: always; }
.lane-break { break-before: page; page-break-before: always; }
@page { size: Letter portrait; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

function buildStartListPageHeader(
  _meetInfo: MeetInfo,
  lane: number,
  pageNum: number,
  totalPages: number,
): string {
  return `<div class="sl-page-hdr">
<table width="100%" cellspacing="0" cellpadding="2" border="0">
<tr>
  <td width="35%">Fiche de d&eacute;parts</td>
  <td width="30%" align="center"><b style="font-size:12pt">Couloir ${lane}</b></td>
  <td width="35%" align="right">Page ${pageNum} / ${totalPages}</td>
</tr>
</table>
</div>\n`
}

// ── Combined Results PDF generator ───────────────────────────────────────────

interface CombinedResultCategory {
  name: string
  subtitle: string
  athletes: Array<{
    athleteId: number
    lastName: string
    firstName: string
    age: number
    clubName: string
    totalPoints: number
    eventCount: number
  }>
}

function generateCombinedResultsPdfHtml(categories: CombinedResultCategory[]): string {
  function buildCategoryHtml(cat: CombinedResultCategory): string {
    let html = `<div class="cr-category">
<div class="cr-title">${esc(cat.name)}</div>\n`

    if (cat.subtitle) {
      html += `<div class="cr-subtitle">${esc(cat.subtitle)}</div>\n`
    }

    if (cat.athletes.length === 0) {
      html += `</div>\n`
      return html
    }

    html += `<table width="100%" cellspacing="0" cellpadding="1" border="0" class="cr-table">\n`

    // Assign ranks (tied athletes share the same rank, next rank skips)
    let rank = 1
    let lastPoints: number | null = null
    let sameCount = 0

    for (let i = 0; i < cat.athletes.length; i++) {
      const a = cat.athletes[i]

      if (a.totalPoints !== lastPoints) {
        rank = i + 1
        sameCount = 1
        lastPoints = a.totalPoints
      } else {
        sameCount++
      }

      // Only show rank number if it's the first athlete at this point level
      const rankStr = (sameCount === 1) ? `${rank}.` : ''

      html += `<tr>
  <td width="5%" align="right" class="cr-rank">${rankStr}</td>
  <td width="1%"></td>
  <td width="34%"><i><b>${esc(a.lastName + ', ' + a.firstName)}</b></i></td>
  <td width="5%" align="right"><i><b>${a.age}</b></i></td>
  <td width="3%"></td>
  <td width="32%"><i><b>${esc(a.clubName)}</b></i></td>
  <td width="12%" align="right"><b>${a.totalPoints}</b></td>
  <td width="8%" align="right">${a.eventCount}</td>
</tr>\n`
    }

    html += `</table>\n</div>\n`
    return html
  }

  const categoriesHtml = categories.map(buildCategoryHtml).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
body { margin: 0; padding: 0; }
.cr-category { margin-bottom: 16pt; }
.cr-title { font-size: 12pt; font-weight: normal; margin-bottom: 6pt; border-bottom: 1px solid black; padding-bottom: 2pt; }
.cr-subtitle { font-size: 10pt; margin-bottom: 4pt; }
.cr-table { border-collapse: collapse; }
.cr-table td { padding: 1px 2px; }
.cr-rank { font-size: 10pt; }
@page { size: Letter portrait; }
</style>
</head>
<body>
${categoriesHtml}
</body>
</html>`
}

function buildCombinedResultsPdfHeaderInfo(meetInfo: MeetInfo): PdfHeaderInfo {
  return {
    line1: meetInfo.name || 'Compétition',
    line2: meetInfo.city || '',
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── Beach Numbers (Identifiants plage) PDF generator ─────────────────────────

interface BeachNumberReportRow {
  clubName: string
  beachNumber: string
  lastName: string
  firstName: string
}

function generateBeachNumbersPdfHtml(rows: BeachNumberReportRow[]): string {
  // Group by club name (already sorted by club name from the query)
  const clubs = new Map<string, BeachNumberReportRow[]>()
  for (const row of rows) {
    const existing = clubs.get(row.clubName)
    if (existing) {
      existing.push(row)
    } else {
      clubs.set(row.clubName, [row])
    }
  }

  let html = ''
  for (const [clubName, athletes] of clubs) {
    html += `<div class="ev">
<h3>${esc(clubName)}</h3>
<table>
${athletes.map(a => `<tr><td>${esc(a.beachNumber)}</td><td>${esc(a.lastName)}</td><td>${esc(a.firstName)}</td></tr>`).join('\n')}
</table>
</div>\n`
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
body { margin: 0; padding: 0; }
.ev { margin-bottom: 14pt; }
.ev h3 { font-size: 11pt; margin: 0 0 4pt 0; border-bottom: 1px solid black; padding-bottom: 2pt; }
.ev table { border-collapse: collapse; width: 100%; }
.ev table td { text-align: left; padding: 1px 6px 1px 0; }
@page { size: Letter portrait; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

function buildBeachNumbersPdfHeaderInfo(meetInfo: MeetInfo): PdfHeaderInfo {
  return {
    line1: meetInfo.name || 'Compétition',
    line2: meetInfo.city ? `${meetInfo.city} — Identifiants plage` : 'Identifiants plage',
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── Entries by Event (Liste des inscriptions par épreuves) PDF generator ──────

interface EntryByEventReportRow {
  eventId: number
  eventNumber: number
  eventName: string
  gender: number
  ageMin: number
  ageMax: number
  lastName: string
  firstName: string
  birthdate: string | number | null
  clubName: string
  clubCode: string
  entryTime: number | null
  beachNumber: string | null
  ageGroupName: string
}

function msToDisplay(ms: number | null): string {
  if (ms == null || ms <= 0) return 'NT'
  const totalSecs = ms / 1000
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs - mins * 60
  if (mins > 0) {
    return `${mins}:${secs < 10 ? '0' : ''}${secs.toFixed(2)}`
  }
  return secs.toFixed(2)
}

function decodeGenderNum(g: number): 'M' | 'F' | 'X' {
  if (g === 1) return 'M'
  if (g === 2) return 'F'
  return 'X'
}

function generateEntriesByEventPdfHtml(rows: EntryByEventReportRow[], isBeach: boolean): string {
  // Group rows by event
  const events = new Map<number, { eventNumber: number; eventName: string; gender: number; ageMin: number; ageMax: number; entries: EntryByEventReportRow[] }>()

  for (const row of rows) {
    if (!events.has(row.eventId)) {
      events.set(row.eventId, {
        eventNumber: row.eventNumber,
        eventName: row.eventName,
        gender: row.gender,
        ageMin: row.ageMin,
        ageMax: row.ageMax,
        entries: [],
      })
    }
    events.get(row.eventId)!.entries.push(row)
  }

  const meetYear = new Date().getFullYear()

  let html = ''
  for (const [, ev] of events) {
    const gender = decodeGenderNum(ev.gender)
    const prefix = genderPrefix(gender, ev.ageMin)
    const centerName = gender === 'X'
      ? esc(ev.eventName ?? '')
      : `${esc(prefix)}, ${esc(ev.eventName ?? '')}`
    const ageRange = esc(formatAgeRange(ev.ageMin, ev.ageMax))
    const entryCount = ev.entries.length

    html += `<div class="ev">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr valign="top">
  <td width="15%"><b>&Eacute;preuve ${ev.eventNumber}</b></td>
  <td width="55%" align="center"><b>${centerName}</b></td>
  <td width="30%" align="right"><em class="f8">${ageRange}</em></td>
</tr>
</table>
<hr class="ev-rule">
<table width="100%" cellspacing="0" cellpadding="1" border="0" class="entry-table">
<tr class="entry-hdr">
  <td width="3%" align="right"><em class="f8">#</em></td>
  ${isBeach ? '<td width="8%"><em class="f8">No.</em></td>' : ''}
  <td width="${isBeach ? '29' : '37'}%"><em class="f8">Nom</em></td>
  <td width="5%"><em class="f8">Age</em></td>
  <td width="10%"><em class="f8">Cat.</em></td>
  <td width="25%"><em class="f8">Club</em></td>
  ${!isBeach ? '<td width="15%" align="right"><em class="f8">Temps inscr.</em></td>' : ''}
</tr>
`

    for (let i = 0; i < ev.entries.length; i++) {
      const e = ev.entries[i]
      const birthYear = parseBirthYearEntry(e.birthdate)
      const age = birthYear > 0 ? meetYear - birthYear : '?'
      const entryTimeStr = isBeach ? '' : msToDisplay(e.entryTime)
      const beachNum = isBeach && e.beachNumber ? esc(e.beachNumber) : ''

      html += `<tr>
  <td align="right">${i + 1}.</td>
  ${isBeach ? `<td>${beachNum}</td>` : ''}
  <td><b>${esc(e.lastName + ', ' + e.firstName)}</b></td>
  <td>${age}</td>
  <td>${esc(e.ageGroupName ?? '')}</td>
  <td>${esc(e.clubName)}</td>
  ${!isBeach ? `<td align="right">${esc(entryTimeStr)}</td>` : ''}
</tr>\n`
    }

    html += `</table>
<div class="entry-count">${entryCount} inscription${entryCount !== 1 ? 's' : ''}</div>
</div>\n`
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
.f8 { font-size: 8pt; }
body { margin: 0; padding: 0; }
.ev { margin-bottom: 14pt; break-inside: avoid; page-break-inside: avoid; }
hr.ev-rule { border: none; border-top: 1px solid black; margin: 2px 0 4px 0; }
.entry-table { border-collapse: collapse; }
.entry-table td { padding: 1px 3px; }
.entry-hdr td { border-bottom: 2px solid #333; padding: 1px 3px; }
.entry-count { font-size: 8pt; color: #555; text-align: right; margin-top: 2pt; }
@page { size: Letter portrait; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

function parseBirthYearEntry(bd: string | number | null): number {
  if (bd == null) return 0
  if (typeof bd === 'number') return new Date(bd).getFullYear()
  const m = String(bd).match(/(\d{4})/)
  return m ? Number(m[1]) : 0
}

function buildEntriesByEventPdfHeaderInfo(meetInfo: MeetInfo): PdfHeaderInfo {
  return {
    line1: meetInfo.name || 'Compétition',
    line2: meetInfo.city ? `${meetInfo.city} — Liste des inscriptions par épreuves` : 'Liste des inscriptions par épreuves',
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── Point Standings (Classement au points) PDF generator ─────────────────────

interface PointStandingsData {
  clubs: Array<{
    clubName: string
    clubCode: string
    totalPoints: number
    categories: Array<{ categoryName: string; points: number }>
  }>
  categories: string[]
}

function generatePointStandingsPdfHtml(data: PointStandingsData): string {
  if (data.clubs.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><p>Aucun résultat disponible.</p></body></html>`
  }

  // Truncate long category names for column headers
  function shortCat(name: string): string {
    // Try to extract a shorter version (e.g., "10 et - G" from "Cumulatif 10 ans et moins - garçons")
    const m = name.match(/(\d+[\s-]+\d+|\d+\s+et\s+[\w-]+).*?([GMFgmf])/i)
    if (m) return `${m[1]} ${m[2].toUpperCase()}`
    if (name.length > 15) return name.slice(0, 14) + '…'
    return name
  }

  const catHeaders = data.categories.map(c => `<td align="right"><em class="f8">${esc(shortCat(c))}</em></td>`).join('\n  ')

  let html = `<div class="ps-report">
<table width="100%" cellspacing="0" cellpadding="2" border="0" class="ps-table">
<tr class="ps-hdr">
  <td width="4%" align="right"><em class="f8">Rang</em></td>
  <td width="30%"><em class="f8">Club</em></td>
  ${catHeaders}
  <td width="8%" align="right"><b><em class="f8">Total</em></b></td>
</tr>
`

  let rank = 1
  let lastPoints: number | null = null
  let sameCount = 0

  for (let i = 0; i < data.clubs.length; i++) {
    const club = data.clubs[i]

    if (club.totalPoints !== lastPoints) {
      rank = i + 1
      sameCount = 1
      lastPoints = club.totalPoints
    } else {
      sameCount++
    }

    const rankStr = sameCount === 1 ? `${rank}.` : ''
    const catCells = club.categories.map(c =>
      `<td align="right">${c.points > 0 ? c.points : ''}</td>`
    ).join('\n  ')

    html += `<tr>
  <td align="right">${rankStr}</td>
  <td><b>${esc(club.clubName)}</b></td>
  ${catCells}
  <td align="right"><b>${club.totalPoints}</b></td>
</tr>\n`
  }

  html += `</table>
</div>`

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
.f8 { font-size: 8pt; }
body { margin: 0; padding: 0; }
.ps-report { margin-bottom: 14pt; }
.ps-table { border-collapse: collapse; }
.ps-table td { padding: 2px 4px; border-bottom: 1px solid #ddd; }
.ps-hdr td { border-bottom: 2px solid #333; padding: 2px 4px; }
@page { size: Letter landscape; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

function buildPointStandingsPdfHeaderInfo(meetInfo: MeetInfo): PdfHeaderInfo {
  return {
    line1: meetInfo.name || 'Compétition',
    line2: meetInfo.city ? `${meetInfo.city} — Classement au points` : 'Classement au points',
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── HTML export generator (TOC + hyperlinks, matches reference .htm format) ────

function generateHeatListHtml(
  meetInfo: MeetInfo,
  sections: ReportEventSection[],
  forExport: boolean,
): string {
  const meetYear = sections.find(s => s.sessionDate)?.sessionDate.slice(0, 4)
    ?? String(new Date().getFullYear())

  // ── TOC ──────────────────────────────────────────────────────────────────────
  const half = Math.ceil(sections.length / 2)
  const leftToc = sections.slice(0, half)
  const rightToc = sections.slice(half)

  function tocLink(s: ReportEventSection, i: number): string {
    const prefix = genderPrefix(s.gender, s.ageMin)
    const fullName = s.gender === 'X'
      ? `${esc(s.eventName)}`
      : `${esc(prefix)},&nbsp;${esc(s.eventName)}`
    const age = esc(formatAgeRange(s.ageMin, s.ageMax))
    return `<a href=#ref${i + 1}>N°&nbsp;${s.eventNumber}.&nbsp;${fullName}&nbsp;&nbsp;${age}</a>`
  }

  const tocHtml = `<table width=100% border=0 cellspacing=0 cellpadding=0><tr valign=top>
<td width=50%><em id=f8>${leftToc.map((s, i) => tocLink(s, i)).join('<br>')}</em></td>
<td width=50%><em id=f8>${rightToc.map((s, i) => tocLink(s, i + half)).join('<br>')}</em></td>
</tr></table>`

  // ── Meet header ───────────────────────────────────────────────────────────────
  const meetHeaderLine1 = esc(meetInfo.name || 'Compétition')
  const dates = [...new Set(sections.map(s => s.sessionDate).filter(Boolean))].sort()
  const dateRange = dates.length > 1
    ? `${dates[0]} - ${dates[dates.length - 1]}`
    : (dates[0] ?? '')
  const meetHeaderLine2 = esc(`${meetInfo.city}${dateRange ? ', ' + dateRange : ''}`)

  const headerHtml = `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td align=center width=100%>${meetHeaderLine1}<br>${meetHeaderLine2}</td></tr>
</table>`

  const HR = `<table width=100% border=0 cellspacing=0 cellpadding=0><tr><td><hr noshade size="1" color="black"></td></tr></table>`

  // ── Events ────────────────────────────────────────────────────────────────────
  function buildEventHtml(s: ReportEventSection, idx: number): string {
    const totalHeats = s.heats.length
    const prefix = genderPrefix(s.gender, s.ageMin)
    const centerName = s.gender === 'X'
      ? esc(s.eventName)
      : `${esc(prefix)}, ${esc(s.eventName)}`
    const ageRange = esc(formatAgeRange(s.ageMin, s.ageMax))
    const dateTimeStr = s.sessionDate
      ? esc(`${s.sessionDate} - ${s.scheduledTime}`)
      : esc(s.scheduledTime)

    let html = `<a name=ref${idx + 1}>\n`

    // TOP link (not on first event)
    if (idx > 0) {
      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><a href="#_top">&lt;&lt; TOP &gt;&gt;</a></td></tr>
</table>\n`
    }

    // Event header
    html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=25%>Epreuve ${s.eventNumber}<br>${dateTimeStr}</td>
<td align=center width=50%>${centerName}<br><br></td>
<td align=right width=25%>${ageRange}<br>Liste des s&eacute;ries</td>
</tr>
</table>
${HR}
<br>
`

    // Column header (Age label)
    html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=2%><em id=f8>Ex</em></td><td width=1%></td><td width=3%></td><td width=1%></td><td width=32%></td>
<td width=5%><em id=f8>Age</em></td>
<td width=35%></td><td width=20%></td><td width=1%></td>
</tr>
</table>
`

    // Heats
    for (const heat of s.heats) {
      if (heat.entries.length === 0) continue

      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><u>S&eacute;rie ${heat.number} de ${totalHeats}</u></td><td width=2%></td></tr>
</table>\n`

      const sorted = [...heat.entries].sort((a, b) => a.lane - b.lane)

      const exceptions = sorted.map(e => `<i><b>${e.handicapex ? esc(e.handicapex) : ''}</b></i>`).join('<br>')
      const lanes = sorted.map(e => `<i><b>${e.lane}</b></i>`).join('<br>')
      const names = sorted.map(e => `<i><b>${esc(e.lastName + ', ' + e.firstName)}</b></i>`).join('<br>')
      const ages  = sorted.map(e => `<i><b>${computeAge(e.birthYear, Number(meetYear))}</b></i>`).join('<br>')
      const clubs = sorted.map(e => `<i><b>${esc(e.clubName || e.clubCode)}</b></i>`).join('<br>')
      const times = sorted.map(e => {
        if (e.status) return `<i><b>${e.status}</b></i>`
        const t = e.finalTime ?? e.entryTime ?? 'NT'
        return `<i><b>${esc(t)}</b></i>`
      }).join('<br>')

      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=2%>${exceptions}<br><br><br></td>
<td width=1%></td>
<td align=right width=3%>${lanes}<br><br><br></td>
<td width=1%></td>
<td width=32%>${names}<br><br><br></td>
<td width=5%>${ages}</td>
<td width=35%>${clubs}<br><br></td>
<td align=right width=20%>${times}<br><br><br></td>
<td width=1%></td>
</tr>
</table>\n`
    }

    return html
  }

  const eventsHtml = sections.map((s, i) => buildEventHtml(s, i)).join('\n')

  // Trailing TOP link
  const trailingTop = sections.length > 0
    ? `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><a href="#_top">&lt;&lt; TOP &gt;&gt;</a></td></tr>
</table>\n`
    : ''

  const SPLASH_FOOTER = !forExport ? '' : `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr><td><hr noshade size="1" color="black"></td></tr></table>
<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr>
  <td width=40%><em id=f8>SauvetageMeet</em></td>
  <td align=center width=20%></td>
  <td align=right width=40%><em id=f8>${new Date().toLocaleDateString('fr-CA')}</em></td>
</tr>
</table>`

  // ── Print CSS ─────────────────────────────────────────────────────────────────
  const printCss = `@page { size: A4 portrait; margin: 1cm 1.5cm; }
@media print { body { background: white !important; } .paper-wrap { box-shadow: none !important; background: white !important; padding: 0 !important; } }`

  // ── Preview-only CSS ──────────────────────────────────────────────────────────
  const previewCss = forExport ? '' : `
body { background: #6b7280; margin: 0; padding: 16px; }
.paper-wrap {
  background: white;
  width: 794px;
  margin: 0 auto;
  padding: 50px 60px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  min-height: 1122px;
}`

  return `<a name=_top>
<!doctype html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<STYLE><!--
BODY,TABLE,TD {font-family: Arial, helvetica; font-style:normal; font-size: 10pt;}
#f8 {font-family: Arial, helvetica; font-style:normal; font-size: 8pt;}
a { color: inherit; text-decoration: underline; }
${printCss}
${previewCss}
--></STYLE>
</head><body>
${forExport ? '' : '<div class="paper-wrap">'}
<center>
${tocHtml}
${HR}
<br>
${headerHtml}
${HR}
<br>
${eventsHtml}
${trailingTop}
${SPLASH_FOOTER}
</center>
${forExport ? '' : '</div>'}
</body></html>`
}

// ── ReportPage ─────────────────────────────────────────────────────────────────

export default function ReportPage({ refreshKey = 0, meetType = 'POOL' }: { refreshKey?: number; meetType?: string }) {
  const [heatSessions, setHeatSessions]   = useState<HeatListSessionRow[]>([])
  const [fullSessions, setFullSessions]   = useState<SessionRow[]>([])
  const [meetInfo, setMeetInfo]           = useState<MeetInfo>({ name: '', city: '', nation: '' })
  const [reportType, setReportType]       = useState<ReportType>('heatList')
  const [loading, setLoading]             = useState(true)

  const [selectedEventIds, setSelectedEventIds] = useState<Set<number>>(new Set())
  const lastClickedIdx = useRef<number | null>(null)

  const [previewUrl, setPreviewUrlState]   = useState<string | null>(null)
  const [exportHtml, setExportHtml]        = useState<string | null>(null)
  const [pdfHtml, setPdfHtml]              = useState<string | null>(null)
  const [pdfHeaderInfo, setPdfHeaderInfo]  = useState<PdfHeaderInfo | null>(null)
  const [generating, setGenerating]        = useState(false)
  const iframeRef  = useRef<HTMLIFrameElement>(null)
  const blobUrlRef = useRef<string | null>(null)

  function setPreviewUrl(url: string | null) {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    blobUrlRef.current = url
    setPreviewUrlState(url)
  }

  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  // ── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    setLoading(true)
    const api = dbApi()
    if (!api) { setLoading(false); return }
    Promise.all([
      api.getHeatListSessions() as Promise<HeatListSessionRow[]>,
      api.getSessions()         as Promise<SessionRow[]>,
      api.getMeetInfo()         as Promise<MeetInfo>,
    ]).then(([hs, fs, mi]) => {
      setHeatSessions(hs)
      setFullSessions(fs)
      setMeetInfo(mi)
      // Select all events by default
      const allEventIds = new Set<number>()
      hs.forEach(s => s.events.forEach(e => { if (!e.isAdmin) allEventIds.add(e.id) }))
      setSelectedEventIds(allEventIds)
    }).catch(console.error).finally(() => setLoading(false))
  }, [refreshKey])

  // ── Flat items for selector ────────────────────────────────────────────────

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []
    for (const s of heatSessions) {
      items.push({
        key: `session:${s.id}`,
        type: 'session',
        id: s.id,
        sessionId: s.id,
        label: `Session ${s.number}${s.name ? ' – ' + s.name : ''}${s.time ? ' (' + s.time + ')' : ''}`,
        isAdmin: false,
      })
      for (const e of s.events) {
        items.push({
          key: `event:${e.id}`,
          type: 'event',
          id: e.id,
          sessionId: s.id,
          label: e.number
            ? `${e.number}. ${e.nameFr}${e.scheduledTime ? ' ' + e.scheduledTime : ''}`
            : e.nameFr,
          isAdmin: e.isAdmin ?? false,
        })
      }
    }
    return items
  }, [heatSessions])

  // ── Age-group lookup from fullSessions ────────────────────────────────────

  const ageGroupMap = useMemo(() => {
    const m = new Map<number, AgeGroupRow[]>()
    for (const s of fullSessions) {
      for (const e of s.events) m.set(e.id, e.ageGroups)
    }
    return m
  }, [fullSessions])

  const sessionDateMap = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of fullSessions) m.set(s.id, s.date ?? '')
    return m
  }, [fullSessions])

  // ── Selection helpers ──────────────────────────────────────────────────────

  function getSessionEventIds(sessionId: number): number[] {
    return heatSessions
      .find(s => s.id === sessionId)
      ?.events.filter(e => !(e.isAdmin)).map(e => e.id) ?? []
  }

  function isSessionSelected(sessionId: number): boolean {
    const ids = getSessionEventIds(sessionId)
    return ids.length > 0 && ids.every(id => selectedEventIds.has(id))
  }

  function isSessionPartial(sessionId: number): boolean {
    const ids = getSessionEventIds(sessionId)
    return ids.some(id => selectedEventIds.has(id)) && !ids.every(id => selectedEventIds.has(id))
  }

  const handleItemClick = useCallback((idx: number, item: FlatItem, e: React.MouseEvent) => {
    if (item.isAdmin) return

    const targetEventIds: number[] = item.type === 'session'
      ? getSessionEventIds(item.id)
      : [item.id]

    setSelectedEventIds(prev => {
      const next = new Set(prev)

      if (e.ctrlKey || e.metaKey) {
        // Toggle
        if (item.type === 'session') {
          const allSel = targetEventIds.every(id => next.has(id))
          targetEventIds.forEach(id => allSel ? next.delete(id) : next.add(id))
        } else {
          if (next.has(item.id)) next.delete(item.id); else next.add(item.id)
        }
      } else if (e.shiftKey && lastClickedIdx.current !== null) {
        // Range select
        const lo = Math.min(lastClickedIdx.current, idx)
        const hi = Math.max(lastClickedIdx.current, idx)
        for (let i = lo; i <= hi; i++) {
          const ri = flatItems[i]
          if (!ri || ri.isAdmin) continue
          if (ri.type === 'event') next.add(ri.id)
          else getSessionEventIds(ri.id).forEach(id => next.add(id))
        }
      } else {
        // Single click: if item already the only selection, deselect; else select only it
        const onlyThis =
          item.type === 'event'
            ? next.size === 1 && next.has(item.id)
            : targetEventIds.every(id => next.has(id)) && next.size === targetEventIds.length

        if (onlyThis) {
          targetEventIds.forEach(id => next.delete(id))
        } else {
          next.clear()
          targetEventIds.forEach(id => next.add(id))
        }
      }

      return next
    })

    lastClickedIdx.current = idx
  }, [flatItems, heatSessions]) // eslint-disable-line

  // ── Build report sections from selection ───────────────────────────────────

  function buildSections(): ReportEventSection[] {
    const sections: ReportEventSection[] = []
    for (const hs of heatSessions) {
      const sDate = sessionDateMap.get(hs.id) ?? ''
      for (const ev of hs.events) {
        if (ev.isAdmin) continue
        if (!selectedEventIds.has(ev.id)) continue
        const ags = ageGroupMap.get(ev.id) ?? []
        const ag = ags[0]
        sections.push({
          eventId: ev.id,
          eventNumber: ev.number,
          eventName: ev.nameFr,
          gender: ev.gender,
          ageMin: ag?.minAge ?? 0,
          ageMax: ag?.maxAge ?? null,
          sessionDate: sDate,
          scheduledTime: ev.scheduledTime ?? '',
          heats: ev.heats,
        })
      }
    }
    return sections
  }

  // ── Generate ───────────────────────────────────────────────────────────────

  async function handleGenerate() {
    const sections = buildSections()
    if (sections.length === 0 && reportType !== 'combinedResults' && reportType !== 'beachNumbers' && reportType !== 'entriesByEvent' && reportType !== 'pointStandings') return

    let pdf: string
    let exported: string
    let hdrInfo: PdfHeaderInfo

    if (reportType === 'beachNumbers') {
      // Fetch beach number report data from main process
      const rows = await dbApi()?.getBeachNumberReport() as BeachNumberReportRow[] | undefined
      pdf = generateBeachNumbersPdfHtml(rows ?? [])
      exported = '' // No HTML export for beachNumbers
      hdrInfo = buildBeachNumbersPdfHeaderInfo(meetInfo)
    } else if (reportType === 'entriesByEvent') {
      // Fetch entries by event from main process
      const eventIds = [...selectedEventIds]
      if (eventIds.length === 0) return
      const rows = await dbApi()?.getEntriesByEvent(eventIds) as EntryByEventReportRow[] | undefined
      const isBeach = meetType === 'BEACH'
      pdf = generateEntriesByEventPdfHtml(rows ?? [], isBeach)
      exported = '' // No HTML export
      hdrInfo = buildEntriesByEventPdfHeaderInfo(meetInfo)
    } else if (reportType === 'pointStandings') {
      // Fetch point standings from main process
      const eventIds = [...selectedEventIds]
      if (eventIds.length === 0) return
      const data = await dbApi()?.getPointStandings(eventIds) as PointStandingsData | undefined
      if (!data || data.clubs.length === 0) {
        alert('Aucune donnée de classement aux points disponible. Vérifiez que des résultats existent pour les épreuves sélectionnées.')
        return
      }
      pdf = generatePointStandingsPdfHtml(data)
      exported = '' // No HTML export
      hdrInfo = buildPointStandingsPdfHeaderInfo(meetInfo)
    } else if (reportType === 'combinedResults') {
      // Fetch combined results from main process
      const eventIds = [...selectedEventIds]
      if (eventIds.length === 0) return
      const categories = await dbApi()?.getCombinedResults(eventIds) as CombinedResultCategory[] | undefined
      if (!categories || categories.length === 0) {
        alert('Aucun résultat combiné disponible. Vérifiez que des résultats existent pour les épreuves sélectionnées.')
        return
      }
      pdf = generateCombinedResultsPdfHtml(categories)
      exported = '' // No HTML export for combinedResults
      hdrInfo = buildCombinedResultsPdfHeaderInfo(meetInfo)
    } else if (reportType === 'startList') {
      // Determine lane range from sessions
      let laneMin = 1
      let laneMax = 8
      for (const hs of heatSessions) {
        if (hs.laneMin < laneMin) laneMin = hs.laneMin
        if (hs.laneMax > laneMax) laneMax = hs.laneMax
      }
      if (heatSessions.length > 0) {
        laneMin = Math.min(...heatSessions.map(s => s.laneMin))
        laneMax = Math.max(...heatSessions.map(s => s.laneMax))
      }
      pdf = generateStartListPdfHtml(sections, laneMin, laneMax, meetInfo)
      exported = '' // No HTML export for startList
      hdrInfo = buildPdfHeaderInfo(meetInfo, sections)
    } else {
      exported = generateHeatListHtml(meetInfo, sections, true)
      pdf = generatePdfHtml(sections)
      hdrInfo = buildPdfHeaderInfo(meetInfo, sections)
    }

    setExportHtml(exported)
    setPdfHtml(pdf)
    setPdfHeaderInfo(hdrInfo)
    setGenerating(true)
    setPreviewUrl(null)
    try {
      const result = await reportApi()?.previewPdf(pdf, hdrInfo)
      if (result?.ok) {
        const bytes = atob(result.data)
        const arr = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
        const blob = new Blob([arr], { type: 'application/pdf' })
        setPreviewUrl(URL.createObjectURL(blob))
      }
    } catch (err) {
      console.error('PDF preview error', err)
    } finally {
      setGenerating(false)
    }
  }

  // ── Print / PDF / HTML ─────────────────────────────────────────────────────

  async function handlePrint() {
    if (!pdfHtml || !pdfHeaderInfo) return
    const r = await reportApi()?.print(pdfHtml, pdfHeaderInfo)
    if (r && !r.ok && !r.canceled) alert(`Erreur impression: ${r.error}`)
  }

  async function handleSavePdf() {
    if (!pdfHtml || !pdfHeaderInfo) return
    const r = await reportApi()?.savePdf(pdfHtml, pdfHeaderInfo)
    if (r && !r.ok && !r.canceled) alert(`Erreur PDF: ${r.error}`)
  }

  async function handleSaveHtml() {
    if (!exportHtml) return
    const r = await reportApi()?.saveHtml(exportHtml)
    if (r && !r.ok && !r.canceled) alert(`Erreur HTML: ${r.error}`)
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  const hasPreview = previewUrl !== null || generating

  return (
    <div className="flex flex-col h-full bg-gray-100" style={{ userSelect: 'none' }}>

      {/* ── Top toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-200 border-b border-gray-300 shrink-0">
        <label className="text-xs font-medium text-gray-600">Rapport:</label>
        <select
          className="text-xs border border-gray-400 bg-white px-2 py-0.5 h-6"
          value={reportType}
          onChange={e => setReportType(e.target.value as ReportType)}
        >
          <option value="heatList">Liste des Séries</option>
          <option value="startList">Fiche de Départs</option>
          <option value="entriesByEvent">Liste des inscriptions par épreuves</option>
          <option value="combinedResults">Résultat Combiné</option>
          <option value="pointStandings">Classement au points</option>
          {meetType === 'BEACH' && (
            <option value="beachNumbers">Identifiants plage</option>
          )}
        </select>
        <button
          onClick={handleGenerate}
          disabled={(selectedEventIds.size === 0 && reportType !== 'beachNumbers') || loading || generating}
          className="px-3 py-0.5 h-6 text-xs bg-blue-600 text-white border border-blue-700 hover:bg-blue-700 disabled:opacity-40"
        >
          {generating ? 'Génération…' : 'Générer'}
        </button>
      </div>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: cascade session/event selector ── */}
        <div className="w-72 border-r border-gray-300 bg-white flex flex-col shrink-0">
          <div className="px-2 py-1 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200">
            Sessions / Épreuves
          </div>
          <div className="flex-1 overflow-y-auto text-xs">
            {loading && (
              <div className="p-3 text-gray-400 italic">Chargement…</div>
            )}
            {!loading && flatItems.length === 0 && (
              <div className="p-3 text-gray-400 italic">Aucune donnée</div>
            )}
            {flatItems.map((item, idx) => {
              const isSession = item.type === 'session'
              const selected = isSession
                ? isSessionSelected(item.id)
                : selectedEventIds.has(item.id)
              const partial = isSession && isSessionPartial(item.id)
              const disabled = item.isAdmin

              return (
                <div
                  key={item.key}
                  onClick={e => !disabled && handleItemClick(idx, item, e)}
                  className={[
                    'flex items-center gap-1 px-2 cursor-default',
                    isSession
                      ? 'py-1 font-semibold border-b border-gray-100 bg-gray-50 hover:bg-gray-100'
                      : 'py-0.5 pl-5 hover:bg-gray-50',
                    selected && !partial ? 'bg-blue-100 text-blue-900 hover:bg-blue-100' : '',
                    partial ? 'bg-blue-50 text-blue-800' : '',
                    disabled ? 'opacity-40 cursor-not-allowed' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {/* checkbox-like indicator */}
                  <span className={[
                    'w-3 h-3 border flex items-center justify-center shrink-0',
                    selected && !partial ? 'bg-blue-600 border-blue-700' : 'bg-white border-gray-400',
                    partial ? 'bg-blue-300 border-blue-500' : '',
                  ].join(' ')}>
                    {(selected || partial) && (
                      <span className="text-white text-[8px] leading-none">
                        {partial ? '–' : '✓'}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>
              )
            })}
          </div>
          {/* Selection summary */}
          <div className="px-2 py-1 text-xs text-gray-500 border-t border-gray-200 bg-gray-50">
            {selectedEventIds.size} épreuve{selectedEventIds.size !== 1 ? 's' : ''} sélectionnée{selectedEventIds.size !== 1 ? 's' : ''}
          </div>
        </div>

        {/* ── Right: preview pane ── */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Preview toolbar */}
          <div className="flex items-center gap-1 px-3 py-1.5 bg-gray-200 border-b border-gray-300 shrink-0">
            <button
              onClick={handlePrint}
              disabled={!pdfHtml || generating}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              Imprimer
            </button>
            <button
              onClick={handleSavePdf}
              disabled={!pdfHtml || generating}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              PDF
            </button>
            <button
              onClick={handleSaveHtml}
              disabled={!exportHtml || generating || reportType === 'startList' || reportType === 'combinedResults' || reportType === 'beachNumbers' || reportType === 'entriesByEvent' || reportType === 'pointStandings'}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              HTML
            </button>
          </div>

          {/* Preview iframe */}
          <div className="flex-1 overflow-hidden bg-gray-500 relative">
            {!hasPreview && (
              <div className="flex items-center justify-center h-full text-gray-300 text-sm italic">
                Sélectionnez des épreuves et cliquez sur <span className="mx-1 px-2 bg-gray-600 rounded">Générer</span>
              </div>
            )}
            {generating && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-700 bg-opacity-70 z-10">
                <span className="text-white text-sm">Génération de l'aperçu…</span>
              </div>
            )}
            {previewUrl && (
              <iframe
                ref={iframeRef}
                src={previewUrl}
                className="w-full h-full border-0"
                title="Aperçu du rapport"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
