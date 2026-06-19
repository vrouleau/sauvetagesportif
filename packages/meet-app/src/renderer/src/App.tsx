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
import EventsPage from './pages/EventsPage'
import HeatsPage from './pages/HeatsPage'
import InscriptionPageWrapper from './pages/InscriptionPageWrapper'
import IndividualEntryPageWrapper from './pages/IndividualEntryPageWrapper'
import RelayEntryPageWrapper from './pages/RelayEntryPageWrapper'
import FinalsPage from './pages/FinalsPage'
import ReportPage from './pages/ReportPage'
import TimingScanPage from './pages/TimingScanPage'
import TimingProcessPage from './pages/TimingProcessPage'
import GuidePage from './pages/GuidePage'
import { GeminiKeyDialog } from './components/GeminiKeyDialog'
import { PgConnectDialog, usePgStatus } from './components/PgConnectDialog'
import { LangProvider, useLang } from '@shared/context/LangContext'
import logoSrc from '@shared/assets/icon.png'

type Page = 'events' | 'individualEntries' | 'relayEntries' | 'inscription' | 'finals' | 'heats' | 'report' | 'scan' | 'process'

interface ImportSummary {
  sessions: number; events: number; ageGroups: number
  heats: number; clubs: number; athletes: number; results: number
  errors: string[]
}

interface ExportSummary {
  sessions: number; events: number
  clubs: number; athletes: number; results: number
}

interface MeetExportSummary {
  sessions: number; events: number
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
        importLenex: (path: string, lang?: string) => Promise<{ ok: boolean; summary?: ImportSummary; error?: string }>
        exportMeetLenex: () => Promise<{ ok: boolean; canceled?: boolean; summary?: MeetExportSummary; error?: string }>
        exportLenexResults: () => Promise<{ ok: boolean; canceled?: boolean; summary?: ExportSummary; error?: string }>
        saveSMB: () => Promise<{ ok: boolean; canceled?: boolean; tables?: number; rows?: number; error?: string }>
        restoreSMB: () => Promise<{ ok: boolean; canceled?: boolean; tables?: number; rows?: number; error?: string }>
        newMeet: (meetType?: string, lang?: string) => Promise<{ ok: boolean; summary?: ImportSummary; meetType?: string; error?: string }>
      }
    }
  }).api?.file ?? null
}

function dbApi() {
  return (window as unknown as {
    api?: {
      db?: {
        flushMeet: () => Promise<{ ok: boolean; error?: string }>
        getMeetType: () => Promise<string>
        getMeetInfo: () => Promise<{ name: string }>
      }
    }
  }).api?.db ?? null
}

// ─── File Menu (now in native OS menu, events received via IPC) ───────────────

