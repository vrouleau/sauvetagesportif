import { useState, useEffect } from 'react'

interface PgConnectionConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

function pgApi() {
  return (window as unknown as {
    api?: {
      pg?: {
        connect: (config: PgConnectionConfig) => Promise<{ ok: boolean; info?: { type: string; label: string }; error?: string }>
        disconnect: () => Promise<{ ok: boolean; info?: { type: string; label: string } }>
        status: () => Promise<{ type: string; label: string }>
      }
    }
  }).api?.pg ?? null
}

export function PgConnectDialog({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('meetmgr')
  const [user, setUser] = useState('meetmgr')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [error, setError] = useState('')

  async function handleConnect() {
    setStatus('connecting')
    setError('')
    const api = pgApi()
    if (!api) {
      setStatus('error')
      setError('PG API not available')
      return
    }
    const result = await api.connect({
      host,
      port: parseInt(port, 10) || 5432,
      database,
      user,
      password,
    })
    if (result.ok) {
      onConnected()
      onClose()
    } else {
      setStatus('error')
      setError(result.error ?? 'Connection failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[400px] text-xs">
        <div className="flex items-center justify-between bg-indigo-700 text-white px-3 py-2">
          <span className="font-semibold">Connecter à PostgreSQL</span>
          <button onClick={onClose} className="hover:text-indigo-200 text-lg leading-none">×</button>
        </div>

        <div className="p-5 space-y-3">
          <div className="grid grid-cols-[100px_1fr] gap-2 items-center">
            <label className="text-gray-600 text-right">Hôte</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="border border-gray-300 px-2 py-1 text-xs"
              placeholder="localhost"
            />

            <label className="text-gray-600 text-right">Port</label>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="border border-gray-300 px-2 py-1 text-xs w-24"
              placeholder="5432"
            />

            <label className="text-gray-600 text-right">Base de données</label>
            <input
              type="text"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              className="border border-gray-300 px-2 py-1 text-xs"
              placeholder="meetmgr"
            />

            <label className="text-gray-600 text-right">Utilisateur</label>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="border border-gray-300 px-2 py-1 text-xs"
              placeholder="meetmgr"
            />

            <label className="text-gray-600 text-right">Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border border-gray-300 px-2 py-1 text-xs"
              onKeyDown={(e) => { if (e.key === 'Enter') handleConnect() }}
            />
          </div>

          {status === 'error' && (
            <div className="text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
            disabled={status === 'connecting'}
          >
            Annuler
          </button>
          <button
            onClick={handleConnect}
            disabled={status === 'connecting'}
            className="px-4 py-1 bg-indigo-600 text-white hover:bg-indigo-700 border border-indigo-700 disabled:opacity-50"
          >
            {status === 'connecting' ? 'Connexion…' : 'Connecter'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Hook to get PG connection status */
export function usePgStatus() {
  const [info, setInfo] = useState<{ type: string; label: string }>({ type: 'sqlite', label: 'Local (SQLite)' })

  async function refresh() {
    const api = pgApi()
    if (!api) return
    const status = await api.status()
    setInfo(status)
  }

  useEffect(() => { refresh() }, [])

  return { info, refresh }
}
