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
 * Time entry happens in the Traitement tab.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

function timingApi() {
  return (window as unknown as {
    api?: {
      timing?: {
        saveScan: (data: {
          eventNumber: number
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

export default function TimingScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [scanCount, setScanCount] = useState(0)
  const [lastBarcode, setLastBarcode] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const [summary, setSummary] = useState<{ unprocessed: number; validated: number } | null>(null)
  const lastBarcodeRef = useRef<string>('')
  const lastBarcodeTimeRef = useRef<number>(0)
  const streamRef = useRef<MediaStream | null>(null)

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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
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
      } catch { return }

      while (running) {
        if (!videoRef.current || videoRef.current.videoWidth === 0) {
          await new Promise((r) => setTimeout(r, 200))
          continue
        }

        try {
          const video = videoRef.current
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) { await new Promise((r) => setTimeout(r, 200)); continue }

          ctx.drawImage(video, 0, 0)
          const imageDataUrl = canvas.toDataURL('image/png')

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

          if (result) handleBarcodeDecode(result)
        } catch { /* continue */ }

        await new Promise((r) => setTimeout(r, 200))
      }
    }

    scanLoop()
    return () => { running = false }
  }, [cameraActive])

  // Handle decoded barcode
  const handleBarcodeDecode = useCallback(async (raw: string) => {
    const now = Date.now()
    if (raw === lastBarcodeRef.current && now - lastBarcodeTimeRef.current < 3000) return
    lastBarcodeRef.current = raw
    lastBarcodeTimeRef.current = now

    const match = raw.match(/^E(\d+)-H(\d+)-L(\d+)$/)
    if (!match) return

    const [, eventStr, heatStr, laneStr] = match
    const imageBase64 = captureFrame()
    if (!imageBase64) return

    // Flash + beep
    setFlash(true)
    setTimeout(() => setFlash(false), 300)
    playBeep()

    // Save
    const api = timingApi()
    if (api) {
      const result = await api.saveScan({
        eventNumber: parseInt(eventStr, 10),
        heatNumber: parseInt(heatStr, 10),
        lane: parseInt(laneStr, 10),
        barcodeRaw: raw,
        imageBase64,
      })
      if (result.ok && !result.duplicate) {
        setScanCount((c) => c + 1)
        setLastBarcode(raw)
      }
    }
  }, [])

  function captureFrame(): string | null {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return null
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null
  }

  function playBeep() {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      gain.gain.value = 0.3
      osc.start()
      osc.stop(ctx.currentTime + 0.15)
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
        <canvas ref={canvasRef} className="hidden" />

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

        {/* Last scan indicator */}
        {lastBarcode && (
          <div className="absolute top-3 left-3 bg-green-700/90 text-white text-sm px-3 py-2 rounded shadow font-mono">
            ✓ {lastBarcode}
          </div>
        )}

        {/* Scan count overlay */}
        <div className="absolute top-3 right-3 bg-black/70 text-white text-2xl font-bold px-4 py-2 rounded">
          {scanCount}
        </div>
      </div>

      {/* Controls */}
      {cameraActive && (
        <div className="flex justify-center">
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