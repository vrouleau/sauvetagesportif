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

import { describe, it, expect, vi } from 'vitest'

// db.ts imports connectionManager, which imports Electron.
vi.mock('../src/main/connectionManager', () => ({
  isPgConnected: () => false,
  getDb: () => { throw new Error('not used') },
  closeDb: () => {},
}))

const { formatDaytime } = await import('../src/main/db')

describe('formatDaytime', () => {
  it('display form drops the hour padding, LENEX form keeps it', () => {
    expect(formatDaytime('2000-01-01 09:05:00')).toBe('9:05')
    expect(formatDaytime('2000-01-01 09:05:00', { pad: true })).toBe('09:05')
    expect(formatDaytime('2000-01-01 14:30:00')).toBe('14:30')
    expect(formatDaytime('2000-01-01 14:30:00', { pad: true })).toBe('14:30')
  })

  it('reads OLE fractional days, numeric or stringified', () => {
    expect(formatDaytime(-36522.3125)).toBe('7:30')          // 0.3125 day = 07:30
    expect(formatDaytime(-36522.3125, { pad: true })).toBe('07:30')
    expect(formatDaytime('-36522.3125', { pad: true })).toBe('07:30')
  })

  it('no time → undefined', () => {
    expect(formatDaytime(null)).toBeUndefined()
    expect(formatDaytime(36522)).toBeUndefined()            // whole day, no time part
    expect(formatDaytime('abc', { pad: true })).toBeUndefined()
  })
})
