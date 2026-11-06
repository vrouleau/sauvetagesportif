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
import { toDateInput, toSplashDate, normalizeDuration, toTimeInput } from './dateFormat'

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

describe('toTimeInput', () => {
  it('zero-pads a single-digit hour (the blank <input type=time> bug)', () => {
    expect(toTimeInput('9:30')).toBe('09:30')
    expect(toTimeInput('1:05')).toBe('01:05')
  })

  it('passes through an already-padded HH:MM', () => {
    expect(toTimeInput('10:00')).toBe('10:00')
    expect(toTimeInput('22:00')).toBe('22:00')
  })

  it('trims seconds if present', () => {
    expect(toTimeInput('09:30:00')).toBe('09:30')
  })

  it('returns empty for empty/nullish/unrecognized input', () => {
    expect(toTimeInput('')).toBe('')
    expect(toTimeInput(null)).toBe('')
    expect(toTimeInput(undefined)).toBe('')
    expect(toTimeInput('abc')).toBe('')
  })
})

describe('normalizeDuration', () => {
  it('keeps an explicit H:MM as typed', () => {
    expect(normalizeDuration('1:00')).toBe('1:00')
    expect(normalizeDuration('1:30')).toBe('1:30')
    expect(normalizeDuration('0:15')).toBe('0:15')
    expect(normalizeDuration('1:5')).toBe('1:05')
    expect(normalizeDuration('1:75')).toBe('1:59') // minutes clamped to 59
  })

  it('treats a bare number as MINUTES', () => {
    expect(normalizeDuration('1')).toBe('0:01')
    expect(normalizeDuration('15')).toBe('0:15')
    expect(normalizeDuration('90')).toBe('1:30')
    expect(normalizeDuration('0')).toBe('0:00')
  })

  it('returns empty for empty/nullish input', () => {
    expect(normalizeDuration('')).toBe('')
    expect(normalizeDuration(null)).toBe('')
    expect(normalizeDuration(undefined)).toBe('')
  })

  it('leaves unrecognized input unchanged for user correction', () => {
    expect(normalizeDuration('abc')).toBe('abc')
  })
})
