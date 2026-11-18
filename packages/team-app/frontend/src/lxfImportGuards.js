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

// Results-import guards (backend: routers/api.py import-results-lxf /
// admin/import-historical, lxf_to_team.py count_results_in_lxf/meet_mismatch).

function detailWithCode(err, code) {
  const d = err?.detail
  return (d && typeof d === 'object' && d.code === code) ? d : null
}

/** 400 not_results_file → localized message, else null. Not overridable. */
export function notResultsFileMessage(err, lang) {
  if (!detailWithCode(err, 'not_results_file')) return null
  return lang === 'fr'
    ? "Ce fichier ne contient aucun résultat (temps ou DSQ/DNS/DNF). S'agit-il du fichier d'inscriptions ou de la structure du meet ? Exportez les résultats depuis SauvetageMeet : Fichier → Exporter les résultats LENEX…"
    : 'This file contains no results (times or DSQ/DNS/DNF). Is it the entries or meet-structure file? Export the results from SauvetageMeet: File → Export LENEX results…'
}

/** 400 beach_results_not_archived → localized message, else null. Not overridable:
 *  beach results are positions (no best times), so a beach meet is closed
 *  without results instead of archived. */
export function beachResultsMessage(err, lang) {
  if (!detailWithCode(err, 'beach_results_not_archived')) return null
  return lang === 'fr'
    ? "Les résultats d'un meet de plage ne sont pas archivés (des positions, pas des temps — aucune meilleure performance). Fermez le meet avec « Fermer sans résultats »."
    : 'Beach meet results are not archived (positions, not times — no best times). Close the meet with "Close without results".'
}

/** 409 meet_mismatch detail, else null. */
export function meetMismatchDetail(err) {
  return detailWithCode(err, 'meet_mismatch')
}

/** Asks whether to close the open meet with a file that looks like it is
 *  from another meet; returns true to proceed (?force_meet=true). */
export function confirmMeetMismatch(d, lang) {
  const msg = lang === 'fr'
    ? `Ce fichier de résultats semble provenir d'un autre meet :\n\n` +
      `  • Fichier : « ${d.file_meet || '?'} »\n` +
      `  • Meet ouvert : « ${d.open_meet || '?'} »\n` +
      `  • Épreuves correspondantes : ${d.events_matched}/${d.events_in_file}\n\n` +
      `L'importation va FERMER le meet ouvert (inscriptions supprimées, NIP régénérés).\n\n` +
      `Continuer quand même ?`
    : `This results file looks like it is from another meet:\n\n` +
      `  • File: "${d.file_meet || '?'}"\n` +
      `  • Open meet: "${d.open_meet || '?'}"\n` +
      `  • Matching events: ${d.events_matched}/${d.events_in_file}\n\n` +
      `Importing will CLOSE the open meet (registrations deleted, PINs regenerated).\n\n` +
      `Continue anyway?`
  return confirm(msg)
}
