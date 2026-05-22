import { useState, useEffect } from 'react'
import EventsPage from './pages/EventsPage'
import HeatsPage from './pages/HeatsPage'
import InscriptionPageWrapper from './pages/InscriptionPageWrapper'
import FinalsPage from './pages/FinalsPage'
import ReportPage from './pages/ReportPage'
import { DbConfigDialog } from './components/DbConfigDialog'
import { competition } from './data/mockData'
import { LangProvider, useLang } from '@shared/context/LangContext'
import logoSrc from './assets/logo.png'

type Page = 'events' | 'inscription' | 'finals' | 'heats' | 'report'

interface ImportSummary {
  sessions: number; events: number; ageGroups: number
  heats: number; clubs: number; athletes: number; results: number
  errors: string[]
}

interface ImportState {
  status: 'idle' | 'running' | 'done' | 'error'
  summary?: ImportSummary
  error?: string
}

function fileApi() {
  return (window as unknown as {
    api?: {
      file?: {
        openLxfDialog: () => Promise<string | null>
        importLenex: (path: string) => Promise<{ ok: boolean; summary?: ImportSummary; error?: string }>
        saveSMB: () => Promise<{ ok: boolean; canceled?: boolean; tables?: number; rows?: number; error?: string }>
        restoreSMB: () => Promise<{ ok: boolean; canceled?: boolean; tables?: number; rows?: number; error?: string }>
        newMeet: () => Promise<{ ok: boolean; summary?: ImportSummary; error?: string }>
      }
    }
  }).api?.file ?? null
}

function dbApi() {
  return (window as unknown as {
    api?: {
      db?: {
        syncUp: () => Promise<{ ok: boolean; tablesCreated?: string[]; error?: string }>
        flushMeet: () => Promise<{ ok: boolean; error?: string }>
      }
    }
  }).api?.db ?? null
}

// ─── File Menu (now in native OS menu, events received via IPC) ───────────────

function menuApi() {
  return (window as unknown as {
    api?: {
      menu?: {
        onConfigureDb: (cb: () => void) => () => void
        onSyncDown: (cb: () => void) => () => void
        onSyncUp: (cb: () => void) => () => void
        onImportLenex: (cb: () => void) => () => void
        onSaveSMB: (cb: () => void) => () => void
        onRestoreSMB: (cb: () => void) => () => void
        onNewMeet: (cb: () => void) => () => void
      }
    }
  }).api?.menu ?? null
}

// ─── Import Status Dialog ─────────────────────────────────────────────────────

