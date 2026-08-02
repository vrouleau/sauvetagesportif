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
 * finish and write down the FINISH POSITION next to each athlete's beach
 * number on paper (writing a 1-2 digit position is quicker than writing a
 * beach number), then transcribe into the laptop afterward.
 *
 * One 2-column table (beach # | position box) per heat: rows are the beach
 * numbers already assigned to that heat, pre-printed, plus a few extra blank
 * rows for late arrivals slotted into that heat.
 */

export interface PositionSheetHeat {
  heatNumber: number
  identifiers: string[] // pre-printed beach numbers/teams, one per row, in display order
}

export interface PositionSheetEvent {
  eventNumber: number
  eventName: string
  genderLabel: string
  heats: PositionSheetHeat[]
}

const EXTRA_ROWS = 4

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Generate the HTML content for beach position entry sheets.
 * One 2-column (beach # | position) card per heat; cards flow in CSS
 * columns to pack as many as fit per page.
 */
export function generatePositionSheetsHtml(events: PositionSheetEvent[]): string {
  const styles = `
    <style>
      @page { margin: 0.35in; size: letter portrait; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; }
      .sheet { column-width: 2.35in; column-gap: 0.2in; }
      .heat-card {
        border: 1.5px solid #000;
        margin-bottom: 0.15in;
        break-inside: avoid;
        -webkit-column-break-inside: avoid;
        display: inline-block;
        width: 100%;
      }
      .heat-title {
        font-weight: bold;
        font-size: 9.5pt;
        padding: 3pt 5pt;
        background: #e8e8e8;
        border-bottom: 1.5px solid #000;
      }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      col.id-col { width: 58%; }
      col.pos-col { width: 42%; }
      th {
        font-size: 7.5pt;
        padding: 2pt 4pt;
        background: #f4f4f4;
        border-bottom: 1px solid #000;
        text-align: left;
      }
      th.pos-col, td.pos-col { border-left: 1px solid #000; text-align: center; }
      td {
        border-bottom: 1px solid #999;
        padding: 1pt 4pt;
        font-family: monospace;
        font-size: 9.5pt;
        font-weight: bold;
        word-break: break-all;
        height: 0.26in;
      }
      td.pos-box { background: #fafafa; }
      tr.late-row td { color: #bbb; font-weight: normal; }
    </style>
  `

  const cardsHtml = events.map((ev) => {
    const title = `Épr. ${ev.eventNumber}: ${ev.genderLabel}, ${escHtml(ev.eventName)}`
    return ev.heats.map((h) => {
      const idRows = h.identifiers.map((id) => `
        <tr>
          <td class="id-col">${escHtml(id)}</td>
          <td class="pos-col pos-box"></td>
        </tr>
      `).join('')

      const lateRows = Array.from({ length: EXTRA_ROWS }, () => `
        <tr class="late-row">
          <td class="id-col"></td>
          <td class="pos-col pos-box"></td>
        </tr>
      `).join('')

      return `
        <div class="heat-card">
          <div class="heat-title">${title} — Série ${h.heatNumber}</div>
          <table>
            <colgroup><col class="id-col"><col class="pos-col"></colgroup>
            <thead>
              <tr><th class="id-col"># plage</th><th class="pos-col">Position</th></tr>
            </thead>
            <tbody>
              ${idRows}
              ${lateRows}
            </tbody>
          </table>
        </div>
      `
    }).join('')
  }).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body><div class="sheet">${cardsHtml}</div></body></html>`
}
