import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { HeatListSession, HeatListEvent, Session, AgeGroup } from '../data/mockData'

// Local aliases matching the IPC return shapes (structurally compatible)
type HeatListSessionRow = HeatListSession
type HeatListEventRow = HeatListEvent
type SessionRow = Session
type AgeGroupRow = AgeGroup

// ── API helpers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbApi = () => (window as any).api?.db
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reportApi = () => (window as any).api?.report

// ── Types ─────────────────────────────────────────────────────────────────────

interface MeetInfo { name: string; city: string; nation: string }

interface FlatItem {
  key: string
  type: 'session' | 'event'
  id: number          // sessionId or eventId
  sessionId: number
  label: string
  isAdmin: boolean
}

interface ReportEventSection {
  eventId: number
  eventNumber: number
  eventName: string     // style name only
  gender: 'M' | 'F' | 'X'
  ageMin: number
  ageMax: number | null
  sessionDate: string   // YYYY-MM-DD
  scheduledTime: string // HH:MM or ''
  heats: HeatListEventRow['heats']
}

// ── HTML generator ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;')
}

function formatAgeRange(minAge: number, maxAge: number | null): string {
  if (maxAge == null || maxAge < 0) return `${minAge} ans et plus`
  return `${minAge} - ${maxAge} ans`
}

function genderPrefix(gender: 'M' | 'F' | 'X', minAge: number): string {
  const adult = minAge >= 15
  if (gender === 'X') return adult ? 'Mixte' : 'Tous'
  if (gender === 'F') return adult ? 'Dames' : 'Filles'
  return adult ? 'Messieurs' : 'Garçons'
}

function computeAge(birthYear: number, meetYear: number): number {
  return meetYear - birthYear
}

// ── PDF header info (passed to main process for displayHeaderFooter) ─────────

export interface PdfHeaderInfo {
  line1: string   // meet name
  line2: string   // city + date range
  today: string   // formatted date for footer
}

function buildPdfHeaderInfo(meetInfo: MeetInfo, sections: ReportEventSection[]): PdfHeaderInfo {
  const dates = [...new Set(sections.map(s => s.sessionDate).filter(Boolean))].sort()
  const dateRange = dates.length > 1
    ? `${dates[0]} - ${dates[dates.length - 1]}`
    : (dates[0] ?? '')
  return {
    line1: meetInfo.name || 'Compétition',
    line2: `${meetInfo.city}${dateRange ? ', ' + dateRange : ''}`,
    today: new Date().toLocaleDateString('fr-CA'),
  }
}

// ── PDF / Print generator (no TOC, no links, one <tr> per entry) ─────────────

