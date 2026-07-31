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
 * Timing sheet barcode encoding/decoding.
 *
 * Format: E{eventNumber}-U{swimEventId}-H{heatNumber}-L{lane}
 * Example: "E5-U1496-H2-L3" → Event 5, Heat 2, Lane 3
 *
 * `eventNumber` is the human-facing event number shown on programs and can be
 * shared between a prelim and its final (Splash convention). `swimEventId` is
 * the internal swimevent primary key, which is always unique — it's what
 * matching/lookups use so a prelim and its final heat 1 lane 3 can never be
 * confused with each other even though they show the same event number.
 *
 * Each strip has both chronos' time entries, so no judge identifier needed.
 */

export interface BarcodeData {
  eventNumber: number
  swimEventId: number
  heatNumber: number
  lane: number
}

/**
 * Encode timing sheet identity into a barcode string.
 */
export function encodeBarcode(
  eventNumber: number,
  swimEventId: number,
  heatNumber: number,
  lane: number,
  _judgeNumber?: number // kept for API compat, ignored
): string {
  if (eventNumber < 1) throw new Error(`Invalid eventNumber: ${eventNumber}`)
  if (swimEventId < 1) throw new Error(`Invalid swimEventId: ${swimEventId}`)
  if (heatNumber < 1) throw new Error(`Invalid heatNumber: ${heatNumber}`)
  if (lane < 1) throw new Error(`Invalid lane: ${lane}`)
  return `E${eventNumber}-U${swimEventId}-H${heatNumber}-L${lane}`
}

/**
 * Decode a barcode string back into its components.
 * Returns null if the string doesn't match the expected format.
 */
export function decodeBarcode(raw: string): BarcodeData | null {
  const match = raw.match(/^E(\d+)-U(\d+)-H(\d+)-L(\d+)$/)
  if (!match) return null
  const [, eventStr, swimEventIdStr, heatStr, laneStr] = match
  return {
    eventNumber: parseInt(eventStr, 10),
    swimEventId: parseInt(swimEventIdStr, 10),
    heatNumber: parseInt(heatStr, 10),
    lane: parseInt(laneStr, 10),
  }
}