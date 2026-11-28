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
 * Processing page for timing sheet scans.
 *
 * - Browse all scans (Non traités / Validés / Tous)
 * - Always shows image + editable time fields
 * - Gemini OCR runs in background (toggle on/off)
 * - Manual entry always available regardless of Gemini state
 * - Accept saves to meet DB immediately
 * - Blank sheets (BLANK-… scans, no barcode): event / heat / lane are editable
 *   too, pre-filled by Gemini, and must resolve to a seeded entry to accept
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { parseLooseTimeToMs } from '@shared/logic/timeFormat'
import {
  ROUND_LABEL, UNRESOLVED, groupKeyOf, sortScans, scanListKey, itemLabel, buildGroups,
  type ScanGroup,
} from '../scanGroups'

type ScanStatus = 'unprocessed' | 'recognized' | 'validated' | 'error'

interface ScanRecord {
  scanId: number
  eventNumber: number
  swimEventId: number
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

interface BlankTarget {
  swimEventId: number
  eventNumber: number
  heatNumber: number
  lane: number
  round: number
  eventName: string
  entryLabel: string
  clubCode: string
  hasTime: boolean
}

/** A look-alike reading (7<->1, 2<->7, ...) of a blank sheet's identity that exists in the meet. */
interface BlankAlternative extends BlankTarget {
  distance: number
}

interface EventLabel {
  swimEventId: number
  eventNumber: number
  round: number
  eventName: string
}

const isBlank = (scan: ScanRecord | null) => !!scan && scan.barcodeRaw.startsWith('BLANK-')


function scanLabel(scan: ScanRecord): string {
  if (!isBlank(scan)) return scan.barcodeRaw
  return scan.eventNumber > 0
    ? `Vierge · E${scan.eventNumber}-H${scan.heatNumber}-L${scan.lane}`
    : 'Vierge · ?'
}

function timingApi() {
  return (window as unknown as {
    api?: {
      timing?: {
        getScansForProcessing: (filter: ScanStatus | 'all') => Promise<ScanRecord[]>
        runOcr: (scanId: number, engine: string) => Promise<{ ok: boolean; result?: { time1: string; time2: string; overallConfidence: number }; error?: string }>
        validateScan: (
          scanId: number, time1: string, timeMs1: number, time2: string, timeMs2: number,
          target?: { eventNumber: number; swimEventId: number; heatNumber: number; lane: number },
        ) => Promise<{ ok: boolean; error?: string }>
        findBlankTargets: (eventNumber: number, heatNumber: number, lane: number) => Promise<BlankTarget[]>
        findBlankAlternatives: (eventNumber: number, heatNumber: number, lane: number) => Promise<BlankAlternative[]>
        getEventLabels: () => Promise<EventLabel[]>
        markError: (scanId: number, notes: string) => Promise<{ ok: boolean }>
      }
    }
  }).api?.timing ?? null
}

export default function TimingProcessPage({
  onGotoHeats,
  onValidated,
}: {
  onGotoHeats?: () => void
  /** Called after a scan is accepted, with the event/heat it was written to. */
  onValidated?: (eventNumber: number, heatNumber: number) => void
}) {
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
  // Blank sheets: hand-written identity + the entries seeded there
  const [editEvent, setEditEvent] = useState('')
  const [editHeat, setEditHeat] = useState('')
  const [editLane, setEditLane] = useState('')
  const [targets, setTargets] = useState<BlankTarget[]>([])
  const [targetId, setTargetId] = useState(0)
  const [alternatives, setAlternatives] = useState<BlankAlternative[]>([])
  // Left list: groups by event, collapsible
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [eventLabels, setEventLabels] = useState<Map<number, EventLabel>>(new Map())
  const labelIdsTried = useRef<Set<number>>(new Set())
  const currentItemRef = useRef<HTMLButtonElement | null>(null)
  const scansRef = useRef<ScanRecord[]>([])
  const currentIdRef = useRef<number | null>(null)

  // New data from the main process: keep display order, and keep the current scan selected
  // even if the sort moved it (e.g. Gemini just resolved a blank sheet's event).
  const applyScans = useCallback((data: ScanRecord[]) => {
    const sorted = sortScans(data)
    if (scanListKey(scansRef.current) === scanListKey(sorted)) return
    scansRef.current = sorted
    setScans(sorted)
    const id = currentIdRef.current
    if (id !== null) {
      const idx = sorted.findIndex((s) => s.scanId === id)
      if (idx >= 0) setCurrentIndex(idx)
      else setCurrentIndex((i) => Math.min(i, Math.max(0, sorted.length - 1))) // list replaced (e.g. scans loaded)
    }
  }, [])

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
      applyScans(data)
      // Update tier
      const bg = await (window as any).api?.timing?.getGeminiBackground()
      if (bg?.tier) setGeminiTier(bg.tier)
    }, 3000)
    return () => clearInterval(interval)
  }, [filter, applyScans])

  // Load scans
  const loadScans = useCallback(async () => {
    const api = timingApi()
    if (!api) return
    const data = await api.getScansForProcessing(filter)
    applyScans(data)
    if (data.length > 0 && currentIndex >= data.length) {
      setCurrentIndex(0)
    }
  }, [filter, applyScans])

  useEffect(() => { loadScans() }, [loadScans])

  const currentScan = scans[currentIndex] ?? null

  useEffect(() => { scansRef.current = scans }, [scans])
  useEffect(() => { currentIdRef.current = currentScan?.scanId ?? null }, [currentScan?.scanId])

  // Event names for the group titles: fetched once, and again only for events not seen yet
  useEffect(() => {
    const missing = scans.filter((s) => s.swimEventId > 0 && !eventLabels.has(s.swimEventId) && !labelIdsTried.current.has(s.swimEventId))
    if (missing.length === 0) return
    missing.forEach((s) => labelIdsTried.current.add(s.swimEventId))
    timingApi()?.getEventLabels().then((list) => setEventLabels(new Map(list.map((l) => [l.swimEventId, l]))))
  }, [scans, eventLabels])

  const groups = useMemo<ScanGroup<ScanRecord>[]>(() => buildGroups(scans, eventLabels), [scans, eventLabels])

  // The group of the scan being worked on opens by itself (others stay as the user left them)
  useEffect(() => {
    if (!currentScan) return
    const key = groupKeyOf(currentScan)
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [currentScan?.scanId, currentScan?.swimEventId])

  useEffect(() => { currentItemRef.current?.scrollIntoView({ block: 'nearest' }) }, [currentScan?.scanId, expanded])

  const toggleGroup = (key: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

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

  // Blank sheet identity: reset on scan switch, and when Gemini fills it in
  useEffect(() => {
    if (!currentScan || !isBlank(currentScan)) return
    const n = (v: number) => (v > 0 ? String(v) : '')
    setEditEvent(n(currentScan.eventNumber))
    setEditHeat(n(currentScan.heatNumber))
    setEditLane(n(currentScan.lane))
    setTargetId(currentScan.swimEventId)
  }, [currentScan?.scanId, currentScan?.eventNumber, currentScan?.heatNumber, currentScan?.lane, currentScan?.swimEventId])

  // Look up what's seeded at the typed event/heat/lane
  const blank = isBlank(currentScan)
  useEffect(() => {
    if (!blank) { setTargets([]); return }
    const e = parseInt(editEvent, 10), h = parseInt(editHeat, 10), l = parseInt(editLane, 10)
    if (!(e > 0 && h > 0 && l > 0)) { setTargets([]); return }
    let cancelled = false
    timingApi()?.findBlankTargets(e, h, l).then((list) => {
      if (cancelled) return
      setTargets(list)
      setTargetId((prev) => {
        if (list.some((t) => t.swimEventId === prev)) return prev
        if (list.length === 1) return list[0].swimEventId
        const open = list.filter((t) => !t.hasTime)
        return open.length === 1 ? open[0].swimEventId : 0
      })
    })
    return () => { cancelled = true }
  }, [blank, editEvent, editHeat, editLane])

  // Look-alike readings of the handwritten identity (7<->1, 2<->7, ...) that exist in the meet
  useEffect(() => {
    if (!blank) { setAlternatives([]); return }
    const e = parseInt(editEvent, 10), h = parseInt(editHeat, 10), l = parseInt(editLane, 10)
    if (!(e > 0 && h > 0 && l > 0)) { setAlternatives([]); return }
    let cancelled = false
    timingApi()?.findBlankAlternatives(e, h, l).then((list) => { if (!cancelled) setAlternatives(list) })
    return () => { cancelled = true }
  }, [blank, editEvent, editHeat, editLane])

  const blankTarget = blank ? targets.find((t) => t.swimEventId === targetId) ?? null : null

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
    if (isBlank(currentScan) && !blankTarget) return
    const api = timingApi()
    if (!api) return

    const timeMs1 = parseTimeInput(editTime1)
    const timeMs2 = parseTimeInput(editTime2)
    if (timeMs1 === null || timeMs2 === null) {
      alert('Format invalide. Utilisez M:SS.HH (ex: 1:23.45)')
      return
    }

    const target = blankTarget
      ? { eventNumber: blankTarget.eventNumber, swimEventId: blankTarget.swimEventId, heatNumber: blankTarget.heatNumber, lane: blankTarget.lane }
      : undefined
    const res = await api.validateScan(currentScan.scanId, editTime1, timeMs1, editTime2, timeMs2, target)
    if (!res.ok) {
      alert(res.error ?? 'Erreur')
      return
    }

    onValidated?.(target?.eventNumber ?? currentScan.eventNumber, target?.heatNumber ?? currentScan.heatNumber)

    // Update local state
    setScans((prev) => {
      const updated = prev.map((s) =>
        s.scanId === currentScan.scanId
          ? { ...s, ...(target ?? {}), status: 'validated' as ScanStatus, validatedTime1: editTime1, validatedTime2: editTime2, timeMs1, timeMs2 }
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
  }, [currentScan, editTime1, editTime2, scans, currentIndex, filter, blankTarget])

  // Flag — delete the scan
  const handleFlag = useCallback(async () => {
    if (!currentScan) return
    const api = timingApi()
    if (!api) return
    if (!window.confirm(`Supprimer le scan ${scanLabel(currentScan)}?`)) return
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
          {/* Quick flip to the Heats tab */}
          {onGotoHeats && (
            <button
              onClick={onGotoHeats}
              className="px-2 py-0.5 text-xs rounded border bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200"
            >
              Goto Heat
            </button>
          )}

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
              ? `🤖 Gemini ${geminiTier === 'paid' ? '(payant)' : geminiTier === 'none' ? '(sans clé)' : '(gratuit)'}${backlogCount > 0 ? ` · ${backlogCount}` : ''}`
              : '🤖 Gemini OFF'}
          </button>

          {/* No key: background OCR silently waits — say so */}
          {geminiEnabled && geminiTier === 'none' && (
            <span
              className="text-xs px-2 py-0.5 rounded border bg-orange-50 text-orange-700 border-orange-300"
              title="Aucune clé API Gemini configurée : les fiches ne seront pas lues automatiquement. Saisie manuelle toujours possible."
            >
              ⚠ Aucune clé Gemini — Outils → Clés API Gemini…
            </span>
          )}

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
          {/* Scan list (left strip): one collapsible group per event */}
          <div className="w-60 flex flex-col bg-white border border-gray-200 rounded overflow-hidden">
            <div className="px-2 py-1.5 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 flex items-center justify-between">
              <span>Fiches</span>
              <span className="font-normal text-gray-500 flex gap-2">
                <button
                  onClick={() => setExpanded(new Set(groups.map((g) => g.key)))}
                  className="hover:text-blue-600"
                  title="Déplier toutes les épreuves"
                >⊞ Tout</button>
                <button
                  onClick={() => setExpanded(new Set(currentScan ? [groupKeyOf(currentScan)] : []))}
                  className="hover:text-blue-600"
                  title="Replier toutes les épreuves (sauf celle en cours)"
                >⊟ Replier</button>
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {groups.map((g) => {
                const open = expanded.has(g.key)
                const done = g.validated === g.items.length
                return (
                  <div key={g.key}>
                    <button
                      onClick={() => toggleGroup(g.key)}
                      className={`w-full text-left px-2 py-1.5 text-xs border-b border-gray-200 flex items-center gap-1.5 sticky top-0 z-10 ${
                        g.key === UNRESOLVED ? 'bg-orange-50 hover:bg-orange-100' : 'bg-gray-50 hover:bg-gray-100'
                      }`}
                      title={g.title}
                    >
                      <span className="text-gray-400 w-3 shrink-0">{open ? '▾' : '▸'}</span>
                      <span className={`flex-1 font-semibold leading-tight break-words ${done ? 'text-gray-400' : 'text-gray-700'}`}>{g.title}</span>
                      <span className={`shrink-0 font-mono ${done ? 'text-green-600' : 'text-gray-500'}`}>
                        {done ? '✓ ' : ''}{g.validated}/{g.items.length}
                      </span>
                    </button>
                    {open && g.items.map(({ scan, index }) => (
                      <button
                        key={scan.scanId}
                        ref={index === currentIndex ? currentItemRef : undefined}
                        onClick={() => setCurrentIndex(index)}
                        className={`w-full text-left pl-6 pr-2 py-1.5 text-xs border-b border-gray-100 flex items-center gap-2 ${
                          index === currentIndex ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'hover:bg-gray-50'
                        }`}
                      >
                        <span className={`${statusColor(scan.status)} font-bold`}>{statusLabel(scan.status)}</span>
                        <span className="font-mono flex-1 truncate">{itemLabel(scan)}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Image */}
          <div className="flex-1 flex flex-col bg-white border border-gray-200 rounded overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs flex justify-between items-center">
              <span className="font-mono font-bold">{blank ? 'Fiche vierge' : currentScan?.barcodeRaw}</span>
              {!blank && (
                <span className="text-gray-500">
                  Épr. {currentScan?.eventNumber} | Série {currentScan?.heatNumber} | Couloir {currentScan?.lane}
                </span>
              )}
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
              {/* Blank sheet: hand-written identity */}
              {blank && (
                <div className="mb-3 pb-3 border-b border-gray-200">
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ['Épr.', editEvent, setEditEvent],
                      ['Série', editHeat, setEditHeat],
                      ['Couloir', editLane, setEditLane],
                    ] as const).map(([label, value, set]) => (
                      <div key={label}>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">{label}</label>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={value}
                          onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
                          className="w-full font-mono text-center border-2 border-gray-300 rounded px-1 py-0.5 focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                  {targets.length > 1 && (
                    <select
                      value={targetId}
                      onChange={(e) => setTargetId(Number(e.target.value))}
                      className="mt-2 w-full text-xs border border-gray-300 rounded px-1 py-1"
                    >
                      <option value={0}>— Choisir la ronde —</option>
                      {targets.map((t) => (
                        <option key={t.swimEventId} value={t.swimEventId}>
                          {ROUND_LABEL[t.round] ?? `Ronde ${t.round}`}{t.hasTime ? ' (a déjà un temps)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="mt-2 text-xs">
                    {blankTarget ? (
                      <div className="text-gray-700">
                        <div className="font-semibold">{blankTarget.eventName}</div>
                        <div>{blankTarget.entryLabel}{blankTarget.clubCode ? ` (${blankTarget.clubCode})` : ''}</div>
                        {blankTarget.hasTime && <div className="text-orange-600">⚠ Ce couloir a déjà un temps — il sera remplacé</div>}
                      </div>
                    ) : editEvent && editHeat && editLane ? (
                      <div className="text-red-600">
                        {targets.length > 1 ? 'Choisissez la ronde' : 'Aucun nageur à ce couloir'}
                      </div>
                    ) : (
                      <div className="text-gray-400">Saisir épreuve / série / couloir</div>
                    )}
                  </div>

                  {/* The handwriting can be misread (7<->1, 2<->7...) and a wrong identity files the times under the wrong swimmer */}
                  {alternatives.length > 0 && (
                    <div className="mt-3">
                      <div className={`text-xs font-semibold mb-1 ${!blankTarget || blankTarget.hasTime ? 'text-orange-600' : 'text-gray-500'}`}>
                        Mal lu ? Autres lectures possibles
                      </div>
                      <div className="flex flex-col gap-1">
                        {alternatives.map((a) => (
                          <button
                            key={`${a.swimEventId}-${a.heatNumber}-${a.lane}`}
                            onClick={() => {
                              setEditEvent(String(a.eventNumber))
                              setEditHeat(String(a.heatNumber))
                              setEditLane(String(a.lane))
                              setTargetId(a.swimEventId)
                            }}
                            className="text-left text-xs border border-gray-200 rounded px-2 py-1 hover:bg-blue-50 hover:border-blue-300"
                            title={a.eventName}
                          >
                            <div className="font-mono font-semibold">
                              Épr. {a.eventNumber} · S{a.heatNumber} · C{a.lane}
                              {a.hasTime && <span className="font-sans font-normal text-orange-600"> · a déjà un temps</span>}
                            </div>
                            <div className="text-gray-600 truncate">
                              {a.entryLabel}{a.clubCode ? ` (${a.clubCode})` : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

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
                disabled={!editTime1 || !editTime2 || (blank && !blankTarget)}
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
// parseTimeInput used to be a bespoke variant of the same loose time parsing
// HeatsPage.tsx has; both now share shared-ui/src/logic/timeFormat.ts.

function parseTimeInput(str: string): number | null {
  return parseLooseTimeToMs(str)
}