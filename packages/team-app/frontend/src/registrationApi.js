/**
 * RegistrationAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the RegistrationAPI interface from shared-ui.
 */
import api from './api'

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
    const r = await api.get('/clubs')
    return r.data
  },

  async getAthletesByClub(clubId) {
    const r = await api.get(`/athletes?club_id=${clubId}`)
    return r.data
  },

  async getAllAthletes() {
    const r = await api.get('/athletes')
    return r.data
  },

  async addAthlete(data) {
    await api.post('/athletes', data)
  },

  async deleteAthlete(id) {
    await api.delete(`/athletes/${id}`)
  },

  async getRegistration(athleteId) {
    const r = await api.get(`/athletes/${athleteId}/registration`)
    return r.data
  },

  async updateAthlete(athleteId, data) {
    await api.put(`/athletes/${athleteId}`, data)
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
