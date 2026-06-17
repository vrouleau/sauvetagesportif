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

import { getScansByStatus, getScanById, updateScanOcrResult, type ScanStatus } from './timingScanDb'
import { GeminiOcrEngine, loadGeminiApiKey } from './ocrGemini'

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

/** Stop the background processing */
export function stopGeminiBackground(): void {
  running = false
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

      const result = await engine.recognizeFullImage(next.imageBlob)

      updateScanOcrResult(next.scanId, {
        recognizedTime1: result.time1 || '',
        recognizedTime2: result.time2 || '',
        ocrEngine: 'gemini',
        ocrConfidence: result.confidence,
      })
    } catch {
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