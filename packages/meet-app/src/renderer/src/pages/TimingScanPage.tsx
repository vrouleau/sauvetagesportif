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
 * Camera scanner page for timing sheets.
 *
 * Pure scanning mode — no time entry here.
 * Workflow: activate camera → scan sheets one after another → beep confirms each.
 * Blank sheets carry their own FV-… barcode and are captured like any other strip; they
 * get their event/heat/lane from Gemini / the operator in the Traitement tab.
 * Time entry happens in the Traitement tab.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  StableCaptureTracker, DEFAULT_CAPTURE_CONFIG, cleanBarcodeText, rgbaToGray, sharpness, meanAbsDiff,
  type CaptureConfig, type CaptureDecision, type TrackerStatus,
} from '../captureQuality'

/** Frame sampling for the stillness / sharpness check (small canvas keeps it cheap). */
const SAMPLE_INTERVAL_MS = 100
const SAMPLE_WIDTH = 320
/** Barcode decoding runs on a copy no wider than this (the code spans the strip, so it is plenty). */
const DECODE_MAX_WIDTH = 1280
/**
 * Scanner debug panel (decode / capture / save counters and errors). Off by default.
 * Turn on with `npm run dev:debug` (sets VITE_SCAN_DEBUG=1), or at runtime, also in a packaged
 * build: DevTools (F12) -> localStorage.setItem('timing-scan-debug', '1') then reload.
 */
const SCAN_DEBUG = (() => {
  if (import.meta.env.VITE_SCAN_DEBUG === '1') return true
  try { return localStorage.getItem('timing-scan-debug') === '1' } catch { return false }
})()
const BARCODE_RE = /^E(\d+)-U(\d+)-H(\d+)-L(\d+)$/
/** Printed on blank strips: `FV-<batch>-<nn>` (see blankTimingSheet.ts). */
const BLANK_CODE_RE = /^FV-([2-9A-HJ-NP-Z]{4}-\d{2,3})$/

function timingApi() {
  return (window as unknown as {
    api?: {
      timing?: {
        saveScan: (data: {
          eventNumber: number
          swimEventId: number
          heatNumber: number
          lane: number
          barcodeRaw: string
          imageBase64: string
        }) => Promise<{ ok: boolean; scanId?: number; duplicate?: boolean; error?: string }>
        getScanSummary: () => Promise<{ unprocessed: number; recognized: number; validated: number; error: number }>
        clearAllScans: () => Promise<{ ok: boolean; deleted: number }>
      }
    }
  }).api?.timing ?? null
}

/**
 * Optional on-site tuning without a rebuild: in DevTools (F12) run e.g.
 *   localStorage.setItem('timing-capture-config', JSON.stringify({ motionThreshold: 4, stableMs: 200 }))
 * then reload. Keys: see CaptureConfig in captureQuality.ts. Unknown/invalid values are ignored.
 */
function loadCaptureConfig(): Partial<CaptureConfig> {
  try {
    const raw = JSON.parse(localStorage.getItem('timing-capture-config') || '{}') as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const k of Object.keys(DEFAULT_CAPTURE_CONFIG)) {
      const v = raw[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
    return out as Partial<CaptureConfig>
  } catch {
    return {}
  }
}

/** Full-resolution JPEG (base64, no prefix) of a frame, or null. */
function bitmapToJpegBase64(bitmap: ImageBitmap): string | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null
  } catch {
    return null
  }
}

/** Best-effort camera tuning: continuous autofocus where the camera supports it. */
async function tuneTrack(track: MediaStreamTrack | undefined): Promise<void> {
  try {
    if (!track?.getCapabilities) return
    const caps = track.getCapabilities() as { focusMode?: string[] }
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
    }
  } catch { /* unsupported — keep camera defaults */ }
}