function menuApi() {
  return (window as unknown as {
    api?: {
      menu?: {
        onConfigureGemini: (cb: () => void) => () => void
        onOpenGuide: (cb: (guideType: string) => void) => () => void
        onImportLenex: (cb: () => void) => () => void
        onExportMeetLenex: (cb: () => void) => () => void
        onExportLenexResults: (cb: () => void) => () => void
        onSaveSMB: (cb: () => void) => () => void
        onRestoreSMB: (cb: () => void) => () => void
      }
      pg?: {
        onConnectPg: (cb: () => void) => () => void
        onDisconnectPg: (cb: () => void) => () => void
        disconnect: () => Promise<{ ok: boolean }>
        fingerprint: () => Promise<Record<string, number> | null>
      }
    }
  }).api ?? null
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

// ─── Flush Confirm Dialog ─────────────────────────────────────────────────────

interface SmbState {
  status: 'running' | 'done' | 'error'
  action: 'save' | 'restore'
  tables?: number
  rows?: number
  detail?: string
  error?: string
}

function SmbStatusDialog({
  state,
  onClose,
}: {
  state: SmbState
  onClose: () => void
}) {
  const title = state.action === 'save' ? 'Sauvegarder le meet (.smb)' : 'Restaurer un meet (.smb)'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[440px] text-xs">
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">{title}</span>
          {state.status !== 'running' && (
            <button onClick={onClose} className="hover:text-gray-300 text-lg leading-none">×</button>
          )}
        </div>

        <div className="p-5">
          {state.status === 'running' && (
            <div className="text-gray-500 italic">
              {state.action === 'save' ? 'Sauvegarde en cours…' : 'Restauration en cours…'}
            </div>
          )}
          {state.status === 'error' && (
            <div className="text-red-600">Erreur: {state.error}</div>
          )}
          {state.status === 'done' && (
            <>
              <div className="font-semibold text-green-700 mb-3">
                {state.action === 'save' ? 'Meet sauvegardé avec succès' : 'Meet restauré avec succès'}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-3">
                <div className="text-gray-500">Tables</div><div className="font-mono">{state.tables}</div>
                <div className="text-gray-500">Enregistrements</div><div className="font-mono">{state.rows}</div>
              </div>
              {state.detail && (
                <div className="mt-2 text-gray-600 text-xs whitespace-pre-wrap bg-gray-50 border border-gray-200 p-2 max-h-32 overflow-y-auto font-mono">
                  {state.detail}
                </div>
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

// ─── App ──────────────────────────────────────────────────────────────────────

function AppInner() {
  const [page, setPage] = useState<Page>('events')
  const { lang, setLang, t } = useLang()
  const [showGeminiConfig, setShowGeminiConfig] = useState(false)
  const [showPgConnect, setShowPgConnect] = useState(false)
  const [showGuide, setShowGuide] = useState<'pool' | 'beach' | null>(null)
  const [importState, setImportState] = useState<ImportState | null>(null)
  const [exportState, setExportState] = useState<{ status: 'done' | 'error'; summary?: ExportSummary; error?: string } | null>(null)
  const [smbState, setSmbState] = useState<SmbState | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [meetType, setMeetType] = useState<string>('POOL')
  const [meetName, setMeetName] = useState<string>('')
  const pgStatus = usePgStatus()
  const [livePushStatus, setLivePushStatus] = useState<{ status: string; queueSize: number }>({ status: 'disconnected', queueSize: 0 })

  // Sync lang to document element so non-React code (meetApiElectron) can read it
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // Load meet type and name on mount and after refresh
  useEffect(() => {
    dbApi()?.getMeetType().then((t) => setMeetType(t || 'POOL'))
    dbApi()?.getMeetInfo().then((info: { name: string }) => setMeetName(info?.name || ''))
  }, [refreshKey])

  // Poll live push status every 5s
  useEffect(() => {
    const liveApi = (window as any).api?.live
    if (!liveApi) return
    const poll = () => liveApi.getStatus().then((s: { status: string; queueSize: number }) => setLivePushStatus(s)).catch(() => {})
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  // Poll for database changes when in PG mode (every 3s)
  useEffect(() => {
    if (pgStatus.info.type !== 'pg') return
    let lastFingerprint: string | null = null
    const interval = setInterval(async () => {
      const apis = menuApi()
      const fp = await apis?.pg?.fingerprint()
      if (!fp) return
      const key = JSON.stringify(fp)
      if (lastFingerprint === null) {
        lastFingerprint = key
      } else if (key !== lastFingerprint) {
        lastFingerprint = key
        setRefreshKey((k) => k + 1)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [pgStatus.info.type])

  // Listen for native menu events
  useEffect(() => {
    const apis = menuApi()
    if (!apis) return
    const m = apis.menu
    const pg = apis.pg
    if (!m) return
    const cleanups = [
      m.onConfigureGemini(() => setShowGeminiConfig(true)),
      m.onOpenGuide((guideType) => setShowGuide(guideType as 'pool' | 'beach')),
      m.onImportLenex(() => handleImportLenex()),
      m.onExportMeetLenex(() => handleExportMeetLenex()),
      m.onExportLenexResults(() => handleExportLenexResults()),
      m.onSaveSMB(() => handleSaveSMB()),
      m.onRestoreSMB(() => handleRestoreSMB()),
      ...(pg ? [
        pg.onConnectPg(() => setShowPgConnect(true)),
        pg.onDisconnectPg(async () => {
          await pg.disconnect()
          pgStatus.refresh()
          handleRefresh()
        }),
      ] : []),
    ]
    return () => { cleanups.forEach((fn) => fn()) }
  }, [])

  async function handleImportLenex() {
    const f = fileApi()
    if (!f) return
    const path = await f.openLxfDialog()
    if (!path) return
    setImportState({ status: 'running' })
    const result = await f.importLenex(path, lang)
    if (result.ok && result.summary) {
      setImportState({ status: 'done', summary: result.summary })
    } else {
      setImportState({ status: 'error', error: result.error ?? 'Unknown error' })
    }
  }

  async function handleExportMeetLenex() {
    const f = fileApi()
    if (!f) return
    const result = await f.exportMeetLenex()
    if (result.canceled) return
    if (!result.ok) {
      alert(result.error ?? 'Export failed')
    }
  }

  async function handleExportLenexResults() {
    const f = fileApi()
    if (!f) return
    const result = await f.exportLenexResults()
    if (result.canceled) return
    if (result.ok && result.summary) {
      setExportState({ status: 'done', summary: result.summary })
    } else {
      setExportState({ status: 'error', error: result.error ?? 'Unknown error' })
    }
  }

  function handleRefresh() {
    setRefreshKey((k) => k + 1)
  }

  async function handleSaveSMB() {
    const f = fileApi()
    if (!f) return
    setSmbState({ status: 'running', action: 'save' })
    const result = await f.saveSMB()
    if (result.canceled) {
      setSmbState(null)
      return
    }
    if (result.ok) {
      setSmbState({ status: 'done', action: 'save', tables: result.tables, rows: result.rows })
    } else {
      setSmbState({ status: 'error', action: 'save', error: result.error })
    }
  }

  async function handleRestoreSMB() {
    const f = fileApi()
    if (!f) return
    setSmbState({ status: 'running', action: 'restore' })
    const result = await f.restoreSMB()
    if (result.canceled) {
      setSmbState(null)
      return
    }
    if (result.ok) {
      setSmbState({
        status: 'done', action: 'restore',
        tables: result.tables, rows: result.rows,
        detail: (result as { detail?: string }).detail,
      })
      handleRefresh()
    } else {
      setSmbState({ status: 'error', action: 'restore', error: result.error })
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
          {meetName || (lang === 'fr' ? 'Gestion de compétition' : 'Meet Management')}
        </span>
        {/* PG connection status */}
        {pgStatus.info.type === 'pg' && (
          <span className="text-green-400 text-[10px] mr-2" title={pgStatus.info.label}>
            🟢 PG: {pgStatus.info.label}
          </span>
        )}
        {pgStatus.info.type === 'sqlite' && (
          <span className="text-gray-500 text-[10px] mr-2">
            💾 SQLite
          </span>
        )}
        {/* Live push status */}
        {livePushStatus.status === 'connected' && (
          <span className="text-green-400 text-[10px] mr-2" title="Live push active">
            📡 Live
          </span>
        )}
        {livePushStatus.status === 'queued' && (
          <span className="text-yellow-400 text-[10px] mr-2" title={`${livePushStatus.queueSize} queued`}>
            📡 ({livePushStatus.queueSize})
          </span>
        )}
        {livePushStatus.status === 'disconnected' && livePushStatus.queueSize > 0 && (
          <span className="text-red-400 text-[10px] mr-2" title="Live push disconnected">
            📡 ✗
          </span>
        )}
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
        {(['events', 'individualEntries', 'relayEntries', 'finals', 'heats', 'report', ...(meetType !== 'BEACH' ? ['scan', 'process'] : [])] as Page[]).map((p) => {
          const labels: Record<Page, string> = {
            events: t.nav.events,
            individualEntries: t.nav.individualEntries,
            relayEntries: t.nav.relayEntries,
            inscription: t.nav.inscription,
            finals: t.nav.finals,
            heats: t.nav.heats,
            report: t.nav.report,
            scan: 'Scanner',
            process: 'Traitement',
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
        {meetType === 'BEACH' && (
          <span className="ml-auto flex items-center px-3 text-xs text-orange-300 font-semibold">
            🏖 PLAGE
          </span>
        )}
        {meetType === 'POOL' && (
          <span className="ml-auto flex items-center px-3 text-xs text-blue-300 font-semibold">
            🏊 PISCINE
          </span>
        )}
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        {page === 'events' && <EventsPage refreshKey={refreshKey} />}
        {page === 'individualEntries' && <IndividualEntryPageWrapper refreshKey={refreshKey} onImportLxf={handleImportLenex} onExportLxf={handleExportMeetLenex} />}
        {page === 'relayEntries' && <RelayEntryPageWrapper refreshKey={refreshKey} />}
        {page === 'inscription' && <InscriptionPageWrapper refreshKey={refreshKey} />}
        {page === 'finals' && <FinalsPage refreshKey={refreshKey} meetType={meetType} />}
        {page === 'heats' && <HeatsPage refreshKey={refreshKey} meetType={meetType} />}
        {page === 'report' && <ReportPage refreshKey={refreshKey} meetType={meetType} />}
        {page === 'scan' && <TimingScanPage />}
        {page === 'process' && <TimingProcessPage />}
      </div>

      {/* Modals */}
      {showGeminiConfig && <GeminiKeyDialog onClose={() => setShowGeminiConfig(false)} />}
      {showPgConnect && (
        <PgConnectDialog
          onClose={() => setShowPgConnect(false)}
          onConnected={() => { pgStatus.refresh(); handleRefresh() }}
        />
      )}
      {showGuide && <GuidePage guideType={showGuide} onClose={() => setShowGuide(null)} />}
      {smbState && <SmbStatusDialog state={smbState} onClose={() => setSmbState(null)} />}
      {importState && (
        <ImportStatusDialog
          state={importState}
          onClose={() => {
            setImportState(null)
            handleRefresh()  // auto-refresh after import
          }}
        />
      )}
      {exportState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white border border-gray-400 shadow-xl w-[440px] text-xs">
            <div className="flex items-center justify-between bg-green-700 text-white px-3 py-2">
              <span className="font-semibold">Export LENEX Résultats</span>
              <button onClick={() => setExportState(null)} className="hover:text-green-200 text-lg leading-none">×</button>
            </div>
            <div className="p-5">
              {exportState.status === 'done' && exportState.summary ? (
                <div className="space-y-2">
                  <p className="font-semibold text-green-700">Export réussi !</p>
                  <ul className="list-disc ml-5 text-gray-700 space-y-0.5">
                    <li>{exportState.summary.sessions} session(s)</li>
                    <li>{exportState.summary.events} épreuve(s)</li>
                    <li>{exportState.summary.clubs} club(s)</li>
                    <li>{exportState.summary.athletes} athlète(s)</li>
                    <li>{exportState.summary.results} résultat(s)</li>
                  </ul>
                </div>
              ) : (
                <p className="text-red-600">Erreur: {exportState.error}</p>
              )}
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => setExportState(null)}
                className="px-4 py-1 bg-green-600 text-white hover:bg-green-700 border border-green-700"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
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
