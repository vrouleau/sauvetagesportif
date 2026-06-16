import { useState, useEffect, useMemo } from 'react'
import { type Athlete } from '../data/mockData'
import { useLang } from '@shared/context/LangContext'

function dbApi() {
  return (window as unknown as {
    api?: {
      db?: {
        getAthletes: () => Promise<Athlete[]>
        saveAthlete: (athlete: unknown) => Promise<{ ok: boolean }>
        getMeetType: () => Promise<string>
      }
    }
  }).api?.db ?? null
}

export default function AthletesPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useLang()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editingAthlete, setEditingAthlete] = useState<Athlete | null>(null)
  const [sortKey, setSortKey] = useState<keyof Athlete>('lastName')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [isBeach, setIsBeach] = useState(false)

  useEffect(() => {
    setLoading(true)
    const api = dbApi()
    if (!api) { setLoading(false); return }
    api.getAthletes().then((rows) => {
      setAthletes(rows)
      setLoading(false)
    }).catch(() => setLoading(false))
    api.getMeetType().then((t) => setIsBeach((t || 'POOL').toUpperCase() === 'BEACH')).catch(() => {})
  }, [refreshKey])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return athletes
      .filter(
        (a) =>
          a.lastName.toLowerCase().includes(q) ||
          a.firstName.toLowerCase().includes(q) ||
          a.clubCode.toLowerCase().includes(q) ||
          a.clubName.toLowerCase().includes(q) ||
          a.nation.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const va = String(a[sortKey] ?? '')
        const vb = String(b[sortKey] ?? '')
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
      })
  }, [athletes, search, sortKey, sortDir])

  function sortBy(key: keyof Athlete) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function calcAge(birthDate: string): number {
    const birth = new Date(birthDate)
    const now = new Date()
    let age = now.getFullYear() - birth.getFullYear()
    const m = now.getMonth() - birth.getMonth()
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--
    return age
  }

  async function saveAthlete(updated: Athlete) {
    const api = dbApi()
    if (api) {
      try {
        await api.saveAthlete(updated)
      } catch {
        window.alert('Erreur lors de la sauvegarde')
        return
      }
    }
    setAthletes((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
    setEditingAthlete(null)
  }

  const ColHeader = ({ label, col }: { label: string; col: keyof Athlete }) => (
    <th
      className="px-2 py-1 text-left font-medium text-gray-600 cursor-pointer hover:bg-gray-200 select-none border-r border-gray-300 whitespace-nowrap"
      onClick={() => sortBy(col)}
    >
      {label}
      {sortKey === col && (
        <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '▲' : '▼'}</span>
      )}
    </th>
  )

  return (
    <div className="flex flex-col h-full text-xs">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 px-3 h-8 bg-gray-100 border-b border-gray-300 shrink-0">
        <label className="flex items-center gap-2 text-gray-600">
          {t.athletes.search}
          <input
            type="text"
            className="border border-gray-400 px-2 py-0.5 w-52 bg-white"
            placeholder={t.athletes.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </label>
        <span className="text-gray-400">
          {loading ? 'Chargement…' : t.athletes.athleteCount(filtered.length)}
        </span>
        <button
          className="ml-auto flex items-center gap-1 border border-gray-400 bg-white hover:bg-gray-50 px-2 py-0.5 rounded text-gray-600"
          onClick={() => {
            const newAthlete: Athlete = {
              id: Math.max(0, ...athletes.map((a) => a.id)) + 1,
              lastName: 'NOUVEAU',
              firstName: '',
              birthDate: '2000-01-01',
              gender: 'M',
              nation: 'CAN',
              clubCode: '',
              clubName: '',
              entries: [],
            }
            setAthletes((prev) => [...prev, newAthlete])
            setEditingAthlete(newAthlete)
          }}
        >
          {t.athletes.newAthlete}
        </button>
      </div>

      {/* ── Athlete table ── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="overflow-auto flex-1">
          <table className="w-full border-collapse heat-table">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-100 border-b border-gray-400">
                <ColHeader label={t.athletes.columns.lastName} col="lastName" />
                <ColHeader label={t.athletes.columns.firstName} col="firstName" />
                <th className="px-2 py-1 text-left font-medium text-gray-600 border-r border-gray-300 w-24">
                  {t.athletes.columns.birthDate}
                </th>
                <th className="px-2 py-1 text-center font-medium text-gray-600 border-r border-gray-300 w-10">
                  {t.athletes.columns.age}
                </th>
                <ColHeader label={t.athletes.columns.nation} col="nation" />
                <ColHeader label={t.athletes.columns.clubCode} col="clubCode" />
                <ColHeader label={t.athletes.columns.clubName} col="clubName" />
                <th className="px-2 py-1 text-center font-medium text-gray-600 border-r border-gray-300 w-8">
                  {t.athletes.columns.gender}
                </th>
                <th className="px-2 py-1 text-left font-medium text-gray-600 w-32">
                  {t.athletes.columns.licence}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((athlete, idx) => {
                const isEven = idx % 2 === 0
                return (
                  <tr
                    key={athlete.id}
                    className={`border-b border-gray-100 cursor-pointer select-none hover:bg-blue-100 ${
                      editingAthlete?.id === athlete.id
                        ? 'bg-blue-600 text-white'
                        : isEven
                        ? 'bg-white'
                        : 'bg-gray-50'
                    }`}
                    onDoubleClick={() => setEditingAthlete({ ...athlete })}
                    onClick={() =>
                      setEditingAthlete(
                        athlete.id === editingAthlete?.id ? editingAthlete : { ...athlete }
                      )
                    }
                  >
                    <td className="px-2 py-0.5 font-medium border-r border-gray-200">{athlete.lastName}</td>
                    <td className="px-2 py-0.5 border-r border-gray-200">{athlete.firstName}</td>
                    <td className="px-2 py-0.5 font-mono border-r border-gray-200">{athlete.birthDate}</td>
                    <td className="px-2 py-0.5 text-center border-r border-gray-200 text-gray-600">
                      {calcAge(athlete.birthDate)}
                    </td>
                    <td className="px-2 py-0.5 text-center font-mono border-r border-gray-200">
                      {athlete.nation}
                    </td>
                    <td className="px-2 py-0.5 text-center font-mono border-r border-gray-200">
                      {athlete.clubCode}
                    </td>
                    <td className="px-2 py-0.5 border-r border-gray-200">{athlete.clubName}</td>
                    <td className="px-2 py-0.5 text-center border-r border-gray-200">{athlete.gender}</td>
                    <td className="px-2 py-0.5 text-gray-500 font-mono">{athlete.licence ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── Entry list for selected athlete (bottom strip) ── */}
        {editingAthlete && (
          <div
            className="border-t-2 border-gray-400 bg-gray-50 shrink-0 overflow-auto"
            style={{ maxHeight: 120 }}
          >
            <div className="flex items-center h-6 px-3 bg-gray-200 border-b border-gray-300">
              <span className="font-semibold text-gray-700">
                {t.athletes.entries} — {editingAthlete.lastName}, {editingAthlete.firstName}
              </span>
            </div>
            {editingAthlete.entries.length === 0 ? (
              <div className="px-4 py-2 text-gray-400 italic">{t.athletes.noEntries}</div>
            ) : (
              <table className="w-full border-collapse heat-table">
                <thead>
                  <tr className="bg-gray-100 border-b border-gray-200">
                    <th className="px-2 py-0.5 text-left font-medium text-gray-600 border-r border-gray-200">
                      {t.athletes.entryColumns.event}
                    </th>
                    <th className="px-2 py-0.5 text-left font-medium text-gray-600 border-r border-gray-200">
                      {t.athletes.entryColumns.category}
                    </th>
                    <th className="px-2 py-0.5 text-center font-medium text-gray-600">
                      {t.athletes.entryColumns.entryTime}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {editingAthlete.entries.map((entry, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-blue-50">
                      <td className="px-2 py-0.5 border-r border-gray-200">{entry.eventName}</td>
                      <td className="px-2 py-0.5 border-r border-gray-200">{entry.category}</td>
                      <td className="px-2 py-0.5 text-center font-mono">{entry.entryTime ?? 'NT'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ── Edit dialog ── */}
      {editingAthlete && (
        <AthleteEditDialog
          athlete={editingAthlete}
          calcAge={calcAge}
          isBeach={isBeach}
          onSave={saveAthlete}
          onClose={() => setEditingAthlete(null)}
        />
      )}
    </div>
  )
}

// ─── Athlete Edit Dialog ───────────────────────────────────────────────────────

function AthleteEditDialog({
  athlete,
  calcAge,
  isBeach,
  onSave,
  onClose,
}: {
  athlete: Athlete
  calcAge: (d: string) => number
  isBeach: boolean
  onSave: (a: Athlete) => void
  onClose: () => void
}) {
  const { t } = useLang()
  const [form, setForm] = useState<Athlete>({ ...athlete })

  function set(key: keyof Athlete, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[600px] text-xs">
        {/* Dialog title bar */}
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-1.5">
          <span className="font-semibold">{t.athletes.dialog.title}</span>
          <button onClick={onClose} className="hover:text-gray-300 text-lg leading-none">
            ×
          </button>
        </div>

        <div className="flex divide-x divide-gray-200">
          {/* ── Left: Général ── */}
          <div className="flex-1 p-4">
            <div className="text-gray-500 font-semibold mb-3 pb-1 border-b border-gray-200">
              {t.athletes.dialog.general}
            </div>
            <div className="space-y-2">
              <Field label={t.athletes.dialog.lastName} value={form.lastName} onChange={(v) => set('lastName', v)} />
              <Field label={t.athletes.dialog.firstName} value={form.firstName} onChange={(v) => set('firstName', v)} />
              <div className="flex items-center gap-2">
                <label className="w-28 text-gray-600 shrink-0">{t.athletes.dialog.gender}</label>
                <select
                  className="border border-gray-300 px-1 py-0.5 bg-white"
                  value={form.gender}
                  onChange={(e) => set('gender', e.target.value)}
                >
                  <option value="M">{t.athletes.dialog.genderM}</option>
                  <option value="F">{t.athletes.dialog.genderF}</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="w-28 text-gray-600 shrink-0">{t.athletes.dialog.birthDate}</label>
                <input
                  type="date"
                  className="border border-gray-300 px-1 py-0.5 bg-white"
                  value={form.birthDate}
                  onChange={(e) => set('birthDate', e.target.value)}
                />
                <span className="text-gray-400 ml-1">
                  ({calcAge(form.birthDate)} {t.athletes.dialog.years})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="w-28 text-gray-600 shrink-0">{t.athletes.dialog.nationality}</label>
                <input
                  className="border border-gray-300 px-1 py-0.5 w-16 bg-white font-mono uppercase"
                  value={form.nation}
                  onChange={(e) => set('nation', e.target.value.toUpperCase())}
                  maxLength={3}
                />
              </div>
              <Field
                label={t.athletes.dialog.birthPlace}
                value={form.birthPlace ?? ''}
                onChange={(v) => set('birthPlace', v)}
              />
              <div className="mt-3 pt-2 border-t border-gray-100">
                <div className="text-gray-400 text-xs font-mono">
                  {form.lastName.toUpperCase()}, {form.firstName}
                </div>
              </div>
            </div>
          </div>

          {/* ── Right: Information additionnelle ── */}
          <div className="flex-1 p-4">
            <div className="text-gray-500 font-semibold mb-3 pb-1 border-b border-gray-200">
              {t.athletes.dialog.additional}
            </div>
            <div className="space-y-2">
              <Field
                label={t.athletes.dialog.licence}
                value={form.licence ?? ''}
                onChange={(v) => set('licence', v)}
              />
              {isBeach && form.beachNumber && (
                <div className="flex items-center gap-2">
                  <label className="w-28 text-gray-600 shrink-0">N° plage</label>
                  <span className="font-mono font-bold text-lg">{form.beachNumber}</span>
                </div>
              )}
              <div className="mt-3">
                <div className="text-gray-500 font-semibold mb-2 pb-1 border-b border-gray-200">
                  {t.athletes.dialog.club}
                </div>
                <div className="space-y-2">
                  <Field
                    label={t.athletes.dialog.clubCode}
                    value={form.clubCode}
                    onChange={(v) => set('clubCode', v)}
                    mono
                  />
                  <Field
                    label={t.athletes.dialog.clubName}
                    value={form.clubName}
                    onChange={(v) => set('clubName', v)}
                  />
                  <div className="flex items-center gap-2">
                    <label className="w-28 text-gray-600 shrink-0">{t.athletes.dialog.clubNation}</label>
                    <input
                      className="border border-gray-300 px-1 py-0.5 w-16 bg-white font-mono uppercase"
                      value={form.nation}
                      readOnly
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Entries list inside dialog */}
            <div className="mt-4 pt-2 border-t border-gray-200">
              <div className="text-gray-500 font-semibold mb-2">
                {t.athletes.dialog.entriesCount(form.entries.length)}
              </div>
              {form.entries.length === 0 ? (
                <div className="text-gray-300 italic">{t.athletes.dialog.noEntries}</div>
              ) : (
                <div className="space-y-0.5">
                  {form.entries.map((e, i) => (
                    <div key={i} className="flex gap-3 bg-gray-50 border border-gray-100 px-2 py-0.5">
                      <span className="flex-1">{e.eventName}</span>
                      <span className="text-gray-500">{e.category}</span>
                      <span className="font-mono text-gray-600">{e.entryTime ?? 'NT'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dialog buttons */}
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
          >
            {t.athletes.dialog.cancel}
          </button>
          <button
            onClick={() => onSave(form)}
            className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
          >
            {t.athletes.dialog.save}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-28 text-gray-600 shrink-0">{label}</label>
      <input
        className={`flex-1 border border-gray-300 px-1 py-0.5 bg-white ${mono ? 'font-mono uppercase' : ''}`}
        value={value}
        onChange={(e) => onChange(mono ? e.target.value.toUpperCase() : e.target.value)}
      />
    </div>
  )
}