export default function TimingScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [scanCount, setScanCount] = useState(0)
  const [lastBarcode, setLastBarcode] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const [summary, setSummary] = useState<{ unprocessed: number; validated: number } | null>(null)
  const [status, setStatus] = useState<TrackerStatus>('idle')
  const [lowQuality, setLowQuality] = useState(false)
  const [metrics, setMetrics] = useState<{ motion: number | null; sharp: number } | null>(null)
  // Holds the last few full-resolution frames; the sharpest still one is saved.
  const trackerRef = useRef<StableCaptureTracker<ImageBitmap>>(null as never)
  if (!trackerRef.current) trackerRef.current = new StableCaptureTracker<ImageBitmap>(loadCaptureConfig(), (b) => b.close())
  const streamRef = useRef<MediaStream | null>(null)
  // Debug panel counters: which stage of scan -> capture -> save is failing (shown only when SCAN_DEBUG)
  const dbgRef = useRef({ loops: 0, decodes: 0, lastRaw: '', decodeMs: 0, decodeErr: '', sampleErr: '', samples: 0, decisions: 0, lastDecision: '', commitErr: '', saveRes: '', noteCalls: 0, rejected: 0, rejectedRaw: '', trk: '' })
  const [dbg, setDbg] = useState(dbgRef.current)

  // Load summary
  useEffect(() => {
    timingApi()?.getScanSummary().then((s) => {
      if (s) setSummary({ unprocessed: s.unprocessed, validated: s.validated })
    })
  }, [scanCount])

  // Start camera
  const startCamera = useCallback(async () => {
    try {
      setCameraError(null)
      // Ask for Full HD: handwritten digits need more pixels than the barcode does.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      })
      streamRef.current = stream
      await tuneTrack(stream.getVideoTracks()[0])
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await new Promise<void>((resolve) => {
          const video = videoRef.current!
          if (video.readyState >= 2) resolve()
          else video.addEventListener('loadeddata', () => resolve(), { once: true })
        })
        await videoRef.current.play()
        setCameraActive(true)
      }
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : 'Impossible d\'accéder à la caméra')
    }
  }, [])

  // Stop camera
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    trackerRef.current.reset()
    setStatus('idle')
    setMetrics(null)
    setCameraActive(false)
  }, [])

  useEffect(() => { return () => { stopCamera() } }, [stopCamera])

  // Barcode scanning loop
  useEffect(() => {
    if (!cameraActive) return
    let running = true

    async function scanLoop() {
      let Quagga: any
      try {
        const mod = await import('@ericblade/quagga2')
        Quagga = mod.default || mod
      } catch (e) { dbgRef.current.decodeErr = 'quagga import: ' + String(e); console.error('[scan] quagga import failed', e); return }

      while (running) {
        dbgRef.current.loops++
        if (!videoRef.current || videoRef.current.videoWidth === 0) {
          await new Promise((r) => setTimeout(r, 200))
          continue
        }

        try {
          const video = videoRef.current
          const scale = Math.min(1, DECODE_MAX_WIDTH / video.videoWidth)
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(video.videoWidth * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          const ctx = canvas.getContext('2d')
          if (!ctx) { await new Promise((r) => setTimeout(r, 200)); continue }

          const grabbedAt = performance.now() // the code must have been readable in THIS frame
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageDataUrl = canvas.toDataURL('image/png')

          const decodeStart = performance.now()
          const result = await Promise.race([
            new Promise<string | null>((resolve) => {
              Quagga.decodeSingle({
                src: imageDataUrl,
                numOfWorkers: 0,
                decoder: { readers: ['code_128_reader'] },
                locate: true,
                locator: { halfSample: true, patchSize: 'large' },
              }, (res: any) => {
                resolve(res?.codeResult?.code ?? null)
              })
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
          ])

          dbgRef.current.decodeMs = Math.round(performance.now() - decodeStart)
          if (result) { dbgRef.current.decodes++; dbgRef.current.lastRaw = JSON.stringify(result) }
          const code = result ? cleanBarcodeText(String(result)) : ''
          // Don't save here: tell the tracker, which saves once the strip is still.
          if (code && !(BARCODE_RE.test(code) || BLANK_CODE_RE.test(code))) { dbgRef.current.rejected++; dbgRef.current.rejectedRaw = JSON.stringify(code) }
          if (code && (BARCODE_RE.test(code) || BLANK_CODE_RE.test(code))) {
            dbgRef.current.noteCalls++
            // A decision here = the previous strip was replaced before it settled: save it anyway.
            const dropped = trackerRef.current.noteDecode(code, grabbedAt)
            if (dropped) void commitCapture(dropped)
          }
        } catch (e) { dbgRef.current.decodeErr = String(e); console.error('[scan] decode loop error', e) }

        await new Promise((r) => setTimeout(r, 200))
      }
    }

    scanLoop()
    return () => { running = false }
  }, [cameraActive])

  // Frame sampling loop: measures stillness + sharpness, keeps recent full-res frames in the
  // tracker, and saves the sharpest still one once a barcode has been read (see captureQuality.ts).
  useEffect(() => {
    if (!cameraActive) return
    let running = true
    const tracker = trackerRef.current
    const small = document.createElement('canvas')
    const smallCtx = small.getContext('2d', { willReadFrequently: true })
    let prevGray: Uint8Array | null = null
    let prevStatus: TrackerStatus = 'idle'

    async function sampleLoop() {
      while (running) {
        const started = performance.now()
        const video = videoRef.current
        if (video && video.videoWidth > 0 && smallCtx) {
          try {
            const w = SAMPLE_WIDTH
            const h = Math.max(2, Math.round((SAMPLE_WIDTH * video.videoHeight) / video.videoWidth))
            if (small.width !== w || small.height !== h) { small.width = w; small.height = h; prevGray = null }
            const t = performance.now()
            smallCtx.drawImage(video, 0, 0, w, h)
            const gray = rgbaToGray(smallCtx.getImageData(0, 0, w, h).data)
            const motion = prevGray ? meanAbsDiff(prevGray, gray) : null
            prevGray = gray
            const sharp = sharpness(gray, w, h)
            const frame = await createImageBitmap(video)
            if (!running) { frame.close(); break }

            dbgRef.current.samples++
            const decision = tracker.pushFrame({ t, motion, sharpness: sharp, frame })
            if (tracker.status !== prevStatus) { prevStatus = tracker.status; setStatus(prevStatus) }
            setMetrics({ motion, sharp })
            if (SCAN_DEBUG) {
              dbgRef.current.trk = tracker.debugState(performance.now())
              setDbg({ ...dbgRef.current })
            }
            if (decision) void commitCapture(decision) // converts the frame synchronously, saves async
          } catch (e) { dbgRef.current.sampleErr = String(e); console.error('[scan] sampler error', e) }
        }
        const wait = SAMPLE_INTERVAL_MS - (performance.now() - started)
        await new Promise((r) => setTimeout(r, Math.max(10, wait)))
      }
    }

    sampleLoop()
    return () => { running = false; tracker.reset() }
  }, [cameraActive])

  // Save the frame the tracker picked (sharpest of the recent still frames).
  const commitCapture = useCallback(async (decision: CaptureDecision<ImageBitmap>) => {
    // Blank strip: no event/heat/lane yet (Gemini + operator resolve them in Traitement).
    // Stored as BLANK-<batch>-<nn>, so re-presenting the same strip replaces its scan.
    const blank = decision.code.match(BLANK_CODE_RE)
    const match = blank ? null : decision.code.match(BARCODE_RE)
    dbgRef.current.decisions++
    dbgRef.current.lastDecision = `${decision.code} lowQ=${decision.lowQuality} waited=${Math.round(decision.waitedMs)}ms`
    if (SCAN_DEBUG) console.log('[scan] decision', decision.code, decision.lowQuality, decision.waitedMs)
    if (!blank && !match) return
    const [, eventStr, swimEventIdStr, heatStr, laneStr] = match ?? []

    // Convert synchronously: the bitmap is closed once it falls out of the tracker's ring.
    const imageBase64 = bitmapToJpegBase64(decision.frame)
    if (!imageBase64) { dbgRef.current.commitErr = 'jpeg conversion failed (bitmap closed?)'; console.error('[scan] jpeg conversion failed'); return }

    // Flash + beep — only now, so the beep means "picture taken, you can move on"
    setFlash(true)
    setTimeout(() => setFlash(false), 300)
    playBeep(decision.lowQuality)

    const api = timingApi()
    if (!api) { dbgRef.current.commitErr = 'window.api.timing missing'; console.error('[scan] window.api.timing missing') }
    if (api) {
      const result = await api.saveScan({
        eventNumber: blank ? 0 : parseInt(eventStr, 10),
        swimEventId: blank ? 0 : parseInt(swimEventIdStr, 10),
        heatNumber: blank ? 0 : parseInt(heatStr, 10),
        lane: blank ? 0 : parseInt(laneStr, 10),
        barcodeRaw: blank ? `BLANK-${blank[1]}` : decision.code,
        imageBase64,
      })
      dbgRef.current.saveRes = JSON.stringify(result)
      if (SCAN_DEBUG) console.log('[scan] saveScan ->', result)
      if (result.ok && !result.duplicate) {
        setScanCount((c) => c + 1)
        setLastBarcode(blank ? 'Fiche vierge' : decision.code)
        setLowQuality(decision.lowQuality)
      }
    }
  }, [])

  /** One high beep = captured OK. Two low beeps = captured but possibly blurry, present the sheet again. */
  function playBeep(lowQuality = false) {
    try {
      const ctx = new AudioContext()
      const tones = lowQuality ? [0, 0.22] : [0]
      for (const offset of tones) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.frequency.value = lowQuality ? 330 : 880
        gain.gain.value = 0.3
        osc.start(ctx.currentTime + offset)
        osc.stop(ctx.currentTime + offset + 0.15)
      }
    } catch { /* */ }
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Scanner les fiches</h1>
        <div className="flex items-center gap-4">
          {summary && (
            <div className="text-xs text-gray-500 flex gap-3">
              <span>À traiter: <strong className="text-orange-600">{summary.unprocessed}</strong></span>
              <span>Validés: <strong className="text-green-600">{summary.validated}</strong></span>
            </div>
          )}
          <span className="text-sm font-mono bg-gray-200 px-2 py-0.5 rounded">
            {scanCount} scan{scanCount !== 1 ? 's' : ''} (session)
          </span>
          <button
            onClick={async () => {
              if (!window.confirm('Supprimer tous les scans? Irréversible.')) return
              const api = timingApi()
              if (api) {
                await api.clearAllScans()
                setScanCount(0)
                setLastBarcode(null)
                setSummary({ unprocessed: 0, validated: 0 })
              }
            }}
            className="px-2 py-0.5 text-xs bg-red-100 text-red-700 border border-red-300 rounded hover:bg-red-200"
          >
            Vider
          </button>
        </div>
      </div>

      {/* Camera */}
      <div className="flex-1 relative bg-black rounded overflow-hidden">
        <video ref={videoRef} className="w-full h-full object-contain" muted playsInline />

        {/* Flash */}
        {flash && <div className="absolute inset-0 bg-green-400/30 pointer-events-none" />}

        {/* Inactive overlay */}
        {!cameraActive && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <button
              onClick={startCamera}
              className="px-6 py-3 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium"
            >
              Activer la caméra
            </button>
          </div>
        )}

        {/* Error */}
        {cameraError && (
          <div className="absolute bottom-4 left-4 right-4 bg-red-600 text-white text-xs p-2 rounded">
            {cameraError}
          </div>
        )}

        {/* Hold-still prompt: barcode read, waiting for the strip to settle */}
        {cameraActive && status !== 'idle' && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-amber-500/90 text-black text-sm font-medium px-4 py-2 rounded shadow">
            {status === 'moving' ? 'Code détecté — gardez la fiche immobile…' : 'Ne bougez pas…'}
          </div>
        )}

        {/* Live readout to tune the thresholds on site (captureQuality.ts DEFAULT_CAPTURE_CONFIG) */}
        {cameraActive && metrics && (
          <div className="absolute bottom-2 left-2 text-[10px] font-mono text-white/70 bg-black/40 px-1.5 py-0.5 rounded">
            mvt {metrics.motion === null ? '–' : metrics.motion.toFixed(1)} · netteté {Math.round(metrics.sharp)}
          </div>
        )}

        {/* Debug panel: only with SCAN_DEBUG (npm run dev:debug) */}
        {SCAN_DEBUG && cameraActive && (
          <div className="absolute top-14 right-3 w-80 text-[10px] leading-tight font-mono text-yellow-200 bg-black/75 px-2 py-1 rounded whitespace-pre-wrap break-all">
            {`status=${status}  samples=${dbg.samples}  scanLoops=${dbg.loops}
decodes=${dbg.decodes}  lastDecodeMs=${dbg.decodeMs}
lastRaw=${dbg.lastRaw || '-'}
decisions=${dbg.decisions}  ${dbg.lastDecision}
saveRes=${dbg.saveRes || '-'}
noteCalls=${dbg.noteCalls}  rejected=${dbg.rejected} ${dbg.rejectedRaw}
tracker: ${dbg.trk}
ERR decode=${dbg.decodeErr || '-'}
ERR sampler=${dbg.sampleErr || '-'}
ERR commit=${dbg.commitErr || '-'}`}
          </div>
        )}

        {/* Last scan indicator */}
        {lastBarcode && (
          <div className={`absolute top-3 left-3 text-white text-sm px-3 py-2 rounded shadow font-mono ${lowQuality ? 'bg-amber-600/95' : 'bg-green-700/90'}`}>
            {lowQuality ? '⚠' : '✓'} {lastBarcode}
            {lowQuality && (
              <div className="font-sans text-xs mt-1">Image possiblement floue — présentez la fiche à nouveau</div>
            )}
          </div>
        )}

        {/* Scan count overlay */}
        <div className="absolute top-3 right-3 bg-black/70 text-white text-2xl font-bold px-4 py-2 rounded">
          {scanCount}
        </div>
      </div>

      {/* Controls */}
      {cameraActive && (
        <div className="flex justify-center gap-3">
          <button
            onClick={stopCamera}
            className="px-4 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-700"
          >
            Arrêter la caméra
          </button>
        </div>
      )}
    </div>
  )
}