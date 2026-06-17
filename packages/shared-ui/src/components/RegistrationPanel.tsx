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

import { useState, useEffect } from 'react'
import { useLang } from '../context/LangContext'
import type { RegistrationData, RegistrationStyle } from '../data/api'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msToTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

function parseTime(str: string): number | null | undefined {
  if (!str || str.trim().toLowerCase() === 'nt') return null
  const s = str.trim()
  let match = s.match(/^(\d+):(\d+)\.(\d+)$/)
  if (match) return parseInt(match[1]) * 60000 + parseInt(match[2]) * 1000 + parseInt(match[3]) * 10
  match = s.match(/^(\d+)\.(\d+)$/)
  if (match) return parseInt(match[1]) * 1000 + parseInt(match[2]) * 10
  return undefined
}

const AGE_CODE_ORDER = ['10-', '11-12', '13-14', '15-18', 'Open', 'Masters']

// ─── TimeInput ────────────────────────────────────────────────────────────────

function TimeInput({ defaultValue, onSave }: { defaultValue: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(defaultValue || '')
  const [error, setError] = useState(false)

  function normalize(str: string): string | null {
    if (!str || str.trim().toLowerCase() === 'nt') return ''
    const s = str.trim()
    if (/^\d+:\d{2}\.\d{2}$/.test(s) || /^\d+\.\d{2}$/.test(s)) return s
    if (/^\d{3,6}$/.test(s)) {
      const padded = s.padStart(6, '0')
      const min = parseInt(padded.slice(0, -4)) || 0
      const sec = parseInt(padded.slice(-4, -2))
      const cs = parseInt(padded.slice(-2))
      if (sec >= 60 || cs >= 100) return null
      if (min > 0) return `${min}:${sec.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
      return `${sec}.${cs.toString().padStart(2, '0')}`
    }
    return null
  }

  return (
    <input
      className={`border border-gray-300 px-1 py-0.5 rounded text-xs w-20 font-mono ${error ? 'border-red-500 bg-red-50' : ''}`}
      placeholder="m:ss.cc"
      value={value}
      onChange={e => { setValue(e.target.value); setError(false) }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      onBlur={e => {
        const v = e.target.value
        if (!v || v.trim().toLowerCase() === 'nt') { onSave(''); return }
        const norm = normalize(v)
        if (norm === null) { setError(true); return }
        setValue(norm)
        setError(false)
        onSave(norm)
      }}
    />
  )
}

// ─── RegistrationPanel ────────────────────────────────────────────────────────

export interface RegistrationPanelProps {
  data: RegistrationData
  athleteId: number
  onRegister: (eventId: number, timeMs: number | null, ageCode: string) => void
  onUnregister: (regId: number) => void
  onUpdateEntryTime: (eventId: number, ageCode: string, timeMs: number | null) => void
  onSetRelayMember?: (eventId: number, position: number, athleteId: number | null) => void
}

export default function RegistrationPanel({
  data,
  athleteId,
  onRegister,
  onUnregister,
  onUpdateEntryTime,
  onSetRelayMember,
}: RegistrationPanelProps) {
  const { t } = useLang()
  const tr = t.registration

  const { individual_events, relay_events, club_athletes, suggested_age_code, meet_course, meet_type } = data
  const isBeach = (meet_type || 'POOL').toUpperCase() === 'BEACH'
  const bestKey: 'best_time_scm_ms' | 'best_time_lcm_ms' = meet_course === 'SCM' ? 'best_time_scm_ms' : 'best_time_lcm_ms'

  // Category state
  const [category, setCategory] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Determine initial category from existing registrations
  useEffect(() => {
    const regs = [...individual_events, ...relay_events]
      .map(s => s.categories.find(c => c.registered))
      .filter(Boolean)
    setCategory(regs[0]?.age_code || suggested_age_code)
  }, [athleteId, individual_events, relay_events, suggested_age_code])

  // Compute available and dropdown categories
  const availableCategories = (() => {
    const set = new Set<string>()
    for (const style of [...individual_events, ...relay_events]) {
      for (const c of style.categories) set.add(c.age_code)
    }
    return AGE_CODE_ORDER.filter(c => set.has(c))
  })()

  const dropdownCategories = (() => {
    const preferred = category || suggested_age_code
    const naturalIdx = AGE_CODE_ORDER.indexOf(suggested_age_code)
    if (naturalIdx < 0) return availableCategories
    const allowed = new Set<string>()
    for (let i = Math.max(0, naturalIdx - 1); i <= Math.min(AGE_CODE_ORDER.length - 1, naturalIdx + 1); i++) {
      allowed.add(AGE_CODE_ORDER[i])
    }
    if (preferred) allowed.add(preferred)
    return availableCategories.filter(c => allowed.has(c))
  })()

  // If preferred category isn't available in the dropdown, fall back to the closest one
  const activeCategory = (() => {
    const preferred = category || suggested_age_code
    if (dropdownCategories.includes(preferred)) return preferred
    if (dropdownCategories.length > 0) return dropdownCategories[0]
    return preferred
  })()

  const allowedSet = new Set(dropdownCategories)
  const visibleIndividual = individual_events.filter(s =>
    s.categories.some(c => allowedSet.has(c.age_code))
  )
  const visibleRelays = relay_events.filter(s =>
    s.categories.some(c => allowedSet.has(c.age_code))
  )

  // Category change handler — re-registers all events under new category
  async function changeCategory(newCategory: string) {
    if (newCategory === category) return
    setSaving(true)
    const allStyles: RegistrationStyle[] = [...individual_events, ...relay_events]
    for (const style of allStyles) {
      const reg = style.categories.find(c => c.registered)
      if (!reg) continue
      const newCat = style.categories.find(c => c.age_code === newCategory)
      if (!newCat) {
        onUnregister(reg.registration_id!)
        continue
      }
      if (newCat.event_id === reg.event_id && newCat.age_code === reg.age_code) continue
      onUnregister(reg.registration_id!)
      onRegister(newCat.event_id, reg.entry_time_ms ?? null, newCat.age_code)
    }
    setCategory(newCategory)
    setSaving(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Category bar */}
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3 shrink-0">
        <label className="text-xs font-medium text-gray-700">{tr.category}:</label>
        <select
          className="border border-gray-300 px-2 py-0.5 rounded text-xs"
          value={activeCategory}
          disabled={saving}
          onChange={e => changeCategory(e.target.value)}
        >
          {dropdownCategories.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {saving && <span className="text-xs text-gray-400 italic">{tr.saving}</span>}
      </div>

      {/* Events content */}
      <div className="flex-1 overflow-auto p-3">
        {/* Individual Events */}
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">{tr.individualEvents}</h3>
          <table className="w-full text-xs border-collapse border border-gray-300">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-2 py-1 w-6 text-center">✓</th>
                <th className="border border-gray-300 px-2 py-1 text-left">{tr.event}</th>
                {!isBeach && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt50}</th>}
                {!isBeach && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt25}</th>}
                {!isBeach && <th className="border border-gray-300 px-2 py-1 text-left w-24">{tr.entryTime}</th>}
              </tr>
            </thead>
            <tbody>
              {visibleIndividual.map(style => {
                const reg = style.categories.find(c => c.registered)
                const bestMs = style[bestKey]
                const catAvailable = style.categories.some(c => c.age_code === activeCategory)
                return (
                  <tr key={style.style_uid} className={reg ? 'bg-green-50' : 'hover:bg-blue-50'}>
                    <td className="border border-gray-300 px-2 py-0.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!reg}
                        disabled={saving || (!reg && !catAvailable)}
                        className="w-3.5 h-3.5"
                        onChange={() => {
                          if (reg) {
                            onUnregister(reg.registration_id!)
                          } else {
                            const cat = style.categories.find(c => c.age_code === activeCategory) || style.categories[0]
                            onRegister(cat.event_id, isBeach ? null : bestMs, cat.age_code)
                          }
                        }}
                      />
                    </td>
                    <td className="border border-gray-300 px-2 py-0.5">{style.style_name}</td>
                    {!isBeach && <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_lcm_ms)}</td>}
                    {!isBeach && <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_scm_ms)}</td>}
                    {!isBeach && (
                      <td className="border border-gray-300 px-2 py-0.5">
                        {reg && (
                          <TimeInput
                            defaultValue={msToTime(reg.entry_time_ms || bestMs)}
                            key={`${reg.registration_id}-${reg.entry_time_ms}`}
                            onSave={v => {
                              const ms = parseTime(v)
                              if (ms === undefined) return
                              onUpdateEntryTime(reg.event_id, reg.age_code, ms)
                            }}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Relay Events */}
        {visibleRelays.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">{tr.relays}</h3>
            <table className="w-full text-xs border-collapse border border-gray-300">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-300 px-2 py-1 w-6 text-center">✓</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">{tr.event}</th>
                  {!isBeach && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt50}</th>}
                  {!isBeach && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt25}</th>}
                  {!isBeach && <th className="border border-gray-300 px-2 py-1 text-left w-24">{tr.entryTime}</th>}
                  <th className="border border-gray-300 px-2 py-1 text-left">{tr.teammates}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRelays.map(style => {
                  const reg = style.categories.find(c => c.registered)
                  const teammateCount = (style.relay_count ?? 1) - 1
                  const bestMs = style[bestKey]
                  const catAvailable = style.categories.some(c => c.age_code === activeCategory)
                  const lockedBy = style.locked_by_name
                  const rowClass = lockedBy ? 'bg-gray-100 text-gray-400' : (reg ? 'bg-green-50' : 'hover:bg-blue-50')
                  return (
                    <tr key={style.style_uid} className={rowClass}>
                      <td className="border border-gray-300 px-2 py-0.5 text-center">
                        <input
                          type="checkbox"
                          checked={!!reg}
                          className="w-3.5 h-3.5"
                          disabled={saving || !!lockedBy || (!reg && !catAvailable)}
                          onChange={() => {
                            if (reg) {
                              onUnregister(reg.registration_id!)
                            } else {
                              const cat = style.categories.find(c => c.age_code === activeCategory) || style.categories[0]
                              onRegister(cat.event_id, isBeach ? null : bestMs, cat.age_code)
                            }
                          }}
                        />
                      </td>
                      <td className="border border-gray-300 px-2 py-0.5">
                        {style.style_name} ({style.relay_count}x)
                        {lockedBy && (
                          <span className="ml-2 text-2xs italic">
                            — {tr.alreadyRegisteredBy} {lockedBy}
                          </span>
                        )}
                      </td>
                      {!isBeach && <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_lcm_ms)}</td>}
                      {!isBeach && <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_scm_ms)}</td>}
                      {!isBeach && (
                        <td className="border border-gray-300 px-2 py-0.5">
                          {!lockedBy && reg && (
                            <TimeInput
                              defaultValue={msToTime(reg.entry_time_ms || bestMs)}
                              key={`r-${reg.registration_id}-${reg.entry_time_ms}`}
                              onSave={v => {
                                const ms = parseTime(v)
                                if (ms === undefined) return
                                onUpdateEntryTime(reg.event_id, reg.age_code, ms)
                              }}
                            />
                          )}
                        </td>
                      )}
                      <td className="border border-gray-300 px-2 py-0.5">
                        {!lockedBy && reg && (
                          <div className="flex flex-wrap gap-1">
                            {Array.from({ length: teammateCount }, (_, i) => {
                              const pos = i + 2 // position 2, 3, 4... (position 1 is the registering athlete)
                              const currentMember = style.relay_members?.find(m => m.position === pos)
                              return (
                                <select
                                  key={i}
                                  className="border border-gray-300 px-1 py-0.5 rounded text-xs w-36"
                                  value={currentMember?.athleteId ?? ''}
                                  onChange={e => {
                                    const val = e.target.value ? parseInt(e.target.value, 10) : null
                                    onSetRelayMember?.(reg.event_id, pos, val)
                                  }}
                                >
                                  <option value="">Member {pos}...</option>
                                  {club_athletes.map(a => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                  ))}
                                </select>
                              )
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}