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
 * Beach position entry sheet PDF generator.
 *
 * Beach events are ranked (finish order), not timed — officials watch the
 * finish and write down each athlete's beach number next to the FINISH
 * POSITION they crossed in (position is known first — it's the order they
 * watch athletes finish in — the beach number is what they read off the
 * athlete and write down). One heat per page: a pre-printed position number
 * (1, 2, 3, ...) per row with a blank box to write the beach number in, plus
 * a few extra blank rows past the heat's entry count for late arrivals.
 * Row height is computed per page so the list fills the page whether the
 * heat has 6 entries or 20.
 */

export interface PositionSheetHeat {
  heatNumber: number
  identifiers: string[] // beach numbers/teams assigned to this heat — only the count is used (row total)
}

export interface PositionSheetEvent {
  eventNumber: number
  eventName: string
  genderLabel: string
  heats: PositionSheetHeat[]
}

const EXTRA_ROWS = 4

const PAGE_HEIGHT_IN = 11
const PAGE_MARGIN_IN = 0.35
const HEADER_HEIGHT_IN = 0.9
const USABLE_HEIGHT_IN = PAGE_HEIGHT_IN - PAGE_MARGIN_IN * 2 - HEADER_HEIGHT_IN
const MIN_ROW_HEIGHT_IN = 0.35
const MAX_ROW_HEIGHT_IN = 1.1

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Generate the HTML content for beach position entry sheets.
 * One full page per heat: a numbered position list (position pre-printed,
 * beach number blank) sized to fill the page.
 */
export function generatePositionSheetsHtml(events: PositionSheetEvent[]): string {
  const styles = `
    <style>
      @page { margin: ${PAGE_MARGIN_IN}in; size: letter portrait; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; }
      .heat-page {
        page-break-after: always;
        break-after: page;
      }
      .heat-page:last-child { page-break-after: auto; break-after: auto; }
      .page-header {
        text-align: center;
        padding-bottom: 8pt;
        margin-bottom: 10pt;
        border-bottom: 2px solid #000;
      }
      .page-header .event-title { font-size: 15pt; font-weight: bold; }
      .page-header .heat-title { font-size: 13pt; margin-top: 2pt; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      col.pos-col { width: 35%; }
      col.id-col { width: 65%; }
      th {
        font-size: 10pt;
        padding: 4pt 8pt;
        background: #f4f4f4;
        border-bottom: 2px solid #000;
        text-align: left;
      }
      th.pos-col, td.pos-col { text-align: center; border-right: 1px solid #000; }
      td {
        border-bottom: 1px solid #999;
        padding: 2pt 8pt;
      }
      td.pos-col {
        font-family: monospace;
        font-size: 15pt;
        font-weight: bold;
      }
      td.id-box { background: #fafafa; }
      tr.late-row td.pos-col { color: #bbb; }
    </style>
  `

  const pagesHtml = events.map((ev) => {
    const eventTitle = `Épr. ${ev.eventNumber}: ${ev.genderLabel}, ${escHtml(ev.eventName)}`
    return ev.heats.map((h) => {
      const rowCount = h.identifiers.length + EXTRA_ROWS
      const rowHeightIn = Math.min(
        MAX_ROW_HEIGHT_IN,
        Math.max(MIN_ROW_HEIGHT_IN, USABLE_HEIGHT_IN / rowCount)
      )

      const rows = Array.from({ length: rowCount }, (_, i) => {
        const late = i >= h.identifiers.length
        return `
          <tr style="height: ${rowHeightIn}in"${late ? ' class="late-row"' : ''}>
            <td class="pos-col">${i + 1}</td>
            <td class="id-box"></td>
          </tr>
        `
      }).join('')

      return `
        <div class="heat-page">
          <div class="page-header">
            <div class="event-title">${eventTitle}</div>
            <div class="heat-title">Série ${h.heatNumber}</div>
          </div>
          <table>
            <colgroup><col class="pos-col"><col class="id-col"></colgroup>
            <thead>
              <tr><th class="pos-col">Position</th><th class="id-col"># plage</th></tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `
    }).join('')
  }).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body>${pagesHtml}</body></html>`
}
