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

/** Canonical age-category bracket codes, youngest → oldest. */
export const AGE_CODE_ORDER = ['10-', '11-12', '13-14', '15-18', 'Open', 'Masters'] as const

/**
 * Classify an age group into a canonical bracket code. Tries name-based
 * matching first (handles localized labels like "10 ans et moins"), then
 * falls back to numeric range. `agemax` of `null`/negative/`>= 99` means
 * "Open" (no upper limit), matching Splash's convention.
 */
export function ageGroupCodeFor(
  name: string | null | undefined,
  agemin: number | null | undefined,
  agemax: number | null | undefined
): string {
  if (name) {
    if (/10/.test(name) && /under|moins|-/.test(name.toLowerCase())) return '10-'
    if (/11.*12/.test(name)) return '11-12'
    if (/13.*14/.test(name)) return '13-14'
    if (/15.*18/.test(name)) return '15-18'
    if (/master/i.test(name)) return 'Masters'
  }
  if (agemin != null && agemax != null) {
    if (agemax <= 10) return '10-'
    if (agemin === 11 && agemax === 12) return '11-12'
    if (agemin === 13 && agemax === 14) return '13-14'
    if (agemin === 15 && agemax <= 18) return '15-18'
    if (agemin >= 19) return 'Open'
  }
  if (agemin != null && (agemax == null || agemax < 0 || agemax >= 99)) {
    if (agemin >= 19) return 'Open'
    if (agemin >= 15) return '15-18'
  }
  return 'Open'
}

/**
 * From `availableCategories` (already restricted to codes actually offered),
 * keep only the bracket adjacent (either direction) to `suggestedCode` plus
 * `preferredCode` itself — the individual-entry category dropdown's
 * "don't show every bracket, just nearby ones" rule. Unrelated to (and looser
 * than) the relay swim-up-only rule in `relayRules.ts`.
 */
export function filterCategoriesAroundSuggestion(
  availableCategories: string[],
  suggestedCode: string,
  preferredCode?: string | null,
  order: readonly string[] = AGE_CODE_ORDER
): string[] {
  const naturalIdx = order.indexOf(suggestedCode)
  if (naturalIdx < 0) return availableCategories
  const allowed = new Set<string>()
  for (let i = Math.max(0, naturalIdx - 1); i <= Math.min(order.length - 1, naturalIdx + 1); i++) {
    allowed.add(order[i])
  }
  if (preferredCode) allowed.add(preferredCode)
  return availableCategories.filter(c => allowed.has(c))
}

/** Distinct age codes found across `styles`, ordered per `order`. */
export function computeAvailableCategories(
  styles: Array<{ categories: Array<{ age_code: string }> }>,
  order: readonly string[] = AGE_CODE_ORDER
): string[] {
  const set = new Set<string>()
  for (const style of styles) {
    for (const c of style.categories) set.add(c.age_code)
  }
  return order.filter(c => set.has(c))
}
