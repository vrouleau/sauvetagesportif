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
 * Relay team age-composition rules. See docs/RELAY_TEAM_RULES.md.
 *
 * A team is anchored to its event's own age category (`nativeCode`, e.g.
 * "Open" for an Open relay event) — members must be from that exact
 * category, or the single adjacent-younger category (swim-up only, never
 * the reverse). At least `REQUIRED_NATIVE_COUNT` members must match the
 * exact native category. SERC events (swimstyle 530) are exempt entirely —
 * callers should skip these checks for that event, not pass SERC data
 * through them.
 *
 * The Python port of these two functions lives in
 * team-app/backend/app/routers/api.py (`_age_code_allowed_on_team`,
 * `_would_miss_native_anchor`) and can't be merged across the language
 * boundary — kept in sync via the fixture table in
 * team-app/tests/fixtures/relay_age_rules.json (see relayRules.test.ts and
 * the Python-side test that reads the same fixture).
 */

/** A relay team needs at least this many members from the event's own exact ("native") category. */
export const REQUIRED_NATIVE_COUNT = 2

/**
 * Is `candidateCode` allowed on a team anchored to `nativeCode`? Members must
 * be from the event's exact own category, or the single adjacent-younger one
 * (swim-up). `order` is age-category codes sorted youngest → oldest; unknown
 * codes (not present in `order`) never block.
 */
export function isAgeCodeAllowedOnTeam(candidateCode: string, nativeCode: string, order: readonly string[]): boolean {
  if (candidateCode === nativeCode) return true
  const ni = order.indexOf(nativeCode)
  const ci = order.indexOf(candidateCode)
  if (ni === -1 || ci === -1) return true
  return ci === ni - 1
}

/**
 * Would assigning `candidateCode` to this position make it impossible for the
 * team to end up with at least `REQUIRED_NATIVE_COUNT` native-category
 * members, given how many positions remain to fill after this one?
 */
export function wouldMissNativeAnchor(
  otherAssignedCodes: string[],
  candidateCode: string,
  nativeCode: string,
  remainingAfterThis: number
): boolean {
  const nativeSoFar = otherAssignedCodes.filter(c => c === nativeCode).length
    + (candidateCode === nativeCode ? 1 : 0)
  const maxPossibleNative = nativeSoFar + remainingAfterThis
  return maxPossibleNative < REQUIRED_NATIVE_COUNT
}
