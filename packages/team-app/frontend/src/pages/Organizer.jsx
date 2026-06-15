import { useState, useEffect, useRef } from 'react'
import { useLang } from '../i18n'
import api from '../api'

export default function Organizer() {
  const [meetInfo, setMeetInfo] = useState(null)
  const [clubs, setClubs] = useState([])
  const [checked, setChecked] = useState({})
  const [stripeStatus, setStripeStatus] = useState(null)
  const [msg, setMsg] = useState('')
  const [showImportConfirm, setShowImportConfirm] = useState(false)
  const { t, lang } = useLang()
  const importResultsRef = useRef(null)
  const isAdmin = localStorage.getItem('role') === 'admin'

  useEffect(() => { loadMeetInfo(); loadClubs(); loadStripeStatus() }, [])

  async function loadMeetInfo() {
    const r = await api.get('/meet-info')
    setMeetInfo(r.data)
  }

  async function loadClubs() {
    const r = await api.get('/clubs')
    const orgId = parseInt(localStorage.getItem('club_id') || '0')
    setClubs(r.data.filter(c => c.id !== orgId))
  }

  async function loadStripeStatus() {
    try {
      const r = await api.get('/stripe/status')
      setStripeStatus(r.data)
    } catch { setStripeStatus({ connected: false }) }
  }

  async function connectStripe() {
    try {
      const r = await api.post('/stripe/connect', {})
      window.location.href = r.data.url
    } catch (e) { setMsg(e.response?.data?.detail || e.message || 'Error') }
  }

  async function disconnectStripe() {
    if (!confirm(lang === 'fr' ? 'Déconnecter Stripe ?' : 'Disconnect Stripe?')) return
    try {
      await api.post('/stripe/disconnect', {})
      setStripeStatus({ connected: false })
      setMsg(lang === 'fr' ? 'Stripe déconnecté' : 'Stripe disconnected')
    } catch (e) { setMsg(e.message || 'Error') }
  }

  async function importResults(e) {
    const file = e.target.files[0]
    if (!file) return
    setMsg(lang === 'fr' ? 'Importation des résultats...' : 'Importing results...')
    const fd = new FormData()
    fd.append('file', file)
    e.target.value = ''
    try {
      const res = await fetch('/api/import-results-lxf', {
        method: 'POST',
        headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' },
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `${res.status}`)
      const r = data.results
      if (data.reset) {
        const isOrganizer = localStorage.getItem('role') === 'organizer'
        if (isOrganizer) {
          setMsg(lang === 'fr'
            ? `✓ Meet archivé : ${r} résultat(s) — ${data.meet_name}. Déconnexion en cours…`
            : `✓ Meet archived: ${r} result(s) — ${data.meet_name}. Logging out…`)
          setTimeout(() => {
            localStorage.removeItem('pin')
            localStorage.removeItem('role')
            localStorage.removeItem('club_id')
            localStorage.removeItem('club_name')
            window.location.href = '/'
          }, 2500)
        } else {
          setMsg(lang === 'fr'
            ? `✓ Meet archivé et réinitialisé : ${r} résultat(s) — ${data.meet_name}`
            : `✓ Meet archived and reset: ${r} result(s) — ${data.meet_name}`)
          loadMeetInfo(); loadClubs()
        }
      } else {
        setMsg(lang === 'fr'
          ? `✓ Meet historique mis à jour : ${r} résultat(s) — ${data.meet_name}`
          : `✓ Historical meet updated: ${r} result(s) — ${data.meet_name}`)
      }
    } catch (err) {
      setMsg(err.message || 'Error')
    }
  }

  async function exportLxf() {
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
    } catch (e) { setMsg(e.message || 'Error') }
  }

  async function uploadMeet(e) {
    const file = e.target.files[0]
    if (!file) return
    if (meetInfo?.filename && !confirm(t.confirm_replace_meet)) {
      e.target.value = ''
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    setMsg(lang === 'fr' ? 'Téléversement...' : 'Uploading...')
    const r = await api.post('/upload/meet', fd)
    setMsg(`${r.data.events_loaded} ${t.events}`)
    e.target.value = ''
    loadMeetInfo(); loadClubs()
    window.dispatchEvent(new Event('meet-changed'))
  }

  async function sendSelectedInvites() {
    const ids = Object.entries(checked).filter(([,v]) => v).map(([k]) => k)
    if (!ids.length) return
    setMsg(lang === 'fr' ? 'Envoi en cours...' : 'Sending...')
    let sent = 0, errors = 0
    for (const id of ids) {
      try {
        await api.post(`/clubs/${id}/send-pin`, { lang })
        sent++
      } catch { errors++ }
    }
    setChecked({})
    loadClubs()
    setMsg(`${sent} ${t.invitations_sent}${errors ? ` (${errors} ${lang === 'fr' ? 'erreur(s)' : 'error(s)'})` : ''}`)
  }

  async function sendSelectedStripeInvoices() {
    const ids = Object.entries(checked).filter(([,v]) => v).map(([k]) => k)
    if (!ids.length) return
    const count = ids.length
    const message = lang === 'fr'
      ? `Envoyer les factures Stripe à ${count} club(s) ?`
      : `Send Stripe invoices to ${count} club(s)?`
    if (!confirm(message)) return
    setMsg(lang === 'fr' ? 'Envoi des factures...' : 'Sending invoices...')
    let sent = 0, errors = 0
    for (const id of ids) {
      try {
        await api.post(`/clubs/${id}/invoice`, {})
        sent++
      } catch { errors++ }
    }
    setChecked({})
    loadClubs()
    setMsg(`${sent} ${t.stripe_invoices_sent}${errors ? ` (${errors} ${lang === 'fr' ? 'erreur(s)' : 'error(s)'})` : ''}`)
  }

  async function downloadSelectedPdfZip() {
    const ids = Object.entries(checked).filter(([,v]) => v).map(([k]) => Number(k))
    if (!ids.length) return
    setMsg(lang === 'fr' ? 'Génération des PDF...' : 'Generating PDFs...')
    try {
      const res = await fetch('/api/invoices/pdf-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Club-Pin': localStorage.getItem('pin') || '' },
        body: JSON.stringify({ club_ids: ids })
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'invoices.zip'; a.click()
      URL.revokeObjectURL(url)
      setMsg('')
    } catch (e) { setMsg(e.message || 'Error') }
  }

  const checkedCount = Object.values(checked).filter(Boolean).length
  const closurePassed = meetInfo?.closure_date && new Date() > new Date(meetInfo.closure_date + 'T23:59:59')

  const mode = !closurePassed ? 'invite' : stripeStatus?.connected ? 'stripe' : 'pdf'

  function handleMainAction() {
    if (mode === 'invite') sendSelectedInvites()
    else if (mode === 'stripe') sendSelectedStripeInvoices()
    else downloadSelectedPdfZip()
  }

  const buttonLabel = mode === 'invite' ? t.send_invitation
    : mode === 'stripe' ? t.send_stripe_invoice_btn
    : t.download_invoices_btn
  const buttonColor = mode === 'invite' ? 'bg-green-600 hover:bg-green-700'
    : mode === 'stripe' ? 'bg-blue-600 hover:bg-blue-700'
    : 'bg-gray-600 hover:bg-gray-700'

  function statusText(c) {
    const parts = []
    if (c.registered_athlete_count) parts.push(`${c.registered_athlete_count} ${t.athletes_short}`)
    if (c.total_fees_cents) parts.push(formatMoney(c.total_fees_cents, meetInfo?.currency || 'CAD', lang))
    if (mode === 'invite' && c.invite_send_count) parts.push(`${c.invite_send_count}× ${t.invited_short}`)
    if (mode === 'stripe' && c.stripe_send_count) parts.push(`${c.stripe_send_count}× ${t.sent_short}`)
    return parts.join(' · ') || '—'
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-white border-b border-gray-300 shrink-0 flex-wrap">
        {/* Meet info compact */}
        {meetInfo?.filename && (
          <span className="text-xs text-gray-600">
            <strong>{meetInfo.meet_name || meetInfo.filename}</strong>
            {' '}— {({'LCM':'50m','SCM':'25m'})[meetInfo.course] || '?'} — {meetInfo.events} {t.events}
            {meetInfo.meet_type === 'BEACH' && (
              <span className="ml-1 px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px] font-semibold">
                {lang === 'fr' ? 'PLAGE' : 'BEACH'}
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {/* Stripe status */}
        {stripeStatus?.connected ? (
          <span className="text-xs text-green-700">✓ Stripe</span>
        ) : (
          <button onClick={connectStripe} className="text-xs text-purple-600 hover:underline">{t.stripe_connect_btn}</button>
        )}
        {/* Closure date */}
        {/* Closure date (read-only, set via meet config) */}
        {meetInfo?.closure_date && (
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-500">{t.closure_date_label}:</label>
            <span className="text-xs font-medium text-red-600">{meetInfo.closure_date}</span>
          </div>
        )}
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200 shrink-0">
        <button onClick={handleMainAction} disabled={!checkedCount}
          className={`text-white px-3 py-1 rounded text-xs disabled:opacity-50 ${buttonColor}`}>
          {buttonLabel} {checkedCount > 0 && `(${checkedCount})`}
        </button>
        <div className="w-px h-4 bg-gray-300" />
        <button onClick={exportLxf} className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700">{t.download_lxf}</button>
        <input ref={importResultsRef} type="file" accept=".lxf" className="hidden" onChange={importResults} />
        <button
          onClick={() => setShowImportConfirm(true)}
          className="px-3 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700">
          {lang === 'fr' ? 'Importer résultats' : 'Import Results'}
        </button>
        {stripeStatus?.connected && (
          <>
            <div className="w-px h-4 bg-gray-300" />
            <button onClick={disconnectStripe} className="text-xs text-red-500 hover:underline">{t.stripe_disconnect_btn}</button>
          </>
        )}
        <div className="flex-1" />
        {msg && <span className="text-xs text-green-700">{msg}</span>}
      </div>

      {/* Live Mode section */}
      <LiveModeSection lang={lang} />

      {/* Clubs table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-gray-100 z-10">
            <tr>
              <th className="px-2 py-1.5 border-b border-gray-300 w-6">
                <input type="checkbox" className="w-3.5 h-3.5"
                  checked={clubs.length > 0 && clubs.every(c => checked[c.id])}
                  onChange={e => {
                    const val = e.target.checked
                    setChecked(Object.fromEntries(clubs.map(c => [c.id, val])))
                  }} />
              </th>
              <th className="px-2 py-1.5 border-b border-gray-300 text-left font-medium">{t.club}</th>
              <th className="px-2 py-1.5 border-b border-gray-300 text-left font-medium">Email</th>
              <th className="px-2 py-1.5 border-b border-gray-300 text-left font-medium">{t.status}</th>
            </tr>
          </thead>
          <tbody>
            {clubs.map(c => (
              <tr key={c.id} className="border-b border-gray-200 hover:bg-blue-50">
                <td className="px-2 py-1">
                  <input type="checkbox" className="w-3.5 h-3.5" checked={!!checked[c.id]}
                    onChange={e => setChecked(prev => ({...prev, [c.id]: e.target.checked}))} />
                </td>
                <td className="px-2 py-1">{c.name}</td>
                <td className="px-2 py-1 text-gray-500">{c.email || <span className="text-red-400 italic">{lang === 'fr' ? 'aucun' : 'none'}</span>}</td>
                <td className="px-2 py-1 text-gray-500">{statusText(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Fee summary panel */}
      {meetInfo?.filename && <FeeSummary meetInfo={meetInfo} t={t} lang={lang} />}

      {/* Import results confirmation modal (organizer only) */}
      {showImportConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">
              {lang === 'fr' ? 'Finaliser le meet et archiver les résultats' : 'Close the Meet and Archive Results'}
            </h2>
            <p className="text-xs text-red-600 font-medium mb-3">
              {lang === 'fr' ? 'Cette action est irréversible.' : 'This action cannot be undone.'}
            </p>
            <p className="text-xs text-gray-600 mb-2">
              {lang === 'fr' ? 'En important les résultats, vous allez :' : 'By importing results, you will:'}
            </p>
            <ul className="text-xs text-gray-700 space-y-1.5 mb-4 ml-2">
              <li className="flex gap-2">
                <span className="text-gray-400 shrink-0">1.</span>
                <span>{lang === 'fr'
                  ? 'Archiver les résultats comme meet historique (visible dans les meilleures performances)'
                  : 'Archive results as a historical meet (visible in best times)'}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400 shrink-0">2.</span>
                <span>{lang === 'fr'
                  ? 'Réinitialiser le meet actuel — toutes les inscriptions et la structure des épreuves seront effacées'
                  : 'Reset the current meet — all registrations and event structure will be erased'}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400 shrink-0">3.</span>
                <span>{lang === 'fr'
                  ? 'Régénérer les NIP de tous les clubs — les entraîneurs devront se reconnecter pour le prochain meet'
                  : 'Regenerate all club PINs — coaches will need to log in again for the next meet'}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-gray-400 shrink-0">4.</span>
                <span className="font-medium text-orange-700">{lang === 'fr'
                  ? "Supprimer votre rôle d'organisateur et vous déconnecter — l'administrateur devra inviter un nouvel organisateur pour le prochain meet"
                  : 'Remove your organizer role and log you out — an admin will need to invite a new organizer for the next meet'}</span>
              </li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowImportConfirm(false)}
                className="px-4 py-1.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50">
                {lang === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={() => { setShowImportConfirm(false); importResultsRef.current?.click() }}
                className="px-4 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 font-medium">
                {lang === 'fr' ? 'Oui, archiver et terminer' : 'Yes, archive and close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const FEE_TYPE_LABEL = {
  CLUB: 'fee_per_club', ATHLETE: 'fee_per_athlete', RELAY: 'fee_per_relay',
  TEAM: 'fee_per_team', LATEFEE: 'fee_late', LSCMEETFEE: 'fee_lsc',
}

function formatMoney(cents, currency, lang) {
  const amount = (cents || 0) / 100
  try {
    return new Intl.NumberFormat(lang === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: currency || 'CAD' }).format(amount)
  } catch { return `${amount.toFixed(2)} ${currency || ''}`.trim() }
}

function LiveModeSection({ lang }) {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const pin = localStorage.getItem('pin') || ''

  useEffect(() => { loadConfig() }, [])

  async function loadConfig() {
    try {
      const res = await fetch('/api/live/config', { headers: { 'X-Club-Pin': pin } })
      if (res.ok) setConfig(await res.json())
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function toggleLive() {
    setToggling(true)
    const endpoint = config?.enabled ? '/api/live/disable' : '/api/live/enable'
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-Club-Pin': pin },
      })
      if (res.ok) await loadConfig()
    } catch { /* ignore */ }
    setToggling(false)
  }

  if (loading) return null

  return (
    <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-3 text-xs">
      <span className="font-medium text-gray-700">
        {lang === 'fr' ? 'Mode direct' : 'Live Mode'}:
      </span>
      {config?.enabled ? (
        <span className="flex items-center gap-1 text-green-700">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {lang === 'fr' ? 'Actif' : 'Active'}
        </span>
      ) : (
        <span className="text-gray-500">{lang === 'fr' ? 'Inactif' : 'Inactive'}</span>
      )}
      <button
        onClick={toggleLive}
        disabled={toggling}
        className={`px-2 py-0.5 rounded text-xs font-medium ${
          config?.enabled
            ? 'bg-red-100 text-red-700 hover:bg-red-200'
            : 'bg-green-100 text-green-700 hover:bg-green-200'
        } disabled:opacity-50`}
      >
        {toggling ? '…' : (config?.enabled
          ? (lang === 'fr' ? 'Désactiver' : 'Disable')
          : (lang === 'fr' ? 'Activer' : 'Enable'))}
      </button>
      {config?.enabled && config?.secret_masked && (
        <span className="text-gray-400 font-mono">{config.secret_masked}</span>
      )}
      {config?.last_push && (
        <span className="text-gray-400 ml-auto">
          {lang === 'fr' ? 'Dernier push' : 'Last push'}: {new Date(config.last_push).toLocaleTimeString()}
        </span>
      )}
      {config?.spectators > 0 && (
        <span className="text-blue-600">
          👁 {config.spectators}
        </span>
      )}
    </div>
  )
}

function FeeSummary({ meetInfo, t, lang }) {
  const currency = meetInfo.currency || 'CAD'
  const meetFees = meetInfo.meet_fees || {}
  const eventFees = (meetInfo.event_fees || []).filter(e => (e.fee_cents || 0) > 0)
  const meetFeeEntries = Object.entries(meetFees)

  return (
    <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0">
      <details className="text-xs">
        <summary className="font-medium text-gray-700 cursor-pointer">{t.fee_summary} ({currency})</summary>
        <div className="mt-2 max-h-40 overflow-y-auto font-mono text-xs bg-white border border-gray-200 rounded p-2">
          {meetFeeEntries.length > 0 && (
            <div className="mb-2">
              <div className="font-sans font-semibold text-gray-600 mb-0.5">{t.fee_meet_level}</div>
              {meetFeeEntries.map(([type, cents]) => (
                <div key={type}>{(t[FEE_TYPE_LABEL[type]] || type).padEnd(22, ' ')}{formatMoney(cents, currency, lang)}</div>
              ))}
            </div>
          )}
          {eventFees.length > 0 && (
            <div>
              <div className="font-sans font-semibold text-gray-600 mb-0.5">{t.fee_per_event}</div>
              {eventFees.map((e, i) => (
                <div key={i}>{e.event_number != null ? `#${String(e.event_number).padStart(3,' ')}` : '   '}  {(e.style_name||'').slice(0,40).padEnd(40,' ')}{formatMoney(e.fee_cents, currency, lang)}</div>
              ))}
            </div>
          )}
          {meetFeeEntries.length === 0 && eventFees.length === 0 && (
            <span className="font-sans text-gray-500">{t.fee_none_meet_level}</span>
          )}
        </div>
      </details>
    </div>
  )
}
