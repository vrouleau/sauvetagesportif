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
import { suggestRelayEntryTime, entryTimeAfterMemberChange, relayEntryTimeStatus } from './relayEntryTime'
import type { RelayTeamMember } from '../data/api'

const m = (position: number, athleteId: number | null, relayBestTimeMs?: number | null): RelayTeamMember =>
  ({ position, athleteId, athleteName: athleteId ? `A${athleteId}` : null, relayBestTimeMs })

describe('suggestRelayEntryTime', () => {
  it('averages the members who have a relay best time', () => {
    expect(suggestRelayEntryTime([m(1, 1, 120000), m(2, 2, 124000), m(3, 3, null), m(4, null)])).toBe(122000)
  })

  it('rounds to the centisecond', () => {
    // (60000 + 60005 + 60010) / 3 = 60005 -> 60010 (Math.round on 6000.5)
    expect(suggestRelayEntryTime([m(1, 1, 60000), m(2, 2, 60005), m(3, 3, 60010)]) ?? 0).toBe(60010)
    expect(suggestRelayEntryTime([m(1, 1, 60001), m(2, 2, 60002)])).toBe(60000)
  })

  it('is null when no member has a time', () => {
    expect(suggestRelayEntryTime([m(1, 1, null), m(2, null)])).toBeNull()
    expect(suggestRelayEntryTime([])).toBeNull()
  })

  it('ignores a best time left on an empty position', () => {
    expect(suggestRelayEntryTime([m(1, null, 90000), m(2, 2, 100000)])).toBe(100000)
  })
})

describe('entryTimeAfterMemberChange', () => {
  const before = [m(1, 1, 120000), m(2, null)]
  const after = [m(1, 1, 120000), m(2, 2, 124000)]

  it('fills an empty entry time with the suggestion', () => {
    expect(entryTimeAfterMemberChange(before, null, after)).toBe(122000)
  })

  it('follows the suggestion while the coach has not typed a time', () => {
    expect(entryTimeAfterMemberChange(before, 120000, after)).toBe(122000)
  })

  it('keeps a typed time', () => {
    expect(entryTimeAfterMemberChange(before, 118500, after)).toBeUndefined()
  })

  it('clears an auto time when no remaining member has a best time', () => {
    expect(entryTimeAfterMemberChange([m(1, 1, 120000)], 120000, [m(1, null)])).toBeNull()
  })

  it('leaves the time alone when the suggestion does not change', () => {
    expect(entryTimeAfterMemberChange(before, 120000, [m(1, 1, 120000), m(2, 3, null)])).toBeUndefined()
    expect(entryTimeAfterMemberChange([m(1, 1, null)], null, [m(1, 2, null)])).toBeUndefined()
  })
})

describe('relayEntryTimeStatus', () => {
  const team = [m(1, 1, 120000), m(2, 2, 124000), m(3, 3, null)]

  it('is none when no member has a relay best time', () => {
    expect(relayEntryTimeStatus([m(1, 1, null), m(2, null)], 118000)).toBe('none')
  })

  it('is following when the time is empty or equals the suggestion', () => {
    expect(relayEntryTimeStatus(team, null)).toBe('following')
    expect(relayEntryTimeStatus(team, 0)).toBe('following')
    expect(relayEntryTimeStatus(team, 122000)).toBe('following')
  })

  it('is typed when the coach entered another time', () => {
    expect(relayEntryTimeStatus(team, 118500)).toBe('typed')
  })
})
