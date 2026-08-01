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
import { useRegistrationApi } from '../context/RegistrationApiContext'
import type { RegistrationData, RegistrationStyle } from '../data/api'
import { formatEntryTime as msToTime, parseEntryTime as parseTime } from '../logic/timeFormat'
import { filterCategoriesAroundSuggestion, computeAvailableCategories } from '../logic/ageGroupCode'
import TimeInput from '../components/TimeInput'

interface RegistrationPageProps {
  athleteId: number
  onNavigateBack: () => void
}

export default function RegistrationPage({ athleteId, onNavigateBack }: RegistrationPageProps) {
  const { t } = useLang()
  const api = useRegistrationApi()
  const [data, setData] = useState<RegistrationData | null>(null)
  const [saving, setSaving] = useState(false)
  const [category, setCategory] = useState<string | null>(null)

  useEffect(() => { setCategory(null); load() }, [athleteId])

  useEffect(() => {
    if (!data || category !== null) return
    const regs = [...data.individual_events, ...data.relay_events]
      .map(s => s.categories.find(c => c.registered))
      .filter(Boolean)
    setCategory(regs[0]?.age_code || data.suggested_age_code)
  }, [data])

  function load() {
    api.getRegistration(athleteId).then(r => setData(r))
  }

  async function saveAthlete(field: string, value: string) {
    await api.updateAthlete(athleteId, { [field]: value })
    if (field === 'birthdate') setCategory(null)
    load()
  }

  async function registerEvent(eventId: number, timeMs: number | null, ageCode = 'Open') {
    setSaving(true)
    await api.register({ athlete_id: athleteId, event_id: eventId, entry_time_ms: timeMs, age_code: ageCode })
    load()
    setSaving(false)
  }

  async function unregister(regId: number) {
    setSaving(true)
    await api.unregister(regId)
    load()
    setSaving(false)
  }

  async function changeCategory(newCategory: string) {
    if (newCategory === category) return
    if (!data) return
    setSaving(true)
    const allStyles: RegistrationStyle[] = [...data.individual_events, ...data.relay_events]
    for (const style of allStyles) {
      const reg = style.categories.find(c => c.registered)
      if (!reg) continue
      const newCat = style.categories.find(c => c.age_code === newCategory)
      if (!newCat) {
        await api.unregister(reg.registration_id!)
        continue
      }
      if (newCat.event_id === reg.event_id && newCat.age_code === reg.age_code) continue
      await api.unregister(reg.registration_id!)
      await api.register({
        athlete_id: athleteId,
        event_id: newCat.event_id,
        age_code: newCat.age_code,
        entry_time_ms: reg.entry_time_ms ?? null,
      })
    }
    setCategory(newCategory)
    load()
    setSaving(false)
  }

  if (!data) return <div className="p-4 text-xs text-gray-500">{t.registration.loading}</div>

  const isAdmin = localStorage.getItem('role') === 'admin'
  const closed = !isAdmin && data.closure_date && new Date() > new Date(data.closure_date + 'T23:59:59')
  if (closed) return (
    <div className="flex items-center justify-center h-full">
      <p className="text-red-600 text-sm font-semibold">{t.registration.entriesClosed}</p>
    </div>
  )

  const { athlete, individual_events, relay_events, club_athletes, suggested_age_code, meet_course } = data
  const bestKey: 'best_time_scm_ms' | 'best_time_lcm_ms' = meet_course === 'SCM' ? 'best_time_scm_ms' : 'best_time_lcm_ms'
  const activeCategory = category || suggested_age_code
  const tr = t.registration

  const availableCategories = computeAvailableCategories([...individual_events, ...relay_events])

  const dropdownCategories = filterCategoriesAroundSuggestion(
    availableCategories,
    suggested_age_code,
    activeCategory
  )

  const allowedSet = new Set(dropdownCategories)
  const visibleIndividual = individual_events.filter(s =>
    s.categories.some(c => allowedSet.has(c.age_code))
  )
  const visibleRelays = relay_events.filter(s =>
    s.categories.some(c => allowedSet.has(c.age_code))
  )

  return (
    <div className="flex flex-col h-full">
      {/* Athlete header strip */}
      <div className="px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={onNavigateBack} className="text-blue-600 hover:underline text-xs">← {tr.athletes}</button>
          <div className="w-px h-4 bg-gray-300" />
          <div className="flex items-center gap-3 flex-1">
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{tr.lastName}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-28" defaultValue={athlete.last_name}
                     onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                     onBlur={e => saveAthlete('last_name', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{tr.firstName}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-28" defaultValue={athlete.first_name}
                     onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                     onBlur={e => saveAthlete('first_name', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{tr.gender}:</label>
              <select className="border border-gray-300 px-1 py-0.5 rounded text-xs" defaultValue={athlete.gender}
                      onChange={e => saveAthlete('gender', e.target.value)}>
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{tr.dob}:</label>
              <input type="date" className="border border-gray-300 px-1.5 py-0.5 rounded text-xs" defaultValue={athlete.birthdate}
                     onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                     onBlur={e => saveAthlete('birthdate', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{tr.nran}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-20" defaultValue={athlete.license}
                     onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                     onBlur={e => saveAthlete('license', e.target.value)} />
            </div>
            <span className="text-xs text-gray-400">{athlete.club}</span>
          </div>
        </div>
      </div>

      {/* Category bar */}
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3 shrink-0">
        <label className="text-xs font-medium text-gray-700">{tr.category}:</label>
        <select className="border border-gray-300 px-2 py-0.5 rounded text-xs"
          value={activeCategory}
          disabled={saving}
          onChange={e => changeCategory(e.target.value)}>
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
                <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt50}</th>
                <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt25}</th>
                <th className="border border-gray-300 px-2 py-1 text-left w-24">{tr.entryTime}</th>
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
                      <input type="checkbox" checked={!!reg} disabled={saving || (!reg && !catAvailable)}
                        className="w-3.5 h-3.5"
                        onChange={() => {
                          if (reg) unregister(reg.registration_id!)
                          else {
                            const cat = style.categories.find(c => c.age_code === activeCategory) || style.categories[0]
                            registerEvent(cat.event_id, bestMs, cat.age_code)
                          }
                        }} />
                    </td>
                    <td className="border border-gray-300 px-2 py-0.5">{style.style_name}</td>
                    <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_lcm_ms)}</td>
                    <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_scm_ms)}</td>
                    <td className="border border-gray-300 px-2 py-0.5">
                      {reg && (
                        <TimeInput defaultValue={msToTime(reg.entry_time_ms || bestMs)}
                          key={`${reg.registration_id}-${reg.entry_time_ms}`}
                          onSave={async v => {
                            const ms = parseTime(v)
                            if (ms === undefined) return
                            await api.register({
                              athlete_id: athleteId, event_id: reg.event_id,
                              age_code: reg.age_code, entry_time_ms: ms
                            })
                            load()
                          }} />
                      )}
                    </td>
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
                  <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt50}</th>
                  <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt25}</th>
                  <th className="border border-gray-300 px-2 py-1 text-left w-24">{tr.entryTime}</th>
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
                        <input type="checkbox" checked={!!reg}
                          className="w-3.5 h-3.5"
                          disabled={saving || !!lockedBy || (!reg && !catAvailable)}
                          onChange={() => {
                            if (reg) unregister(reg.registration_id!)
                            else {
                              const cat = style.categories.find(c => c.age_code === activeCategory) || style.categories[0]
                              registerEvent(cat.event_id, bestMs, cat.age_code)
                            }
                          }} />
                      </td>
                      <td className="border border-gray-300 px-2 py-0.5">
                        {style.style_name} ({style.relay_count}x)
                        {lockedBy && (
                          <span className="ml-2 text-2xs italic">
                            — {tr.alreadyRegisteredBy} {lockedBy}
                          </span>
                        )}
                      </td>
                      <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_lcm_ms)}</td>
                      <td className="border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500">{msToTime(style.best_time_scm_ms)}</td>
                      <td className="border border-gray-300 px-2 py-0.5">
                        {!lockedBy && reg && (
                          <TimeInput defaultValue={msToTime(reg.entry_time_ms || bestMs)}
                            key={`r-${reg.registration_id}-${reg.entry_time_ms}`}
                            onSave={async v => {
                              const ms = parseTime(v)
                              if (ms === undefined) return
                              await api.register({
                                athlete_id: athleteId, event_id: reg.event_id,
                                age_code: reg.age_code, entry_time_ms: ms
                              })
                              load()
                            }} />
                        )}
                      </td>
                      <td className="border border-gray-300 px-2 py-0.5">
                        {!lockedBy && reg && (
                          <div className="flex flex-wrap gap-1">
                            {Array.from({length: teammateCount}, (_, i) => (
                              <select key={i} className="border border-gray-300 px-1 py-0.5 rounded text-xs w-36">
                                <option value="">Member {i + 2}...</option>
                                {club_athletes.map(a => (
                                  <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                              </select>
                            ))}
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