function ImportStatusDialog({
  state,
  onClose,
}: {
  state: ImportState
  onClose: () => void
}) {
  const s = state.summary

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[440px] text-xs">
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">Import LENEX</span>
          {state.status !== 'running' && (
            <button onClick={onClose} className="hover:text-gray-300 text-lg leading-none">×</button>
          )}
        </div>

        <div className="p-5">
          {state.status === 'running' && (
            <div className="text-gray-500 italic">Importation en cours…</div>
          )}
          {state.status === 'error' && (
            <div className="text-red-600">Erreur: {state.error}</div>
          )}
          {state.status === 'done' && s && (
            <>
              <div className="font-semibold text-green-700 mb-3">Import terminé avec succès</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                <div className="text-gray-500">Sessions</div><div className="font-mono">{s.sessions}</div>
                <div className="text-gray-500">Épreuves</div><div className="font-mono">{s.events}</div>
                <div className="text-gray-500">Catégories d'âge</div><div className="font-mono">{s.ageGroups}</div>
                <div className="text-gray-500">Vagues</div><div className="font-mono">{s.heats}</div>
                <div className="text-gray-500">Clubs</div><div className="font-mono">{s.clubs}</div>
                <div className="text-gray-500">Athlètes</div><div className="font-mono">{s.athletes}</div>
                <div className="text-gray-500">Résultats</div><div className="font-mono">{s.results}</div>
              </div>
              {s.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="text-orange-600 cursor-pointer">
                    {s.errors.length} avertissement(s)
                  </summary>
                  <div className="mt-1 max-h-32 overflow-y-auto bg-gray-50 border border-gray-200 p-2 font-mono text-xs space-y-0.5">
                    {s.errors.map((e, i) => <div key={i} className="text-orange-700">{e}</div>)}
                  </div>
                </details>
              )}
            </>
          )}
        </div>

        {state.status !== 'running' && (
          <div className="flex justify-end px-5 py-3 border-t border-gray-200 bg-gray-50">
            <button
              onClick={onClose}
              className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
            >
              Fermer
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sync-Up Dialog ───────────────────────────────────────────────────────────

interface SyncUpState {
  status: 'running' | 'done' | 'error'
  tablesCreated?: string[]
  error?: string
}

function SyncUpDialog({
  state,
  onClose,
}: {
  state: SyncUpState
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[420px] text-xs">
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">Synchronisation ↑ (app → BD)</span>
          {state.status !== 'running' && (
            <button onClick={onClose} className="hover:text-gray-300 text-lg leading-none">×</button>
          )}
        </div>

        <div className="p-5">
          {state.status === 'running' && (
            <div className="text-gray-500 italic">Synchronisation en cours…</div>
          )}
          {state.status === 'error' && (
            <div className="text-red-600">Erreur: {state.error}</div>
          )}
          {state.status === 'done' && (
            state.tablesCreated && state.tablesCreated.length > 0 ? (
              <>
                <div className="font-semibold text-green-700 mb-2">
                  Base de données initialisée — {state.tablesCreated.length} table(s) créée(s)
                </div>
                <ul className="list-disc ml-4 space-y-0.5 text-gray-700">
                  {state.tablesCreated.map(t => <li key={t} className="font-mono">{t}</li>)}
                </ul>
              </>
            ) : (
              <div className="text-gray-700">La base de données est déjà à jour — aucune table à créer.</div>
            )
          )}
        </div>

        {state.status !== 'running' && (
          <div className="flex justify-end px-5 py-3 border-t border-gray-200 bg-gray-50">
            <button
              onClick={onClose}
              className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
            >
              Fermer
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Flush Confirm Dialog ─────────────────────────────────────────────────────

function FlushConfirmDialog({
  onConfirm,
  onClose,
  running,
  error,
}: {
  onConfirm: () => void
  onClose: () => void
  running: boolean
  error?: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[420px] text-xs">
        <div className="flex items-center justify-between bg-red-700 text-white px-3 py-2">
          <span className="font-semibold">Créer un nouveau meet</span>
          {!running && (
            <button onClick={onClose} className="hover:text-red-200 text-lg leading-none">×</button>
          )}
        </div>

        <div className="p-5">
          {running ? (
            <div className="text-gray-500 italic">Réinitialisation et importation en cours…</div>
          ) : error ? (
            <div className="text-red-600">Erreur: {error}</div>
          ) : (
            <>
              <p className="mb-3 font-semibold text-red-700">
                Cette action supprimera TOUTES les données du meet et importera le gabarit par défaut:
              </p>
              <ul className="list-disc ml-5 space-y-0.5 text-gray-700 mb-4">
                <li>Sessions, épreuves, catégories d'âge, vagues</li>
                <li>Clubs et athlètes</li>
                <li>Tous les résultats et temps chronométrés</li>
                <li>Les styles de nage seront réimportés du gabarit</li>
              </ul>
              <p className="text-gray-500">Cette action est irréversible.</p>
            </>
          )}
        </div>

        {!running && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
            {error ? (
              <button
                onClick={onClose}
                className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
              >
                Fermer
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
                >
                  Annuler
                </button>
                <button
                  onClick={onConfirm}
                  className="px-4 py-1 bg-red-600 text-white hover:bg-red-700 border border-red-700"
                >
                  Créer un nouveau meet
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

function AppInner() {
  const [page, setPage] = useState<Page>('events')
  const { lang, setLang, t } = useLang()
  const [showDbConfig, setShowDbConfig] = useState(false)
  const [importState, setImportState] = useState<ImportState | null>(null)
  const [flushState, setFlushState] = useState<{ open: boolean; running: boolean; error?: string } | null>(null)
  const [syncUpState, setSyncUpState] = useState<SyncUpState | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Listen for native menu events
  useEffect(() => {
    const m = menuApi()
    if (!m) return
    const cleanups = [
      m.onConfigureDb(() => setShowDbConfig(true)),
      m.onSyncDown(() => handleRefresh()),
      m.onSyncUp(() => handleSyncUp()),
      m.onImportLenex(() => handleImportLenex()),
      m.onSaveSMB(() => handleSaveSMB()),
      m.onRestoreSMB(() => handleRestoreSMB()),
      m.onNewMeet(() => setFlushState({ open: true, running: false })),
    ]
    return () => { cleanups.forEach((fn) => fn()) }
  }, [])

  async function handleImportLenex() {
    const f = fileApi()
    if (!f) return
    const path = await f.openLxfDialog()
    if (!path) return
    setImportState({ status: 'running' })
    const result = await f.importLenex(path)
    if (result.ok && result.summary) {
      setImportState({ status: 'done', summary: result.summary })
    } else {
      setImportState({ status: 'error', error: result.error ?? 'Unknown error' })
    }
  }

  function handleRefresh() {
    setRefreshKey((k) => k + 1)
  }

  async function handleSyncUp() {
    setSyncUpState({ status: 'running' })
    const result = await dbApi()?.syncUp()
    if (!result || result.ok) {
      setSyncUpState({ status: 'done', tablesCreated: result?.tablesCreated ?? [] })
    } else {
      setSyncUpState({ status: 'error', error: result.error })
    }
  }

  async function handleSaveSMB() {
    const f = fileApi()
    if (!f) return
    const result = await f.saveSMB()
    if (result.canceled) return
    if (result.ok) {
      window.alert(`Meet sauvegardé: ${result.rows} enregistrements dans ${result.tables} tables.`)
    } else {
      window.alert(`Erreur: ${result.error}`)
    }
  }

  async function handleRestoreSMB() {
    const f = fileApi()
    if (!f) return
    const result = await f.restoreSMB()
    if (result.canceled) return
    if (result.ok) {
      window.alert(`Meet restauré: ${result.rows} enregistrements dans ${result.tables} tables.\n\n${(result as { detail?: string }).detail ?? ''}`)
      handleRefresh()
    } else {
      window.alert(`Erreur: ${result.error}`)
    }
  }

  async function handleFlushConfirm() {
    setFlushState({ open: true, running: true })
    const f = fileApi()
    if (!f) {
      setFlushState({ open: true, running: false, error: 'File API not available' })
      return
    }
    const result = await f.newMeet()
    if (result.ok) {
      setFlushState(null)
      if (result.summary) {
        setImportState({ status: 'done', summary: result.summary })
      }
      handleRefresh()
    } else {
      setFlushState({ open: true, running: false, error: result.error })
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* Title bar */}
      <div className="flex items-center h-8 bg-gray-800 text-white text-xs select-none shrink-0">
        <img src={logoSrc} alt="Logo" className="h-5 w-5 ml-2 mr-1" />
        <span className="px-1 font-semibold text-gray-300">SauvetageMeet</span>
        <span className="text-gray-500 mr-1">|</span>
        <span className="text-gray-300 truncate mr-4">
          {competition.nameFr} — {competition.city} ({competition.nation}) {competition.poolSize}m
        </span>
        {/* Language toggle */}
        <div className="ml-auto flex items-center gap-1 pr-3">
          <button
            onClick={() => setLang('fr')}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
              lang === 'fr'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400'
            }`}
          >
            FR
          </button>
          <button
            onClick={() => setLang('en')}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
              lang === 'en'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400'
            }`}
          >
            EN
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex h-8 bg-gray-700 shrink-0 border-b border-gray-900">
        {(['events', 'inscription', 'finals', 'heats', 'report'] as Page[]).map((p) => {
          const labels: Record<Page, string> = {
            events: t.nav.events,
            inscription: t.nav.inscription,
            finals: t.nav.finals,
            heats: t.nav.heats,
            report: t.nav.report,
          }
          return (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`px-5 h-full text-xs font-medium border-r border-gray-600 transition-colors ${
                page === p
                  ? 'bg-white text-gray-900 shadow-inner'
                  : 'text-gray-300 hover:bg-gray-600 hover:text-white'
              }`}
            >
              {labels[p]}
            </button>
          )
        })}
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        {page === 'events' && <EventsPage refreshKey={refreshKey} />}
        {page === 'inscription' && <InscriptionPageWrapper refreshKey={refreshKey} />}
        {page === 'finals' && <FinalsPage refreshKey={refreshKey} />}
        {page === 'heats' && <HeatsPage refreshKey={refreshKey} />}
        {page === 'report' && <ReportPage refreshKey={refreshKey} />}
      </div>

      {/* Modals */}
      {showDbConfig && <DbConfigDialog onClose={() => setShowDbConfig(false)} />}
      {syncUpState && (
        <SyncUpDialog
          state={syncUpState}
          onClose={() => setSyncUpState(null)}
        />
      )}
      {flushState?.open && (
        <FlushConfirmDialog
          running={flushState.running}
          error={flushState.error}
          onConfirm={handleFlushConfirm}
          onClose={() => setFlushState(null)}
        />
      )}
      {importState && (
        <ImportStatusDialog
          state={importState}
          onClose={() => {
            setImportState(null)
            handleRefresh()  // auto-refresh after import
          }}
        />
      )}
    </div>
  )
}

export default function App() {
  return (
    <LangProvider>
      <AppInner />
    </LangProvider>
  )
}
