import { useState } from 'react'
import { useParams } from 'react-router'
import api from '../api'

export default function Secret() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function reveal() {
    setLoading(true)
    try {
      const r = await api.post(`/secret/${token}`, {})
      setData(r.data)
    } catch (e) {
      setError(e.detail || 'Lien invalide ou expiré. / Link invalid or expired.')
    }
    setLoading(false)
  }

  if (error) return (
    <div className="p-8 max-w-md mx-auto text-center">
      <p className="text-red-600 text-lg">{error}</p>
    </div>
  )

  if (!data) return (
    <div className="p-8 max-w-md mx-auto text-center">
      <h1 className="text-xl font-bold mb-4 text-balance">Révéler le NIP / Reveal PIN</h1>
      <button
        onClick={reveal}
        disabled={loading}
        className="bg-blue-600 text-white px-6 py-3 rounded text-lg hover:bg-blue-600/85 disabled:opacity-50">
        {loading ? '...' : 'Afficher / Show'}
      </button>
    </div>
  )

  return (
    <div className="p-8 max-w-md mx-auto text-center">
      <h1 className="text-xl font-bold mb-4 text-balance">PIN — {data.club}</h1>
      <div className="bg-gray-100 border-2 border-gray-300 rounded p-6 text-3xl font-mono tracking-widest transition-all duration-500 starting:opacity-0 starting:translate-y-2">
        {data.pin}
      </div>
      <p className="mt-4 text-sm text-gray-500 text-pretty">
        Ce lien est à usage unique. / This link is one-time use.
      </p>
    </div>
  )
}
