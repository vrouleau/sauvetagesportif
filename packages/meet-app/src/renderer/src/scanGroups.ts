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
 * Grouping of the Traitement scan list by event (a cascading, collapsible list).
 *
 * A big meet produces hundreds of scans, so the left list is one group per event, with a
 * "validated / total" counter. The flat, SORTED array stays the source of truth (the arrow keys
 * and the Suiv/Préc buttons walk it), and the groups are just contiguous runs of it.
 *
 * Pure (no React, no electron) so it can be unit tested.
 */

/** The scan fields this module needs. */
export interface GroupableScan {
  scanId: number
  swimEventId: number
  eventNumber: number
  heatNumber: number
  lane: number
  barcodeRaw: string
  status: string
  recognizedTime1: string | null
  recognizedTime2: string | null
}

export interface EventLabelLite {
  swimEventId: number
  eventNumber: number
  /** swimevent.round, Splash codes (src/main/rounds.ts) */
  round: number
  eventName: string
}

export interface ScanGroup<T extends GroupableScan> {
  key: string
  title: string
  items: Array<{ scan: T; index: number }>
  validated: number
}

/** swimevent.round, Splash codes (src/main/rounds.ts) */
export const ROUND_LABEL: Record<number, string> = { 1: 'Finale directe', 2: 'Préliminaire', 6: 'Demi-finale', 9: 'Finale' }

/** Group of blank sheets whose event could not be resolved yet. */
export const UNRESOLVED = 'unresolved'

export const isBlankScan = (scan: { barcodeRaw: string }): boolean => scan.barcodeRaw.startsWith('BLANK-')

/** A scan belongs to the group of its event (swimEventId: a prelim and its final are different groups). */
export function groupKeyOf(scan: { swimEventId: number }): string {
  return scan.swimEventId > 0 ? `u${scan.swimEventId}` : UNRESOLVED
}

/**
 * Display order = group order, so the arrow keys and "Suiv" walk the list exactly as it is shown:
 * blank sheets that still need an identity first (they block), then event by event, heat by
 * heat, lane by lane. Does not mutate its input.
 */
export function sortScans<T extends GroupableScan>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = a.swimEventId > 0
    const rb = b.swimEventId > 0
    if (ra !== rb) return ra ? 1 : -1
    if (ra) {
      if (a.eventNumber !== b.eventNumber) return a.eventNumber - b.eventNumber
      if (a.swimEventId !== b.swimEventId) return a.swimEventId - b.swimEventId
      if (a.heatNumber !== b.heatNumber) return a.heatNumber - b.heatNumber
      if (a.lane !== b.lane) return a.lane - b.lane
    }
    return a.scanId - b.scanId
  })
}

/** Cheap change detector for the polled list: equal keys = nothing to re-render. */
export function scanListKey(list: GroupableScan[]): string {
  return JSON.stringify(list.map((s) => ({
    id: s.scanId, s: s.status, t1: s.recognizedTime1, t2: s.recognizedTime2,
    e: s.eventNumber, h: s.heatNumber, l: s.lane, u: s.swimEventId,
  })))
}

export function groupTitle(
  scan: Pick<GroupableScan, 'swimEventId' | 'eventNumber'>,
  labels: Map<number, EventLabelLite>,
): string {
  if (scan.swimEventId <= 0) return 'Fiches vierges à identifier'
  const l = labels.get(scan.swimEventId)
  const base = `Épr. ${scan.eventNumber}${l?.eventName ? ` · ${l.eventName}` : ''}`
  // A prelim and its final share the event number: tell the two groups apart
  const shared = l ? [...labels.values()].filter((x) => x.eventNumber === l.eventNumber).length > 1 : false
  return shared && l ? `${base} (${ROUND_LABEL[l.round] ?? `ronde ${l.round}`})` : base
}

/** Row label inside a group (the event is already in the group title). */
export function itemLabel(scan: GroupableScan): string {
  if (scan.swimEventId > 0) return `Série ${scan.heatNumber} · Couloir ${scan.lane}${isBlankScan(scan) ? ' · vierge' : ''}`
  return scan.eventNumber > 0 ? `Vierge · E${scan.eventNumber}-S${scan.heatNumber}-C${scan.lane}` : 'Vierge · ?'
}

/** Contiguous runs of an already sorted list, one per event. `index` = position in that list. */
export function buildGroups<T extends GroupableScan>(sorted: T[], labels: Map<number, EventLabelLite>): ScanGroup<T>[] {
  const out: ScanGroup<T>[] = []
  sorted.forEach((scan, index) => {
    const key = groupKeyOf(scan)
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      g = { key, title: groupTitle(scan, labels), items: [], validated: 0 }
      out.push(g)
    }
    g.items.push({ scan, index })
    if (scan.status === 'validated') g.validated++
  })
  return out
}
