import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import api from '../api'

export default function Organizer() {
  const [meetInfo, setMeetInfo] = useState(null)
  const [clubs, setClubs] = useState([])
  const [checked, setChecked] = useState({})
  const [stripeStatus, setStripeStatus] = useState(null)
  const [msg, setMsg] = useState('')
  const { t, lang } = useLang()

  useEffect(() => { loadMeetInfo(); loadClubs(); loadStripeStatus() }, [])

  async function loadMeetInfo() {
    const r = await api.get('/meet-info')
    setMeetInfo(r.data)
  }

  async function loadClubs() {
    const [r, org] = await Promise.all([api.get('/clubs'), api.get('/admin/organizer')])
    const orgId = org.data.club_id
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

  function exportLxf() {
    window.open('/api/export', '_blank')
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
          </span>
        )}
        {meetInfo && !meetInfo.filename && (
          <span className="text-xs text-red-500">{t.no_meet}</span>
        )}
        <div className="flex-1" />
        {/* Stripe status */}
        {stripeStatus?.connected ? (
          <span className="text-xs text-green-700">✓ Stripe</span>
        ) : (
          <button onClick={connectStripe} className="text-xs text-purple-600 hover:underline">{t.stripe_connect_btn}</button>
        )}
        {/* Closure date */}
        <div className="flex items-center gap-1">
          <label className="text-xs text-gray-500">{t.closure_date_label}:</label>
          <input type="date" className="border border-gray-300 px-1.5 py-0.5 rounded text-xs"
            defaultValue={meetInfo?.closure_date || ''}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
            onBlur={async e => {
              await api.put('/closure-date', { closure_date: e.target.value })
              loadMeetInfo()
              setMsg(t.closure_saved)
            }} />
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200 shrink-0">
        <button onClick={handleMainAction} disabled={!checkedCount}
          className={`text-white px-3 py-1 rounded text-xs disabled:opacity-50 ${buttonColor}`}>
          {buttonLabel} {checkedCount > 0 && `(${checkedCount})`}
        </button>
        <div className="w-px h-4 bg-gray-300" />
        <label className="text-xs text-gray-600 cursor-pointer hover:text-blue-600">
          {t.upload_meet}
          <input type="file" accept=".lxf" onChange={uploadMeet} className="hidden" />
        </label>
        <div className="w-px h-4 bg-gray-300" />
        <button onClick={exportLxf} className="text-xs text-blue-600 hover:underline">{t.download_lxf}</button>
        {stripeStatus?.connected && (
          <>
            <div className="w-px h-4 bg-gray-300" />
            <button onClick={disconnectStripe} className="text-xs text-red-500 hover:underline">{t.stripe_disconnect_btn}</button>
          </>
        )}
        <div className="flex-1" />
        {msg && <span className="text-xs text-green-700">{msg}</span>}
      </div>

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
