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
 * "Stable, then capture" logic for the timing-sheet camera scanner.
 *
 * Problem: the barcode is large and high-contrast, so it decodes as soon as the strip
 * slides into view, and the old code saved a frame right then (a *later* frame than the
 * decoded one, because decoding is async) while the strip was still moving, which
 * blurred the handwriting.
 *
 * Fix: after a barcode is seen, keep sampling frames and only capture once the picture
 * has been still for a moment AND the barcode was decoded from a still frame; save the
 * sharpest recent frame. If the strip never settles, capture anyway after a timeout and
 * flag the result `lowQuality` so the UI can ask the operator to present it again.
 *
 * Pure (no DOM, no electron) so it can be unit tested; the page feeds it frames.
 */

// ── Image metrics (grayscale, row-major, length = w*h) ───────────────────────

/** RGBA pixel data → 8-bit luma. */
export function rgbaToGray(rgba: ArrayLike<number>): Uint8Array {
  const n = Math.floor(rgba.length / 4)
  const gray = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  }
  return gray
}

/**
 * Variance of the Laplacian: higher = sharper. Motion blur / defocus flattens edges and
 * drives it down. Only meaningful for comparing frames of the same scene and size.
 */
export function sharpness(gray: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3) return 0
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const i = row + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += lap
      sumSq += lap * lap
      count++
    }
  }
  const mean = sum / count
  return sumSq / count - mean * mean
}

/** Mean absolute pixel difference (0–255) between two same-size grayscale frames. */
export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Infinity
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

// ── Stable-capture state machine ─────────────────────────────────────────────

export interface CaptureConfig {
  /** Mean abs diff between consecutive samples at or below which the scene counts as still. */
  motionThreshold: number
  /** How long the scene must stay still before capturing (ms). */
  stableMs: number
  /** Capture anyway (flagged lowQuality) this long after the barcode was first seen (ms). */
  maxWaitMs: number
  /** A barcode counts as "still in view" for this long after its last decode (ms). */
  codeTtlMs: number
  /** After a capture, the same code re-arms only once it has not been decoded for this long (ms). */
  releaseMs: number
  /** Number of recent full-resolution frames kept to choose the sharpest from. */
  ringSize: number
}

/**
 * Starting values, to be tuned on the real camera and lighting (the scan page shows live
 * motion/sharpness readouts for that). Sensor noise on a still scene is typically ~0.5–1.5;
 * a strip being moved is well above 5.
 */
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  motionThreshold: 2.5,
  stableMs: 300,
  maxWaitMs: 2000,
  codeTtlMs: 1500,
  releaseMs: 1500,
  ringSize: 6,
}

export interface FrameSample<T> {
  /** Grab time (ms, any monotonic clock — same one as `noteDecode`). */
  t: number
  /** Difference vs. the previous sample; null for the very first one. */
  motion: number | null
  sharpness: number
  /** The frame itself (e.g. an ImageBitmap); handed back in the decision. */
  frame: T
}

export interface CaptureDecision<T> {
  code: string
  frame: T
  sharpness: number
  /** True when the strip never settled and we captured on timeout. */
  lowQuality: boolean
  /** ms between first seeing the barcode and capturing. */
  waitedMs: number
}

export type TrackerStatus = 'idle' | 'moving' | 'steady'

export class StableCaptureTracker<T> {
  private cfg: CaptureConfig
  private onEvict?: (frame: T) => void
  private ring: FrameSample<T>[] = []
  private candidate: { code: string; firstSeen: number; lastDecode: number } | null = null
  private fired: { code: string; lastSeen: number } | null = null
  private stableSince: number | null = null

  constructor(cfg: Partial<CaptureConfig> = {}, onEvict?: (frame: T) => void) {
    this.cfg = { ...DEFAULT_CAPTURE_CONFIG, ...cfg }
    this.onEvict = onEvict
  }

  /**
   * A barcode was decoded from the frame grabbed at time `t` (the grab time, not when the
   * async decode finished — the code must have been readable in a still frame).
   */
  noteDecode(code: string, t: number): void {
    if (this.fired && this.fired.code === code) {
      this.fired.lastSeen = Math.max(this.fired.lastSeen, t)
      return
    }
    if (this.candidate && this.candidate.code === code) {
      this.candidate.lastDecode = Math.max(this.candidate.lastDecode, t)
      return
    }
    this.candidate = { code, firstSeen: t, lastDecode: t }
  }

  /** Feed the next frame sample; returns a decision when it is time to save. */
  pushFrame(s: FrameSample<T>): CaptureDecision<T> | null {
    this.ring.push(s)
    while (this.ring.length > this.cfg.ringSize) this.onEvict?.(this.ring.shift()!.frame)

    if (s.motion !== null && s.motion <= this.cfg.motionThreshold) {
      if (this.stableSince === null) this.stableSince = s.t
    } else {
      this.stableSince = null
    }

    if (this.fired && s.t - this.fired.lastSeen >= this.cfg.releaseMs) this.fired = null
    if (this.candidate && s.t - this.candidate.lastDecode > this.cfg.codeTtlMs) this.candidate = null
    if (!this.candidate) return null

    // Still long enough, AND the barcode was decoded from a frame at/after the still period
    // (otherwise the strip may have been swapped or removed since it was decoded).
    const steady =
      this.stableSince !== null &&
      s.t - this.stableSince >= this.cfg.stableMs &&
      this.candidate.lastDecode >= this.stableSince
    const timedOut = s.t - this.candidate.firstSeen >= this.cfg.maxWaitMs
    if (!steady && !timedOut) return null

    const pool = steady ? this.ring.filter((f) => f.t >= this.stableSince!) : this.ring
    const best = pool.reduce((a, b) => (b.sharpness > a.sharpness ? b : a))
    const decision: CaptureDecision<T> = {
      code: this.candidate.code,
      frame: best.frame,
      sharpness: best.sharpness,
      lowQuality: !steady,
      waitedMs: s.t - this.candidate.firstSeen,
    }
    this.fired = { code: this.candidate.code, lastSeen: this.candidate.lastDecode }
    this.candidate = null
    return decision
  }

  /** For UI feedback: nothing in view / barcode seen but moving / barcode seen and still. */
  get status(): TrackerStatus {
    if (!this.candidate) return 'idle'
    return this.stableSince !== null ? 'steady' : 'moving'
  }

  /** Drop all state (camera stopped) and release held frames. */
  reset(): void {
    for (const f of this.ring) this.onEvict?.(f.frame)
    this.ring = []
    this.candidate = null
    this.fired = null
    this.stableSince = null
  }
}
