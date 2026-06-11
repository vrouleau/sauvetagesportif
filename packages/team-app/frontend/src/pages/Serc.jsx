/**
 * SERC (Simulated Emergency Response Competition) page.
 * Teams come from relay entries for the SERC event (swimstyle 530).
 *
 * Redesigned:
 * - Setup: user picks descriptive labels for Approach/Rescue/Control (factors hidden)
 *   Landing and Care factors are auto-derived from victim type.
 * - Single scoring grid (no multi-draw concept). One scenario, one grid.
 *   Two orderings: "Random Draw" and "Final Draw" (reordered by results).
 * - Tab navigation moves down (next criterion same team), not right.
 * - Data is entered by judges/victims on a per-team column basis.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useLang } from '../i18n'
import { QRCodeSVG } from 'qrcode.react'
import api from '../api'

// ─── Factor Catalog ───────────────────────────────────────────────────────────
// Descriptive labels from the XLSX "Drop Down Info" sheet.
// User picks these; the factor value is hidden.

const APPROACH_OPTIONS = {
  en: [
    { label: 'Victim far from landing i.e. 15m+', factor: 1.5 },
    { label: 'Victim near to landing i.e. 6-10m', factor: 1.25 },
    { label: 'Victim close to landing or on deck i.e. 5m', factor: 1.0 },
  ],
  fr: [
    { label: 'Victime loin du débarquement, c.-à-d. 15m+', factor: 1.5 },
    { label: 'Victime près du débarquement, c.-à-d. 6-10m', factor: 1.25 },
    { label: 'Victime proche du débarquement ou sur le bord, c.-à-d. 5m', factor: 1.0 },
  ],
}

const RESCUE_OPTIONS = {
  en: [
    { label: 'Refuses aid and will not swim in unless clear and concise directions are given', factor: 1.5 },
    { label: 'Accepts aid but will not swim in unless clear and concise directions are given', factor: 1.25 },
    { label: 'Accepts aid and swims in / Unconscious', factor: 1.0 },
  ],
  fr: [
    { label: "Refuse l'aide et ne nagera pas sans directives claires et concises", factor: 1.5 },
    { label: "Accepte l'aide mais ne nagera pas sans directives claires et concises", factor: 1.25 },
    { label: "Accepte l'aide et nage / Inconscient", factor: 1.0 },
  ],
}

const CONTROL_OPTIONS = {
  en: [
    { label: 'Talk or Throw rescue expected', factor: 1.5 },
    { label: 'Reach or Tow rescue expected', factor: 1.25 },
    { label: 'Carry rescue expected', factor: 1.0 },
  ],
  fr: [
    { label: 'Sauvetage verbal ou par lancer attendu', factor: 1.5 },
    { label: 'Sauvetage par extension ou remorquage attendu', factor: 1.25 },
    { label: 'Sauvetage par transport attendu', factor: 1.0 },
  ],
}

// Overall factor options (descriptive labels from Drop Down Info)
const OVERALL_OPTIONS = {
  en: {
    assessment: [
      { label: 'Significant barrier to assess and identify victim priorities', factor: 1.5 },
      { label: 'Moderate barrier to assess and identify victim priorities', factor: 1.25 },
      { label: 'Minor barrier to assess and identify victim priorities', factor: 1.0 },
    ],
    control: [
      { label: 'Significant limitations that provide difficulty for teams to maintain safety', factor: 1.5 },
      { label: 'Moderate environment, equipment, condition limitations to maintain safety', factor: 1.25 },
      { label: 'Minor environment, equipment, condition limitations to maintain safety', factor: 1.0 },
    ],
    communication: [
      { label: 'Significant interference to communication due to size/layout/noise', factor: 1.5 },
      { label: 'Moderate interference to communication due to size/layout/noise', factor: 1.25 },
      { label: 'Minor interference to communication due to size/layout/noise', factor: 1.0 },
    ],
    search: [
      { label: 'Victim is significantly hidden from view and searching', factor: 1.5 },
      { label: 'Victim is moderately hidden from view or searching', factor: 1.25 },
      { label: 'Victim is minimally hidden from view or searching', factor: 1.0 },
    ],
    teamwork: [
      { label: 'Teamwork without bystanders/victim assistance or uncooperative bystanders', factor: 1.5 },
      { label: 'Teamwork with reluctant bystanders/victim assistance', factor: 1.25 },
      { label: 'Teamwork with cooperative bystander/victim assistance', factor: 1.0 },
    ],
  },
  fr: {
    assessment: [
      { label: 'Obstacle important pour évaluer et identifier les priorités des victimes', factor: 1.5 },
      { label: 'Obstacle modéré pour évaluer et identifier les priorités des victimes', factor: 1.25 },
      { label: 'Obstacle mineur pour évaluer et identifier les priorités des victimes', factor: 1.0 },
    ],
    control: [
      { label: "Limitations importantes rendant difficile le maintien de la sécurité", factor: 1.5 },
      { label: "Limitations modérées d'environnement, équipement, conditions pour la sécurité", factor: 1.25 },
      { label: "Limitations mineures d'environnement, équipement, conditions pour la sécurité", factor: 1.0 },
    ],
    communication: [
      { label: 'Interférence importante à la communication due à la taille/disposition/bruit', factor: 1.5 },
      { label: 'Interférence modérée à la communication due à la taille/disposition/bruit', factor: 1.25 },
      { label: 'Interférence mineure à la communication due à la taille/disposition/bruit', factor: 1.0 },
    ],
    search: [
      { label: 'Victime significativement cachée de la vue et de la recherche', factor: 1.5 },
      { label: 'Victime modérément cachée de la vue ou de la recherche', factor: 1.25 },
      { label: 'Victime minimalement cachée de la vue ou de la recherche', factor: 1.0 },
    ],
    teamwork: [
      { label: "Travail d'équipe sans passants/aide des victimes ou passants non coopératifs", factor: 1.5 },
      { label: "Travail d'équipe avec passants/aide des victimes réticents", factor: 1.25 },
      { label: "Travail d'équipe avec passants/aide des victimes coopératifs", factor: 1.0 },
    ],
  },
}

// Landing/Care auto-derived from victim type
const LANDING_CARE_MAP = {
  'Non Swimmer': { landing: 1.25, care: 1.25 },
  'Weak Swimmer': { landing: 1.5, care: 1.0 },
  'Injured Swimmer': { landing: 1.25, care: 1.25 },
  'Unconscious Non-Breathing': { landing: 1.0, care: 1.5 },
}

// Victim type labels (stored value is always English key)
const VICTIM_TYPE_LABELS = {
  en: {
    'Non Swimmer': 'Non Swimmer',
    'Weak Swimmer': 'Weak Swimmer',
    'Injured Swimmer': 'Injured Swimmer',
    'Unconscious Non-Breathing': 'Unconscious Non-Breathing',
  },
  fr: {
    'Non Swimmer': 'Non-nageur',
    'Weak Swimmer': 'Nageur faible',
    'Injured Swimmer': 'Nageur blessé',
    'Unconscious Non-Breathing': 'Inconscient sans respiration',
  },
}

export default function Serc() {
  const { lang } = useLang()
  const [page, setPage] = useState('setup')
  const [config, setConfig] = useState(null)
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const pendingSaveRef = useRef(null)

  const loadAll = useCallback(async () => {
    try {
      const [cfgR, teamsR] = await Promise.all([
        api.get('/serc/config'),
        api.get('/serc/teams'),
      ])
      setConfig(cfgR.data)
      setTeams(teamsR.data || [])
    } catch { /* first load may have no config */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // Auto-save pending config when navigating away from setup
  function handleSetPage(newPage) {
    if (page === 'setup' && newPage !== 'setup' && pendingSaveRef.current) {
      pendingSaveRef.current()
    }
    setPage(newPage)
  }

  if (loading) return <div className="p-4 text-xs text-gray-500">{lang === 'fr' ? 'Chargement SERC…' : 'Loading SERC…'}</div>

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-44 bg-gray-800 text-white text-xs flex flex-col shrink-0">
        <div className="px-3 py-2 font-bold border-b border-gray-700">
          SERC
          <div className="text-gray-400 font-normal text-[10px] mt-0.5">{teams.length} {lang === 'fr' ? 'équipes' : 'teams'}</div>
        </div>
        <div className="text-gray-500 text-[10px] uppercase px-3 pt-2">{lang === 'fr' ? 'Configuration' : 'Configuration'}</div>
        <NavItem label={lang === 'fr' ? 'Configuration et facteurs' : 'Setup & Factors'} active={page === 'setup'} onClick={() => handleSetPage('setup')} />
        <div className="text-gray-500 text-[10px] uppercase px-3 pt-3">{lang === 'fr' ? 'Saisie des pointages' : 'Score Entry'}</div>
        <NavItem label={lang === 'fr' ? 'Pointages' : 'Scoring'} active={page === 'scoring'} onClick={() => handleSetPage('scoring')} />
        <div className="text-gray-500 text-[10px] uppercase px-3 pt-3">{lang === 'fr' ? 'Résultats' : 'Output'}</div>
        <NavItem label={lang === 'fr' ? 'Résultats' : 'Results'} active={page === 'results'} onClick={() => handleSetPage('results')} />
        <NavItem label={lang === 'fr' ? 'Feuilles d\'impression' : 'Print Sheets'} active={false}
          onClick={() => window.open('/api/serc/print/sheets?lang=bilingual', '_blank')} />
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-4">
        {page === 'setup' && <SetupPage config={config} onSave={loadAll} lang={lang} registerSave={fn => { pendingSaveRef.current = fn }} />}
        {page === 'scoring' && <ScoringPage teams={teams} config={config} lang={lang} />}
        {page === 'results' && <ResultsPage lang={lang} />}
      </div>
    </div>
  )
}

