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

import { useState, useEffect, useRef } from 'react'
import { useLang } from '../context/LangContext'
import type { RegistrationData, RegistrationStyle } from '../data/api'
import { formatEntryTime as msToTime, parseEntryTime as parseTime } from '../logic/timeFormat'
import { addMonthsIso } from '../logic/dateFormat'
import { eventDisplayName } from '../logic/eventName'
import { filterCategoriesAroundSuggestion, computeAvailableCategories, AGE_CODE_ORDER } from '../logic/ageGroupCode'
import TimeInput from './TimeInput'
import HelpTip from './HelpTip'

// ─── RegistrationPanel ────────────────────────────────────────────────────────

export interface RegistrationPanelProps {
  data: RegistrationData
  athleteId: number
  onRegister: (eventId: number, timeMs: number | null, ageCode: string) => void
  onUnregister: (regId: number) => void
  onUpdateEntryTime: (eventId: number, ageCode: string, timeMs: number | null) => void
  onSetHC?: (eventId: number, ageCode: string, entryTimeMs: number | null, isHC: boolean) => void
}

/** BT 50 / BT 25 cells — or, for a throw from the deck (course-free style),
 *  one cell spanning both: the pool's length doesn't matter there. */
function BestTimeCells({ style }: { style: RegistrationStyle }) {
  const cls = 'border border-gray-300 px-2 py-0.5 text-right font-mono text-gray-500'
  if (style.course_free) {
    return <td colSpan={2} className={`${cls} text-center`}>{msToTime(style.best_time_lcm_ms ?? style.best_time_scm_ms)}</td>
  }
  return (
    <>
      <td className={cls}>{msToTime(style.best_time_lcm_ms)}</td>
      <td className={cls}>{msToTime(style.best_time_scm_ms)}</td>
    </>
  )
}

/**
 * "?" bubble next to an individual entry time (team-app only — meet-app keeps
 * no best times, so it has no `best_time_policy`): where the pre-filled time
 * comes from (this athlete's best time, its date and origin, when it expires),
 * and what a typed time becomes — the athlete's new best time once the meet is
 * closed, dated to the meet start (see capture_coach_best_times, team-app).
 */
function EntryTimeHelp({ style, course, entryTimeMs, policy }: {
  style: RegistrationStyle
  course: 'lcm' | 'scm'
  entryTimeMs: number | null | undefined
  policy: NonNullable<RegistrationData['best_time_policy']>
}) {
  const { t } = useLang()
  const h = t.registration.entryTimeHelp
  const months = policy.max_age_months
  const bestMs = style[`best_time_${course}_ms`]
  const bestDate = style[`best_time_${course}_date`]
  const source = style[`best_time_${course}_source`]
  // The field shows the best time while no entry time is stored (see below).
  const shownMs = entryTimeMs || bestMs || null
  const following = bestMs != null && shownMs === bestMs
  const typedDate = policy.typed_time_date
  const typedUntil = addMonthsIso(typedDate, months)

  return (
    <HelpTip ariaLabel={h.ariaLabel}>
      <p className="font-semibold text-gray-800">{h.title}</p>
      <p>{h.rule(months)}</p>
      {bestMs != null ? (
        <p className="text-gray-800">
          {source === 'coach'
            ? h.fromCoach(msToTime(bestMs), bestDate || '?')
            : h.fromResult(msToTime(bestMs), bestDate || '?')}
          {bestDate && <> {h.expires(addMonthsIso(bestDate, months))}</>}
        </p>
      ) : (
        <p className="text-gray-600">{h.noBestTime(months)}</p>
      )}
      {following && <p className="text-gray-600">{h.following}</p>}
      {shownMs != null && !following
        ? <p className="text-amber-700">{h.typed(typedDate, months, typedUntil)} {h.fasterResult}</p>
        : <p className="text-gray-600">{h.ifTyped(typedDate, months, typedUntil)} {h.fasterResult}</p>}
    </HelpTip>
  )
}

