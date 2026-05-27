/**
 * Processing page for timing sheet scans.
 *
 * - Browse all scans (Non traités / Validés / Tous)
 * - Always shows image + editable time fields
 * - Gemini OCR runs in background (toggle on/off)
 * - Manual entry always available regardless of Gemini state
 * - Accept saves to meet DB immediately
 */

import { useState, useEffect, useCallback, useRef } from 'react'

type ScanStatus = 'unprocessed' | 'recognized' | 'validated' | 'error'

interface ScanRecord {
  scanId: number
  eventNumber: number
  heatNumber: number
  lane: number
  barcodeRaw: string
  imageBase64: string
  scannedAt: string
  status: ScanStatus
  recognizedTime1: string | null
  recognizedTime2: string | null
  validatedTime1: string | null
  validatedTime2: string | null
  timeMs1: number | null
  timeMs2: number | null
  ocrEngine: string | null
  ocrConfidence: number | null
  notes: string | null
}

function timingApi() {
  return (window as unknown as {
    api?: {
      timing?: {
        getScansForProcessing: (filter: ScanStatus | 'all') => Promise<ScanRecord[]>
        runOcr: (scanId: number, engine: string) => Promise<{ ok: boolean; result?: { time1: string; time2: string; overallConfidence: number }; error?: string }>
        validateScan: (scanId: number, time1: string, timeMs1: number, time2: string, timeMs2: number) => Promise<{ ok: boolean }>
        markError: (scanId: number, notes: string) => Promise<{ ok: boolean }>
      }
    }
  }).api?.timing ?? null
}

