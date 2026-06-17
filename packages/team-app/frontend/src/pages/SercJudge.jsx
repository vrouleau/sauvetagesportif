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

/**
 * SERC Judge Mobile Form — tablet/phone entry for a single judge/section.
 * URL: /serc/judge/:section (e.g., /serc/judge/overall, /serc/judge/victim/3)
 * No login required — the URL itself identifies the section.
 */
import { useState, useEffect } from 'react'
import { useParams } from 'react-router'

const API_BASE = '/api'

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`)
  return r.json()
}
async function apiPut(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

// Score button values
const SCORE_VALUES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]

export default function SercJudge() {
  const params = useParams()
  // Route can be /serc/judge/overall, /serc/judge/bystander, /serc/judge/victim/:num
  const sectionParam = params.section // 'overall', 'bystander', or 'victim'
  const victimNum = params.num ? parseInt(params.num) : null
  const section = victimNum ? `victim_${victimNum - 1}` : sectionParam

  const [config, setConfig] = useState(null)
  const [teams, setTeams] = useState([])
  const [order, setOrder] = useState([])
  const [currentTeamIdx, setCurrentTeamIdx] = useState(0)
  const [scores, setScores] = useState({})
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [lang, setLang] = useState(() => localStorage.getItem('serc_judge_lang') || 'fr')

  useEffect(() => {
    Promise.all([
      apiGet('/serc/config'),
      apiGet('/serc/teams'),
      apiGet('/serc/draw-order/1'),
      apiGet('/serc/scores/1'),
    ]).then(([cfg, tms, ord, scr]) => {
      setConfig(cfg)
      setTeams(tms || [])
      const orderIds = (ord || []).map(o => o.relay_team_id)
      setOrder(orderIds.length ? orderIds : (tms || []).map(t => t.relay_team_id))
      setScores(scr || {})
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  if (!loaded) return <Loading />
  if (!config) return <div className="p-6 text-center text-red-600 text-lg">{lang === 'fr' ? 'Aucune configuration SERC trouvée.' : 'No SERC configuration found.'}</div>

  const orderedTeams = order.map(id => teams.find(t => t.relay_team_id === id)).filter(Boolean)
  const currentTeam = orderedTeams[currentTeamIdx]
  if (!currentTeam) return <div className="p-6 text-center">{lang === 'fr' ? 'Aucune équipe disponible.' : 'No teams available.'}</div>

  // Build criteria for this section
  const criteria = buildCriteria(section, config, lang)
  const sectionTitle = buildTitle(section, config, lang)

  function toggleLang() {
    const next = lang === 'fr' ? 'en' : 'fr'
    setLang(next)
    localStorage.setItem('serc_judge_lang', next)
  }

  function getScore(field) {
    return scores[String(currentTeam.relay_team_id)]?.[section]?.[field] ?? null
  }

  async function setScore(field, value) {
    setSaving(true)
    await apiPut('/serc/score', {
      draw: 1,
      relay_team_id: currentTeam.relay_team_id,
      section,
      field,
      value,
    })
    setScores(prev => {
      const tid = String(currentTeam.relay_team_id)
      const copy = { ...prev }
      if (!copy[tid]) copy[tid] = {}
      if (!copy[tid][section]) copy[tid][section] = {}
      copy[tid][section][field] = value
      return copy
    })
    setSaving(false)
  }

  function nextTeam() {
    if (currentTeamIdx < orderedTeams.length - 1) setCurrentTeamIdx(currentTeamIdx + 1)
  }
  function prevTeam() {
    if (currentTeamIdx > 0) setCurrentTeamIdx(currentTeamIdx - 1)
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <div className="bg-blue-800 px-4 py-3 flex items-center justify-between shrink-0">
        <div>
          <div className="text-lg font-bold">{sectionTitle}</div>
          <div className="text-xs text-blue-200">{lang === 'fr' ? 'Saisie juge SERC' : 'SERC Judge Entry'}</div>
        </div>
        <div className="flex items-center gap-2">
          {saving && <div className="text-yellow-300 text-xs animate-pulse">{lang === 'fr' ? 'Enregistrement...' : 'Saving...'}</div>}
          <button onClick={toggleLang}
            className="px-2 py-1 rounded text-xs font-bold border border-blue-400 text-blue-200 hover:bg-blue-700">
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
        </div>
      </div>

      {/* Team selector */}
      <div className="bg-gray-800 px-4 py-3 flex items-center gap-3 border-b border-gray-700">
        <button onClick={prevTeam} disabled={currentTeamIdx === 0}
          className="px-3 py-2 bg-gray-700 rounded text-lg disabled:opacity-30">◀</button>
        <div className="flex-1 text-center">
          <div className="text-xs text-gray-400">{lang === 'fr' ? 'Équipe' : 'Team'} {currentTeamIdx + 1} / {orderedTeams.length}</div>
          <div className="text-base font-bold">{currentTeam.name || currentTeam.club}</div>
          <div className="text-xs text-gray-400">{currentTeam.club}</div>
        </div>
        <button onClick={nextTeam} disabled={currentTeamIdx === orderedTeams.length - 1}
          className="px-3 py-2 bg-gray-700 rounded text-lg disabled:opacity-30">▶</button>
      </div>

      {/* Criteria scoring */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {criteria.map(c => (
          <CriterionBlock
            key={c.field}
            label={c.label}
            desc={c.desc}
            factor={c.factor}
            isRough={c.isRough}
            value={getScore(c.field)}
            onChange={val => setScore(c.field, val)}
          />
        ))}
      </div>

      {/* Footer nav */}
      <div className="bg-gray-800 px-4 py-3 flex items-center justify-between border-t border-gray-700 shrink-0">
        <button onClick={prevTeam} disabled={currentTeamIdx === 0}
          className="px-4 py-2 bg-gray-600 rounded font-bold disabled:opacity-30">← {lang === 'fr' ? 'Précédent' : 'Previous'}</button>
        <span className="text-xs text-gray-400">{currentTeamIdx + 1} / {orderedTeams.length}</span>
        <button onClick={nextTeam} disabled={currentTeamIdx === orderedTeams.length - 1}
          className="px-4 py-2 bg-green-600 rounded font-bold disabled:opacity-30">{lang === 'fr' ? 'Suivant' : 'Next'} →</button>
      </div>
    </div>
  )
}

function CriterionBlock({ label, desc, factor, isRough, value, onChange }) {
  if (isRough) {
    return (
      <div className="bg-red-900/40 border border-red-700 rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-red-300">{label}</span>
        </div>
        <div className="flex gap-3">
          <button onClick={() => onChange(0)}
            className={`flex-1 py-3 rounded text-lg font-bold ${value === 0 ? 'bg-green-600' : 'bg-gray-700'}`}>
            0
          </button>
          <button onClick={() => onChange(-10)}
            className={`flex-1 py-3 rounded text-lg font-bold ${value === -10 ? 'bg-red-600' : 'bg-gray-700'}`}>
            -10
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 border border-gray-600 rounded p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-bold">{label}</span>
        <span className="text-xs text-blue-400">×{factor}</span>
      </div>
      {desc && <div className="text-[11px] text-gray-400 mb-2 whitespace-pre-line leading-tight">{desc}</div>}
      <div className="flex flex-wrap gap-1">
        {SCORE_VALUES.map(v => (
          <button key={v} onClick={() => onChange(v)}
            className={`w-11 h-10 rounded text-xs font-bold ${
              value === v ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}>
            {v}
          </button>
        ))}
      </div>
      {value !== null && value !== undefined && (
        <div className="mt-2 text-right text-sm text-green-400 font-bold">
          {value} × {factor} = {(value * factor).toFixed(2)}
        </div>
      )}
    </div>
  )
}

