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
 *
 * Rows are a fixed, uniform size (up to MAX_ROWS_PER_PAGE per page) rather
 * than computed to stretch across the page — beach heats are capped at 16
 * entries app-wide (see HEAT_GENERATION_RULES.md), so a flat 16-row table
 * always has room, and a fixed size avoids depending on exactly how a given
 * print pipeline resolves relative page height (100vh and computed-to-fill
 * inline heights both proved unreliable against Electron's real print path).
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
const MAX_ROWS_PER_PAGE = 16
const ROW_HEIGHT_IN = 0.55

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Generate the HTML content for beach position entry sheets.
 * One full page per heat: a numbered position list (position pre-printed,
 * beach number blank), fixed-size rows, up to 16 rows per page.
 */
export function generatePositionSheetsHtml(events: PositionSheetEvent[]): string {
  const styles = `
    <style>
      @page { size: letter portrait; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; }
      .heat-page {
        page-break-after: always;
        break-after: page;
      }
      .heat-page:last-child { page-break-after: auto; break-after: auto; }
      .heat-title {
        font-weight: bold;
        font-size: 13pt;
        padding: 6pt 8pt;
        background: #e8e8e8;
        border: 1.5px solid #000;
        border-bottom: none;
      }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      col.pos-col { width: 35%; }
      col.id-col { width: 65%; }
      th {
        font-size: 10pt;
        padding: 4pt 8pt;
        background: #f4f4f4;
        border: 1.5px solid #000;
        text-align: left;
      }
      th.pos-col, td.pos-col { text-align: center; }
      td {
        border: 1px solid #999;
        padding: 2pt 8pt;
        height: ${ROW_HEIGHT_IN}in;
      }
      td.pos-col {
        font-family: monospace;
        font-size: 14pt;
        font-weight: bold;
        border-left: 1.5px solid #000;
        border-right: 1.5px solid #000;
      }
      td.id-box { background: #fafafa; }
      tr.late-row td.pos-col { color: #bbb; }
    </style>
  `

  const pagesHtml = events.map((ev) => {
    const eventTitle = `Épr. ${ev.eventNumber}: ${ev.genderLabel}, ${escHtml(ev.eventName)}`
    return ev.heats.map((h) => {
      const rowCount = Math.min(h.identifiers.length + EXTRA_ROWS, MAX_ROWS_PER_PAGE)

      const rows = Array.from({ length: rowCount }, (_, i) => {
        const late = i >= h.identifiers.length
        return `
          <tr${late ? ' class="late-row"' : ''}>
            <td class="pos-col">${i + 1}</td>
            <td class="id-box"></td>
          </tr>
        `
      }).join('')

      return `
        <div class="heat-page">
          <div class="heat-title">${eventTitle} — Série ${h.heatNumber}</div>
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
