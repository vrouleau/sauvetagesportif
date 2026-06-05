/**
 * MeetAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the same MeetAPI interface as the Electron IPC adapter.
 */
import api from './api'

export const meetApiHttp = {
  async getSessions() {
    const r = await api.get('/sessions')
    return r.data || []
  },

  async createSession(name, number) {
    const r = await api.post('/sessions', { name, number })
    return { id: r.data.id }
  },

  async updateSession(sessionId, data) {
    await api.put(`/sessions/${sessionId}`, data)
  },

  async deleteSession(sessionId) {
    await api.delete(`/sessions/${sessionId}`)
  },

  async createEvent(sessionId, number, gender, distance, phase, styleName) {
    const r = await api.post('/events', {
      sessionId,
      number,
      gender,
      phase,
      // Don't pass distance/styleName — backend picks the best available swimstyle
    })
    return { id: r.data.id }
  },

  async createBreak(sessionId, number, name) {
    // Breaks are events with internalevent='T'
    const r = await api.post('/events', {
      sessionId,
      number,
      gender: 'X',
      phase: 'Finale directe',
      isBreak: true,
      breakName: name,
    })
    return { id: r.data.id }
  },

  async deleteEvent(eventId) {
    await api.delete(`/events/${eventId}`)
  },

  async updateEvent(eventId, data) {
    await api.put(`/events/${eventId}`, data)
  },

  async reorderEvents(updates) {
    await api.put('/events/reorder', { updates })
  },

  async createAgeGroup(eventId, name, minAge, maxAge, gender) {
    const r = await api.post('/age-groups', { eventId, name, minAge, maxAge, gender })
    return { id: r.data.id }
  },

  async deleteAgeGroup(agegroupId) {
    await api.delete(`/age-groups/${agegroupId}`)
  },

  async updateAgeGroup(agegroupId, data) {
    await api.put(`/age-groups/${agegroupId}`, data)
  },

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
      const r = await api.get('/meet-config')
      return r.data || {}
    } catch {
      try {
        const r = await api.get('/meet-info')
        const info = r.data || {}
        return {
          NAME: info.meet_name || '',
          COURSE: info.course === 'LCM' ? '1' : info.course === 'SCM' ? '3' : '1',
          MASTERS: info.masters ? 'T' : 'F',
        }
      } catch { return {} }
    }
  },

  async setMeetConfig(entries) {
    await api.put('/meet-config', entries)
  },

  async getSwimStyles() {
    try {
      const r = await api.get('/swim-styles')
      return r.data || []
    } catch { return [] }
  },

  async generateHeats(eventId, sessionId) {
    return { heatsCreated: 0, entriesAssigned: 0 }
  },

  async importMeet() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.lxf'
      input.onchange = async (e) => {
        const file = e.target.files?.[0]
        if (!file) { resolve({ ok: false }); return }
        const fd = new FormData()
        fd.append('file', file)
        try {
          const r = await api.post('/upload/meet', fd)
          resolve({ ok: true, events: r.data.events_loaded })
        } catch (err) {
          resolve({ ok: false, error: err.response?.data?.detail || err.message || 'Error' })
        }
      }
      input.oncancel = () => resolve({ ok: false })
      input.click()
    })
  },

  async exportMeet() {
    const res = await fetch('/api/export/meet-lxf', {
      headers: { 'X-Club-Pin': localStorage.getItem('pin') || '' }
    })
    if (!res.ok) throw new Error(`Export failed: ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'meet.lxf'; a.click()
    URL.revokeObjectURL(url)
    return { ok: true }
  },

  async createMeet(meetType) {
    try {
      const r = await api.post('/admin/new-meet', { meet_type: meetType })
      return { ok: true, meetType: r.data.meet_type }
    } catch (err) {
      return { ok: false, error: err.response?.data?.detail || err.message || 'Error' }
    }
  },
}
