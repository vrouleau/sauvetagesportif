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

import { describe, it, expect } from 'vitest'
import { toDateInput, toSplashDate } from './dateFormat'

describe('toDateInput', () => {
  it('passes through a bare ISO date', () => {
    expect(toDateInput('2026-11-28')).toBe('2026-11-28')
  })

  it('trims the time off an ISO datetime (the session-date regression)', () => {
    expect(toDateInput('2026-11-28T00:00:00')).toBe('2026-11-28')
    expect(toDateInput('2026-11-28T13:45:00.000Z')).toBe('2026-11-28')
  })

  it('unpacks Splash YYYYMMDDHHMMSSMMM into YYYY-MM-DD', () => {
    expect(toDateInput('20261128000000000')).toBe('2026-11-28')
    expect(toDateInput('20261231120000000')).toBe('2026-12-31')
  })

  it('returns empty string for empty/nullish/unrecognized input', () => {
    expect(toDateInput('')).toBe('')
    expect(toDateInput(null)).toBe('')
    expect(toDateInput(undefined)).toBe('')
    expect(toDateInput('not-a-date')).toBe('')
  })
})

describe('toSplashDate', () => {
  it('packs YYYY-MM-DD into Splash format', () => {
    expect(toSplashDate('2026-11-28')).toBe('20261128000000000')
  })

  it('returns empty string for empty/nullish input', () => {
    expect(toSplashDate('')).toBe('')
    expect(toSplashDate(null)).toBe('')
    expect(toSplashDate(undefined)).toBe('')
  })

  it('round-trips with toDateInput', () => {
    expect(toDateInput(toSplashDate('2026-11-28'))).toBe('2026-11-28')
  })
})
