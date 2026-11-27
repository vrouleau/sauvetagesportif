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

import { describe, it, expect } from 'vitest'
import {
  AttemptChain, parseRateLimit, DEFAULT_ATTEMPTS,
  MINUTE_COOLDOWN_MS, DAILY_COOLDOWN_MS, UNAVAILABLE_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS,
} from '../src/main/ocrFallback'

const both = () => true
const ids = (a: Array<{ model: string; tier: string }>) => a.map((x) => `${x.model}|${x.tier}`)

describe('Gemini attempt order', () => {
  it('is 3.5 Flash-Lite free -> 2.5 Flash-Lite free -> 2.5 Flash-Lite paid', () => {
    expect(ids(DEFAULT_ATTEMPTS)).toEqual([
      'gemini-3.5-flash-lite|free', 'gemini-2.5-flash-lite|free', 'gemini-2.5-flash-lite|paid',
    ])
    expect(ids(new AttemptChain().available(0, both))).toEqual(ids(DEFAULT_ATTEMPTS))
  })

  it('skips attempts whose key is not configured', () => {
    const c = new AttemptChain()
    expect(ids(c.available(0, (t) => t === 'free'))).toEqual(['gemini-3.5-flash-lite|free', 'gemini-2.5-flash-lite|free'])
    expect(ids(c.available(0, (t) => t === 'paid'))).toEqual(['gemini-2.5-flash-lite|paid'])
    expect(c.available(0, () => false)).toEqual([])
  })
})

describe('Cooldowns', () => {
  it('a per-minute 429 skips that attempt for a minute (or the server retryDelay if longer), then recovers', () => {
    const c = new AttemptChain()
    const [first] = c.available(0, both)
    c.noteRateLimited(first, 1000, { daily: false })
    expect(ids(c.available(1000 + MINUTE_COOLDOWN_MS - 1, both))).not.toContain('gemini-3.5-flash-lite|free')
    expect(ids(c.available(1000 + MINUTE_COOLDOWN_MS, both))).toContain('gemini-3.5-flash-lite|free')
    c.noteRateLimited(first, 0, { daily: false, retryAfterMs: 90_000 })
    expect(ids(c.available(80_000, both))).not.toContain('gemini-3.5-flash-lite|free')
    expect(ids(c.available(90_000, both))).toContain('gemini-3.5-flash-lite|free')
  })

  it('a daily 429 backs off 30 min; unavailable 10 min; transient 15 s', () => {
    const c = new AttemptChain()
    const [a, b, p] = c.available(0, both)
    c.noteRateLimited(a, 0, { daily: true })
    c.noteUnavailable(b, 0)
    c.noteTransientFailure(p, 0)
    expect(c.available(TRANSIENT_COOLDOWN_MS, both).map((x) => x.tier)).toEqual(['paid'])
    expect(c.available(UNAVAILABLE_COOLDOWN_MS, both)).toHaveLength(2) // b and p back, a still out
    expect(ids(c.available(DAILY_COOLDOWN_MS, both))).toHaveLength(3)
  })

  it('success lifts a cooldown; reset clears everything', () => {
    const c = new AttemptChain()
    const [a] = c.available(0, both)
    c.noteRateLimited(a, 0, { daily: true })
    c.noteSuccess(a)
    expect(c.available(1, both)).toHaveLength(3)
    c.noteUnavailable(a, 0)
    c.reset()
    expect(c.available(1, both)).toHaveLength(3)
  })
})

describe('Requests-per-minute pacing', () => {
  it('stops using a free model one request under its rpm until the window slides', () => {
    const c = new AttemptChain() // 3.5 free = 15 rpm -> 14 usable
    const [a] = c.available(0, both)
    for (let i = 0; i < 14; i++) c.noteRequest(a, i * 1000)
    expect(ids(c.available(14_000, both))[0]).toBe('gemini-2.5-flash-lite|free')
    // oldest request (t=0) leaves the 60 s window
    expect(ids(c.available(60_000, both))[0]).toBe('gemini-3.5-flash-lite|free')
  })

  it('paid attempt has no rpm cap', () => {
    const c = new AttemptChain()
    const paid = c.available(0, both)[2]
    for (let i = 0; i < 500; i++) c.noteRequest(paid, i)
    expect(ids(c.available(500, both))).toContain('gemini-2.5-flash-lite|paid')
  })
})

describe('parseRateLimit', () => {
  it('detects daily quota and retry delay in a Gemini 429 body', () => {
    const body = JSON.stringify({
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13.5s' },
        ],
      },
    })
    expect(parseRateLimit(body)).toEqual({ daily: true, retryAfterMs: 13500 })
  })

  it('per-minute quota, and unparseable bodies, are not daily', () => {
    expect(parseRateLimit('{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}').daily).toBe(false)
    expect(parseRateLimit('')).toEqual({ daily: false, retryAfterMs: undefined })
  })
})
