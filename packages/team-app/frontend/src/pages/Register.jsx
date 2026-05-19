import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router'
import { useLang } from '../i18n'
import api from '../api'

function msToTime(ms) {
  if (!ms) return ''
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

function parseTime(str) {
  if (!str || str.trim().toLowerCase() === 'nt') return null
  const s = str.trim()
  let m = s.match(/^(\d+):(\d+)\.(\d+)$/)
  if (m) return parseInt(m[1]) * 60000 + parseInt(m[2]) * 1000 + parseInt(m[3]) * 10
  m = s.match(/^(\d+)\.(\d+)$/)
  if (m) return parseInt(m[1]) * 1000 + parseInt(m[2]) * 10
  return undefined
}

const AGE_CODE_ORDER = ['10-', '11-12', '13-14', '15-18', 'Open', 'Masters']

function TimeInput({ defaultValue, onSave }) {
  const [value, setValue] = useState(defaultValue || '')
  const [error, setError] = useState(false)

  function normalize(str) {
    if (!str || str.trim().toLowerCase() === 'nt') return ''
    let s = str.trim()
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
    <input className={`border border-gray-300 px-1 py-0.5 rounded text-xs w-20 font-mono ${error ? 'border-red-500 bg-red-50' : ''}`}
      placeholder="m:ss.cc"
      value={value}
      onChange={e => { setValue(e.target.value); setError(false) }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      onBlur={e => {
        const v = e.target.value
        if (!v || v.trim().toLowerCase() === 'nt') { onSave(''); return }
        const norm = normalize(v)
        if (norm === null) { setError(true); return }
        setValue(norm)
        setError(false)
        onSave(norm)
      }} />
  )
}

export default function Register() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [category, setCategory] = useState(null)
  const { t } = useLang()

  useEffect(() => { setCategory(null); load() }, [id])

  useEffect(() => {
    if (!data || category !== null) return
    const regs = [...data.individual_events, ...data.relay_events]
      .map(s => s.categories.find(c => c.registered))
      .filter(Boolean)
    setCategory(regs[0]?.age_code || data.suggested_age_code)
  }, [data])

  function load() {
    api.get(`/athletes/${id}/registration`).then(r => setData(r.data))
  }

  async function saveAthlete(field, value) {
    await api.put(`/athletes/${id}`, { [field]: value })
    if (field === 'birthdate') setCategory(null)
    load()
  }

  async function registerEvent(eventId, timeMs, ageCode = 'Open') {
    setSaving(true)
    await api.post('/registrations', { athlete_id: parseInt(id), event_id: eventId, entry_time_ms: timeMs, age_code: ageCode })
    await load()
    setSaving(false)
  }

  async function unregister(regId) {
    setSaving(true)
    await api.delete(`/registrations/${regId}`)
    await load()
    setSaving(false)
  }

  async function changeCategory(newCategory) {
    if (newCategory === category) return
    setSaving(true)
    const allStyles = [...data.individual_events, ...data.relay_events]
    for (const style of allStyles) {
      const reg = style.categories.find(c => c.registered)
      if (!reg) continue
      const newCat = style.categories.find(c => c.age_code === newCategory)
      if (!newCat) {
        await api.delete(`/registrations/${reg.registration_id}`)
        continue
      }
      if (newCat.event_id === reg.event_id && newCat.age_code === reg.age_code) continue
      await api.delete(`/registrations/${reg.registration_id}`)
      await api.post('/registrations', {
        athlete_id: parseInt(id),
        event_id: newCat.event_id,
        age_code: newCat.age_code,
        entry_time_ms: reg.entry_time_ms,
      })
    }
    setCategory(newCategory)
    await load()
    setSaving(false)
  }

  if (!data) return <div className="p-4 text-xs text-gray-500">Loading...</div>

  const isAdmin = localStorage.getItem('role') === 'admin'
  const closed = !isAdmin && data.closure_date && new Date() > new Date(data.closure_date + 'T23:59:59')
  if (closed) return (
    <div className="flex items-center justify-center h-full">
      <p className="text-red-600 text-sm font-semibold">
        {t.entries_closed || 'Les inscriptions sont fermées. / Entries are closed.'}
      </p>
    </div>
  )

  const { athlete, individual_events, relay_events, club_athletes, suggested_age_code, meet_course } = data
  const bestKey = meet_course === 'SCM' ? 'best_time_scm_ms' : 'best_time_lcm_ms'
  const activeCategory = category || suggested_age_code

  const availableCategories = (() => {
    const set = new Set()
    for (const style of [...individual_events, ...relay_events]) {
      for (const c of style.categories) set.add(c.age_code)
    }
    return AGE_CODE_ORDER.filter(c => set.has(c))
  })()

  const dropdownCategories = (() => {
    const naturalIdx = AGE_CODE_ORDER.indexOf(suggested_age_code)
    if (naturalIdx < 0) return availableCategories
    const allowed = new Set()
    for (let i = Math.max(0, naturalIdx - 1); i <= Math.min(AGE_CODE_ORDER.length - 1, naturalIdx + 1); i++) {
      allowed.add(AGE_CODE_ORDER[i])
    }
    if (activeCategory) allowed.add(activeCategory)
    return availableCategories.filter(c => allowed.has(c))
  })()

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
          <Link to="/" className="text-blue-600 hover:underline text-xs">← {t.athletes}</Link>
          <div className="w-px h-4 bg-gray-300" />
          <div className="flex items-center gap-3 flex-1">
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{t.last_name}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-28" defaultValue={athlete.last_name}
                     onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                     onBlur={e => saveAthlete('last_name', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{t.first_name}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-28" defaultValue={athlete.first_name}
                     onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                     onBlur={e => saveAthlete('first_name', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{t.gender}:</label>
              <select className="border border-gray-300 px-1 py-0.5 rounded text-xs" defaultValue={athlete.gender}
                      onChange={e => saveAthlete('gender', e.target.value)}>
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{t.dob}:</label>
              <input type="date" className="border border-gray-300 px-1.5 py-0.5 rounded text-xs" defaultValue={athlete.birthdate}
                     onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                     onBlur={e => saveAthlete('birthdate', e.target.value)} />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-gray-500">{t.nran}:</label>
              <input className="border border-gray-300 px-1.5 py-0.5 rounded text-xs w-20" defaultValue={athlete.license}
                     onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                     onBlur={e => saveAthlete('license', e.target.value)} />
            </div>
            <span className="text-xs text-gray-400">{athlete.club}</span>
          </div>
        </div>
      </div>

      {/* Category bar */}
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3 shrink-0">
        <label className="text-xs font-medium text-gray-700">{t.category}:</label>
        <select className="border border-gray-300 px-2 py-0.5 rounded text-xs"
          value={activeCategory}
          disabled={saving}
          onChange={e => changeCategory(e.target.value)}>
          {dropdownCategories.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {saving && <span className="text-xs text-gray-400 italic">saving...</span>}
      </div>

      {/* Events content */}
      <div className="flex-1 overflow-auto p-3">
        {/* Individual Events */}
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">{t.individual_events}</h3>
          <table className="w-full text-xs border-collapse border border-gray-300">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-2 py-1 w-6 text-center">✓</th>
                <th className="border border-gray-300 px-2 py-1 text-left">{t.event}</th>
                <th className="border border-gray-300 px-2 py-1 text-right w-20">{t.bt_50}</th>
                <th className="border border-gray-300 px-2 py-1 text-right w-20">{t.bt_25}</th>
                <th className="border border-gray-300 px-2 py-1 text-left w-24">{t.entry_time}</th>
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
                          if (reg) unregister(reg.registration_id)
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
                            await api.post('/registrations', {
                              athlete_id: parseInt(id), event_id: reg.event_id,
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
            <h3 className="text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">{t.relays}</h3>
            <table className="w-full text-xs border-collapse border border-gray-300">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-300 px-2 py-1 w-6 text-center">✓</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">{t.event}</th>
                  <th className="border border-gray-300 px-2 py-1 text-right w-20">{t.bt_50}</th>
                  <th className="border border-gray-300 px-2 py-1 text-right w-20">{t.bt_25}</th>
                  <th className="border border-gray-300 px-2 py-1 text-left w-24">{t.entry_time}</th>
                  <th className="border border-gray-300 px-2 py-1 text-left">{t.teammates}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRelays.map(style => {
                  const reg = style.categories.find(c => c.registered)
                  const teammateCount = style.relay_count - 1
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
                            if (reg) unregister(reg.registration_id)
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
                            — {t.already_registered_by} {lockedBy}
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
                              await api.post('/registrations', {
                                athlete_id: parseInt(id), event_id: reg.event_id,
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
