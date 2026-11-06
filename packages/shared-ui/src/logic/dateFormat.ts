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
 * Date coercion shared by every `<input type="date">` in the meet UI.
 *
 * An HTML date input only renders a value in strict `YYYY-MM-DD` form. Two
 * backend shapes otherwise look close enough to pass review but are silently
 * rejected by the input (it shows blank):
 *   - a datetime from a DATE/DATETIME column, e.g. "2026-11-28T00:00:00"
 *   - Splash's packed format "YYYYMMDDHHMMSSMMM", e.g. "20261128000000000"
 * `toDateInput()` normalizes both (and a plain ISO date) to "YYYY-MM-DD".
 *
 * `toSplashDate()` is the inverse for meet-config fields that persist back in
 * Splash's packed format.
 */

/**
 * Coerce any supported date representation to the strict `YYYY-MM-DD` form an
 * `<input type="date">` can display. Returns '' for empty/unrecognized input.
 */
export function toDateInput(v: string | null | undefined): string {
  if (!v) return ''
  // ISO date or datetime ("2026-11-28", "2026-11-28T00:00:00") → take the date part.
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  // Splash packed ("20261128000000000", or any 8+ leading digits) → insert dashes.
  if (/^\d{8}/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
  return ''
}

/**
 * Convert a `YYYY-MM-DD` input value to Splash's packed `YYYYMMDD000000000`
 * format. Returns '' for empty input.
 */
export function toSplashDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.replace(/-/g, '') + '000000000'
}
