import { useState, useEffect } from 'react'

interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

interface TestResult {
  ok: boolean
  version?: string
  error?: string
}

function api() {
  return (window as unknown as {
    api?: {
      db?: {
        getConfig: () => Promise<DbConfig>
        configure: (cfg: DbConfig) => Promise<{ ok: boolean }>
        testConnection: () => Promise<TestResult>
      }
    }
  }).api?.db ?? null
}

export function DbConfigDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<DbConfig>({
    host: '192.168.1.190', port: 5432, user: 'meetmgr', password: 'meetmgr', database: 'meet',
  })
  const [original, setOriginal] = useState<DbConfig | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    api()?.getConfig().then((cfg) => {
      setForm(cfg)
      setOriginal(cfg)
    })
  }, [])

  function set(key: keyof DbConfig, value: string) {
    setForm((prev) => ({ ...prev, [key]: key === 'port' ? (parseInt(value, 10) || prev.port) : value }))
    setTestResult(null)
  }

  async function handleTest() {
    const db = api()
    if (!db) return
    setTesting(true)
    setTestResult(null)
    await db.configure(form)
    const result = await db.testConnection()
    setTestResult(result)
    setTesting(false)
  }

  async function handleSave() {
    await api()?.configure(form)
    onClose()
  }

  async function handleCancel() {
    if (original) await api()?.configure(original)
    onClose()
  }

  const Field = ({
    label, field, type = 'text',
  }: { label: string; field: keyof DbConfig; type?: string }) => (
    <div className="flex items-center gap-3 mb-2">
      <label className="w-24 text-right text-gray-600 text-xs shrink-0">{label}</label>
      <input
        type={type}
        className="flex-1 border border-gray-300 px-2 py-1 text-xs bg-white font-mono"
        value={String(form[field])}
        onChange={(e) => set(field, e.target.value)}
      />
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[420px] text-xs">
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">Configuration PostgreSQL</span>
          <button onClick={handleCancel} className="hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        <div className="p-5">
          <Field label="Hôte" field="host" />
          <Field label="Port" field="port" type="number" />
          <Field label="Utilisateur" field="user" />
          <Field label="Mot de passe" field="password" type="password" />
          <Field label="Base de données" field="database" />

          {testResult && (
            <div className={`mt-3 px-3 py-2 rounded text-xs font-mono ${
              testResult.ok
                ? 'bg-green-50 border border-green-300 text-green-800'
                : 'bg-red-50 border border-red-300 text-red-800'
            }`}>
              {testResult.ok
                ? `Connecté — ${testResult.version?.slice(0, 60) ?? ''}`
                : `Erreur: ${testResult.error}`}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-3 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700 disabled:opacity-50"
          >
            {testing ? 'Test…' : 'Tester la connexion'}
          </button>
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
            >
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
