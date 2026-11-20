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
 * DSQ codes: which events a code applies to lives in our own `dsqitem.appliesto` column
 * ('I' individual, 'R' relay, 'IR' both — read by HeatsPage's DSQ dropdown and
 * scripts/generate_results.py). Splash's own `dsqitem.options` is an opaque 5-digit code
 * (seen: "00000", "80600"); meet-app writes Splash's "no options" value there and never
 * puts its own tag in it (Splash reads that table directly on a shared Postgres database).
 */
export const SPLASH_DSQ_NO_OPTIONS = '00000'

/** dsq-codes.json "options" ("INDIVIDUAL,RELAY"…) → appliesto ('I' / 'R' / 'IR'). */
export function dsqAppliesTo(options: string | undefined): string {
  const o = options || 'INDIVIDUAL,RELAY'
  const hasIndividual = o.includes('INDIVIDUAL')
  const hasRelay = o.includes('RELAY')
  if (hasIndividual && hasRelay) return 'IR'
  if (hasIndividual) return 'I'
  if (hasRelay) return 'R'
  return ''
}
