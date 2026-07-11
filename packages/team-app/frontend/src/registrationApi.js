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
 * RegistrationAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the RegistrationAPI interface from shared-ui.
 */
import api from './api'

/**
 * Simple in-memory cache with TTL to avoid redundant fetches on tab navigation.
 * Entries expire after 30 seconds — mutations call invalidateCache().
 */
const _cache = new Map()
const CACHE_TTL = 30_000 // 30 seconds

function cacheGet(key) {
  const entry = _cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return undefined }
  return entry.data
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() })
}

function invalidateCache() {
  _cache.clear()
}

/**
 * Helper for relay mutation requests that need to surface error detail messages
 * from 409 Conflict, 403 Forbidden, and 400 Bad Request responses.
 */
async function relayRequest(method, path, body) {
  const pin = localStorage.getItem('pin') || ''
  const headers = { 'X-Club-Pin': pin, 'Content-Type': 'application/json' }
  const opts = { method, headers }
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`/api${path}`, opts)
  if (!res.ok) {
    const err = new Error(`${res.status}`)
    err.status = res.status
    try { err.detail = (await res.json()).detail } catch {}
    throw err
  }
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

export const registrationApiHttp = {
  async getClubs() {
    const cached = cacheGet('clubs')
    if (cached) return cached
    const r = await api.get('/clubs')
    cacheSet('clubs', r.data)
    return r.data
  },

  async getAthletesByClub(clubId) {
    const key = `athletes-club-${clubId}`
    const cached = cacheGet(key)
    if (cached) return cached
    const r = await api.get(`/athletes?club_id=${clubId}`)
    cacheSet(key, r.data)
    return r.data
  },

  async getAllAthletes() {
    const cached = cacheGet('athletes-all')
    if (cached) return cached
    const r = await api.get('/athletes')
    cacheSet('athletes-all', r.data)
    return r.data
  },

  async getAllAthletesGrouped() {
    const cached = cacheGet('athletes-grouped')
    if (cached) return cached
    const r = await api.get('/athletes/all-grouped')
    cacheSet('athletes-grouped', r.data)
    return r.data
  },

  async addAthlete(data) {
    await api.post('/athletes', data)
    invalidateCache()
  },

  async deleteAthlete(id) {
    await api.delete(`/athletes/${id}`)
    invalidateCache()
  },

  async getRegistration(athleteId) {
    const r = await api.get(`/athletes/${athleteId}/registration`)
    return r.data
  },

  async updateAthlete(athleteId, data) {
    try {
      await api.put(`/athletes/${athleteId}`, data)
    } catch (err) {
      if (err.detail) err.message = err.detail
      throw err
    }
    invalidateCache()
  },

  async register(data) {
    await api.post('/registrations', data)
  },

  async unregister(registrationId) {
    await api.delete(`/registrations/${registrationId}`)
  },

  async resetClubPin(clubId) {
    const r = await api.post(`/clubs/${clubId}/reset-pin`, {})
    return r.data
  },

  async getRelayPageData(clubId) {
    const query = clubId != null ? `?club_id=${clubId}` : ''
    const r = await api.get(`/relay-teams${query}`)
    return r.data
  },

  async createRelayTeam(eventId, ageCode, clubId) {
    return await relayRequest('POST', '/relay-teams', {
      event_id: eventId,
      age_code: ageCode,
      club_id: clubId,
    })
  },

  async deleteRelayTeam(teamId) {
    await relayRequest('DELETE', `/relay-teams/${teamId}`)
  },

  async setRelayTeamMember(teamId, position, athleteId) {
    await relayRequest('PUT', `/relay-teams/${teamId}/members/${position}`, {
      athleteId,
    })
  },

  async setRelayTeamName(teamId, name) {
    await relayRequest('PUT', `/relay-teams/${teamId}/name`, { name })
  },
}
