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
 * Which Gemini model + API key to try, in what order, for timing-sheet OCR.
 *
 * Order (cheapest first; the free tier is generous on the newest Flash-Lite and tiny on 2.5):
 *   1. gemini-3.5-flash-lite  on the FREE key
 *   2. gemini-2.5-flash-lite  on the FREE key
 *   3. gemini-2.5-flash-lite  on the PAID key
 *
 * An attempt is skipped (no wasted request) while it is in cooldown after a 429 / failure,
 * or when it has already used up its known requests-per-minute in the last 60 s.
 * Pure (no electron, no network) so it can be unit tested.
 */

export type KeyTier = 'free' | 'paid'

export interface Attempt {
  model: string
  tier: KeyTier
  /** Known requests/minute of this model on this tier (free-tier limits seen in AI Studio); none = unlimited. */
  rpm?: number
}

/** Verify the model IDs against ai.google.dev/gemini-api/docs/models; a wrong ID 404s and is skipped. */
export const DEFAULT_ATTEMPTS: Attempt[] = [
  { model: 'gemini-3.5-flash-lite', tier: 'free', rpm: 15 },
  { model: 'gemini-2.5-flash-lite', tier: 'free', rpm: 10 },
  { model: 'gemini-2.5-flash-lite', tier: 'paid' },
]

export const MINUTE_COOLDOWN_MS = 60_000
/** Daily quota exhausted: recheck every 30 min (it resets around midnight Pacific time). */
export const DAILY_COOLDOWN_MS = 30 * 60_000
/** Model not found / not allowed: probably a wrong or retired ID, so back off for a long time. */
export const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000
/** Transient server / network error. */
export const TRANSIENT_COOLDOWN_MS = 15_000

export interface RateLimitInfo {
  /** The per-DAY quota is exhausted (not just per-minute). */
  daily: boolean
  retryAfterMs?: number
}

/** Pull "per day" and the suggested retry delay out of a Gemini 429 response body. */
export function parseRateLimit(bodyText: string): RateLimitInfo {
  const daily = /PerDay/i.test(bodyText) || /per\s*day/i.test(bodyText)
  const m = bodyText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  return { daily, retryAfterMs: m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined }
}

const idOf = (a: Attempt) => `${a.model}|${a.tier}`

export class AttemptChain {
  private attempts: Attempt[]
  private margin: number
  private recent = new Map<string, number[]>()
  private blockedUntil = new Map<string, number>()

  /** `rpmMargin`: stay this many requests under a known rpm (clock/limit slack). */
  constructor(attempts: Attempt[] = DEFAULT_ATTEMPTS, rpmMargin = 1) {
    this.attempts = attempts
    this.margin = rpmMargin
  }

  /** Attempts worth trying right now, in priority order. */
  available(now: number, hasKey: (tier: KeyTier) => boolean): Attempt[] {
    return this.attempts.filter((a) => {
      if (!hasKey(a.tier)) return false
      if ((this.blockedUntil.get(idOf(a)) ?? 0) > now) return false
      if (a.rpm !== undefined) {
        const used = (this.recent.get(idOf(a)) ?? []).filter((t) => now - t < 60_000).length
        if (used >= Math.max(1, a.rpm - this.margin)) return false
      }
      return true
    })
  }

  /** Call right before sending a request with this attempt. */
  noteRequest(a: Attempt, now: number): void {
    const id = idOf(a)
    const list = (this.recent.get(id) ?? []).filter((t) => now - t < 60_000)
    list.push(now)
    this.recent.set(id, list)
  }

  noteRateLimited(a: Attempt, now: number, info: RateLimitInfo): void {
    const wait = info.daily ? DAILY_COOLDOWN_MS : Math.max(info.retryAfterMs ?? 0, MINUTE_COOLDOWN_MS)
    this.blockedUntil.set(idOf(a), now + wait)
  }

  /** Not found / forbidden / bad model id. */
  noteUnavailable(a: Attempt, now: number): void {
    this.blockedUntil.set(idOf(a), now + UNAVAILABLE_COOLDOWN_MS)
  }

  /** 5xx, timeout, network error. */
  noteTransientFailure(a: Attempt, now: number): void {
    this.blockedUntil.set(idOf(a), now + TRANSIENT_COOLDOWN_MS)
  }

  /** A successful answer lifts any cooldown on this attempt. */
  noteSuccess(a: Attempt): void {
    this.blockedUntil.delete(idOf(a))
  }

  /** Forget cooldowns (e.g. the user just entered new API keys). */
  reset(): void {
    this.recent.clear()
    this.blockedUntil.clear()
  }
}
