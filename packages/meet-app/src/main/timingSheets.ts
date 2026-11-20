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
 * Timing sheet PDF generator.
 *
 * Produces printable sheets in PORTRAIT with 3 lane strips per page
 * (plus blank, hand-identified strips — see generateBlankTimingSheetsHtml).
 * Each strip includes:
 * - Code128B barcode (rendered as inline SVG)
 * - Event info (name, heat, lane, athlete)
 * - TWO rows of underlined M : SS . HH fields (Chrono 1 and Chrono 2)
 * - Corner registration marks for perspective correction during scanning
 *
 * Each strip has BOTH judges' time entry on the same slip, so we only
 * need one sheet per lane (not one per judge).
 */

import { encodeBarcode } from './timingBarcode'

export interface TimingSheetLane {
  eventNumber: number
  swimEventId: number
  eventName: string
  heatNumber: number
  lane: number
  athleteName?: string
  clubCode?: string
}

export interface TimingSheetPage {
  strips: TimingSheetLane[] // 1-3 strips per page
}

/**
 * Generate all timing sheet pages for a given heat.
 * Groups lanes into pages of 3 strips each.
 * Each strip has both judges' time fields (no separate judge sheets needed).
 */
export function buildTimingSheetPages(
  swimEventId: number,
  eventNumber: number,
  eventName: string,
  heatNumber: number,
  lanes: number[],
  _judgeNumber?: number, // kept for API compat but ignored — both judges on same strip
  athleteNames?: Map<number, string>,
  clubCodes?: Map<number, string>
): TimingSheetPage[] {
  const pages: TimingSheetPage[] = []
  for (let i = 0; i < lanes.length; i += 3) {
    const chunk = lanes.slice(i, i + 3)
    const strips: TimingSheetLane[] = chunk.map((lane) => ({
      eventNumber,
      swimEventId,
      eventName,
      heatNumber,
      lane,
      athleteName: athleteNames?.get(lane),
      clubCode: clubCodes?.get(lane),
    }))
    pages.push({ strips })
  }
  return pages
}

// ── HTML-based PDF generation ─────────────────────────────────────────────────

const SHEET_STYLES = `
    <style>
      @page { margin: 0; size: letter portrait; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; }
      .page {
        width: 8.5in; height: 11in;
        page-break-after: always;
        padding: 0.3in 0.4in;
        display: flex; flex-direction: column;
        justify-content: flex-start;
        gap: 0.15in;
      }
      .page:last-child { page-break-after: avoid; }
      .strip {
        border: 1.5px solid #000;
        padding: 0.15in 0.25in;
        position: relative;
        height: 3.2in;
        display: flex; flex-direction: column;
        justify-content: space-between;
      }
      .cut-line {
        border-top: 1px dashed #aaa;
        margin: 0.05in 0;
        position: relative;
      }
      .cut-line::after {
        content: '✂';
        position: absolute;
        left: -0.15in;
        top: -0.4em;
        font-size: 10pt;
        color: #aaa;
      }
      .strip-header {
        margin-bottom: 0.05in;
      }
      .strip-info { font-size: 10pt; }
      .strip-info .event-name { font-weight: bold; font-size: 12pt; }
      .strip-info .details { color: #222; margin-top: 3pt; font-size: 10pt; }
      .strip-info .athlete { color: #444; font-weight: 500; margin-top: 2pt; font-size: 10pt; }
      .barcode-area { text-align: center; margin-top: 0.1in; }
      /* 48pt (was 60pt): with the athlete line, 60pt pushed the M/S/H digit labels
         out below the strip border. Code128 reads by bar width, height is ample. */
      .barcode-area svg { height: 48pt; width: 100%; }
      .barcode-text { font-family: monospace; font-size: 11pt; color: #000; margin-top: 3pt; text-align: center; font-weight: bold; letter-spacing: 2pt; }
      .judges-section { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 0.1in; }
      .judge-row { display: flex; align-items: flex-end; gap: 0.1in; }
      .judge-label { font-size: 9pt; font-weight: bold; width: 0.55in; text-align: right; color: #333; padding-bottom: 3pt; }
      /* Times: one underline per group (M : SS . HH) — free handwriting, but the
         printed separators still tell the reader which digits are which. */
      .digit-row { display: flex; align-items: flex-end; gap: 4pt; }
      .time-line { height: 0.48in; border-bottom: 2px solid #000; }
      .time-m { width: 0.5in; }
      .time-ss, .time-hh { width: 0.85in; }
      .separator { font-size: 20pt; font-weight: bold; width: 0.14in; text-align: center; line-height: 1; padding-bottom: 1pt; }      .digit-labels { display: flex; gap: 4pt; margin-left: 0.65in; margin-top: 1pt; }
      .digit-labels span { text-align: center; font-size: 7pt; color: #999; }
      .digit-labels .sep-space { width: 0.14in; }
      .reg-mark { position: absolute; width: 6pt; height: 6pt; background: #000; }
      .reg-tl { top: 3pt; left: 3pt; }
      .reg-tr { top: 3pt; right: 3pt; }
      .reg-bl { bottom: 3pt; left: 3pt; }
      .reg-br { bottom: 3pt; right: 3pt; }
      /* Blank strip: hand-written identity on underlines */
      .blank-tag { position: absolute; top: 0.1in; right: 0.3in; font-size: 8pt; font-weight: bold; letter-spacing: 1pt; color: #555; }
      .id-row { display: flex; align-items: flex-end; gap: 0.3in; margin-top: 0.1in; }
      .id-field { display: flex; align-items: flex-end; gap: 6pt; }
      .id-label { font-size: 12pt; font-weight: bold; }
      .id-line { width: 1.1in; height: 0.45in; border-bottom: 2px solid #000; }
      .name-row { display: flex; align-items: flex-end; gap: 6pt; margin-top: 0.12in; }
      .name-label { font-size: 9pt; color: #444; white-space: nowrap; }
      .name-line { flex: 1; height: 0.3in; border-bottom: 1px solid #666; }
    </style>
`

