/**
 * MeetAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the same interface as the Electron IPC adapter.
 * Write operations are stubs for now — will be implemented as backend endpoints are added.
 */
import api from './api'

export const meetApiHttp = {
  async getSessions() {
    const r = await api.get('/sessions')
    return r.data || []
  },

  async createSession(name, number) { return { id: Date.now() } },
  async updateSession(sessionId, data) {},
  async deleteSession(sessionId) {},

  async createEvent(sessionId, number, gender, distance, phase, styleName) { return { id: Date.now() } },
  async createBreak(sessionId, number, name) { return { id: Date.now() } },
  async deleteEvent(eventId) {},
  async updateEvent(eventId, data) {},
  async reorderEvents(updates) {},

  async createAgeGroup(eventId, name, minAge, maxAge, gender) { return { id: Date.now() } },
  async deleteAgeGroup(agegroupId) {},
  async updateAgeGroup(agegroupId, data) {},

  async getAthletes() {
    const r = await api.get('/athletes', { headers: { 'X-Club-Pin': localStorage.getItem('pin') } })
    return (r.data || []).map(a => ({
      id: a.id,
      lastName: a.last_name || '',
      firstName: a.first_name || '',
      birthDate: a.birthdate || '',
      gender: a.gender === 'F' ? 'F' : 'M',
      nation: '',
      clubCode: '',
      clubName: a.club_name || '',
      entries: [],
    }))
  },
  async saveAthlete(athlete) {},

  async getMeetConfig() {
    try {
      const r = await api.get('/meet-info')
      const info = r.data || {}
      return {
        NAME: info.meet_name || '',
        COURSE: info.course === 'LCM' ? '1' : info.course === 'SCM' ? '3' : '1',
        MASTERS: info.masters ? 'T' : 'F',
      }
    } catch { return {} }
  },
  async setMeetConfig(entries) {},

  async getSwimStyles() {
    try {
      const r = await api.get('/styles', { headers: { 'X-Club-Pin': localStorage.getItem('pin') } })
      return (r.data || []).map(s => ({
        id: s.uid || s.id,
        distance: s.distance || 0,
        stroke: 1,
        name: s.name || '',
        relaycount: s.relay_count || 1,
      }))
    } catch { return [] }
  },
}
