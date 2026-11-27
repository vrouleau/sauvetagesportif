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
  rgbaToGray, sharpness, meanAbsDiff, StableCaptureTracker, DEFAULT_CAPTURE_CONFIG,
  type CaptureDecision,
} from '../src/renderer/src/captureQuality'

// ── image metrics ────────────────────────────────────────────────────────────

const W = 32
const H = 32

/** Vertical stripes, 2px wide. */
function stripes(shift = 0): Uint8Array {
  const g = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = ((x + shift) >> 1) % 2 ? 230 : 20
  return g
}

/** Horizontal box blur (simulates motion blur). */
function blur(src: Uint8Array, radius = 3): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k
        if (xx < 0 || xx >= W) continue
        s += src[y * W + xx]; n++
      }
      out[y * W + x] = Math.round(s / n)
    }
  }
  return out
}

describe('image metrics', () => {
  it('rgbaToGray converts luma', () => {
    const gray = rgbaToGray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255])
    expect(gray[0]).toBeGreaterThanOrEqual(254)
    expect(gray[1]).toBe(0)
    expect(gray[2]).toBeGreaterThan(60)
    expect(gray[2]).toBeLessThan(90)
  })

  it('sharpness: crisp image scores far above its motion-blurred copy', () => {
    const crisp = stripes()
    expect(sharpness(crisp, W, H)).toBeGreaterThan(sharpness(blur(crisp), W, H) * 5)
  })

  it('sharpness: flat image is 0, tiny images do not crash', () => {
    expect(sharpness(new Uint8Array(W * H).fill(128), W, H)).toBe(0)
    expect(sharpness(new Uint8Array(4), 2, 2)).toBe(0)
  })

  it('meanAbsDiff: identical = 0, shifted large, size mismatch = Infinity', () => {
    expect(meanAbsDiff(stripes(), stripes())).toBe(0)
    expect(meanAbsDiff(stripes(), stripes(2))).toBeGreaterThan(50)
    expect(meanAbsDiff(new Uint8Array(4), new Uint8Array(5))).toBe(Infinity)
  })
})

// ── tracker ──────────────────────────────────────────────────────────────────

const STEP = 100 // ms between samples
const MOVING = 12
const STILL = 0.8

interface Harness {
  tracker: StableCaptureTracker<number>
  evicted: number[]
  decisions: Array<CaptureDecision<number> & { at: number }>
  /** push one sample at time t; `decode` marks a barcode decode of that frame */
  step(t: number, motion: number | null, sharp: number, decode?: string): void
}

function harness(cfg = {}): Harness {
  const evicted: number[] = []
  const tracker = new StableCaptureTracker<number>(cfg, (f) => evicted.push(f))
  const decisions: Harness['decisions'] = []
  return {
    tracker, evicted, decisions,
    step(t, motion, sharp, decode) {
      if (decode) {
        const dropped = tracker.noteDecode(decode, t)
        if (dropped) decisions.push({ ...dropped, at: t })
      }
      const d = tracker.pushFrame({ t, motion, sharpness: sharp, frame: t })
      if (d) decisions.push({ ...d, at: t })
    },
  }
}

