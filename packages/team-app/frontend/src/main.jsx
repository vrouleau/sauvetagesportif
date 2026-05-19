import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router'
import './index.css'
import { LangProvider, useLang } from './i18n'
import Login from './pages/Login'
import Athletes from './pages/Athletes'
import Register from './pages/Register'
import Admin from './pages/Admin'
import Organizer from './pages/Organizer'
import DataManagement from './pages/DataManagement'
import Secret from './pages/Secret'
import SelfInvite from './pages/SelfInvite'
import BestTimesPublic from './pages/BestTimesPublic'
import Workflow from './pages/Workflow'
import Footer from './Footer'

function AuthLayout({ children, canOrganizer, canAdmin, meetName, toggle, lang, logout, auth, t }) {
  const location = useLocation()
  const standalone = location.pathname === '/best-times'
  if (standalone) return children

  const tabs = [
    { to: '/', label: t.athletes, show: true },
    { to: '/organizer', label: t.organizer, show: canOrganizer },
    { to: '/admin', label: t.admin, show: canAdmin },
    { to: '/data-management', label: t.data_management, show: canAdmin },
  ]

  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      {/* Title bar */}
      <div className="flex items-center h-8 bg-gray-800 text-white text-xs select-none shrink-0">
        <span className="px-3 font-semibold text-gray-300">SplashTeam</span>
        <span className="text-gray-500 mr-1">|</span>
        <span className="text-gray-300 truncate mr-4">
          {meetName || 'Gestion des inscriptions'}
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
      <div className="flex-1 overflow-auto">
        {children}
      </div>

      <Footer showUsage={canOrganizer && location.pathname === '/organizer'} />
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
        <Route path="/best-times" element={<BestTimesPublic />} />
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
          <Route path="/" element={<Athletes role={auth.role} clubId={auth.club_id} />} />
          <Route path="/athletes/:id/register" element={<Register />} />
          {canOrganizer && <Route path="/organizer" element={<Organizer />} />}
          {canAdmin && <Route path="/admin" element={<Admin />} />}
          {canAdmin && <Route path="/data-management" element={<DataManagement />} />}
          <Route path="/secret/:token" element={<Secret />} />
          <Route path="/best-times" element={<BestTimesPublic />} />
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
