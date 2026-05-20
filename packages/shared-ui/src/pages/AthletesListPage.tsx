import { useState, useEffect } from 'react'
import { useLang } from '../context/LangContext'
import { useRegistrationApi } from '../context/RegistrationApiContext'
import type { AthleteListItem, Club } from '../data/api'

interface AthletesListPageProps {
  role: string
  clubId?: string
  onNavigateToRegistration: (athleteId: number) => void
}

export default function AthletesListPage({ role, clubId, onNavigateToRegistration }: AthletesListPageProps) {
  const { t } = useLang()
  const api = useRegistrationApi()
  const [athletes, setAthletes] = useState<AthleteListItem[]>([])
  const [clubs, setClubs] = useState<Club[]>([])
  const [clubFilter, setClubFilter] = useState(clubId || sessionStorage.getItem('clubFilter') || '')
  const [search, setSearch] = useState('')
  const [showAddAthlete, setShowAddAthlete] = useState(false)

  const isAdmin = role === 'admin'
  const canViewAll = role === 'admin'

  useEffect(() => {
    api.getClubs().then(r => {
      setClubs(r)
      if (clubId) setClubFilter(clubId)
      else if (!clubFilter && r.length > 0) setClubFilter(String(r[0].id))
    })
  }, [])

  useEffect(() => {
    if (clubFilter) sessionStorage.setItem('clubFilter', clubFilter)
  }, [clubFilter])

  useEffect(() => {
    if (clubFilter) {
      api.getAthletesByClub(clubFilter).then(r => setAthletes(r))
    } else {
      api.getAllAthletes().then(r => setAthletes(r))
    }
  }, [clubFilter])

  function reload() {
    if (clubFilter) api.getAthletesByClub(clubFilter).then(r => setAthletes(r))
    else api.getAllAthletes().then(r => setAthletes(r))
  }

  const filtered = athletes.filter(a => {
    if (!search) return true
    return (a.first_name + ' ' + a.last_name).toLowerCase().includes(search.toLowerCase())
  })

  async function addAthlete(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    await api.addAthlete({
      first_name: fd.get('first_name') as string,
      last_name: fd.get('last_name') as string,
      gender: fd.get('gender') as string,
      birthdate: (fd.get('birthdate') as string) || null,
      license: (fd.get('license') as string) || '',
      club_id: parseInt(clubFilter),
    })
    setShowAddAthlete(false)
    reload()
  }

  async function deleteAthlete(id: number, name: string) {
    if (!confirm(`Delete ${name}?`)) return
    await api.deleteAthlete(id)
    reload()
  }

  const tr = t.registration

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        {canViewAll ? (
          <select value={clubFilter} onChange={e => setClubFilter(e.target.value)}
                  className="border border-gray-300 px-2 py-1 rounded text-xs">
            {clubs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.athlete_count ?? 0})</option>)}
          </select>
        ) : (
          <span className="text-xs font-semibold text-gray-700">
            {clubs.find(c => String(c.id) === clubFilter)?.name}
          </span>
        )}

        {isAdmin && api.resetClubPin && (
          <button onClick={async () => {
            if (!confirm('Reset PIN for this club?')) return
            const r = await api.resetClubPin!(clubFilter)
            alert(`New PIN: ${r.pin}`)
            api.getClubs().then(r => setClubs(r))
          }} className="text-orange-600 text-xs hover:underline">{tr.resetPin}</button>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <input type="text" placeholder={tr.search} value={search}
                 onChange={e => setSearch(e.target.value)}
                 className="border border-gray-300 px-2 py-1 rounded text-xs w-48" />
        </div>

        <button onClick={() => setShowAddAthlete(!showAddAthlete)}
                className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700">
          {tr.addAthlete}
        </button>

        <span className="text-gray-500 text-xs">{filtered.length} {tr.athletes.toLowerCase()}</span>
      </div>

      {/* Add athlete form */}
      {showAddAthlete && clubFilter && (
        <form onSubmit={addAthlete} className="px-3 py-2 bg-green-50 border-b border-green-200 flex items-center gap-2">
          <input name="first_name" placeholder={tr.firstName} className="border border-gray-300 px-2 py-1 rounded text-xs w-28" required />
          <input name="last_name" placeholder={tr.lastName} className="border border-gray-300 px-2 py-1 rounded text-xs w-28" required />
          <select name="gender" className="border border-gray-300 px-2 py-1 rounded text-xs">
            <option value="M">M</option><option value="F">F</option>
          </select>
          <input name="birthdate" type="date" className="border border-gray-300 px-2 py-1 rounded text-xs" />
          <input name="license" placeholder="NRAN" className="border border-gray-300 px-2 py-1 rounded text-xs w-24" />
          <button type="submit" className="px-3 py-1 bg-green-700 text-white text-xs rounded hover:bg-green-800">OK</button>
          <button type="button" onClick={() => setShowAddAthlete(false)} className="text-gray-500 text-xs hover:underline">✕</button>
        </form>
      )}

      {/* Athletes table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-gray-100 z-10">
            <tr>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{tr.lastName}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{tr.firstName}</th>
              <th className="text-center px-2 py-1.5 border-b border-gray-300 font-medium w-8">{tr.gender}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{tr.dob}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{tr.nran}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium w-20"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id} className="border-b border-gray-200 hover:bg-blue-50 cursor-pointer">
                <td className="px-2 py-1">{a.last_name}</td>
                <td className="px-2 py-1">{a.first_name}</td>
                <td className="px-2 py-1 text-center">{a.gender}</td>
                <td className="px-2 py-1">{a.birthdate}</td>
                <td className="px-2 py-1 text-gray-500">{a.license}</td>
                <td className="px-2 py-1 flex gap-2">
                  <button onClick={() => onNavigateToRegistration(a.id)}
                        className="text-blue-600 hover:underline">{tr.edit}</button>
                  <button onClick={() => deleteAthlete(a.id, `${a.first_name} ${a.last_name}`)}
                          className="text-red-500 hover:underline">{tr.delete}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