function Loading() {
  return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white text-lg">Chargement...</div>
}

function buildCriteria(section, config, lang) {
  const of = config?.overall_factors || {}
  const bf = config?.bystander_factors || {}
  const vfs = config?.victim_factors || []
  const L = lang === 'fr' ? LABELS_FR : LABELS_EN

  if (section === 'overall') {
    const descs = lang === 'fr' ? OVERALL_DESCS_FR : OVERALL_DESCS_EN
    return [
      { field: 'assessment', label: L.assessment, factor: of.assessment || 1, desc: descs.assessment },
      { field: 'control', label: L.control, factor: of.control || 1, desc: descs.control },
      { field: 'communication', label: L.communication, factor: of.communication || 1, desc: descs.communication },
      { field: 'search', label: L.search, factor: of.search || 1, desc: descs.search },
      { field: 'teamwork', label: L.teamwork, factor: of.teamwork || 1, desc: descs.teamwork },
      { field: 'rough', label: L.rough, factor: 1, isRough: true },
    ]
  }
  if (section === 'bystander') {
    const descs = lang === 'fr' ? BYSTANDER_DESCS_FR : BYSTANDER_DESCS_EN
    return [
      { field: 'approach', label: descs.approach.label, factor: bf.approach || 1, desc: descs.approach.desc },
      { field: 'info', label: descs.info.label, factor: bf.info || 1, desc: descs.info.desc },
      { field: 'directions', label: descs.directions.label, factor: bf.directions || 1, desc: descs.directions.desc },
      { field: 'monitoring', label: descs.monitoring.label, factor: bf.monitoring || 1, desc: descs.monitoring.desc },
      { field: 'encouragement', label: descs.encouragement.label, factor: bf.encouragement || 1, desc: descs.encouragement.desc },
      { field: 'rough', label: L.rough, factor: 1, isRough: true },
    ]
  }
  // victim_N
  const idx = parseInt(section.replace('victim_', ''))
  const vf = vfs[idx] || {}
  const type = vf.type || 'Non Swimmer'
  const descsMap = lang === 'fr' ? VICTIM_DESCS_FR : VICTIM_DESCS_EN
  const descs = descsMap[type] || descsMap['Non Swimmer']
  return [
    { field: 'approach', label: L.approach, factor: vf.approach || 1, desc: descs.approach },
    { field: 'rescue', label: L.rescue, factor: vf.rescue || 1, desc: descs.rescue },
    { field: 'control', label: L.controlVictim, factor: vf.control || 1, desc: descs.control },
    { field: 'landing', label: L.landing, factor: vf.landing || 1, desc: descs.landing },
    { field: 'care', label: L.care, factor: vf.care || 1, desc: descs.care },
    { field: 'rough', label: L.rough, factor: 1, isRough: true },
  ]
}