/** One chrono row: M : SS . HH on underlines. */
const chronoRowHtml = (label: string): string => `
  <div class="judge-row">
    <div class="judge-label">${label}</div>
    <div class="digit-row">
      <div class="time-line time-m"></div>
      <div class="separator">:</div>
      <div class="time-line time-ss"></div>
      <div class="separator">.</div>
      <div class="time-line time-hh"></div>
    </div>
  </div>`

/** Chrono 1 / Chrono 2 rows (M:SS.HH) — shared by barcoded and blank strips. */
const CHRONO_ROWS_HTML = `
<div class="judges-section">
  ${chronoRowHtml('Chrono 1')}
  ${chronoRowHtml('Chrono 2')}
  <div class="digit-labels">
    <span class="time-m">min</span>
    <span class="sep-space"></span>
    <span class="time-ss">sec</span>
    <span class="sep-space"></span>
    <span class="time-hh">1/100</span>
  </div>
</div>
`

/**
 * Generate the HTML content for timing sheets (portrait, 3 strips/page).
 * Each strip has two judge time-entry rows.
 */
export function generateTimingSheetsHtml(pages: TimingSheetPage[]): string {
  const pagesHtml = pages.map((page) => {
    const stripsHtml = page.strips.map((strip) => {
      // Barcode encodes lane with judge=1 (the strip covers both judges, barcode identifies the lane)
      const barcodeValue = encodeBarcode(strip.eventNumber, strip.swimEventId, strip.heatNumber, strip.lane, 1)
      const barcodeSvg = generateCode128Svg(barcodeValue)
      return `
        <div class="strip">
          <div class="reg-mark reg-tl"></div>
          <div class="reg-mark reg-tr"></div>
          <div class="reg-mark reg-bl"></div>
          <div class="reg-mark reg-br"></div>
          <div class="strip-header">
            <div class="strip-info">
              <div class="event-name">Épr. ${strip.eventNumber}: ${escHtml(strip.eventName)}</div>
              <div class="details">Série ${strip.heatNumber} &nbsp;|&nbsp; Couloir ${strip.lane}</div>
              ${strip.athleteName ? `<div class="athlete">${escHtml(strip.athleteName)}${strip.clubCode ? ` <span style="color:#666">(${escHtml(strip.clubCode)})</span>` : ''}</div>` : ''}
            </div>
          </div>
          <div class="barcode-area">
            ${barcodeSvg}
            <div class="barcode-text">${barcodeValue}</div>
          </div>
          ${CHRONO_ROWS_HTML}
        </div>
      `
    }).join('<div class="cut-line"></div>')

    return `<div class="page">${stripsHtml}</div>`
  }).join('')

  return wrapSheetsHtml(pagesHtml)
}

