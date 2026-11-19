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

// Meet editor fields (MEETVALUES) <-> LENEX MEET header, both directions.
// The mapping is data: config/lenex-meet-fields.json, shared with team-app's
// backend/app/lenex_meet_fields.py — every field LENEX has a place for travels
// the way Splash Team Manager / Meet Manager exchange it (MEET attributes,
// POOL, FACILITY, QUALIFY, CONTACT, FEES). The Meet Manager settings LENEX
// can't carry (seeding, heats…) travel in the hidden `.meetvalues` zip entry.
// MEETVALUES values here are typed Splash strings: { KEY: 'TYPE;value' }.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

interface Place { el: string; attr: string; match?: Record<string, string> }
interface MeetField extends Place {
  key: string
  type: string
  also?: Place[]
  values?: Record<string, string>
  importAliases?: Record<string, string>
  date?: boolean
  cents?: boolean
}
interface Config { fields: MeetField[]; dotfileKeys: string[] }

/** Minimal shape of lenex.ts's parsed XML element */
export interface MeetXmlElem { tag: string; attrs: Record<string, string>; children: MeetXmlElem[] }

// MEET children, in Splash's order (after AGEDATE, before SESSIONS)
const CHILD_ORDER = ['POOL', 'FACILITY', 'QUALIFY', 'CONTACT', 'FEES']

function getConfigPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'lenex-meet-fields.json')
    : join(__dirname, '../../../../config/lenex-meet-fields.json')
}

let cached: Config | null = null
function config(): Config {
  if (!cached) cached = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as Config
  return cached
}

export function dotfileKeys(): Set<string> {
  return new Set(config().dotfileKeys)
}

function valueOf(typed: string): string {
  const semi = typed.indexOf(';')
  return (semi >= 0 ? typed.slice(semi + 1) : typed).trim()
}

function toLenex(f: MeetField, value: string): string | null {
  if (f.values) return f.values[value] ?? null
  if (f.date) {
    const d = value.replace(/-/g, '')
    return /^\d{8}/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
  }
  if (f.cents) {
    const n = parseFloat(value.replace(',', '.'))
    return Number.isFinite(n) ? String(Math.round(n * 100)) : null
  }
  return value
}

function fromLenex(f: MeetField, raw: string): string | null {
  if (f.values) {
    const reverse: Record<string, string> = {}
    for (const [k, v] of Object.entries(f.values)) reverse[v] = k
    Object.assign(reverse, f.importAliases ?? {})
    return reverse[raw.toUpperCase()] ?? null
  }
  if (f.date) {
    const d = raw.slice(0, 10).replace(/-/g, '')
    return /^\d{8}$/.test(d) ? `${d}000000000` : null
  }
  if (f.cents) {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return null
    return (n / 100).toFixed(2).replace(/\.?0+$/, '')
  }
  return raw
}

function findEl(meet: MeetXmlElem, place: Place): MeetXmlElem | undefined {
  if (!place.el) return meet
  if (place.el === 'FEES/FEE') {
    const fees = meet.children.find(c => c.tag === 'FEES')
    return fees?.children.find(c => c.tag === 'FEE' &&
      Object.entries(place.match ?? {}).every(([k, v]) => (c.attrs[k] ?? '').toUpperCase() === v.toUpperCase()))
  }
  return meet.children.find(c => c.tag === place.el.toUpperCase())
}

/** Every mapped field a MEET element carries → typed MEETVALUES. */
export function readMeetHeader(meet: MeetXmlElem): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of config().fields) {
    for (const place of [f, ...(f.also ?? [])]) {
      const raw = (findEl(meet, place)?.attrs[place.attr] ?? '').trim()
      if (!raw) continue
      const v = fromLenex(f, raw)
      if (v) { out[f.key] = `${f.type};${v}`; break }
    }
  }
  return out
}

/** `.meetvalues` zip entry → typed MEETVALUES (dotfile keys only). */
export function readMeetValuesDotfile(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return {}
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const keys = dotfileKeys()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (keys.has(k) && typeof v === 'string' && v.includes(';') && valueOf(v)) out[k] = v
  }
  return out
}

/** `.meetvalues` zip entry content for typed MEETVALUES. */
export function meetValuesDotfile(mv: Record<string, string>): string {
  const keys = dotfileKeys()
  return JSON.stringify(Object.fromEntries(Object.entries(mv).filter(([k]) => keys.has(k))))
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The MEET header for typed MEETVALUES: the MEET element's attributes (as one
 * ` a="v"…` string) and its child element lines (POOL, FACILITY, QUALIFY,
 * CONTACT, FEES — in that order), each without indentation.
 */
export function meetHeaderXml(mv: Record<string, string>): { attrs: string; children: string[] } {
  const meetAttrs: Array<[string, string]> = []
  const children = new Map<string, Array<[string, string]>>()
  const fees: Array<Array<[string, string]>> = []
  for (const f of config().fields) {
    const typed = mv[f.key]
    if (!typed) continue
    const lenex = toLenex(f, valueOf(typed))
    if (!lenex) continue
    for (const place of [f, ...(f.also ?? [])]) {
      if (!place.el) meetAttrs.push([place.attr, lenex])
      else if (place.el === 'FEES/FEE') fees.push([...Object.entries(place.match ?? {}), [place.attr, lenex]])
      else {
        if (!children.has(place.el)) children.set(place.el, [])
        children.get(place.el)!.push([place.attr, lenex])
      }
    }
  }
  const attrStr = (pairs: Array<[string, string]>): string => pairs.map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
  const lines: string[] = []
  for (const tag of CHILD_ORDER) {
    if (tag === 'FEES') {
      if (fees.length) {
        lines.push('<FEES>')
        for (const fee of fees) lines.push(`  <FEE${attrStr(fee)} />`)
        lines.push('</FEES>')
      }
    } else if (children.has(tag)) {
      lines.push(`<${tag}${attrStr(children.get(tag)!)} />`)
    }
  }
  return { attrs: attrStr(meetAttrs), children: lines }
}