const LABELS_EN = { assessment: 'Assessment', control: 'Control', communication: 'Communication', search: 'Search', teamwork: 'Teamwork', rough: 'Rough Handling', approach: 'Victim recognition/approach', rescue: 'Rescue', controlVictim: 'Control of victim', landing: 'Landing', care: 'Care and aftercare' }
const LABELS_FR = { assessment: 'Évaluation', control: 'Contrôle', communication: 'Communication', search: 'Recherche', teamwork: "Travail d'équipe", rough: 'Manipulation brutale', approach: 'Reconnaissance / Approche', rescue: 'Sauvetage', controlVictim: 'Contrôle de la victime', landing: 'Débarquement', care: 'Soins et après-soins' }

const OVERALL_DESCS_EN = { assessment: "Assessment of the emergency\nDid the Leader coordinate the team and direct to the correct priorities of rescue?\nOn-going assessment / re-assessment", control: "Control and safety over the scenario area\nLeader retains control throughout the scenario\nOn-going assessment / re-assessment", communication: "Communication and feedback between Leader and team members,\nAnd between team members and victims\nBasic questioning and simple instructions given to victims and team", search: "Effective search of scenario area\nIdentification and location of victims", teamwork: "Teamwork, summon assistance (emergency services called) with appropriate information provided\nIdentification and securing of all victims\nEffective use of bystanders / victims" }
const OVERALL_DESCS_FR = { assessment: "Évaluation de l'urgence\nLe chef a-t-il coordonné l'équipe et dirigé vers les bonnes priorités de sauvetage?\nÉvaluation / réévaluation continue", control: "Contrôle et sécurité de la zone du scénario\nLe chef maintient le contrôle tout au long du scénario\nÉvaluation / réévaluation continue", communication: "Communication et rétroaction entre le chef et les membres de l'équipe,\nEt entre les membres et les victimes\nQuestionnement de base et instructions simples", search: "Recherche efficace de la zone du scénario\nIdentification et localisation des victimes", teamwork: "Travail d'équipe, demander de l'assistance (services d'urgence appelés)\nIdentification et sécurisation de toutes les victimes\nUtilisation efficace des passants / victimes" }

const BYSTANDER_DESCS_EN = { approach: { label: 'Victim Recognition/Approach', desc: "Recognition that they are a bystander and cooperative." }, info: { label: 'Assesses relevant information', desc: "Questions bystander to assess information about the scenario.\n(low marks for not giving the bystander directions — maximum 5 marks for this section)" }, directions: { label: 'Provides directions and instructions', desc: "Rescuer provides directions or instructions to assist the rescue scenario such as; asst. removals, reassure victims, call emergency services." }, monitoring: { label: 'Monitoring bystander actions', desc: "Check periodically to ensure that bystander has followed the directions of the Rescuer throughout rescue." }, encouragement: { label: 'Provides ongoing encouragement', desc: "Provides feedback to bystander on their actions to encourage them to assist with victim support." } }
const BYSTANDER_DESCS_FR = { approach: { label: 'Reconnaissance / Approche', desc: "Reconnaissance qu'il s'agit d'un passant et qu'il est coopératif." }, info: { label: 'Évalue les informations pertinentes', desc: "Questionne le passant pour évaluer les informations sur le scénario.\n(notes basses pour ne pas avoir donné de directives — maximum 5 points)" }, directions: { label: 'Fournit des directives et instructions', desc: "Le sauveteur fournit des directives pour assister le scénario; retraits, rassurer les victimes, appeler les services d'urgence." }, monitoring: { label: 'Surveillance des actions du passant', desc: "Vérifier périodiquement que le passant a suivi les directives du sauveteur." }, encouragement: { label: 'Encouragement continu', desc: "Rétroaction au passant sur ses actions pour l'encourager à assister au soutien des victimes." } }

