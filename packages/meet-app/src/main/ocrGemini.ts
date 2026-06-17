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
import type { OcrEngine, OcrResult, CroppedDigit, TimeOcrResult } from './ocrEngine'

const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
]

function getGeminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
}

const PROMPT = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times in digit boxes labeled "Chrono 1" and "Chrono 2".
Each time is in the format M:SS.HH (1 digit for minutes, 2 for seconds, 2 for hundredths).
The separators : and . are pre-printed between the boxes.

Read the handwritten digits carefully and return ONLY the two times in this exact format:
C1:M:SS.HH
C2:M:SS.HH

For example:
C1:1:23.45
C2:1:24.02

If you cannot read a time clearly, write "unclear" for that line. Return nothing else.`

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
    if (!this.apiKey) throw new Error('Gemini API key not set')

    const base64 = imageBuffer.toString('base64')

    // Try models in order (fallback if rate limited)
    let lastError = ''
    for (const model of GEMINI_MODELS) {
      const url = getGeminiUrl(model, this.apiKey)

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPT },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: base64,
                },
              },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1000,
          },
        }),
      })

      if (response.status === 429) {
        // Rate limited — try switching to paid key
        const paidKey = switchToPaidKey()
        if (paidKey && paidKey !== this.apiKey) {
          this.apiKey = paidKey
          // Retry with paid key on same model
          const retryUrl = getGeminiUrl(model, paidKey)
          const retryResp = await fetch(retryUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: PROMPT },
                  { inline_data: { mime_type: 'image/jpeg', data: base64 } },
                ],
              }],
              generationConfig: { temperature: 0, maxOutputTokens: 1000 },
            }),
          })
          if (retryResp.ok) {
            const data = await retryResp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
            return { ...parseGeminiResponse(text), raw: text }
          }
        }
        lastError = `Rate limited on ${model}`
        continue
      }

      if (!response.ok) {
        const err = await response.text()
        lastError = `Gemini API error ${response.status}: ${err}`
        continue
      }

      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
      const parsed = parseGeminiResponse(text)
      return { ...parsed, raw: text }
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

/** Legacy: also check the old file-based config */
export function saveGeminiApiKey(apiKey: string): void {
  saveGeminiKeys(apiKey, cachedPaidKey)
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

// ── Response parsing ──────────────────────────────────────────────────────────

function parseGeminiResponse(text: string): { time1: string; time2: string; confidence: number } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  let time1 = ''
  let time2 = ''

  for (const line of lines) {
    const m1 = line.match(/^(?:C1|Chrono\s*1)\s*[:=]\s*(.+)$/i)
    if (m1) { time1 = m1[1].trim(); continue }
    const m2 = line.match(/^(?:C2|Chrono\s*2)\s*[:=]\s*(.+)$/i)
    if (m2) { time2 = m2[1].trim(); continue }
  }

  // Fallback: extract time patterns
  if (!time1 && !time2) {
    const timePattern = /(\d{1,2}:\d{2}\.\d{2})/g
    const matches = text.match(timePattern)
    if (matches && matches.length >= 1) time1 = matches[0]
    if (matches && matches.length >= 2) time2 = matches[1]
  }

  const confidence = (time1 && time1 !== 'unclear' && time2 && time2 !== 'unclear') ? 0.95 : 0.3
  return { time1, time2, confidence }
}