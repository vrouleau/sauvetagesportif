import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import api from '../api'

export default function Meet() {
  const { t } = useLang()
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/meet-info')
      .then(r => { setInfo(r.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-xs text-gray-400">Chargement…</div>
  if (!info || !info.meet_name) return (
    <div className="p-6 text-sm text-gray-500">{t.no_meet}</div>
  )

  return (
    <div className="text-xs">
      <div className="flex items-center h-7 bg-gray-50 border-b border-gray-200 px-3 font-semibold text-gray-700 sticky top-0 z-10">
        {t.meet}
      </div>

      <div className="flex border-b border-gray-200 bg-gray-50">
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">
          {t.meet_designation || 'Désignation'}
        </div>
        <div className="flex-1 px-3 py-0.5 font-semibold text-gray-500">
          {t.meet_value || 'Valeur'}
        </div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          <SectionHeader title={t.meet_general || 'Général'} />
          <Row label={t.meet_name_label || 'Nom'} value={info.meet_name} />
          <Row label={t.meet_events_label || 'Épreuves'} value={info.events} />
          <Row label={t.meet_course_label || 'Bassin'} value={courseLabel(info.course)} />
          <Row label={t.meet_masters_label || 'Nages Maîtres'} value={info.masters ? '✓' : '—'} />
          <Row label={t.meet_uploaded_label || 'Téléversé'} value={info.uploaded_at || '—'} />
          <Row label={t.meet_filename_label || 'Fichier'} value={info.filename || '—'} />

          <SectionHeader title={t.meet_closure || 'Inscription'} />
          <Row label={t.closure_date_label} value={info.closure_date || '—'} />

          {info.meet_fees && Object.keys(info.meet_fees).length > 0 && (
            <>
              <SectionHeader title={t.fee_summary} />
              {info.meet_fees.fee_athlete != null && (
                <Row label={t.fee_per_athlete} value={`${info.meet_fees.fee_athlete} ${info.currency}`} />
              )}
              {info.meet_fees.fee_relay != null && (
                <Row label={t.fee_per_relay} value={`${info.meet_fees.fee_relay} ${info.currency}`} />
              )}
              {info.meet_fees.fee_team != null && (
                <Row label={t.fee_per_team} value={`${info.meet_fees.fee_team} ${info.currency}`} />
              )}
            </>
          )}

          {info.event_fees && info.event_fees.length > 0 && (
            <>
              <SectionHeader title={t.fee_per_event} />
              {info.event_fees.filter(e => e.fee_cents > 0).map((e, i) => (
                <Row
                  key={i}
                  label={`#${e.event_number} ${e.distance}m ${e.style_name}`}
                  value={`${(e.fee_cents / 100).toFixed(2)} ${info.currency}`}
                />
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

function courseLabel(course) {
  if (course === 'LCM' || course === '1') return 'Bassin 50m (LCM)'
  if (course === 'SCM' || course === '3') return 'Bassin 25m (SCM)'
  if (course === 'SCY' || course === '2') return 'Bassin 25yd (SCY)'
  return course || '—'
}

function SectionHeader({ title }) {
  return (
    <tr>
      <td colSpan={2} className="bg-gray-100 border-b border-gray-200 font-semibold text-xs px-2 py-1">
        {title}
      </td>
    </tr>
  )
}

function Row({ label, value }) {
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50">
      <td className="px-4 py-0.5 text-gray-600 w-64">{label}</td>
      <td className="px-2 py-0.5">{value ?? '—'}</td>
    </tr>
  )
}