export default function TimingProcessPage() {
  const [scans, setScans] = useState<ScanRecord[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [filter, setFilter] = useState<ScanStatus | 'all'>('unprocessed')
  const [editTime1, setEditTime1] = useState('')
  const [editTime2, setEditTime2] = useState('')
  const [geminiEnabled, setGeminiEnabled] = useState(() => {
    const saved = localStorage.getItem('timing-gemini-enabled')
    return saved !== null ? saved === 'true' : true
  })
  const [geminiTier, setGeminiTier] = useState<'free' | 'paid' | 'none'>('free')
  const time1InputRef = useRef<HTMLInputElement>(null)

  // Sync toggle with main process
  useEffect(() => {
    const api = (window as any).api?.timing
    api?.setGeminiBackground(geminiEnabled)
  }, [geminiEnabled])

  // Poll for updates from background processing + tier status
  useEffect(() => {
    const interval = setInterval(async () => {
      const api = timingApi()
      if (!api) return
      const data = await api.getScansForProcessing(filter)
      setScans((prev) => {
        if (JSON.stringify(prev.map(s => ({ id: s.scanId, s: s.status, t1: s.recognizedTime1 }))) !==
            JSON.stringify(data.map(s => ({ id: s.scanId, s: s.status, t1: s.recognizedTime1 })))) {
          return data
        }
        return prev
      })
      // Update tier
      const bg = await (window as any).api?.timing?.getGeminiBackground()
      if (bg?.tier) setGeminiTier(bg.tier)
    }, 3000)
    return () => clearInterval(interval)
  }, [filter])

  // Load scans
  const loadScans = useCallback(async () => {
    const api = timingApi()
    if (!api) return
    const data = await api.getScansForProcessing(filter)
    setScans(data)
    if (data.length > 0 && currentIndex >= data.length) {
      setCurrentIndex(0)
    }
  }, [filter])

  useEffect(() => { loadScans() }, [loadScans])

  const currentScan = scans[currentIndex] ?? null

  // When current scan changes OR Gemini fills in times, update edit fields
  useEffect(() => {
    if (currentScan) {
      const newTime1 = currentScan.recognizedTime1 ?? currentScan.validatedTime1 ?? ''
      const newTime2 = currentScan.recognizedTime2 ?? currentScan.validatedTime2 ?? ''
      // Only update if fields are empty (don't overwrite user edits)
      setEditTime1((prev) => prev || newTime1)
      setEditTime2((prev) => prev || newTime2)
      // Auto-focus the first time input
      setTimeout(() => time1InputRef.current?.focus(), 50)
    }
  }, [currentIndex, currentScan?.scanId, currentScan?.recognizedTime1, currentScan?.recognizedTime2])

  // When switching scans, always reset fields
  useEffect(() => {
    if (currentScan) {
      setEditTime1(currentScan.recognizedTime1 ?? currentScan.validatedTime1 ?? '')
      setEditTime2(currentScan.recognizedTime2 ?? currentScan.validatedTime2 ?? '')
    }
  }, [currentIndex, currentScan?.scanId])

  // Backlog count (unprocessed scans waiting for Gemini)
  const backlogCount = scans.filter((s) => s.status === 'unprocessed' && !s.recognizedTime1).length

  // Navigation
  const goNext = useCallback(() => {
    if (currentIndex < scans.length - 1) setCurrentIndex((i) => i + 1)
  }, [currentIndex, scans.length])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1)
  }, [currentIndex])

  // Accept / validate
  const handleAccept = useCallback(async () => {
    if (!currentScan || !editTime1 || !editTime2) return
    const api = timingApi()
    if (!api) return

    const timeMs1 = parseTimeInput(editTime1)
    const timeMs2 = parseTimeInput(editTime2)
    if (timeMs1 === null || timeMs2 === null) {
      alert('Format invalide. Utilisez M:SS.HH (ex: 1:23.45)')
      return
    }

    await api.validateScan(currentScan.scanId, editTime1, timeMs1, editTime2, timeMs2)

    // Update local state
    setScans((prev) => {
      const updated = prev.map((s) =>
        s.scanId === currentScan.scanId
          ? { ...s, status: 'validated' as ScanStatus, validatedTime1: editTime1, validatedTime2: editTime2, timeMs1, timeMs2 }
          : s
      )
      // If filtering by "unprocessed", remove validated from the list
      if (filter === 'unprocessed') {
        const filtered = updated.filter((s) => s.status !== 'validated')
        if (filtered.length === 0) {
          // All done!
          return filtered
        }
        // Adjust index if needed
        if (currentIndex >= filtered.length) {
          setCurrentIndex(Math.max(0, filtered.length - 1))
        }
        return filtered
      }
      return updated
    })

    // Move to next unprocessed (if not filtering)
    if (filter !== 'unprocessed') {
      const nextUnprocessed = scans.findIndex((s, i) => i > currentIndex && s.status !== 'validated')
      if (nextUnprocessed >= 0) {
        setCurrentIndex(nextUnprocessed)
      } else {
        goNext()
      }
    }
  }, [currentScan, editTime1, editTime2, scans, currentIndex, filter])

  // Flag — delete the scan
  const handleFlag = useCallback(async () => {
    if (!currentScan) return
    const api = timingApi()
    if (!api) return
    if (!window.confirm(`Supprimer le scan ${currentScan.barcodeRaw}?`)) return
    await api.markError(currentScan.scanId, 'Illisible — supprimé')
    // Remove from local list
    setScans((prev) => prev.filter((s) => s.scanId !== currentScan.scanId))
    if (currentIndex >= scans.length - 2) setCurrentIndex(Math.max(0, currentIndex - 1))
  }, [currentScan, scans.length, currentIndex])

  // Keyboard shortcuts (only when not in an input)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Don't intercept when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleAccept()
        }
        return
      }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      else if (e.key === 'Enter') handleAccept()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleAccept, goNext, goPrev])

  const statusLabel = (s: ScanStatus) => {
    if (s === 'validated') return '✓'
    if (s === 'recognized') return '◎'
    if (s === 'error') return '✗'
    return '○'
  }

  const statusColor = (s: ScanStatus) => {
    if (s === 'validated') return 'text-green-600'
    if (s === 'recognized') return 'text-blue-500'
    if (s === 'error') return 'text-red-500'
    return 'text-gray-400'
  }

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Traitement</h1>
        <div className="flex items-center gap-3">
          {/* Filter */}
          <select
            value={filter}
            onChange={(e) => { setFilter(e.target.value as ScanStatus | 'all'); setCurrentIndex(0) }}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="unprocessed">Non traités ({scans.filter(s => s.status === 'unprocessed').length})</option>
            <option value="validated">Validés</option>
            <option value="all">Tous ({scans.length})</option>
          </select>

          {/* Gemini toggle */}
          <button
            onClick={() => setGeminiEnabled((v) => { const next = !v; localStorage.setItem('timing-gemini-enabled', String(next)); return next })}
            className={`px-2 py-0.5 text-xs rounded border ${
              geminiEnabled
                ? 'bg-blue-100 text-blue-700 border-blue-300'
                : 'bg-gray-100 text-gray-500 border-gray-300'
            }`}
          >
            {geminiEnabled
              ? `🤖 Gemini ${geminiTier === 'paid' ? '(payant)' : '(gratuit)'}${backlogCount > 0 ? ` · ${backlogCount}` : ''}`
              : '🤖 Gemini OFF'}
          </button>

          {/* Processing indicator */}
          {geminiEnabled && geminiTier === 'paid' && (
            <span className="text-xs text-orange-500">⚡ tier payant</span>
          )}

          {/* Counter */}
          <span className="text-xs text-gray-500">
            {scans.length > 0 ? `${currentIndex + 1} / ${scans.length}` : '—'}
          </span>
        </div>
      </div>

      {scans.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          Aucune fiche. Scannez des fiches depuis l'onglet Scanner.
        </div>
      ) : (
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Scan list (left strip) */}
          <div className="w-48 flex flex-col bg-white border border-gray-200 rounded overflow-hidden">
            <div className="px-2 py-1.5 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600">
              Fiches
            </div>
            <div className="flex-1 overflow-y-auto">
              {scans.map((scan, i) => (
                <button
                  key={scan.scanId}
                  onClick={() => setCurrentIndex(i)}
                  className={`w-full text-left px-2 py-1.5 text-xs border-b border-gray-100 flex items-center gap-2 ${
                    i === currentIndex ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className={`${statusColor(scan.status)} font-bold`}>{statusLabel(scan.status)}</span>
                  <span className="font-mono flex-1">{scan.barcodeRaw}</span>
                  {scan.status === 'validated' && (
                    <span className="text-2xs text-green-600">✓</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Image */}
          <div className="flex-1 flex flex-col bg-white border border-gray-200 rounded overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs flex justify-between items-center">
              <span className="font-mono font-bold">{currentScan?.barcodeRaw}</span>
              <span className="text-gray-500">
                Épr. {currentScan?.eventNumber} | Série {currentScan?.heatNumber} | Couloir {currentScan?.lane}
              </span>
            </div>
            <div className="flex-1 flex items-center justify-center p-2 bg-gray-100 overflow-auto">
              {currentScan?.imageBase64 ? (
                <img
                  src={`data:image/jpeg;base64,${currentScan.imageBase64}`}
                  alt="Fiche"
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div className="text-gray-400 text-sm">Pas d'image</div>
              )}
            </div>
          </div>

          {/* Time entry panel */}
          <div className="w-64 flex flex-col gap-3">
            <div className="bg-white border border-gray-200 rounded p-3">
              {/* Chrono 1 */}
              <div className="mb-3">
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Chrono 1</label>
                <input
                  ref={time1InputRef}
                  type="text"
                  value={editTime1}
                  onChange={(e) => setEditTime1(e.target.value)}
                  placeholder="M:SS.HH"
                  className="w-full text-lg font-mono text-center border-2 border-gray-300 rounded px-2 py-1 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* Chrono 2 */}
              <div className="mb-3">
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Chrono 2</label>
                <input
                  type="text"
                  value={editTime2}
                  onChange={(e) => setEditTime2(e.target.value)}
                  placeholder="M:SS.HH"
                  className="w-full text-lg font-mono text-center border-2 border-gray-300 rounded px-2 py-1 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* Accept */}
              <button
                onClick={handleAccept}
                disabled={!editTime1 || !editTime2}
                className="w-full py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 disabled:opacity-30"
              >
                ✓ Accepter (Enter)
              </button>
            </div>

            {/* Navigation + actions */}
            <div className="flex gap-2">
              <button onClick={goPrev} disabled={currentIndex === 0} className="flex-1 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">
                ← Préc
              </button>
              <button onClick={goNext} disabled={currentIndex >= scans.length - 1} className="flex-1 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">
                Suiv →
              </button>
            </div>

            <button
              onClick={handleFlag}
              className="py-1.5 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100"
            >
              ⚑ Signaler illisible
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTimeInput(str: string): number | null {
  // Already formatted: M:SS.HH
  const full = str.match(/^(\d):(\d{2})\.(\d{2})$/)
  if (full) {
    const [, min, sec, hh] = full
    return (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000 + parseInt(hh, 10) * 10
  }
  // SS.HH
  const short = str.match(/^(\d{1,2})\.(\d{2})$/)
  if (short) {
    const [, sec, hh] = short
    return parseInt(sec, 10) * 1000 + parseInt(hh, 10) * 10
  }
  // Raw digits: < 100 = whole seconds, >= 100 = MSSCC or SSCC
  const n = parseInt(str, 10)
  if (!isNaN(n) && n > 0) {
    if (n < 100) {
      // Whole seconds (e.g. "35" → 35000ms)
      return n * 1000
    }
    const cc = n % 100
    const rest = Math.floor(n / 100)
    const ss = rest % 100
    const mm = Math.floor(rest / 100)
    const totalMs = (mm * 60 + ss) * 1000 + cc * 10
    if (totalMs > 0) return totalMs
  }
  return null
}
