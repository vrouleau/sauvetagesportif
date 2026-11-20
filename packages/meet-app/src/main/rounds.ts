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
 * swimevent.round — Splash Meet Manager's own codes, stored as-is (Splash reads our rows
 * directly on a shared Postgres database, and our .smb carries them unchanged).
 * Full list from Splash's RoundNames (Meet.xus): 1 Timed Final, 2 Prelim, 3 Swim Off Prelim,
 * 4 Quarterfinal, 5 Swim Off Quarterfinal, 6 Semifinal, 7 Swim Off Semifinal,
 * 8 Fastest Heat, 9 Final, 10 Medal ceremony, 11 Break.
 */
export const ROUND = {
  TIM: 1,
  PRE: 2,
  SEM: 6,
  FIN: 9,
  BREAK: 11,
} as const

export type Phase = 'Finale' | 'Eliminatoire' | 'Finale directe'

/** LENEX EVENT@round → Splash code (unknown → timed final). */
export function roundFromLenex(r: string | undefined): number {
  switch ((r ?? '').toUpperCase()) {
    case 'PRE': return ROUND.PRE
    case 'SEM': return ROUND.SEM
    case 'FIN': return ROUND.FIN
    default: return ROUND.TIM
  }
}

/** Splash code → LENEX EVENT@round (anything else → TIM). */
export function roundToLenex(r: number | null | undefined): 'PRE' | 'SEM' | 'FIN' | 'TIM' {
  switch (r) {
    case ROUND.PRE: return 'PRE'
    case ROUND.SEM: return 'SEM'
    case ROUND.FIN: return 'FIN'
    default: return 'TIM'
  }
}

/** UI phase (shared EventsPage) → Splash code. */
export function roundFromPhase(phase: Phase): number {
  return phase === 'Eliminatoire' ? ROUND.PRE : phase === 'Finale' ? ROUND.FIN : ROUND.TIM
}

/** Splash code → UI phase (the UI has no semifinal phase; anything else is a timed final). */
export function phaseOfRound(r: number | null | undefined): Phase {
  if (r === ROUND.PRE) return 'Eliminatoire'
  if (r === ROUND.FIN) return 'Finale'
  return 'Finale directe'
}

/**
 * UI/API round request → Splash code. The shared EventsPage sends LENEX names ('PRE', 'TIM'…)
 * since 2026-11 — the same editor drives team-app, which stores its own codes.
 */
export function roundFromRequest(r: string | number): number {
  return typeof r === 'number' ? r : roundFromLenex(r)
}
