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
 * OCR engine using the Google Gemini vision API (models + key order: see ocrFallback.ts).
 *
 * Get your API key at: https://aistudio.google.com/apikey
 * (Sign in with your Google account, click "Create API Key")
 *
 * The key is stored in the app's local config (userData).
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { OcrEngine } from './ocrEngine'
import {
  CHRONO_PROMPT, BLANK_SHEET_PROMPT, parseChronoTimes, parseBlankSheetResponse,
  type BlankSheetReading,
} from './blankTimingSheet'

/** Single digit OCR result */
interface OcrResult { text: string; confidence: number }

/** Cropped digit image data */
interface CroppedDigit { imageBuffer: Buffer; position: number }

/** Full time OCR result */
interface TimeOcrResult { timeString: string; digitResults: OcrResult[]; overallConfidence: number }

import { AttemptChain, parseRateLimit, type KeyTier } from './ocrFallback'

/** Thrown when no model/key could be tried or all were rate limited: the scan should be retried later, not given up on. */
export class GeminiBusyError extends Error {
  constructor(message: string) { super(message); this.name = 'GeminiBusyError' }
}

const REQUEST_TIMEOUT_MS = 30_000

/** Shared by every engine instance so cooldowns / per-minute counts survive engine re-creation. */
const attemptChain = new AttemptChain()
let lastUsedTier: KeyTier = 'free'

function getGeminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
}

export class GeminiOcrEngine implements OcrEngine {
  readonly name = 'gemini' as const
  async initialize(): Promise<void> {
    if (!loadGeminiApiKey()) {
      throw new Error(
        'Gemini API key not configured. ' +
        'Get your key at https://aistudio.google.com/apikey then set it in the app settings.'
      )
    }
  }

  async recognizeDigit(_imageBuffer: Buffer): Promise<OcrResult> {
    return { text: '0', confidence: 0 }
  }

  async recognizeTime(_digits: CroppedDigit[]): Promise<TimeOcrResult> {
    return { timeString: '', digitResults: [], overallConfidence: 0 }
  }

  /**
   * Recognize both chrono times from a full strip image via Gemini vision.
   */
  async recognizeFullImage(imageBuffer: Buffer): Promise<{
    time1: string
    time2: string
    confidence: number
    raw: string
  }> {
    const text = await this.generate(CHRONO_PROMPT, imageBuffer)
    return { ...parseChronoTimes(text), raw: text }
  }

  /**
   * Read a hand-filled blank strip: event / heat / lane plus both chrono times.
   */
  async recognizeBlankSheet(imageBuffer: Buffer): Promise<BlankSheetReading & { raw: string }> {
    const text = await this.generate(BLANK_SHEET_PROMPT, imageBuffer)
    return { ...parseBlankSheetResponse(text), raw: text }
  }

  /**
   * Send prompt + JPEG to Gemini, trying the attempts of `ocrFallback.ts` in order
   * (3.5 Flash-Lite free -> 2.5 Flash-Lite free -> 2.5 Flash-Lite paid).
   * Throws GeminiBusyError when nothing could be tried / everything was rate limited.
   */
  private async generate(prompt: string, imageBuffer: Buffer): Promise<string> {
    const keys = loadGeminiKeys()
    if (!keys.freeKey && !keys.paidKey) throw new Error('Gemini API key not set')
    const keyFor = (tier: KeyTier) => (tier === 'free' ? keys.freeKey : keys.paidKey)

    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1000 },
    })

    let lastError = ''
    let rateLimited = false
    for (const attempt of attemptChain.available(Date.now(), (t) => !!keyFor(t))) {
      const label = `${attempt.model} (${attempt.tier})`
      attemptChain.noteRequest(attempt, Date.now())

      let resp: Response
      try {
        resp = await fetch(getGeminiUrl(attempt.model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyFor(attempt.tier) },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (e) {
        attemptChain.noteTransientFailure(attempt, Date.now())
        lastError = `${label}: ${e instanceof Error ? e.message : String(e)}`
        continue
      }

      if (resp.status === 429) {
        attemptChain.noteRateLimited(attempt, Date.now(), parseRateLimit(await resp.text().catch(() => '')))
        rateLimited = true
        lastError = `Rate limited on ${label}`
        continue
      }
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200)
        // 404/403: model id wrong/retired or not allowed for this key -> back off for a while.
        // 400 (bad image / bad key) is not model-specific: no cooldown, just try the next attempt.
        if (resp.status === 404 || resp.status === 403) attemptChain.noteUnavailable(attempt, Date.now())
        else if (resp.status >= 500) attemptChain.noteTransientFailure(attempt, Date.now())
        lastError = `Gemini API error ${resp.status} on ${label}: ${detail}`
        continue
      }

      const data = await resp.json().catch(() => null) as
        { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
      if (!text) { // blocked / empty answer: try the next model instead of returning nothing
        lastError = `Empty answer from ${label}`
        continue
      }
      attemptChain.noteSuccess(attempt)
      lastUsedTier = attempt.tier
      return text
    }

    // Nothing usable right now (all cooling down / over their per-minute quota) or all failed.
    if (rateLimited || !lastError) {
      throw new GeminiBusyError(lastError || 'Gemini: every model/key is rate limited right now')
    }
    throw new Error(lastError)
  }

  async dispose(): Promise<void> {
    // Nothing to clean up
  }
}

