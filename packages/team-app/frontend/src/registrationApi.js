/**
 * RegistrationAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the RegistrationAPI interface from shared-ui.
 */
import api from './api'

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
}
