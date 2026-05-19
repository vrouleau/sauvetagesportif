import { useState, useEffect } from 'react'
import { Link } from 'react-router'
import { useLang } from '../i18n'
import api from '../api'

export default function Athletes({ role, clubId }) {
  const { t } = useLang()
  const [athletes, setAthletes] = useState([])
  const [clubs, setClubs] = useState([])
  const [clubFilter, setClubFilter] = useState(clubId || sessionStorage.getItem('clubFilter') || '')
  const [search, setSearch] = useState('')
  const [showAddAthlete, setShowAddAthlete] = useState(false)

  const isAdmin = role === 'admin'
  const canViewAll = role === 'admin'

  useEffect(() => {
    api.get('/clubs').then(r => {
      setClubs(r.data)
      if (clubId) setClubFilter(clubId)
      else if (!clubFilter && r.data.length > 0) setClubFilter(String(r.data[0].id))
    })
  }, [])

  useEffect(() => {
    if (clubFilter) sessionStorage.setItem('clubFilter', clubFilter)
  }, [clubFilter])

  useEffect(() => {
    if (clubFilter) {
      api.get(`/athletes?club_id=${clubFilter}`).then(r => setAthletes(r.data))
    } else {
      api.get('/athletes').then(r => setAthletes(r.data))
    }
  }, [clubFilter])

  function reload() {
    if (clubFilter) api.get(`/athletes?club_id=${clubFilter}`).then(r => setAthletes(r.data))
    else api.get('/athletes').then(r => setAthletes(r.data))
  }

  const filtered = athletes.filter(a => {
    if (!search) return true
    return (a.first_name + ' ' + a.last_name).toLowerCase().includes(search.toLowerCase())
  })

  async function addAthlete(e) {
    e.preventDefault()
    const fd = new FormData(e.target)
    await api.post('/athletes', {
      first_name: fd.get('first_name'),
      last_name: fd.get('last_name'),
      gender: fd.get('gender'),
      birthdate: fd.get('birthdate') || null,
      license: fd.get('license') || '',
      club_id: parseInt(clubFilter),
    })
    setShowAddAthlete(false)
    reload()
  }

  async function deleteAthlete(id, name) {
    if (!confirm(`Delete ${name}?`)) return
    await api.delete(`/athletes/${id}`)
    reload()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0">
        {canViewAll ? (
          <select value={clubFilter} onChange={e => setClubFilter(e.target.value)}
                  className="border border-gray-300 px-2 py-1 rounded text-xs">
            {clubs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.athlete_count})</option>)}
          </select>
        ) : (
          <span className="text-xs font-semibold text-gray-700">
            {clubs.find(c => String(c.id) === clubFilter)?.name}
          </span>
        )}

        {isAdmin && (
          <button onClick={async () => {
            if (!confirm('Reset PIN for this club?')) return
            const r = await api.post(`/clubs/${clubFilter}/reset-pin`, {})
            alert(`New PIN: ${r.data.pin}`)
            api.get('/clubs').then(r => setClubs(r.data))
          }} className="text-orange-600 text-xs hover:underline">{t.reset_pin}</button>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <input type="text" placeholder={t.search} value={search}
                 onChange={e => setSearch(e.target.value)}
                 className="border border-gray-300 px-2 py-1 rounded text-xs w-48" />
        </div>

        <button onClick={() => setShowAddAthlete(!showAddAthlete)}
                className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700">
          {t.add_athlete}
        </button>

        <span className="text-gray-500 text-xs">{filtered.length} {t.athletes.toLowerCase()}</span>
      </div>

      {/* Add athlete form */}
      {showAddAthlete && clubFilter && (
        <form onSubmit={addAthlete} className="px-3 py-2 bg-green-50 border-b border-green-200 flex items-center gap-2">
          <input name="first_name" placeholder={t.first_name} className="border border-gray-300 px-2 py-1 rounded text-xs w-28" required />
          <input name="last_name" placeholder={t.last_name} className="border border-gray-300 px-2 py-1 rounded text-xs w-28" required />
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
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{t.last_name}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{t.first_name}</th>
              <th className="text-center px-2 py-1.5 border-b border-gray-300 font-medium w-8">{t.gender}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{t.dob}</th>
              <th className="text-left px-2 py-1.5 border-b border-gray-300 font-medium">{t.nran}</th>
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
                  <Link to={`/athletes/${a.id}/register`}
                        className="text-blue-600 hover:underline">{t.edit}</Link>
                  <button onClick={() => deleteAthlete(a.id, `${a.first_name} ${a.last_name}`)}
                          className="text-red-500 hover:underline">{t.delete}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