export default function RegistrationPanel({
  data,
  athleteId,
  onRegister,
  onUnregister,
  onUpdateEntryTime,
  onSetHC,
}: RegistrationPanelProps) {
  const { t, lang } = useLang()
  const tr = t.registration

  const { individual_events, suggested_age_code, meet_course, meet_type } = data
  const isBeach = (meet_type || 'POOL').toUpperCase() === 'BEACH'
  const bestKey: 'best_time_scm_ms' | 'best_time_lcm_ms' = meet_course === 'SCM' ? 'best_time_scm_ms' : 'best_time_lcm_ms'
  const bestCourse: 'lcm' | 'scm' = meet_course === 'SCM' ? 'scm' : 'lcm'
  const policy = data.best_time_policy
  // MT 50m / MT 25m columns: only team-app has best-time history (it's the
  // one that sends best_time_policy); meet-app never has them, so hide them.
  const showBestTimes = !isBeach && !!policy

  // Category state
  const [category, setCategory] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Determine initial category from existing registrations
  useEffect(() => {
    const regs = individual_events
      .map(s => s.categories.find(c => c.registered))
      .filter(Boolean)
    setCategory(regs[0]?.age_code || suggested_age_code)
  }, [athleteId, individual_events, suggested_age_code])

  // Compute available and dropdown categories
  const availableCategories = computeAvailableCategories(individual_events)

  const dropdownCategories = filterCategoriesAroundSuggestion(
    availableCategories,
    suggested_age_code,
    category || suggested_age_code
  )

  // If preferred category isn't available in the dropdown, fall back to the closest one
  const activeCategory = (() => {
    const preferred = category || suggested_age_code
    if (dropdownCategories.includes(preferred)) return preferred
    if (dropdownCategories.length > 0) return dropdownCategories[0]
    return preferred
  })()

  // Entered in a bracket older than the athlete's own (e.g. a 13-14 athlete in
  // 15-18 because the meet has no 13-14 group) — easy to miss, since the
  // dropdown then offers only that one option.
  const isUpCategorized = (() => {
    const own = AGE_CODE_ORDER.indexOf(suggested_age_code as typeof AGE_CODE_ORDER[number])
    const cur = AGE_CODE_ORDER.indexOf(activeCategory as typeof AGE_CODE_ORDER[number])
    const masters = AGE_CODE_ORDER.indexOf('Masters')
    return own >= 0 && cur >= 0 && cur !== masters && cur > own
  })()

  const allowedSet = new Set(dropdownCategories)
  const visibleIndividual = individual_events.filter(s =>
    s.categories.some(c => allowedSet.has(c.age_code))
  )

  // Category change handler — re-registers all events under new category
  async function changeCategory(newCategory: string) {
    if (newCategory === category) return
    setSaving(true)
    for (const style of individual_events) {
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

  // "Select all" header checkbox state — only considers events available in active category
  const selectableIndividual = visibleIndividual.filter(style =>
    style.categories.some(c => c.age_code === activeCategory)
  )
  const allIndividualChecked = selectableIndividual.length > 0 && selectableIndividual.every(style => style.categories.some(c => c.registered))
  const someIndividualChecked = selectableIndividual.some(style => style.categories.some(c => c.registered))

  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someIndividualChecked && !allIndividualChecked
    }
  }, [someIndividualChecked, allIndividualChecked])

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
        {isUpCategorized && (
          <span
            className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5"
            title={tr.upCategorizedHelp.replace('{own}', suggested_age_code)}
          >
            ↑ {tr.upCategorized}
          </span>
        )}
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
                <th className="border border-gray-300 px-2 py-1 w-6 text-center">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5"
                    checked={allIndividualChecked}
                    ref={selectAllRef}
                    disabled={saving || selectableIndividual.length === 0}
                    onChange={() => {
                      if (allIndividualChecked) {
                        for (const style of selectableIndividual) {
                          const reg = style.categories.find(c => c.registered)
                          if (reg) onUnregister(reg.registration_id!)
                        }
                      } else {
                        for (const style of selectableIndividual) {
                          const reg = style.categories.find(c => c.registered)
                          if (!reg) {
                            const cat = style.categories.find(c => c.age_code === activeCategory)
                            if (cat) onRegister(cat.event_id, isBeach ? null : style[bestKey], cat.age_code)
                          }
                        }
                      }
                    }}
                  />
                </th>
                <th className="border border-gray-300 px-2 py-1 text-left">{tr.event}</th>
                {showBestTimes && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt50}</th>}
                {showBestTimes && <th className="border border-gray-300 px-2 py-1 text-right w-20">{tr.bt25}</th>}
                {!isBeach && <th className={`border border-gray-300 px-2 py-1 text-left ${policy ? 'w-28' : 'w-24'}`}>{tr.entryTime}</th>}
                <th className="border border-gray-300 px-2 py-1 text-center w-10" title={tr.hcTitle}>{tr.hc}</th>
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
                    <td className="border border-gray-300 px-2 py-0.5">{eventDisplayName({ nameFr: style.style_name, nameEn: style.style_name_en }, lang)}</td>
                    {showBestTimes && <BestTimeCells style={style} />}
                    {!isBeach && (
                      <td className="border border-gray-300 px-2 py-0.5">
                        {reg && (
                          <div className="flex items-center gap-1">
                            <TimeInput
                              defaultValue={msToTime(reg.entry_time_ms || bestMs)}
                              key={`${reg.registration_id}-${reg.entry_time_ms}`}
                              onSave={v => {
                                const ms = parseTime(v)
                                if (ms === undefined) return
                                onUpdateEntryTime(reg.event_id, reg.age_code, ms)
                              }}
                            />
                            {policy && (
                              <EntryTimeHelp style={style} course={bestCourse} entryTimeMs={reg.entry_time_ms} policy={policy} />
                            )}
                          </div>
                        )}
                      </td>
                    )}
                    <td className="border border-gray-300 px-2 py-0.5 text-center">
                      {reg && (
                        <input
                          type="checkbox"
                          checked={!!reg.hc}
                          disabled={saving}
                          className="w-3.5 h-3.5"
                          title={tr.hcTitle}
                          onChange={(e) => onSetHC?.(reg.event_id, reg.age_code, reg.entry_time_ms ?? null, e.target.checked)}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  )
}