// ── API Key management ────────────────────────────────────────────────────────
// Keys are stored in the BSGLOBAL table of the local meet database.
// Two keys: free tier (GEMINI_KEY_FREE) and paid tier (GEMINI_KEY_PAID).
// Which model/key is tried first, and when to move on, lives in ocrFallback.ts.

import { getLocalDb } from './db'

let cachedFreeKey = ''
let cachedPaidKey = ''

const CONFIG_FILE = 'gemini-config.json'

/** Any configured key (used to check that OCR can run at all). */
export function loadGeminiApiKey(): string {
  refreshKeysFromDb()
  return cachedFreeKey || cachedPaidKey
}

/** The key tier that answered the last request (for the UI indicator). */
export function getCurrentGeminiTier(): 'free' | 'paid' | 'none' {
  refreshKeysFromDb()
  if (!cachedFreeKey && !cachedPaidKey) return 'none'
  if (lastUsedTier === 'paid' && cachedPaidKey) return 'paid'
  return cachedFreeKey ? 'free' : 'paid'
}

export function loadGeminiKeys(): { freeKey: string; paidKey: string } {
  refreshKeysFromDb()
  return { freeKey: cachedFreeKey, paidKey: cachedPaidKey }
}

export function saveGeminiKeys(freeKey: string, paidKey: string): void {
  attemptChain.reset() // new keys: forget rate-limit cooldowns
  try {
    const db = getLocalDb()
    if (freeKey !== undefined) {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('GEMINI_KEY_FREE', ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data`).run(freeKey)
    }
    if (paidKey !== undefined) {
      db.prepare(`INSERT INTO bsglobal (name, data) VALUES ('GEMINI_KEY_PAID', ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data`).run(paidKey)
    }
    cachedFreeKey = freeKey
    cachedPaidKey = paidKey
  } catch {
    // DB not ready yet — fall back to file
    const configPath = join(app.getPath('userData'), CONFIG_FILE)
    writeFileSync(configPath, JSON.stringify({ freeKey, paidKey }, null, 2), 'utf-8')
    cachedFreeKey = freeKey
    cachedPaidKey = paidKey
  }
}

function refreshKeysFromDb(): void {
  try {
    const db = getLocalDb()
    const freeRow = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_FREE'`).get() as { data: string } | undefined
    const paidRow = db.prepare(`SELECT data FROM bsglobal WHERE name = 'GEMINI_KEY_PAID'`).get() as { data: string } | undefined
    cachedFreeKey = freeRow?.data || ''
    cachedPaidKey = paidRow?.data || ''
  } catch {
    // DB not available — try file fallback
    try {
      const configPath = join(app.getPath('userData'), CONFIG_FILE)
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        cachedFreeKey = config.freeKey || config.apiKey || ''
        cachedPaidKey = config.paidKey || ''
      }
    } catch { /* no keys available */ }
  }
}
