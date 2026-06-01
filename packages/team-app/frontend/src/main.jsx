import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation, useParams, useNavigate, Navigate } from 'react-router'
import './index.css'
import { LangProvider, useLang } from './i18n'
import Login from './pages/Login'
import EventsPageShared from '@shared/pages/EventsPage'
import InscriptionPageShared from '@shared/pages/InscriptionPage'
import { ApiProvider } from '@shared/context/ApiContext'
import { LangProvider as SharedLangProvider } from '@shared/context/LangContext'
import { RegistrationApiProvider } from '@shared/context/RegistrationApiContext'
import AthletesListPageShared from '@shared/pages/AthletesListPage'
import RegistrationPageShared from '@shared/pages/RegistrationPage'
import { meetApiHttp } from './meetApi'
import { registrationApiHttp } from './registrationApi'
import Admin from './pages/Admin'
import Organizer from './pages/Organizer'
import DataManagement from './pages/DataManagement'
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
    { to: '/', label: t.tab_registration || 'Inscription', show: true },
    { to: '/admin', label: t.admin, show: canAdmin },
    { to: '/data-management', label: t.data_management, show: canAdmin },
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
          <Route path="/" element={<InscriptionPage role={auth.role} clubId={auth.club_id} />} />
          <Route path="/athletes/:id/register" element={<RegisterPage />} />
          {canOrganizer && <Route path="/meet" element={<EventsPage />} />}
          {canOrganizer && <Route path="/invitation" element={<Organizer />} />}
          {canAdmin && <Route path="/admin" element={<Admin />} />}
          {canAdmin && <Route path="/data-management" element={<DataManagement />} />}
          <Route path="/secret/:token" element={<Secret />} />
          <Route path="/best-times" element={<Navigate to="/results" replace />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/usage" element={<Workflow />} />
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
