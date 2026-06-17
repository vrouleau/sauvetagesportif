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

import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate, Navigate } from 'react-router'
import './index.css'
import { LangProvider, useLang } from './i18n'
import Login from './pages/Login'
import EventsPageShared from '@shared/pages/EventsPage'
import InscriptionPageShared from '@shared/pages/InscriptionPage'
import IndividualEntryPageShared from '@shared/pages/IndividualEntryPage'
import RelayEntryPageShared from '@shared/pages/RelayEntryPage'
import { ApiProvider } from '@shared/context/ApiContext'
import { LangProvider as SharedLangProvider } from '@shared/context/LangContext'
import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import AthletesListPageShared from '@shared/pages/AthletesListPage'
import RegistrationPageShared from '@shared/pages/RegistrationPage'
import { meetApiHttp } from './meetApi'
import { registrationApiHttp } from './registrationApi'
import api from './api'
import Admin from './pages/Admin'
import Organizer from './pages/Organizer'
import SercPage from './pages/Serc'
import SercJudgePage from './pages/SercJudge'
import Secret from './pages/Secret'
import SelfInvite from './pages/SelfInvite'
import BestTimesPublic from './pages/BestTimesPublic'
import ResultsPage from './pages/ResultsPage'
import Workflow from './pages/Workflow'
import Footer from './Footer'
import logoSrc from '@shared/assets/icon.png'

// Wrap the shared EventsPage with its required providers
function EventsPage() {
  const { lang } = useLang()
  return (
    <SharedLangProvider initialLang={lang}>
      <ApiProvider api={meetApiHttp}>
        <EventsPageShared />
      </ApiProvider>
    </SharedLangProvider>
  )
}

// Wrap the shared AthletesListPage
function AthletesListPage({ role, clubId }) {
  const { lang } = useLang()
  const navigate = useNavigate()
  return (
    <SharedLangProvider initialLang={lang}>
      <RegistrationApiProvider api={registrationApiHttp}>
        <AthletesListPageShared
          role={role}
          clubId={clubId}
          onNavigateToRegistration={(id) => navigate(`/athletes/${id}/register`)}
        />
      </RegistrationApiProvider>
    </SharedLangProvider>
  )
}

// Wrap the shared InscriptionPage (new cascade tree layout)
function InscriptionPage({ role, clubId }) {
  const { lang } = useLang()
  return (
    <SharedLangProvider initialLang={lang}>
      <RegistrationApiProvider api={registrationApiHttp}>
        <InscriptionPageShared
          role={role}
          clubId={clubId}
        />
      </RegistrationApiProvider>
    </SharedLangProvider>
  )
}