describe('StableCaptureTracker', () => {
  it('does not capture while moving; captures once still, using the sharpest still frame', () => {
    const h = harness()
    // strip slides in: decodes while moving
    for (let t = 0; t <= 800; t += STEP) h.step(t, t === 0 ? null : MOVING, 5, t >= 200 ? 'E1-U1-H1-L1' : undefined)
    expect(h.decisions).toHaveLength(0)
    expect(h.tracker.status).toBe('moving')

    // strip settles: sharpness varies a bit, 900 is the sharpest
    const sharpAt: Record<number, number> = { 900: 40, 1000: 60, 1100: 95, 1200: 70, 1300: 65 }
    for (let t = 900; t <= 1500; t += STEP) h.step(t, STILL, sharpAt[t] ?? 50, 'E1-U1-H1-L1')

    expect(h.decisions).toHaveLength(1)
    const d = h.decisions[0]
    expect(d.code).toBe('E1-U1-H1-L1')
    expect(d.lowQuality).toBe(false)
    // fires after stableMs of stillness (stable since 900 → 1200), not earlier
    expect(d.at).toBe(1200)
    // best of the still frames seen so far (900..1200) is 1100
    expect(d.frame).toBe(1100)
    expect(d.sharpness).toBe(95)
  })

  it('never picks a blurry moving frame even if the metric is higher', () => {
    const h = harness()
    for (let t = 0; t <= 600; t += STEP) h.step(t, t === 0 ? null : MOVING, 999, 'E2-U2-H1-L1')
    for (let t = 700; t <= 1200; t += STEP) h.step(t, STILL, 30, 'E2-U2-H1-L1')
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].frame).toBeGreaterThanOrEqual(700)
  })

  it('strip removed after being decoded while moving: saved from its best frame (flagged), never an empty scene', () => {
    const h = harness()
    for (let t = 0; t <= 300; t += STEP) h.step(t, t === 0 ? null : MOVING, t === 200 ? 80 : 5, 'E3-U3-H1-L1')
    // strip pulled away: empty, still scene, no more decodes
    for (let t = 400; t <= 1900; t += STEP) h.step(t, STILL, 5)
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].code).toBe('E3-U3-H1-L1')
    expect(h.decisions[0].lowQuality).toBe(true)
    expect(h.decisions[0].frame).toBe(200) // from while the strip was in view
    expect(h.tracker.status).toBe('idle')
  })

  it('fast flipping: next strip arrives before the previous settled -> previous is still saved (flagged)', () => {
    const h = harness()
    // strip A visible and moving, best frame at 200
    for (let t = 0; t <= 400; t += STEP) h.step(t, t === 0 ? null : MOVING, t === 200 ? 90 : 10, 'E8-U8-H1-L1')
    expect(h.decisions).toHaveLength(0)
    // strip B shows up
    h.step(500, MOVING, 10, 'E8-U8-H1-L2')
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].code).toBe('E8-U8-H1-L1')
    expect(h.decisions[0].lowQuality).toBe(true)
    expect(h.decisions[0].frame).toBe(200)
    // B then settles and is captured normally
    for (let t = 600; t <= 1300; t += STEP) h.step(t, STILL, 30, 'E8-U8-H1-L2')
    expect(h.decisions).toHaveLength(2)
    expect(h.decisions[1].code).toBe('E8-U8-H1-L2')
    expect(h.decisions[1].lowQuality).toBe(false)
  })

  it('best frame survives ring eviction and is released only after the decision was consumed', () => {
    const h = harness({ ringSize: 3, codeTtlMs: 600, maxWaitMs: 99999 })
    h.step(0, null, 100, 'E9-U9-H1-L1') // sharpest, decoded
    for (let t = 100; t <= 500; t += STEP) h.step(t, MOVING, 5, 'E9-U9-H1-L1')
    expect(h.evicted).not.toContain(0) // evicted from the ring but still held
    // strip leaves; candidate expires -> decision uses frame 0
    for (let t = 600; t <= 1200; t += STEP) h.step(t, MOVING, 5)
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].frame).toBe(0)
    expect(h.evicted).not.toContain(0) // caller still has to convert it
    h.step(1300, MOVING, 5) // next call releases it
    expect(h.evicted).toContain(0)
  })

  it('waits for a decode in the still frame, then captures', () => {
    const h = harness()
    for (let t = 0; t <= 300; t += STEP) h.step(t, t === 0 ? null : MOVING, 5, 'E4-U4-H1-L1')
    for (let t = 400; t <= 900; t += STEP) h.step(t, STILL, 20)
    expect(h.decisions).toHaveLength(0) // still, but last decode predates stillness
    h.step(1000, STILL, 20, 'E4-U4-H1-L1')
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].lowQuality).toBe(false)
  })

  it('times out and flags lowQuality when the strip never settles', () => {
    const h = harness()
    for (let t = 0; t <= 2600; t += STEP) h.step(t, t === 0 ? null : MOVING, 10 + (t % 3), 'E5-U5-H1-L1')
    expect(h.decisions).toHaveLength(1)
    expect(h.decisions[0].lowQuality).toBe(true)
    expect(h.decisions[0].at).toBe(DEFAULT_CAPTURE_CONFIG.maxWaitMs)
  })

  it('does not re-capture the same code while it stays in view; re-arms after it leaves', () => {
    const h = harness()
    let t = 0
    h.step(t, null, 5)
    for (t = 100; t <= 1000; t += STEP) h.step(t, STILL, 30, 'E6-U6-H1-L1')
    expect(h.decisions).toHaveLength(1)

    // still in view for another 5 s: no second capture
    for (; t <= 6000; t += STEP) h.step(t, STILL, 30, 'E6-U6-H1-L1')
    expect(h.decisions).toHaveLength(1)

    // removed for > releaseMs, then presented again
    for (; t <= 8000; t += STEP) h.step(t, STILL, 5)
    for (; t <= 9000; t += STEP) h.step(t, STILL, 30, 'E6-U6-H1-L1')
    expect(h.decisions).toHaveLength(2)
  })

  it('a different code arms immediately after a capture', () => {
    const h = harness()
    h.step(0, null, 5)
    for (let t = 100; t <= 1000; t += STEP) h.step(t, STILL, 30, 'E7-U7-H1-L1')
    expect(h.decisions).toHaveLength(1)
    // next strip swapped in right away (moving, then still)
    for (let t = 1100; t <= 1400; t += STEP) h.step(t, MOVING, 5, 'E7-U7-H1-L2')
    for (let t = 1500; t <= 2000; t += STEP) h.step(t, STILL, 30, 'E7-U7-H1-L2')
    expect(h.decisions).toHaveLength(2)
    expect(h.decisions[1].code).toBe('E7-U7-H1-L2')
  })

  it('keeps only ringSize frames and reports evictions; reset releases the rest', () => {
    const h = harness({ ringSize: 3 })
    for (let t = 0; t < 600; t += STEP) h.step(t, STILL, 1) // 6 frames, no decode
    expect(h.evicted).toEqual([0, 100, 200])
    h.tracker.reset()
    expect(h.evicted).toEqual([0, 100, 200, 300, 400, 500])
    expect(h.tracker.status).toBe('idle')
  })
})