function NavItem({ label, active, onClick }) {
  return (
    <div
      className={`px-3 py-1.5 cursor-pointer text-xs ${active ? 'bg-blue-600 font-bold' : 'hover:bg-gray-700'}`}
      onClick={onClick}
    >
      {label}
    </div>
  )
}

// ─── Setup Page ───────────────────────────────────────────────────────────────

function SetupPage({ config, onSave, lang, registerSave }) {
  const [form, setForm] = useState({
    num_victims: config?.num_victims || 9,
    num_draws: 1, // always 1 — single scoring grid
    has_bystander: config?.has_bystander ?? true,
    overall_factors: config?.overall_factors || { assessment: 1, control: 1, communication: 1.25, search: 1.5, teamwork: 1 },
    bystander_factors: config?.bystander_factors || { approach: 1, info: 1, directions: 1, monitoring: 1, encouragement: 1 },
    victim_factors: config?.victim_factors || [],
  })
  const [dirty, setDirty] = useState(false)

  function updateForm(updater) {
    setForm(updater)
    setDirty(true)
  }

  async function save() {
    // Auto-compute landing/care from victim type before saving
    const vfs = form.victim_factors.slice(0, form.num_victims).map(vf => {
      const derived = LANDING_CARE_MAP[vf.type] || { landing: 1.25, care: 1.25 }
      return { ...vf, landing: derived.landing, care: derived.care }
    })
    await api.post('/serc/config', { ...form, num_draws: 1, victim_factors: vfs })
    setDirty(false)
    onSave()
  }

  // Register save function so parent can auto-save when navigating away
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (registerSave) registerSave(() => { if (dirty) saveRef.current() })
    return () => { if (registerSave) registerSave(null) }
  }, [registerSave, dirty])

  const victimTypes = ['Non Swimmer', 'Weak Swimmer', 'Injured Swimmer', 'Unconscious Non-Breathing']

  // Ensure victim_factors has enough entries
  while (form.victim_factors.length < form.num_victims) {
    form.victim_factors.push({ type: 'Non Swimmer', approach: 1.25, rescue: 1.5, control: 1, landing: 1.25, care: 1.25 })
  }

  function updateVictim(index, field, value) {
    const nv = [...form.victim_factors]
    nv[index] = { ...nv[index], [field]: value }
    // Auto-compute landing/care when type changes
    if (field === 'type') {
      const derived = LANDING_CARE_MAP[value] || { landing: 1.25, care: 1.25 }
      nv[index].landing = derived.landing
      nv[index].care = derived.care
    }
    setForm(f => ({ ...f, victim_factors: nv }))
    setDirty(true)
  }

  function getApproachLabel(factor) {
    return APPROACH_OPTIONS[lang].find(o => o.factor === factor)?.label || APPROACH_OPTIONS[lang][2].label
  }
  function getRescueLabel(factor) {
    return RESCUE_OPTIONS[lang].find(o => o.factor === factor)?.label || RESCUE_OPTIONS[lang][2].label
  }
  function getControlLabel(factor) {
    return CONTROL_OPTIONS[lang].find(o => o.factor === factor)?.label || CONTROL_OPTIONS[lang][2].label
  }

  const overallOptions = OVERALL_OPTIONS[lang]
  const victimTypeLabels = VICTIM_TYPE_LABELS[lang]

  return (
    <div className="space-y-4 max-w-6xl">
      <h2 className="text-lg font-bold text-gray-800">{lang === 'fr' ? 'SERC — Configuration et facteurs' : 'SERC Setup & Factors'}</h2>

      <div className="bg-white border border-gray-300 rounded p-4 space-y-3">
        <h3 className="text-sm font-bold text-gray-700 border-b pb-1">{lang === 'fr' ? 'Paramètres de la compétition' : 'Competition Settings'}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 block mb-0.5">{lang === 'fr' ? 'Nombre de victimes (1–16)' : 'Number of Victims (1–16)'}</label>
            <input type="number" min={1} max={16} className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
              value={form.num_victims} onChange={e => updateForm(f => ({ ...f, num_victims: Math.min(16, Math.max(1, +e.target.value)) }))} />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 block mb-0.5">{lang === 'fr' ? 'Passant' : 'Bystander'}</label>
            <select className="w-full border border-gray-300 rounded px-2 py-1 text-xs" value={form.has_bystander ? '1' : '0'}
              onChange={e => updateForm(f => ({ ...f, has_bystander: e.target.value === '1' }))}>
              <option value="1">{lang === 'fr' ? 'Oui — Passant présent' : 'Yes — Bystander present'}</option>
              <option value="0">{lang === 'fr' ? 'Non — Pas de passant' : 'No — No bystander'}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-300 rounded p-4">
        <h3 className="text-sm font-bold text-gray-700 border-b pb-1 mb-2">{lang === 'fr' ? 'Global (Juge en chef)' : 'Overall (Chief Judge)'}</h3>
        <div className="space-y-2">
          {Object.entries(overallOptions).map(([key, options]) => {
            const overallKeyLabels = lang === 'fr'
              ? { assessment: 'Évaluation', control: 'Contrôle', communication: 'Communication', search: 'Recherche', teamwork: "Travail d'équipe" }
              : { assessment: 'Assessment', control: 'Control', communication: 'Communication', search: 'Search', teamwork: 'Teamwork' }
            return (
            <div key={key} className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 w-28">{overallKeyLabels[key] || key}</label>
              <select className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
                value={form.overall_factors[key] || 1}
                onChange={e => updateForm(f => ({ ...f, overall_factors: { ...f.overall_factors, [key]: +e.target.value } }))}>
                {options.map(o => <option key={o.factor} value={o.factor}>{o.label}</option>)}
              </select>
            </div>
            )
          })}
        </div>
      </div>

      <div className="bg-white border border-gray-300 rounded p-4">
        <h3 className="text-sm font-bold text-gray-700 border-b pb-1 mb-2">{lang === 'fr' ? 'Configuration des victimes' : 'Victim Configuration'}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-800 text-white">
                <th className="px-2 py-1 text-left w-8">#</th>
                <th className="px-2 py-1 text-left w-36">{lang === 'fr' ? 'Type' : 'Type'}</th>
                <th className="px-2 py-1 text-left">{lang === 'fr' ? 'Reconnaissance / Approche' : 'Victim Recognition / Approach'}</th>
                <th className="px-2 py-1 text-left">{lang === 'fr' ? 'Sauvetage' : 'Rescue'}</th>
                <th className="px-2 py-1 text-left">{lang === 'fr' ? 'Contrôle de la victime' : 'Control of Victim'}</th>
                <th className="px-2 py-1 text-center w-20">{lang === 'fr' ? 'Débarq.' : 'Landing'}</th>
                <th className="px-2 py-1 text-center w-20">{lang === 'fr' ? 'Soins' : 'Care'}</th>
              </tr>
            </thead>
            <tbody>
              {form.victim_factors.slice(0, form.num_victims).map((vf, i) => {
                const derived = LANDING_CARE_MAP[vf.type] || { landing: 1.25, care: 1.25 }
                return (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="px-2 py-1 font-bold">{i + 1}</td>
                    <td className="px-2 py-1">
                      <select className="border border-gray-300 rounded px-1 py-0.5 text-xs w-full" value={vf.type}
                        onChange={e => updateVictim(i, 'type', e.target.value)}>
                        {victimTypes.map(t => <option key={t} value={t}>{victimTypeLabels[t]}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select className="border border-gray-300 rounded px-1 py-0.5 text-xs w-full" value={vf.approach}
                        onChange={e => updateVictim(i, 'approach', +e.target.value)}>
                        {APPROACH_OPTIONS[lang].map(o => <option key={o.factor} value={o.factor}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select className="border border-gray-300 rounded px-1 py-0.5 text-xs w-full" value={vf.rescue}
                        onChange={e => updateVictim(i, 'rescue', +e.target.value)}>
                        {RESCUE_OPTIONS[lang].map(o => <option key={o.factor} value={o.factor}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select className="border border-gray-300 rounded px-1 py-0.5 text-xs w-full" value={vf.control}
                        onChange={e => updateVictim(i, 'control', +e.target.value)}>
                        {CONTROL_OPTIONS[lang].map(o => <option key={o.factor} value={o.factor}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1 text-center text-gray-500 italic text-[10px]">
                      {derived.landing}
                    </td>
                    <td className="px-2 py-1 text-center text-gray-500 italic text-[10px]">
                      {derived.care}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-400 mt-1">{lang === 'fr' ? 'Les facteurs Débarquement et Soins sont dérivés du type de victime.' : 'Landing and Care factors are derived from the victim type.'}</p>
      </div>

      <button className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700" onClick={save}>
        {lang === 'fr' ? 'Enregistrer la configuration' : 'Save Configuration'}
      </button>
    </div>
  )
}

// ─── Scoring Page (Single Grid) ───────────────────────────────────────────────

function ScoringPage({ teams, config, lang }) {
  const [scores, setScores] = useState({})
  const [order, setOrder] = useState([])
  const [drawMode, setDrawMode] = useState('random') // 'random' or 'final'
  const [showQR, setShowQR] = useState(false)
  const gridRef = useRef(null)

  useEffect(() => {
    // Load scores (draw_number=1 always, single grid)
    api.get('/serc/scores/1').then(r => setScores(r.data || {})).catch(() => {})
    api.get('/serc/draw-order/1').then(r => {
      const o = (r.data || []).map(x => x.relay_team_id)
      setOrder(o.length ? o : teams.map(t => t.relay_team_id))
    }).catch(() => setOrder(teams.map(t => t.relay_team_id)))
  }, [teams])

  async function randomize() {
    const r = await api.post('/serc/draw-order/1/randomize')
    setOrder(r.data.order)
    setDrawMode('random')
  }

  async function orderByResults() {
    // Reorder by current totals (lowest first, best goes last)
    const totals = orderedTeams.map(t => ({ id: t.relay_team_id, total: calcTotal(t.relay_team_id) }))
    totals.sort((a, b) => a.total - b.total) // worst first, best last
    const newOrder = totals.map(t => t.id)
    await api.put('/serc/draw-order/1', { team_ids: newOrder })
    setOrder(newOrder)
    setDrawMode('final')
  }

  async function saveScore(teamId, section, field, value) {
    await api.put('/serc/score', { draw: 1, relay_team_id: teamId, section, field, value: value === '' ? null : value })
    setScores(prev => {
      const tid = String(teamId)
      const copy = { ...prev }
      if (!copy[tid]) copy[tid] = {}
      if (!copy[tid][section]) copy[tid][section] = {}
      copy[tid][section][field] = value === '' ? null : +value
      return copy
    })
  }

  function getScore(teamId, section, field) {
    return scores[String(teamId)]?.[section]?.[field] ?? ''
  }

  function calcTotal(teamId) {
    const ts = scores[String(teamId)] || {}
    const of = config?.overall_factors || {}
    const bf = config?.bystander_factors || {}
    const vfs = config?.victim_factors || []
    let total = 0
    for (const f of ['assessment', 'control', 'communication', 'search', 'teamwork'])
      total += (ts.overall?.[f] || 0) * (of[f] || 1)
    total += ts.overall?.rough || 0
    if (config?.has_bystander) {
      for (const f of ['approach', 'info', 'directions', 'monitoring', 'encouragement'])
        total += (ts.bystander?.[f] || 0) * (bf[f] || 1)
      total += ts.bystander?.rough || 0
    }
    for (let i = 0; i < (config?.num_victims || 9); i++) {
      const vs = ts[`victim_${i}`] || {}
      const vf = vfs[i] || {}
      for (const f of ['approach', 'rescue', 'control', 'landing', 'care'])
        total += (vs[f] || 0) * (vf[f] || 1)
      total += vs.rough || 0
    }
    return Math.round(total * 100) / 100
  }

  // Tab navigation: move down within the same column
  function handleKeyDown(e, rowIdx, colIdx) {
    if (e.key === 'Tab') {
      e.preventDefault()
      const inputs = gridRef.current?.querySelectorAll(`input[data-col="${colIdx}"]`)
      if (!inputs) return
      const arr = Array.from(inputs)
      const curIdx = arr.findIndex(el => el === e.target)
      const nextIdx = e.shiftKey ? curIdx - 1 : curIdx + 1
      if (nextIdx >= 0 && nextIdx < arr.length) {
        arr[nextIdx].focus()
        arr[nextIdx].select()
      }
    }
  }

  // Build criteria rows
  const of = config?.overall_factors || {}
  const bf = config?.bystander_factors || {}
  const vfs = config?.victim_factors || []

  const criteria = []
  // Overall
  criteria.push({ header: lang === 'fr' ? 'Global (Juge en chef)' : 'Overall (Chief Judge)' })
  const overallLabels = lang === 'fr'
    ? { assessment: 'Évaluation', control: 'Contrôle', communication: 'Communication', search: 'Recherche', teamwork: "Travail d'équipe" }
    : { assessment: 'Assessment', control: 'Control', communication: 'Communication', search: 'Search', teamwork: 'Teamwork' }
  for (const f of ['assessment', 'control', 'communication', 'search', 'teamwork'])
    criteria.push({ section: 'overall', field: f, label: overallLabels[f], factor: of[f] || 1 })
  criteria.push({ section: 'overall', field: 'rough', label: lang === 'fr' ? 'Manipulation brutale' : 'Rough Handling', factor: 1, isRough: true })
  // Bystander
  if (config?.has_bystander) {
    criteria.push({ header: lang === 'fr' ? 'Passant' : 'Bystander' })
    criteria.push({ section: 'bystander', field: 'approach', label: lang === 'fr' ? 'Reconnaissance / Approche' : 'Victim Recognition/Approach', factor: bf.approach || 1 })
    criteria.push({ section: 'bystander', field: 'info', label: lang === 'fr' ? 'Évalue les informations pertinentes' : 'Assesses relevant information', factor: bf.info || 1 })
    criteria.push({ section: 'bystander', field: 'directions', label: lang === 'fr' ? 'Fournit des directives et instructions' : 'Provides directions and instructions', factor: bf.directions || 1 })
    criteria.push({ section: 'bystander', field: 'monitoring', label: lang === 'fr' ? 'Surveillance des actions du passant' : 'Monitoring bystander actions', factor: bf.monitoring || 1 })
    criteria.push({ section: 'bystander', field: 'encouragement', label: lang === 'fr' ? 'Encouragement continu' : 'Provides ongoing encouragement', factor: bf.encouragement || 1 })
    criteria.push({ section: 'bystander', field: 'rough', label: lang === 'fr' ? 'Manipulation brutale' : 'Rough Handling', factor: 1, isRough: true })
  }
  // Victims
  const victimFieldLabels = lang === 'fr'
    ? { approach: 'Reconnaissance / Approche', rescue: 'Sauvetage', control: 'Contrôle de la victime', landing: 'Débarquement', care: 'Soins et après-soins' }
    : { approach: 'Victim recognition/approach', rescue: 'Rescue', control: 'Control of victim', landing: 'Landing', care: 'Care and aftercare' }
  const victimTypeLabels = VICTIM_TYPE_LABELS[lang]
  for (let i = 0; i < (config?.num_victims || 9); i++) {
    const vf = vfs[i] || {}
    criteria.push({ header: `${lang === 'fr' ? 'Victime' : 'Victim'} ${i + 1} — ${victimTypeLabels[vf.type] || '?'}` })
    criteria.push({ section: `victim_${i}`, field: 'approach', label: victimFieldLabels.approach, factor: vf.approach || 1 })
    criteria.push({ section: `victim_${i}`, field: 'rescue', label: victimFieldLabels.rescue, factor: vf.rescue || 1 })
    criteria.push({ section: `victim_${i}`, field: 'control', label: victimFieldLabels.control, factor: vf.control || 1 })
    criteria.push({ section: `victim_${i}`, field: 'landing', label: victimFieldLabels.landing, factor: vf.landing || 1 })
    criteria.push({ section: `victim_${i}`, field: 'care', label: victimFieldLabels.care, factor: vf.care || 1 })
    criteria.push({ section: `victim_${i}`, field: 'rough', label: lang === 'fr' ? 'Manipulation brutale' : 'Rough Handling', factor: 1, isRough: true })
  }

  const orderedTeams = order.map(id => teams.find(t => t.relay_team_id === id)).filter(Boolean)

  // Assign row indices (only for input rows, not headers)
  let inputRowIdx = 0
  const criteriaWithIdx = criteria.map(row => {
    if (row.header) return { ...row, rowIdx: -1 }
    return { ...row, rowIdx: inputRowIdx++ }
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">{lang === 'fr' ? 'Pointages' : 'Scoring'}</h2>
        <button className={`px-3 py-1 text-xs rounded ${drawMode === 'random' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
          onClick={randomize}>🎲 {lang === 'fr' ? 'Tirage aléatoire' : 'Random Draw'}</button>
        <button className={`px-3 py-1 text-xs rounded ${drawMode === 'final' ? 'bg-amber-600 text-white' : 'bg-gray-200 text-gray-700'}`}
          onClick={orderByResults}>🏆 {lang === 'fr' ? 'Tirage final' : 'Final Draw'}</button>
        <button className="px-3 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-700"
          onClick={() => window.open('/api/serc/print/sheets?draw=1&lang=fr', '_blank')}>🖨 {lang === 'fr' ? 'Imprimer FR' : 'Print FR'}</button>
        <button className="px-3 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-700"
          onClick={() => window.open('/api/serc/print/sheets?draw=1&lang=bilingual', '_blank')}>🖨 FR/EN</button>
        <span className="text-xs text-gray-500">{orderedTeams.length} {lang === 'fr' ? 'équipes' : 'teams'} • {drawMode === 'final' ? (lang === 'fr' ? 'Ordre final' : 'Final') : (lang === 'fr' ? 'Ordre aléatoire' : 'Random')} {lang === 'fr' ? '' : 'order'}</span>
        <button className="px-3 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
          onClick={() => setShowQR(true)}>📱 {lang === 'fr' ? 'Codes QR juges' : 'Judge QR Codes'}</button>
      </div>

      {/* QR Code Modal */}
      {showQR && <QRModal config={config} onClose={() => setShowQR(false)} lang={lang} />}

      {/* Scoring Grid */}
      <div className="overflow-auto border border-gray-300 rounded bg-white" ref={gridRef}>
        <table className="text-[10px] border-collapse min-w-max">
          <thead>
            <tr className="bg-gray-800 text-white">
              <th className="px-2 py-1 text-left sticky left-0 bg-gray-800 z-10 w-40">{lang === 'fr' ? 'Critère' : 'Criteria'}</th>
              <th className="px-1 py-1 text-center w-10">{lang === 'fr' ? 'Fact.' : 'Fact.'}</th>
              {orderedTeams.map((t, i) => (
                <th key={t.relay_team_id} className="px-1 py-1 text-center min-w-[50px] max-w-[70px] truncate" title={t.name}>
                  {i + 1}. {t.name?.split('/')[0] || t.club}
                </th>
              ))}
            </tr>
            {/* Total row */}
            <tr className="bg-blue-900 text-white font-bold">
              <td className="px-2 py-1 sticky left-0 bg-blue-900 z-10">TOTAL</td>
              <td></td>
              {orderedTeams.map(t => (
                <td key={t.relay_team_id} className="px-1 py-1 text-center">{calcTotal(t.relay_team_id).toFixed(1)}</td>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteriaWithIdx.map((row, idx) => {
              if (row.header) {
                return (
                  <tr key={idx} className="bg-gray-200">
                    <td colSpan={2 + orderedTeams.length} className="px-2 py-1 font-bold text-gray-700">{row.header}</td>
                  </tr>
                )
              }
              return (
                <tr key={idx} className={`border-b border-gray-50 ${row.isRough ? 'bg-red-50' : 'hover:bg-blue-50'}`}>
                  <td className="px-2 py-0.5 sticky left-0 bg-white z-10 border-r border-gray-200">{row.label}</td>
                  <td className="px-1 py-0.5 text-center text-blue-600 font-bold border-r border-gray-100">{row.factor}</td>
                  {orderedTeams.map((t, colIdx) => (
                    <td key={t.relay_team_id} className="px-0.5 py-0.5 text-center">
                      {row.isRough ? (
                        <select
                          data-col={colIdx}
                          className="w-full text-center border border-red-200 text-red-600 rounded px-0.5 py-0 text-[10px]"
                          value={getScore(t.relay_team_id, row.section, row.field) === '' ? '' : getScore(t.relay_team_id, row.section, row.field)}
                          onChange={e => saveScore(t.relay_team_id, row.section, row.field, e.target.value)}
                          onKeyDown={e => handleKeyDown(e, row.rowIdx, colIdx)}
                        >
                          <option value="">—</option>
                          <option value="0">0</option>
                          <option value="-10">-10</option>
                        </select>
                      ) : (
                        <input
                          type="number" step="0.5" min="0" max="10"
                          data-col={colIdx}
                          className="w-full text-center border border-gray-200 rounded px-0.5 py-0 text-[10px]"
                          value={getScore(t.relay_team_id, row.section, row.field)}
                          onChange={e => saveScore(t.relay_team_id, row.section, row.field, e.target.value)}
                          onKeyDown={e => handleKeyDown(e, row.rowIdx, colIdx)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Results Page ─────────────────────────────────────────────────────────────

function ResultsPage({ lang }) {
  const [results, setResults] = useState(null)

  useEffect(() => {
    api.get('/serc/results').then(r => setResults(r.data)).catch(() => {})
  }, [])

  if (!results) return <div className="text-xs text-gray-500">{lang === 'fr' ? 'Chargement des résultats…' : 'Loading results…'}</div>

  const ranked = results.overall || []

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-lg font-bold text-gray-800">{lang === 'fr' ? 'Résultats SERC' : 'SERC Results'}</h2>

      <table className="w-full text-xs border-collapse bg-white border border-gray-300 rounded">
        <thead>
          <tr className="bg-gray-800 text-white">
            <th className="px-3 py-2 text-left w-12">{lang === 'fr' ? 'Rang' : 'Rank'}</th>
            <th className="px-3 py-2 text-left">{lang === 'fr' ? 'Équipe' : 'Team'}</th>
            <th className="px-3 py-2 text-left">{lang === 'fr' ? 'Club' : 'Club'}</th>
            <th className="px-3 py-2 text-right">{lang === 'fr' ? 'Total' : 'Total'}</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(r => (
            <tr key={r.relay_team_id} className="border-b border-gray-100 hover:bg-blue-50">
              <td className="px-3 py-1.5">
                <span className={`inline-flex w-6 h-6 items-center justify-center rounded-full text-white font-bold text-[10px] ${r.rank === 1 ? 'bg-amber-500' : r.rank === 2 ? 'bg-gray-400' : r.rank === 3 ? 'bg-amber-800' : 'bg-gray-700'}`}>
                  {r.rank}
                </span>
              </td>
              <td className="px-3 py-1.5 font-bold">{r.name}</td>
              <td className="px-3 py-1.5 text-gray-600">{r.club}</td>
              <td className="px-3 py-1.5 text-right font-bold text-lg">{r.total.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


// ─── QR Code Modal ────────────────────────────────────────────────────────────

function QRModal({ config, onClose, lang }) {
  const baseUrl = window.location.origin

  const sections = [
    { path: '/serc/judge/overall', label: lang === 'fr' ? 'Global (Juge en chef)' : 'Overall (Chief Judge)' },
  ]
  if (config?.has_bystander) {
    sections.push({ path: '/serc/judge/bystander', label: lang === 'fr' ? 'Passant' : 'Bystander' })
  }
  const victimTypeLabels = VICTIM_TYPE_LABELS[lang]
  for (let i = 0; i < (config?.num_victims || 9); i++) {
    const vf = (config?.victim_factors || [])[i] || {}
    sections.push({ path: `/serc/judge/victim/${i + 1}`, label: `${lang === 'fr' ? 'Victime' : 'Victim'} ${i + 1} — ${victimTypeLabels[vf.type] || '?'}` })
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">📱 {lang === 'fr' ? 'Codes QR juges' : 'Judge QR Codes'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800 text-xl">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          {lang === 'fr'
            ? 'Chaque juge scanne le code QR de sa section assignée. Ouvre un formulaire mobile — aucune connexion requise.'
            : 'Each judge scans the QR code for their assigned section. Opens a mobile-friendly scoring form — no login needed.'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {sections.map(s => (
            <div key={s.path} className="border border-gray-200 rounded p-3 text-center">
              <QRCodeSVG value={`${baseUrl}${s.path}`} size={120} className="mx-auto mb-2" />
              <div className="text-[10px] font-bold text-gray-700">{s.label}</div>
              <div className="text-[8px] text-gray-400 break-all mt-1">{baseUrl}{s.path}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
