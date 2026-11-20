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
 * OCR engine using Google Gemini 2.0 Flash vision API.
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

const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
]

function getGeminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
}

export class GeminiOcrEngine implements OcrEngine {
  readonly name = 'gemini' as const
  private apiKey: string = ''

  async initialize(): Promise<void> {
    this.apiKey = loadGeminiApiKey()
    if (!this.apiKey) {
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

  /** Send prompt + JPEG to Gemini (model fallback, free → paid key on 429). */
  private async generate(prompt: string, imageBuffer: Buffer): Promise<string> {
    if (!this.apiKey) throw new Error('Gemini API key not set')

    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 1000 },
    })
    const post = (model: string, key: string) => fetch(getGeminiUrl(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const textOf = async (resp: Response): Promise<string> => {
      const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
    }

    // Try models in order (fallback if rate limited)
    let lastError = ''
    for (const model of GEMINI_MODELS) {
      const response = await post(model, this.apiKey)

      if (response.status === 429) {
        // Rate limited — try switching to paid key, retry same model
        const paidKey = switchToPaidKey()
        if (paidKey && paidKey !== this.apiKey) {
          this.apiKey = paidKey
          const retryResp = await post(model, paidKey)
          if (retryResp.ok) return textOf(retryResp)
        }
        lastError = `Rate limited on ${model}`
        continue
      }

      if (!response.ok) {
        lastError = `Gemini API error ${response.status}: ${await response.text()}`
        continue
      }

      return textOf(response)
    }

    throw new Error(lastError || 'All Gemini models failed')
  }

  async dispose(): Promise<void> {
    // Nothing to clean up
  }
}

// ── API Key management ────────────────────────────────────────────────────────
// Keys are stored in the BSGLOBAL table of the local meet database.
// Two keys: free tier (GEMINI_KEY_FREE) and paid tier (GEMINI_KEY_PAID).
// The engine uses the free key first, falls back to paid on rate limit,
// then returns to free after 60 seconds.

import { getLocalDb } from './db'

let cachedFreeKey = ''
let cachedPaidKey = ''
let usingPaidSince: number | null = null // timestamp when we switched to paid

const CONFIG_FILE = 'gemini-config.json'

export function loadGeminiApiKey(): string {
  // Return the appropriate key based on rate limit state
  refreshKeysFromDb()

  // If we switched to paid less than 60s ago, keep using paid
  if (usingPaidSince && Date.now() - usingPaidSince < 60000) {
    return cachedPaidKey || cachedFreeKey
  }

  // Reset to free tier
  usingPaidSince = null
  return cachedFreeKey || cachedPaidKey
}

/** Called when free tier is rate-limited — switch to paid */
export function switchToPaidKey(): string {
  if (cachedPaidKey) {
    usingPaidSince = Date.now()
    return cachedPaidKey
  }
  return ''
}

/** Get the current tier being used */
export function getCurrentGeminiTier(): 'free' | 'paid' | 'none' {
  refreshKeysFromDb()
  if (!cachedFreeKey && !cachedPaidKey) return 'none'
  if (usingPaidSince && Date.now() - usingPaidSince < 60000) return 'paid'
  return 'free'
}

export function loadGeminiKeys(): { freeKey: string; paidKey: string } {
  refreshKeysFromDb()
  return { freeKey: cachedFreeKey, paidKey: cachedPaidKey }
}

export function saveGeminiKeys(freeKey: string, paidKey: string): void {
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