/**
 * Blank timing sheets (late arrivals / missing sheets): same strip as above,
 * but no barcode — Épreuve / Série / Couloir are hand-written on underlines,
 * and Gemini reads them back along with the times (BLANK_SHEET_PROMPT).
 */
export function generateBlankTimingSheetsHtml(pageCount = 1): string {
  const pages = Math.max(1, Math.min(50, Math.floor(pageCount) || 1))
  const strip = `
        <div class="strip">
          <div class="reg-mark reg-tl"></div>
          <div class="reg-mark reg-tr"></div>
          <div class="reg-mark reg-bl"></div>
          <div class="reg-mark reg-br"></div>
          <div class="blank-tag">FICHE VIERGE</div>
          <div class="id-row">
            <div class="id-field"><span class="id-label">Épreuve</span><span class="id-line"></span></div>
            <div class="id-field"><span class="id-label">Série</span><span class="id-line"></span></div>
            <div class="id-field"><span class="id-label">Couloir</span><span class="id-line"></span></div>
          </div>
          <div class="name-row"><span class="name-label">Nageur / équipe (club)</span><span class="name-line"></span></div>
          ${CHRONO_ROWS_HTML}
        </div>
      `
  const pageHtml = `<div class="page">${[strip, strip, strip].join('<div class="cut-line"></div>')}</div>`
  return wrapSheetsHtml(pageHtml.repeat(pages))
}

function wrapSheetsHtml(pagesHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${SHEET_STYLES}</head><body>${pagesHtml}</body></html>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Code128B barcode SVG generator ────────────────────────────────────────────

/**
 * Code128B encoding table.
 * Each entry is a pattern of bar/space widths (6 elements for data, 7 for stop).
 */
const CODE128B_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', // 0-4
  '131222', '122213', '122312', '132212', '221213', // 5-9
  '221312', '231212', '112232', '122132', '122231', // 10-14
  '113222', '123122', '123221', '223211', '221132', // 15-19
  '221231', '213212', '223112', '312131', '311222', // 20-24
  '321122', '321221', '312212', '322112', '322211', // 25-29
  '212123', '212321', '232121', '111323', '131123', // 30-34
  '131321', '112313', '132113', '132311', '211313', // 35-39
  '231113', '231311', '112133', '112331', '132131', // 40-44
  '113123', '113321', '133121', '313121', '211331', // 45-49
  '231131', '213113', '213311', '213131', '311123', // 50-54
  '311321', '331121', '312113', '312311', '332111', // 55-59
  '314111', '221411', '431111', '111224', '111422', // 60-64
  '121124', '121421', '141122', '141221', '112214', // 65-69
  '112412', '122114', '122411', '142112', '142211', // 70-74
  '241211', '221114', '413111', '241112', '134111', // 75-79
  '111242', '121142', '121241', '114212', '124112', // 80-84
  '124211', '411212', '421112', '421211', '212141', // 85-89
  '214121', '412121', '111143', '111341', '131141', // 90-94
  '114113', '114311', '411113', '411311', '113141', // 95-99
  '114131', '311141', '411131', '211412', '211214', // 100-104
  '211232',                                          // 105 (Start Code B)
  '2331112',                                         // 106 (Stop)
]

const START_B = 104
const STOP = 106

/**
 * Generate an inline SVG string for a Code128B barcode.
 */
function generateCode128Svg(text: string): string {
  // Encode to Code128B values
  const values: number[] = [START_B]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 32
    if (code < 0 || code > 95) continue
    values.push(code)
  }

  // Calculate checksum
  let checksum = values[0]
  for (let i = 1; i < values.length; i++) {
    checksum += values[i] * i
  }
  checksum = checksum % 103
  values.push(checksum)
  values.push(STOP)

  // Convert to bar widths
  const bars: number[] = []
  for (const val of values) {
    const pattern = CODE128B_PATTERNS[val]
    for (const ch of pattern) {
      bars.push(parseInt(ch, 10))
    }
  }

  // Calculate total width in modules
  const totalModules = bars.reduce((sum, w) => sum + w, 0)
  const quietZone = 10
  const fullWidth = totalModules + quietZone * 2

  // Generate SVG
  const height = 50
  let x = quietZone
  let isBar = true
  const rects: string[] = []

  for (const width of bars) {
    if (isBar) {
      rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#000"/>`)
    }
    x += width
    isBar = !isBar
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullWidth} ${height}" preserveAspectRatio="none">${rects.join('')}</svg>`
}