function generatePdfHtml(
  sections: ReportEventSection[],
): string {
  const meetYear = Number(
    sections.find(s => s.sessionDate)?.sessionDate?.slice(0, 4) ?? new Date().getFullYear()
  )

  function buildEventHtml(s: ReportEventSection): string {
    const totalHeats = s.heats.length
    const prefix = genderPrefix(s.gender, s.ageMin)
    const centerName = s.gender === 'X'
      ? esc(s.eventName)
      : `${esc(prefix)},&nbsp;${esc(s.eventName)}`
    const ageRange = esc(formatAgeRange(s.ageMin, s.ageMax))
    const dateTimeStr = s.sessionDate
      ? esc(`${s.sessionDate} - ${s.scheduledTime}`)
      : esc(s.scheduledTime)

    let html = `<div class="ev">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr valign="top">
  <td width="25%">Epreuve ${s.eventNumber}<br>${dateTimeStr}</td>
  <td width="50%" align="center">${centerName}<br><br></td>
  <td width="25%" align="right">${ageRange}<br>Liste des s&eacute;ries</td>
</tr>
</table>
<hr class="ev-rule">
<table width="100%" cellspacing="0" cellpadding="0" border="0">
<tr>
  <td width="1%"></td><td width="3%"></td><td width="1%"></td><td width="34%"></td>
  <td width="5%"><em class="f8">Age</em></td>
  <td width="35%"></td><td width="20%"></td><td width="1%"></td>
</tr>
</table>
`
    for (const heat of s.heats) {
      if (heat.entries.length === 0) continue
      const sorted = [...heat.entries].sort((a, b) => a.lane - b.lane)
      html += `<div class="hb">
<div class="hl">S&eacute;rie&nbsp;${heat.number}&nbsp;de&nbsp;${totalHeats}</div>
<table width="100%" cellspacing="0" cellpadding="0" border="0">
${sorted.map(e => {
  const age = computeAge(e.birthYear, meetYear)
  const t = e.status ? e.status : (e.finalTime ?? e.entryTime ?? 'NT')
  return `<tr>
  <td width="1%"></td>
  <td width="3%" align="right"><i><b>${e.lane}</b></i></td>
  <td width="1%"></td>
  <td width="34%"><i><b>${esc(e.lastName + ', ' + e.firstName)}</b></i></td>
  <td width="5%"><i><b>${age}</b></i></td>
  <td width="35%"><i><b>${esc(e.clubName || e.clubCode)}</b></i></td>
  <td width="20%" align="right"><i><b>${esc(t)}</b></i></td>
  <td width="1%"></td>
</tr>`
}).join('\n')}
</table>
</div>
`
    }

    html += `</div>\n`
    return html
  }

  const eventsHtml = sections.map(buildEventHtml).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
BODY, TABLE, TD { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: black; }
.f8 { font-size: 8pt; }
body { margin: 0; padding: 0; }
.ev { margin-bottom: 10pt; }
hr.ev-rule { border: none; border-top: 1px solid black; margin: 2px 0 4px 0; }
.hb { break-inside: avoid; page-break-inside: avoid; margin-bottom: 8pt; }
.hl { text-decoration: underline; margin-bottom: 2pt; }
@page { size: Letter portrait; }
</style>
</head>
<body>
<center>
${eventsHtml}
</center>
</body>
</html>`
}

// ── HTML export generator (TOC + hyperlinks, matches reference .htm format) ────

function generateHeatListHtml(
  meetInfo: MeetInfo,
  sections: ReportEventSection[],
  forExport: boolean,
): string {
  const meetYear = sections.find(s => s.sessionDate)?.sessionDate.slice(0, 4)
    ?? String(new Date().getFullYear())

  // ── TOC ──────────────────────────────────────────────────────────────────────
  const half = Math.ceil(sections.length / 2)
  const leftToc = sections.slice(0, half)
  const rightToc = sections.slice(half)

  function tocLink(s: ReportEventSection, i: number): string {
    const prefix = genderPrefix(s.gender, s.ageMin)
    const fullName = s.gender === 'X'
      ? `${esc(s.eventName)}`
      : `${esc(prefix)},&nbsp;${esc(s.eventName)}`
    const age = esc(formatAgeRange(s.ageMin, s.ageMax))
    return `<a href=#ref${i + 1}>N°&nbsp;${s.eventNumber}.&nbsp;${fullName}&nbsp;&nbsp;${age}</a>`
  }

  const tocHtml = `<table width=100% border=0 cellspacing=0 cellpadding=0><tr valign=top>
<td width=50%><em id=f8>${leftToc.map((s, i) => tocLink(s, i)).join('<br>')}</em></td>
<td width=50%><em id=f8>${rightToc.map((s, i) => tocLink(s, i + half)).join('<br>')}</em></td>
</tr></table>`

  // ── Meet header ───────────────────────────────────────────────────────────────
  const meetHeaderLine1 = esc(meetInfo.name || 'Compétition')
  const dates = [...new Set(sections.map(s => s.sessionDate).filter(Boolean))].sort()
  const dateRange = dates.length > 1
    ? `${dates[0]} - ${dates[dates.length - 1]}`
    : (dates[0] ?? '')
  const meetHeaderLine2 = esc(`${meetInfo.city}${dateRange ? ', ' + dateRange : ''}`)

  const headerHtml = `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td align=center width=100%>${meetHeaderLine1}<br>${meetHeaderLine2}</td></tr>
</table>`

  const HR = `<table width=100% border=0 cellspacing=0 cellpadding=0><tr><td><hr noshade size="1" color="black"></td></tr></table>`

  // ── Events ────────────────────────────────────────────────────────────────────
  function buildEventHtml(s: ReportEventSection, idx: number): string {
    const totalHeats = s.heats.length
    const prefix = genderPrefix(s.gender, s.ageMin)
    const centerName = s.gender === 'X'
      ? esc(s.eventName)
      : `${esc(prefix)}, ${esc(s.eventName)}`
    const ageRange = esc(formatAgeRange(s.ageMin, s.ageMax))
    const dateTimeStr = s.sessionDate
      ? esc(`${s.sessionDate} - ${s.scheduledTime}`)
      : esc(s.scheduledTime)

    let html = `<a name=ref${idx + 1}>\n`

    // TOP link (not on first event)
    if (idx > 0) {
      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><a href="#_top">&lt;&lt; TOP &gt;&gt;</a></td></tr>
</table>\n`
    }

    // Event header
    html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=25%>Epreuve ${s.eventNumber}<br>${dateTimeStr}</td>
<td align=center width=50%>${centerName}<br><br></td>
<td align=right width=25%>${ageRange}<br>Liste des s&eacute;ries</td>
</tr>
</table>
${HR}
<br>
`

    // Column header (Age label)
    html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=1%></td><td width=3%></td><td width=1%></td><td width=34%></td>
<td width=5%><em id=f8>Age</em></td>
<td width=35%></td><td width=20%></td><td width=1%></td><td width=2%></td>
</tr>
</table>
`

    // Heats
    for (const heat of s.heats) {
      if (heat.entries.length === 0) continue

      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><u>S&eacute;rie ${heat.number} de ${totalHeats}</u></td><td width=2%></td></tr>
</table>\n`

      const sorted = [...heat.entries].sort((a, b) => a.lane - b.lane)

      const lanes = sorted.map(e => `<i><b>${e.lane}</b></i>`).join('<br>')
      const names = sorted.map(e => `<i><b>${esc(e.lastName + ', ' + e.firstName)}</b></i>`).join('<br>')
      const ages  = sorted.map(e => `<i><b>${computeAge(e.birthYear, Number(meetYear))}</b></i>`).join('<br>')
      const clubs = sorted.map(e => `<i><b>${esc(e.clubName || e.clubCode)}</b></i>`).join('<br>')
      const times = sorted.map(e => {
        if (e.status) return `<i><b>${e.status}</b></i>`
        const t = e.finalTime ?? e.entryTime ?? 'NT'
        return `<i><b>${esc(t)}</b></i>`
      }).join('<br>')

      html += `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top>
<td width=1%></td>
<td align=right width=3%>${lanes}<br><br><br></td>
<td width=1%></td>
<td width=34%>${names}<br><br><br></td>
<td width=5%>${ages}</td>
<td width=35%>${clubs}<br><br></td>
<td align=right width=20%>${times}<br><br><br></td>
<td width=1%></td>
</tr>
</table>\n`
    }

    return html
  }

  const eventsHtml = sections.map((s, i) => buildEventHtml(s, i)).join('\n')

  // Trailing TOP link
  const trailingTop = sections.length > 0
    ? `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr valign=top><td width=100%><a href="#_top">&lt;&lt; TOP &gt;&gt;</a></td></tr>
</table>\n`
    : ''

  const SPLASH_FOOTER = !forExport ? '' : `<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr><td><hr noshade size="1" color="black"></td></tr></table>
<table width=100% border=0 cellspacing=0 cellpadding=0>
<tr>
  <td width=40%><em id=f8>SauvetageMeet</em></td>
  <td align=center width=20%></td>
  <td align=right width=40%><em id=f8>${new Date().toLocaleDateString('fr-CA')}</em></td>
</tr>
</table>`

  // ── Print CSS ─────────────────────────────────────────────────────────────────
  const printCss = `@page { size: A4 portrait; margin: 1cm 1.5cm; }
@media print { body { background: white !important; } .paper-wrap { box-shadow: none !important; background: white !important; padding: 0 !important; } }`

  // ── Preview-only CSS ──────────────────────────────────────────────────────────
  const previewCss = forExport ? '' : `
body { background: #6b7280; margin: 0; padding: 16px; }
.paper-wrap {
  background: white;
  width: 794px;
  margin: 0 auto;
  padding: 50px 60px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  min-height: 1122px;
}`

  return `<a name=_top>
<!doctype html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<STYLE><!--
BODY,TABLE,TD {font-family: Arial, helvetica; font-style:normal; font-size: 10pt;}
#f8 {font-family: Arial, helvetica; font-style:normal; font-size: 8pt;}
a { color: inherit; text-decoration: underline; }
${printCss}
${previewCss}
--></STYLE>
</head><body>
${forExport ? '' : '<div class="paper-wrap">'}
<center>
${tocHtml}
${HR}
<br>
${headerHtml}
${HR}
<br>
${eventsHtml}
${trailingTop}
${SPLASH_FOOTER}
</center>
${forExport ? '' : '</div>'}
</body></html>`
}

