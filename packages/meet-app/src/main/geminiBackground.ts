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
 * Background Gemini OCR processing.
 *
 * Runs in the main process — processes unprocessed scans automatically
 * regardless of which page the user is on.
 * Can be enabled/disabled via IPC.
 */

import { getScansByStatus, updateScanOcrResult, updateScanIdentity, type TimingScan } from './timingScanDb'
import { GeminiOcrEngine, GeminiBusyError, loadGeminiApiKey } from './ocrGemini'
import { isBlankScan, findBlankSheetCandidates, pickBlankSheetTarget } from './blankTimingSheet'
import { getLocalDb } from './db'

/**
 * Run Gemini on one scan and store the result. Barcoded strips: both times.
 * Blank strips: also the handwritten event/heat/lane, resolved to the entry
 * seeded there (swimEventId stays 0 when unreadable or ambiguous — the
 * operator settles it in the Traitement tab).
 */
export async function recognizeScan(engine: GeminiOcrEngine, scan: TimingScan): Promise<{
  time1: string; time2: string; confidence: number
}> {
  if (!isBlankScan(scan.barcodeRaw)) {
    const result = await engine.recognizeFullImage(scan.imageBlob)
    updateScanOcrResult(scan.scanId, {
      recognizedTime1: result.time1 || '',
      recognizedTime2: result.time2 || '',
      ocrEngine: 'gemini',
      ocrConfidence: result.confidence,
    })
    return result
  }

  const reading = await engine.recognizeBlankSheet(scan.imageBlob)
  let swimEventId = 0
  try {
    const target = pickBlankSheetTarget(
      findBlankSheetCandidates(getLocalDb(), reading.eventNumber, reading.heatNumber, reading.lane),
    )
    if (target) swimEventId = target.swimEventId
  } catch { /* meet DB not available — operator resolves */ }
  updateScanIdentity(scan.scanId, {
    eventNumber: reading.eventNumber,
    swimEventId,
    heatNumber: reading.heatNumber,
    lane: reading.lane,
  })
  updateScanOcrResult(scan.scanId, {
    recognizedTime1: reading.time1 || '',
    recognizedTime2: reading.time2 || '',
    ocrEngine: 'gemini',
    ocrConfidence: swimEventId ? reading.confidence : Math.min(reading.confidence, 0.3),
  })
  return reading
}

let enabled = true
let running = false
let engine: GeminiOcrEngine | null = null
const attemptedIds = new Set<number>()

/** Start the background processing loop */
export function startGeminiBackground(): void {
  if (running) return
  running = true
  processLoop()
}

/** Enable/disable background processing */
export function setGeminiBackgroundEnabled(value: boolean): void {
  enabled = value
  if (value && !running) {
    running = true
    processLoop()
  }
}

export function isGeminiBackgroundEnabled(): boolean {
  return enabled
}

/** Reset attempted list (e.g. when scans are cleared) */
export function resetGeminiAttempted(): void {
  attemptedIds.clear()
}

async function processLoop(): Promise<void> {
  while (running) {
    if (!enabled) {
      await sleep(1000)
      continue
    }

    // Check if API key is configured
    const apiKey = loadGeminiApiKey()
    if (!apiKey) {
      await sleep(5000)
      continue
    }

    // Find next unprocessed scan
    const unprocessed = getScansByStatus('unprocessed')
    const next = unprocessed.find((s) => !attemptedIds.has(s.scanId))

    if (!next) {
      // Nothing to process, wait and check again
      await sleep(2000)
      continue
    }

    attemptedIds.add(next.scanId)

    try {
      // Initialize engine if needed
      if (!engine) {
        engine = new GeminiOcrEngine()
        await engine.initialize()
      }

      await recognizeScan(engine, next)
    } catch (e) {
      if (e instanceof GeminiBusyError) {
        // Every model/key is rate limited right now: leave the scan queued and try again soon
        // (the quota recovers) instead of giving up on it with empty times.
        attemptedIds.delete(next.scanId)
        await sleep(5000)
        continue
      }
      // Mark as recognized with empty times so we don't retry
      updateScanOcrResult(next.scanId, {
        recognizedTime1: '',
        recognizedTime2: '',
        ocrEngine: 'gemini',
        ocrConfidence: 0,
      })
    }

    // Small delay between requests to respect rate limits
    await sleep(1000)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