// Wrap the shared IndividualEntryPage
function IndividualEntryPage({ role, clubId }) {
  const { lang, t } = useLang()
  const importRef = useRef(null)

  async function handleImportLxf() {
    if (importRef.current) importRef.current.click()
  }

  async function handleImportFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const fdPreview = new FormData()
    fdPreview.append('file', file)
    let preview
    try {
      const r = await api.post('/upload/preview', fdPreview)
      preview = r.data
    } catch (err) {
      alert('Cannot read file: ' + (err.detail || err.message))
      e.target.value = ''
      return
    }
    const prompt = t.confirm_upload_lenex
      .replace('%clubs_total%', preview.clubs_in_file)
      .replace('%athletes_total%', preview.athletes_in_file)
      .replace('%clubs%', preview.clubs_new)
      .replace('%athletes%', preview.athletes_new)
    if (!confirm(prompt)) { e.target.value = ''; return }
    const fd = new FormData()
    fd.append('file', file)
    try {
      await api.post('/upload/entries', fd)
    } catch (err) {
      alert(err.message || 'Import failed')
    }
    e.target.value = ''
  }

  async function handleExportLxf() {
    try {
      const res = await fetch('/api/export/registrations-lxf', {
        headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' }
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'inscriptions.lxf'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert(e.message || 'Export failed') }
  }

  // Only show import/export for admin and organizer roles
  const showImportExport = role === 'admin' || role === 'organizer'

  return (
    <SharedLangProvider initialLang={lang}>
      <RegistrationApiProvider api={registrationApiHttp}>
        <IndividualEntryPageShared
          role={role}
          clubId={clubId}
          onImportLxf={showImportExport ? handleImportLxf : undefined}
          onExportLxf={showImportExport ? handleExportLxf : undefined}
        />
        {showImportExport && (
          <input ref={importRef} type="file" accept=".lxf" className="hidden" onChange={handleImportFile} />
        )}
      </RegistrationApiProvider>
    </SharedLangProvider>
  )
}

// Wrap the shared RelayEntryPage
function RelayEntryPage({ role, clubId }) {
  const { lang } = useLang()
  return (
    <SharedLangProvider initialLang={lang}>
      <RegistrationApiProvider api={registrationApiHttp}>
        <RelayEntryPageShared
          role={role}
          clubId={clubId ? parseInt(clubId) : undefined}
        />
      </RegistrationApiProvider>
    </SharedLangProvider>
  )
}

// Wrap the shared RegistrationPage
function RegisterPage() {
  const { id } = useParams()
  const { lang } = useLang()
  const navigate = useNavigate()
  return (
    <SharedLangProvider initialLang={lang}>
      <RegistrationApiProvider api={registrationApiHttp}>
        <RegistrationPageShared
          athleteId={parseInt(id)}
          onNavigateBack={() => navigate('/')}
        />
      </RegistrationApiProvider>
    </SharedLangProvider>
  )
}

function AuthLayout({ children, canOrganizer, canAdmin, meetName, toggle, lang, logout, auth, t }) {
  const location = useLocation()
  const standalone = location.pathname === '/best-times' || location.pathname === '/results'
  if (standalone) return children

  const tabs = [
    { to: '/meet', label: t.tab_meet || 'Compétition', show: canOrganizer },
    { to: '/invitation', label: t.tab_invitation || 'Invitation', show: canOrganizer },
    { to: '/', label: t.tab_individual_entries || 'Individual Entries', show: true },
    { to: '/relay-entries', label: t.tab_relay_entries || 'Relay Entries', show: true },
    { to: '/serc', label: 'SERC', show: canOrganizer },
    { to: '/admin', label: t.admin, show: canAdmin },
  ]

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Title bar */}
      <div className="flex items-center h-8 bg-gray-800 text-white text-xs select-none shrink-0">
        <img src={logoSrc} alt="Logo" className="h-5 w-5 ml-2 mr-1" />
        <span className="px-1 font-semibold text-gray-300">SauvetageTeam</span>
        <span className="text-gray-500 mr-1">|</span>
        <span className="text-gray-300 truncate mr-4">
          {lang === 'fr' ? 'Gestion des inscriptions' : 'Registration Management'}{meetName ? ` — ${meetName}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2 pr-3">
          <span className="text-gray-400 text-xs">{auth.club_name}</span>
          <button
            onClick={() => { const next = lang === 'fr' ? 'en' : 'fr'; toggle() }}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
              lang === 'fr'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400'
            }`}
          >
            {lang === 'fr' ? 'FR' : 'EN'}
          </button>
          <button onClick={logout} className="text-red-400 hover:text-red-300 text-xs">{t.logout}</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex h-8 bg-gray-700 shrink-0 border-b border-gray-900">
        {tabs.filter(tab => tab.show).map((tab) => {
          const active = location.pathname === tab.to ||
            (tab.to === '/' && location.pathname.startsWith('/athletes'))
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`px-5 h-full flex items-center text-xs font-medium border-r border-gray-600 transition-colors ${
                active
                  ? 'bg-white text-gray-900 shadow-inner'
                  : 'text-gray-300 hover:bg-gray-600 hover:text-white'
              }`}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        {children}
      </div>

      <Footer showUsage={true} />
    </div>
  )
}

function AppInner() {
  const [auth, setAuth] = useState(null)
  const [meetName, setMeetName] = useState('')
  const { t, lang, toggle } = useLang()

  useEffect(() => {
    const pin = localStorage.getItem('pin')
    const role = localStorage.getItem('role')
    if (pin && role) {
      setAuth({ role, club_id: localStorage.getItem('club_id'), club_name: localStorage.getItem('club_name') })
    }
    import('./api').then(m => m.default.get('/meet-info').then(r => setMeetName(r.data.meet_name || '')).catch(() => {}))
  }, [])

  // Refresh title bar meet name when a new meet is loaded anywhere in the app
  useEffect(() => {
    function onMeetChanged() {
      import('./api').then(m => m.default.get('/meet-info').then(r => setMeetName(r.data.meet_name || '')).catch(() => {}))
    }
    window.addEventListener('meet-changed', onMeetChanged)
    return () => window.removeEventListener('meet-changed', onMeetChanged)
  }, [])

  function logout() {
    localStorage.removeItem('pin')
    localStorage.removeItem('role')
    localStorage.removeItem('club_id')
    localStorage.removeItem('club_name')
    setAuth(null)
  }

  if (!auth) return (
    <BrowserRouter>
      <Routes>
        <Route path="/secret/:token" element={<Secret />} />
        <Route path="/self-invite" element={<SelfInvite />} />
        <Route path="/best-times" element={<Navigate to="/results" replace />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/usage" element={<Workflow />} />
        <Route path="/serc/judge/:section" element={<SercJudgePage />} />
        <Route path="/serc/judge/:section/:num" element={<SercJudgePage />} />
        <Route path="*" element={<Login onLogin={setAuth} />} />
      </Routes>
      <Footer />
    </BrowserRouter>
  )

  const canOrganizer = auth.role === 'admin' || auth.role === 'organizer'
  const canAdmin = auth.role === 'admin'

  return (
    <BrowserRouter>
      <AuthLayout canOrganizer={canOrganizer} canAdmin={canAdmin} meetName={meetName} toggle={toggle} lang={lang} logout={logout} auth={auth} t={t}>
        <Routes>
          <Route path="/" element={<IndividualEntryPage role={auth.role} clubId={auth.club_id} />} />
          <Route path="/relay-entries" element={<RelayEntryPage role={auth.role} clubId={auth.club_id} />} />
          <Route path="/athletes/:id/register" element={<RegisterPage />} />
          {canOrganizer && <Route path="/meet" element={<EventsPage />} />}
          {canOrganizer && <Route path="/invitation" element={<Organizer />} />}
          {canOrganizer && <Route path="/serc" element={<SercPage />} />}
          {canAdmin && <Route path="/admin" element={<Admin />} />}
          <Route path="/secret/:token" element={<Secret />} />
          <Route path="/best-times" element={<Navigate to="/results" replace />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/usage" element={<Workflow />} />
          <Route path="/serc/judge/:section" element={<SercJudgePage />} />
          <Route path="/serc/judge/:section/:num" element={<SercJudgePage />} />
        </Routes>
      </AuthLayout>
    </BrowserRouter>
  )
}

function App() {
  return (
    <LangProvider>
      <AppInner />
    </LangProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)