// ── ReportPage ─────────────────────────────────────────────────────────────────

export default function ReportPage({ refreshKey = 0 }: { refreshKey?: number }) {
  const [heatSessions, setHeatSessions]   = useState<HeatListSessionRow[]>([])
  const [fullSessions, setFullSessions]   = useState<SessionRow[]>([])
  const [meetInfo, setMeetInfo]           = useState<MeetInfo>({ name: '', city: '', nation: '' })
  const [loading, setLoading]             = useState(true)

  const [selectedEventIds, setSelectedEventIds] = useState<Set<number>>(new Set())
  const lastClickedIdx = useRef<number | null>(null)

  const [previewUrl, setPreviewUrlState]   = useState<string | null>(null)
  const [exportHtml, setExportHtml]        = useState<string | null>(null)
  const [pdfHtml, setPdfHtml]              = useState<string | null>(null)
  const [pdfHeaderInfo, setPdfHeaderInfo]  = useState<PdfHeaderInfo | null>(null)
  const [generating, setGenerating]        = useState(false)
  const iframeRef  = useRef<HTMLIFrameElement>(null)
  const blobUrlRef = useRef<string | null>(null)

  function setPreviewUrl(url: string | null) {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    blobUrlRef.current = url
    setPreviewUrlState(url)
  }

  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  // ── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    setLoading(true)
    const api = dbApi()
    if (!api) { setLoading(false); return }
    Promise.all([
      api.getHeatListSessions() as Promise<HeatListSessionRow[]>,
      api.getSessions()         as Promise<SessionRow[]>,
      api.getMeetInfo()         as Promise<MeetInfo>,
    ]).then(([hs, fs, mi]) => {
      setHeatSessions(hs)
      setFullSessions(fs)
      setMeetInfo(mi)
      // Select all events by default
      const allEventIds = new Set<number>()
      hs.forEach(s => s.events.forEach(e => { if (!e.isAdmin) allEventIds.add(e.id) }))
      setSelectedEventIds(allEventIds)
    }).catch(console.error).finally(() => setLoading(false))
  }, [refreshKey])

  // ── Flat items for selector ────────────────────────────────────────────────

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []
    for (const s of heatSessions) {
      items.push({
        key: `session:${s.id}`,
        type: 'session',
        id: s.id,
        sessionId: s.id,
        label: `Session ${s.number}${s.name ? ' – ' + s.name : ''}${s.time ? ' (' + s.time + ')' : ''}`,
        isAdmin: false,
      })
      for (const e of s.events) {
        items.push({
          key: `event:${e.id}`,
          type: 'event',
          id: e.id,
          sessionId: s.id,
          label: e.number
            ? `${e.number}. ${e.nameFr}${e.scheduledTime ? ' ' + e.scheduledTime : ''}`
            : e.nameFr,
          isAdmin: e.isAdmin ?? false,
        })
      }
    }
    return items
  }, [heatSessions])

  // ── Age-group lookup from fullSessions ────────────────────────────────────

  const ageGroupMap = useMemo(() => {
    const m = new Map<number, AgeGroupRow[]>()
    for (const s of fullSessions) {
      for (const e of s.events) m.set(e.id, e.ageGroups)
    }
    return m
  }, [fullSessions])

  const sessionDateMap = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of fullSessions) m.set(s.id, s.date ?? '')
    return m
  }, [fullSessions])

  // ── Selection helpers ──────────────────────────────────────────────────────

  function getSessionEventIds(sessionId: number): number[] {
    return heatSessions
      .find(s => s.id === sessionId)
      ?.events.filter(e => !(e.isAdmin)).map(e => e.id) ?? []
  }

  function isSessionSelected(sessionId: number): boolean {
    const ids = getSessionEventIds(sessionId)
    return ids.length > 0 && ids.every(id => selectedEventIds.has(id))
  }

  function isSessionPartial(sessionId: number): boolean {
    const ids = getSessionEventIds(sessionId)
    return ids.some(id => selectedEventIds.has(id)) && !ids.every(id => selectedEventIds.has(id))
  }

  const handleItemClick = useCallback((idx: number, item: FlatItem, e: React.MouseEvent) => {
    if (item.isAdmin) return

    const targetEventIds: number[] = item.type === 'session'
      ? getSessionEventIds(item.id)
      : [item.id]

    setSelectedEventIds(prev => {
      const next = new Set(prev)

      if (e.ctrlKey || e.metaKey) {
        // Toggle
        if (item.type === 'session') {
          const allSel = targetEventIds.every(id => next.has(id))
          targetEventIds.forEach(id => allSel ? next.delete(id) : next.add(id))
        } else {
          if (next.has(item.id)) next.delete(item.id); else next.add(item.id)
        }
      } else if (e.shiftKey && lastClickedIdx.current !== null) {
        // Range select
        const lo = Math.min(lastClickedIdx.current, idx)
        const hi = Math.max(lastClickedIdx.current, idx)
        for (let i = lo; i <= hi; i++) {
          const ri = flatItems[i]
          if (!ri || ri.isAdmin) continue
          if (ri.type === 'event') next.add(ri.id)
          else getSessionEventIds(ri.id).forEach(id => next.add(id))
        }
      } else {
        // Single click: if item already the only selection, deselect; else select only it
        const onlyThis =
          item.type === 'event'
            ? next.size === 1 && next.has(item.id)
            : targetEventIds.every(id => next.has(id)) && next.size === targetEventIds.length

        if (onlyThis) {
          targetEventIds.forEach(id => next.delete(id))
        } else {
          next.clear()
          targetEventIds.forEach(id => next.add(id))
        }
      }

      return next
    })

    lastClickedIdx.current = idx
  }, [flatItems, heatSessions]) // eslint-disable-line

  // ── Build report sections from selection ───────────────────────────────────

  function buildSections(): ReportEventSection[] {
    const sections: ReportEventSection[] = []
    for (const hs of heatSessions) {
      const sDate = sessionDateMap.get(hs.id) ?? ''
      for (const ev of hs.events) {
        if (ev.isAdmin) continue
        if (!selectedEventIds.has(ev.id)) continue
        const ags = ageGroupMap.get(ev.id) ?? []
        const ag = ags[0]
        sections.push({
          eventId: ev.id,
          eventNumber: ev.number,
          eventName: ev.nameFr,
          gender: ev.gender,
          ageMin: ag?.minAge ?? 0,
          ageMax: ag?.maxAge ?? null,
          sessionDate: sDate,
          scheduledTime: ev.scheduledTime ?? '',
          heats: ev.heats,
        })
      }
    }
    return sections
  }

  // ── Generate ───────────────────────────────────────────────────────────────

  async function handleGenerate() {
    const sections = buildSections()
    if (sections.length === 0) return
    const exported = generateHeatListHtml(meetInfo, sections, true)
    const pdf = generatePdfHtml(sections)
    const hdrInfo = buildPdfHeaderInfo(meetInfo, sections)
    setExportHtml(exported)
    setPdfHtml(pdf)
    setPdfHeaderInfo(hdrInfo)
    setGenerating(true)
    setPreviewUrl(null)
    try {
      const result = await reportApi()?.previewPdf(pdf, hdrInfo)
      if (result?.ok) {
        const bytes = atob(result.data)
        const arr = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
        const blob = new Blob([arr], { type: 'application/pdf' })
        setPreviewUrl(URL.createObjectURL(blob))
      }
    } catch (err) {
      console.error('PDF preview error', err)
    } finally {
      setGenerating(false)
    }
  }

  // ── Print / PDF / HTML ─────────────────────────────────────────────────────

  async function handlePrint() {
    if (!pdfHtml || !pdfHeaderInfo) return
    const r = await reportApi()?.print(pdfHtml, pdfHeaderInfo)
    if (r && !r.ok && !r.canceled) alert(`Erreur impression: ${r.error}`)
  }

  async function handleSavePdf() {
    if (!pdfHtml || !pdfHeaderInfo) return
    const r = await reportApi()?.savePdf(pdfHtml, pdfHeaderInfo)
    if (r && !r.ok && !r.canceled) alert(`Erreur PDF: ${r.error}`)
  }

  async function handleSaveHtml() {
    if (!exportHtml) return
    const r = await reportApi()?.saveHtml(exportHtml)
    if (r && !r.ok && !r.canceled) alert(`Erreur HTML: ${r.error}`)
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  const hasPreview = previewUrl !== null || generating

  return (
    <div className="flex flex-col h-full bg-gray-100" style={{ userSelect: 'none' }}>

      {/* ── Top toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-200 border-b border-gray-300 shrink-0">
        <label className="text-xs font-medium text-gray-600">Rapport:</label>
        <select className="text-xs border border-gray-400 bg-white px-2 py-0.5 h-6">
          <option>Liste des Séries</option>
        </select>
        <button
          onClick={handleGenerate}
          disabled={selectedEventIds.size === 0 || loading || generating}
          className="px-3 py-0.5 h-6 text-xs bg-blue-600 text-white border border-blue-700 hover:bg-blue-700 disabled:opacity-40"
        >
          {generating ? 'Génération…' : 'Générer'}
        </button>
      </div>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: cascade session/event selector ── */}
        <div className="w-72 border-r border-gray-300 bg-white flex flex-col shrink-0">
          <div className="px-2 py-1 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200">
            Sessions / Épreuves
          </div>
          <div className="flex-1 overflow-y-auto text-xs">
            {loading && (
              <div className="p-3 text-gray-400 italic">Chargement…</div>
            )}
            {!loading && flatItems.length === 0 && (
              <div className="p-3 text-gray-400 italic">Aucune donnée</div>
            )}
            {flatItems.map((item, idx) => {
              const isSession = item.type === 'session'
              const selected = isSession
                ? isSessionSelected(item.id)
                : selectedEventIds.has(item.id)
              const partial = isSession && isSessionPartial(item.id)
              const disabled = item.isAdmin

              return (
                <div
                  key={item.key}
                  onClick={e => !disabled && handleItemClick(idx, item, e)}
                  className={[
                    'flex items-center gap-1 px-2 cursor-default',
                    isSession
                      ? 'py-1 font-semibold border-b border-gray-100 bg-gray-50 hover:bg-gray-100'
                      : 'py-0.5 pl-5 hover:bg-gray-50',
                    selected && !partial ? 'bg-blue-100 text-blue-900 hover:bg-blue-100' : '',
                    partial ? 'bg-blue-50 text-blue-800' : '',
                    disabled ? 'opacity-40 cursor-not-allowed' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {/* checkbox-like indicator */}
                  <span className={[
                    'w-3 h-3 border flex items-center justify-center shrink-0',
                    selected && !partial ? 'bg-blue-600 border-blue-700' : 'bg-white border-gray-400',
                    partial ? 'bg-blue-300 border-blue-500' : '',
                  ].join(' ')}>
                    {(selected || partial) && (
                      <span className="text-white text-[8px] leading-none">
                        {partial ? '–' : '✓'}
                      </span>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>
              )
            })}
          </div>
          {/* Selection summary */}
          <div className="px-2 py-1 text-xs text-gray-500 border-t border-gray-200 bg-gray-50">
            {selectedEventIds.size} épreuve{selectedEventIds.size !== 1 ? 's' : ''} sélectionnée{selectedEventIds.size !== 1 ? 's' : ''}
          </div>
        </div>

        {/* ── Right: preview pane ── */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Preview toolbar */}
          <div className="flex items-center gap-1 px-3 py-1.5 bg-gray-200 border-b border-gray-300 shrink-0">
            <button
              onClick={handlePrint}
              disabled={!pdfHtml || generating}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              Imprimer
            </button>
            <button
              onClick={handleSavePdf}
              disabled={!pdfHtml || generating}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              PDF
            </button>
            <button
              onClick={handleSaveHtml}
              disabled={!exportHtml || generating}
              className="px-3 py-0.5 text-xs border border-gray-400 bg-white hover:bg-gray-100 disabled:opacity-40"
            >
              HTML
            </button>
          </div>

          {/* Preview iframe */}
          <div className="flex-1 overflow-hidden bg-gray-500 relative">
            {!hasPreview && (
              <div className="flex items-center justify-center h-full text-gray-300 text-sm italic">
                Sélectionnez des épreuves et cliquez sur <span className="mx-1 px-2 bg-gray-600 rounded">Générer</span>
              </div>
            )}
            {generating && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-700 bg-opacity-70 z-10">
                <span className="text-white text-sm">Génération de l'aperçu…</span>
              </div>
            )}
            {previewUrl && (
              <iframe
                ref={iframeRef}
                src={previewUrl}
                className="w-full h-full border-0"
                title="Aperçu du rapport"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
