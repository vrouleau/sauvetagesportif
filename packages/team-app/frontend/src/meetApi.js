/**
 * MeetAPI adapter for the team-app (HTTP → FastAPI backend).
 * Implements the same interface as the Electron IPC adapter.
 * Write operations are stubs for now — will be implemented as backend endpoints are added.
 */
import api from './api'

export const meetApiHttp = {
  async getSessions() {
    // The team-app backend doesn't have a /sessions endpoint yet.
    // Use /events and group by session for now.
    const r = await api.get('/events')
    const events = r.data || []
    // Group events by session
    const sessionMap = new Map()
    for (const e of events) {
      const sid = e.session_id || 1
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, {
          id: sid,
          number: e.session_number || sid,
          name: e.session_name || `Session ${sid}`,
          poolSize: 50,
          events: [],
        })
      }
      sessionMap.get(sid).events.push({
        id: e.id,
        sessionId: sid,
        number: e.eventnumber || e.event_number || 0,
        nameFr: e.style_name || e.name || '',
        nameEn: e.style_name || e.name || '',
        gender: e.gender === 2 ? 'F' : e.gender === 1 ? 'M' : 'X',
        distance: e.distance || 0,
        phase: 'Finale directe',
        isAdmin: false,
        swimstyleId: e.swimstyle_id || null,
        ageGroups: (e.age_groups || []).map((ag, i) => ({
          id: ag.id || i,
          number: i + 1,
          name: ag.name || ag.code || '',
          minAge: ag.agemin || 0,
          maxAge: ag.agemax || null,
          gender: ag.gender === 2 ? 'F' : ag.gender === 1 ? 'M' : 'X',
          numHeats: 1,
          ranking: 'By time',
          countForMedalStats: true,
          usedForCombined: false,
          alwaysSwimPrelims: true,
          advanceByTime: false,
          laneOrderInFinals: 'By time',
        })),
      })
    }
    return Array.from(sessionMap.values())
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