const VICTIM_DESCS_EN = { 'Non Swimmer': { approach: "Recognition of non-swimmer (high priority), speed of reaching victim\nSafe approach by rescuer", rescue: "Rescue with extreme caution\n(low marks for contact rescue if not required — max 5 marks)\nMonitor while still in water", control: "Clear effective questioning and reassurance\nReassurance during rescue until returned to safety", landing: "Care of the victim; protection of the head\nAppropriate landing for size and strength of rescuer", care: "Safe position away from the edge; warmth and protection where possible; monitor safety; ongoing reassurance" }, 'Weak Swimmer': { approach: "Recognition that they are a weak swimmer and high priority to mobilize.\nSafe approach by rescuer", rescue: "Encourage return to safety with clear directions; non-contact rescue\n(low marks for contact rescue if not required — max 5 marks)", control: "Effective communication / instruction; use for keeping another victim warm / safe", landing: "Make secure and land\nAppropriate landing for size and strength of rescuer", care: "Safe position away from danger; warmth and protection; ongoing monitoring and care" }, 'Injured Swimmer': { approach: "Recognition that they are an injured swimmer and medium priority to mobilize\nSafe approach by rescuer", rescue: "Encourage to return to the edge with clear directions\nNon-contact rescue\n(low marks for contact rescue if not required — max 5 marks)", control: "Effective communication / instruction\nReassurance throughout rescue", landing: "Careful removal from water with attention to injury\nAppropriate landing for size and strength of rescuer", care: "Safe position away from the edge; warmth and protection; ongoing monitoring and care" }, 'Unconscious Non-Breathing': { approach: "Identification of casualty", rescue: "Speed of rescue (considering priority of rescue)\nSpeed in getting back to safety", control: "Effective and efficient carry", landing: "Careful handling/landing of the casualty", care: "Effective and efficient CPR likely to assist recovery\nSafe position away from danger; ongoing monitoring and care" } }
const VICTIM_DESCS_FR = { 'Non Swimmer': { approach: "Reconnaissance du non-nageur (priorité élevée), vitesse pour atteindre la victime\nApproche sécuritaire par le sauveteur", rescue: "Sauvetage avec extrême prudence\n(notes basses pour contact si non requis — max 5 points)\nSurveiller dans l'eau", control: "Questionnement clair et efficace et réassurance\nRéassurance jusqu'au retour en sécurité", landing: "Soin de la victime; protection de la tête\nDébarquement approprié selon taille et force du sauveteur", care: "Position sécuritaire loin du bord; chaleur et protection; surveillance; réassurance continue" }, 'Weak Swimmer': { approach: "Reconnaissance qu'il s'agit d'un nageur faible et priorité élevée à mobiliser\nApproche sécuritaire", rescue: "Encourager le retour en sécurité; sauvetage sans contact\n(notes basses pour contact si non requis — max 5 points)", control: "Communication / instruction efficace; utiliser pour garder une autre victime au chaud", landing: "Sécuriser et débarquer\nDébarquement approprié selon taille et force du sauveteur", care: "Position sécuritaire loin du danger; chaleur et protection; soins continus" }, 'Injured Swimmer': { approach: "Reconnaissance qu'il s'agit d'un nageur blessé et priorité moyenne\nApproche sécuritaire", rescue: "Encourager à revenir au bord; sauvetage sans contact\n(notes basses pour contact si non requis — max 5 points)", control: "Communication / instruction efficace\nRéassurance tout au long du sauvetage", landing: "Retrait soigneux avec attention à la blessure\nDébarquement approprié selon taille et force du sauveteur", care: "Position sécuritaire loin du bord; chaleur et protection; soins continus" }, 'Unconscious Non-Breathing': { approach: "Identification de la victime", rescue: "Vitesse du sauvetage (considérant la priorité)\nVitesse de retour en sécurité", control: "Transport efficace et efficient", landing: "Manipulation/débarquement soigneux de la victime", care: "RCR efficace susceptible d'aider à la récupération\nPosition sécuritaire; surveillance; soins continus" } }

function buildTitle(section, config, lang) {
  if (section === 'overall') return lang === 'fr' ? 'Global (Juge en chef)' : 'Overall (Chief Judge)'
  if (section === 'bystander') return lang === 'fr' ? 'Passant' : 'Bystander'
  const idx = parseInt(section.replace('victim_', ''))
  const vf = (config?.victim_factors || [])[idx] || {}
  return `${lang === 'fr' ? 'Victime' : 'Victim'} ${idx + 1} — ${vf.type || '?'}`
}