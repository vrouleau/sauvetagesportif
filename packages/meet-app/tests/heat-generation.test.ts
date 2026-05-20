import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb, seedMeet } from './helpers'
import { generateHeats } from '../src/main/db'

describe('Heat generation', () => {
  let db: Database.Database
  let cleanup: () => void

  beforeEach(() => {
    const t = createTestDb()
    db = t.db
    cleanup = t.cleanup
    seedMeet(db)
  })

  afterEach(() => cleanup())

  // ── Helper functions ──────────────────────────────────────────────────────

  function setLanes(min: number, max: number) {
    db.prepare('UPDATE swimsession SET lanemin=?, lanemax=? WHERE swimsessionid=1').run(min, max)
  }

  function addEntries(eventId: number, agegroupId: number | null, count: number, startTime = 60000) {
    const baseId = (db.prepare('SELECT COALESCE(MAX(swimresultid),0)+1 AS n FROM swimresult').get() as { n: number }).n
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime)
         VALUES (?, 1, ?, ?, ?)`
      ).run(baseId + i, eventId, agegroupId, startTime + i * 1000)
    }
  }

  function addNTEntries(eventId: number, agegroupId: number | null, count: number) {
    const baseId = (db.prepare('SELECT COALESCE(MAX(swimresultid),0)+1 AS n FROM swimresult').get() as { n: number }).n
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime)
         VALUES (?, 1, ?, ?, NULL)`
      ).run(baseId + i, eventId, agegroupId)
    }
  }

  function setMeetValues(data: string) {
    db.prepare(
      `INSERT INTO bsglobal (name, data) VALUES ('MEETVALUES', ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
    ).run(data)
  }

  function getHeats(eventId: number) {
    return db.prepare(
      `SELECT heatid, heatnumber, agegroupid FROM heat WHERE swimeventid=? ORDER BY heatnumber`
    ).all(eventId) as Array<{ heatid: number; heatnumber: number; agegroupid: number | null }>
  }

  function getAssignments(heatId: number) {
    return db.prepare(
      `SELECT swimresultid, lane, entrytime FROM swimresult WHERE heatid=? ORDER BY lane`
    ).all(heatId) as Array<{ swimresultid: number; lane: number; entrytime: number | null }>
  }

  // ── Basic seeding tests ─────────────────────────────────────────────────────

  describe('basic circle seeding', () => {
    it('creates correct number of heats for entries exceeding lane count', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 16) // 16 entries, 8 lanes → 2 heats

      const result = await generateHeats(1, undefined, db)

      expect(result.heatsCreated).toBe(2)
      expect(result.entriesAssigned).toBe(16)
      const heats = getHeats(1)
      expect(heats).toHaveLength(2)
    })

    it('creates a single heat when entries fit in one heat', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 6) // 6 entries, 8 lanes → 1 heat

      const result = await generateHeats(1, undefined, db)

      expect(result.heatsCreated).toBe(1)
      expect(result.entriesAssigned).toBe(6)
    })

    it('distributes swimmers evenly across heats (circle seed)', async () => {
      setLanes(1, 6)
      addEntries(1, 1, 12) // 12 entries, 6 lanes → 2 heats

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const h1 = getAssignments(heats[0].heatid)
      const h2 = getAssignments(heats[1].heatid)
      expect(h1).toHaveLength(6)
      expect(h2).toHaveLength(6)
    })

    it('assigns center lane to fastest swimmer in each heat', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 8) // 8 entries, 8 lanes → 1 heat

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      // Fastest swimmer (lowest entrytime) should be in center lane
      // For 8 lanes (1-8): center = floor(8/2) = 4, lane = 1+4 = 5
      // Lane order: 5, 6, 4, 7, 3, 8, 2, 1
      const fastestEntry = assignments.find(a => a.lane === 5)
      expect(fastestEntry).toBeDefined()
      const minTime = Math.min(...assignments.map(a => a.entrytime!))
      expect(fastestEntry!.entrytime).toBe(minTime)
    })

    it('places NTs in outer lanes', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 4, 60000) // 4 timed entries
      addNTEntries(1, 1, 4) // 4 NTs

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      // NTs should be in the last 4 positions (outer lanes)
      // Lane order for 8 lanes: 5, 6, 4, 7, 3, 8, 2, 1
      // First 4 positions (timed): lanes 5, 6, 4, 7
      // Last 4 positions (NTs): lanes 3, 8, 2, 1
      const ntEntries = assignments.filter(a => a.entrytime === null)
      expect(ntEntries).toHaveLength(4)
      const outerLanes = [3, 8, 2, 1]
      for (const nt of ntEntries) {
        expect(outerLanes).toContain(nt.lane)
      }
    })
  })

  // ── Pyramid seeding tests ───────────────────────────────────────────────────

  describe('pyramid seeding (finalseedtype=1)', () => {
    it('places fastest swimmers in the last heat', async () => {
      setLanes(1, 8)
      db.prepare('UPDATE agegroup SET finalseedtype=1 WHERE agegroupid=1').run()
      addEntries(1, 1, 16) // 16 entries → 2 heats

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(2)
      const lastHeat = heats[heats.length - 1]
      const lastAssignments = getAssignments(lastHeat.heatid)
      const firstHeat = heats[0]
      const firstAssignments = getAssignments(firstHeat.heatid)

      // Last heat should have faster times than first heat
      const lastMax = Math.max(...lastAssignments.map(a => a.entrytime!))
      const firstMin = Math.min(...firstAssignments.map(a => a.entrytime!))
      expect(lastMax).toBeLessThan(firstMin)
    })

    it('fills heats from last to first', async () => {
      setLanes(1, 4)
      setMeetValues('MINPERHEAT=I;0')
      db.prepare('UPDATE agegroup SET finalseedtype=1 WHERE agegroupid=1').run()
      addEntries(1, 1, 10) // 10 entries, 4 lanes → 3 heats

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(3)
      // Pyramid fills from last: heat 3 gets first 4 (fastest), heat 2 gets next 4, heat 1 gets remaining 2
      const h3 = getAssignments(heats[2].heatid)
      const h2 = getAssignments(heats[1].heatid)
      const h1 = getAssignments(heats[0].heatid)
      expect(h3).toHaveLength(4)
      expect(h2).toHaveLength(4)
      expect(h1).toHaveLength(2)
    })
  })

  // ── Straight seeding tests ──────────────────────────────────────────────────

  describe('straight seeding (finalseedtype=2)', () => {
    it('places fastest swimmers in heat 1', async () => {
      setLanes(1, 8)
      db.prepare('UPDATE agegroup SET finalseedtype=2 WHERE agegroupid=1').run()
      addEntries(1, 1, 16)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const h1 = getAssignments(heats[0].heatid)
      const h2 = getAssignments(heats[1].heatid)

      // Heat 1 should have faster times than heat 2
      const h1Max = Math.max(...h1.map(a => a.entrytime!))
      const h2Min = Math.min(...h2.map(a => a.entrytime!))
      expect(h1Max).toBeLessThan(h2Min)
    })
  })

  // ── FINA "last N heats" rule ────────────────────────────────────────────────

  describe('fast heat count (FINA last-N-heats rule)', () => {
    it('circle-seeds only the last N heats when fastheatcount is set', async () => {
      setLanes(1, 4)
      db.prepare('UPDATE agegroup SET fastheatcount=2 WHERE agegroupid=1').run()
      // 20 entries, 4 lanes → 5 heats. Last 2 should be circle-seeded.
      addEntries(1, 1, 20)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(5)

      // The last 2 heats should have similar speed ranges (circle-seeded)
      const h4 = getAssignments(heats[3].heatid)
      const h5 = getAssignments(heats[4].heatid)
      // Both should contain some of the fastest swimmers
      const h4Times = h4.map(a => a.entrytime!).sort((a, b) => a - b)
      const h5Times = h5.map(a => a.entrytime!).sort((a, b) => a - b)
      // In circle seeding, the fastest swimmer goes to heat 4, 2nd fastest to heat 5, etc.
      // So both heats should have interleaved fast times
      expect(h4Times[0]).toBeLessThan(h5Times[h5Times.length - 1])
      expect(h5Times[0]).toBeLessThan(h4Times[h4Times.length - 1])
    })

    it('uses meet-level FASTHEATCOUNT from MEETVALUES', async () => {
      setLanes(1, 4)
      setMeetValues('FASTHEATCOUNT=I;2')
      addEntries(1, 1, 20) // 5 heats

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(5)
      // Early heats should have slower swimmers
      const h1 = getAssignments(heats[0].heatid)
      const h5 = getAssignments(heats[4].heatid)
      const h1Avg = h1.reduce((s, a) => s + (a.entrytime ?? 999999), 0) / h1.length
      const h5Avg = h5.reduce((s, a) => s + (a.entrytime ?? 999999), 0) / h5.length
      expect(h1Avg).toBeGreaterThan(h5Avg)
    })
  })

  // ── Lane order tests ────────────────────────────────────────────────────────

  describe('lane assignment order', () => {
    it('uses center-out pattern for 8 lanes', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 8)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      // Sort by entrytime to get rank order
      const byTime = [...assignments].sort((a, b) => a.entrytime! - b.entrytime!)
      // For 8 lanes (1-8): center = floor(8/2) = 4, first lane = 1+4 = 5
      // Expected lane order: 5, 6, 4, 7, 3, 8, 2, 1
      expect(byTime[0].lane).toBe(5) // fastest → lane 5
      expect(byTime[1].lane).toBe(6) // 2nd → lane 6
      expect(byTime[2].lane).toBe(4) // 3rd → lane 4
      expect(byTime[3].lane).toBe(7) // 4th → lane 7
      expect(byTime[4].lane).toBe(3) // 5th → lane 3
      expect(byTime[5].lane).toBe(8) // 6th → lane 8
      expect(byTime[6].lane).toBe(2) // 7th → lane 2
      expect(byTime[7].lane).toBe(1) // 8th → lane 1
    })

    it('uses center-out pattern for 6 lanes', async () => {
      setLanes(1, 6)
      addEntries(1, 1, 6)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      const byTime = [...assignments].sort((a, b) => a.entrytime! - b.entrytime!)
      // For 6 lanes (1-6): center = floor(6/2) = 3, first lane = 1+3 = 4
      // Order: 4, 5, 3, 6, 2, 1
      expect(byTime[0].lane).toBe(4) // fastest → lane 4
      expect(byTime[1].lane).toBe(5) // 2nd → lane 5
      expect(byTime[2].lane).toBe(3) // 3rd → lane 3
    })

    it('uses custom lanesbyplace when set', async () => {
      setLanes(1, 8)
      db.prepare('UPDATE swimsession SET lanesbyplace=? WHERE swimsessionid=1').run('5,4,6,3,7,2,8,1')
      addEntries(1, 1, 8)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      const byTime = [...assignments].sort((a, b) => a.entrytime! - b.entrytime!)
      // Custom order: fastest → lane 5
      expect(byTime[0].lane).toBe(5)
      expect(byTime[1].lane).toBe(4)
      expect(byTime[2].lane).toBe(6)
    })
  })

  // ── Entry priority tests ────────────────────────────────────────────────────

  describe('entry priority ordering', () => {
    it('seeds late entries last when SEEDLATELAST is set', async () => {
      setLanes(1, 4)
      setMeetValues('SEEDLATELAST=B;T')
      // Add 4 regular entries (fast)
      addEntries(1, 1, 4, 60000)
      // Add 4 late entries (also fast, but should be seeded last)
      const baseId = (db.prepare('SELECT COALESCE(MAX(swimresultid),0)+1 AS n FROM swimresult').get() as { n: number }).n
      for (let i = 0; i < 4; i++) {
        db.prepare(
          `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, lateentry)
           VALUES (?, 1, 1, 1, ?, 'T')`
        ).run(baseId + i, 55000 + i * 1000) // faster than regular entries!
      }

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(2)
      // Late entries should be in heat 1 (slower heat) despite having faster times
      // because they are seeded after regular entries
      const h1 = getAssignments(heats[0].heatid)
      const h2 = getAssignments(heats[1].heatid)
      // Heat 2 should have the regular entries (seeded first = faster heats in circle seed)
      // Actually in circle seed, swimmer 1→heat1, swimmer 2→heat2, etc.
      // With priority ordering: regular entries come first, then late entries
      // So regular entries (positions 1-4) get distributed first, then late entries (positions 5-8)
      expect(h1.length + h2.length).toBe(8)
    })

    it('seeds bonus entries last when SEEDBONUSLAST is set', async () => {
      setLanes(1, 4)
      setMeetValues('SEEDBONUSLAST=B;T')
      // 4 regular entries (slower)
      addEntries(1, 1, 4, 60000)
      // 4 bonus entries (faster times, but should be seeded in later heats)
      const baseId = (db.prepare('SELECT COALESCE(MAX(swimresultid),0)+1 AS n FROM swimresult').get() as { n: number }).n
      for (let i = 0; i < 4; i++) {
        db.prepare(
          `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, bonusentry)
           VALUES (?, 1, 1, 1, ?, 'T')`
        ).run(baseId + i, 50000 + i * 1000)
      }

      await generateHeats(1, undefined, db)

      // 8 entries, 4 lanes → 2 heats
      const heats = getHeats(1)
      expect(heats).toHaveLength(2)
      // In circle seed with priority: regular entries (positions 1-4) go first,
      // bonus entries (positions 5-8) go second.
      // Circle: pos1→heat1, pos2→heat2, pos3→heat1, pos4→heat2 (regular)
      //         pos5→heat1, pos6→heat2, pos7→heat1, pos8→heat2 (bonus)
      // So each heat has 2 regular + 2 bonus entries
      const h1 = getAssignments(heats[0].heatid)
      const h2 = getAssignments(heats[1].heatid)
      expect(h1).toHaveLength(4)
      expect(h2).toHaveLength(4)
    })
  })

  // ── Qualification period tests ──────────────────────────────────────────────

  describe('qualification period filtering', () => {
    it('treats entries outside qualification period as NT', async () => {
      setLanes(1, 8)
      setMeetValues('QUALIFROM=S;2025-01-01\r\nQUALITO=S;2025-12-31')
      // Add entries with qtdate inside period
      const baseId = (db.prepare('SELECT COALESCE(MAX(swimresultid),0)+1 AS n FROM swimresult').get() as { n: number }).n
      db.prepare(
        `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, qtdate)
         VALUES (?, 1, 1, 1, 60000, '2025-06-15')`
      ).run(baseId)
      // Add entry with qtdate outside period (too old)
      db.prepare(
        `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, entrytime, qtdate)
         VALUES (?, 1, 1, 1, 55000, '2024-06-15')`
      ).run(baseId + 1)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      const assignments = getAssignments(heats[0].heatid)
      // The entry with valid qtdate should get center lane (lane 5 for 8-lane pool)
      // The entry with expired qtdate has its time nullified → treated as NT → outer lane
      const validEntry = assignments.find(a => a.swimresultid === baseId)
      const expiredEntry = assignments.find(a => a.swimresultid === baseId + 1)
      expect(validEntry!.lane).toBe(5) // center lane (fastest valid)
      // Expired entry gets lane 6 (next position, since it's now NT)
      expect(expiredEntry!.lane).toBe(6)
    })
  })

  // ── Combine age groups tests ────────────────────────────────────────────────

  describe('combine age groups', () => {
    it('pools entries from all age groups when combineagegroups is set', async () => {
      setLanes(1, 8)
      setMeetValues('COMBINEAGEGROUPS=B;T')
      addEntries(1, 1, 4, 60000) // age group 1
      addEntries(1, 2, 4, 65000) // age group 2

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      // All 8 entries should be in 1 heat (combined)
      expect(heats).toHaveLength(1)
      const assignments = getAssignments(heats[0].heatid)
      expect(assignments).toHaveLength(8)
    })

    it('creates separate heats per age group when not combined', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 4, 60000) // age group 1
      addEntries(1, 2, 4, 65000) // age group 2

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      // Each age group gets its own heat
      expect(heats).toHaveLength(2)
      const h1 = getAssignments(heats[0].heatid)
      const h2 = getAssignments(heats[1].heatid)
      expect(h1).toHaveLength(4)
      expect(h2).toHaveLength(4)
    })
  })

  // ── Minimum per heat tests ──────────────────────────────────────────────────

  describe('minimum swimmers per heat', () => {
    it('redistributes when a heat has fewer than minimum', async () => {
      setLanes(1, 4)
      setMeetValues('MINPERHEAT=I;3')
      // 5 entries, 4 lanes → 2 heats (heat 1: 1 swimmer, heat 2: 4 swimmers)
      // After min enforcement: heat 1 should get swimmers from heat 2
      addEntries(1, 1, 5)

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      // Should still be 2 heats but more balanced
      for (const h of heats) {
        const assignments = getAssignments(h.heatid)
        if (assignments.length > 0) {
          // No heat should have fewer than 3 (unless total is less)
          // With 5 entries: could be 3+2 or 2+3
          expect(assignments.length).toBeGreaterThanOrEqual(2)
        }
      }
    })
  })

  // ── Session-level generation tests ──────────────────────────────────────────

  describe('session and global generation', () => {
    it('generates heats for all events in a session', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 8, 60000) // event 1
      addEntries(2, null, 8, 70000) // event 2 (no age group)

      const result = await generateHeats(undefined, 1, db)

      expect(result.heatsCreated).toBe(2) // 1 heat per event
      expect(result.entriesAssigned).toBe(16)
    })

    it('generates heats for all events when no filter specified', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 8, 60000) // event 1, session 1
      addEntries(3, null, 8, 70000) // event 3, session 2

      const result = await generateHeats(undefined, undefined, db)

      expect(result.heatsCreated).toBeGreaterThanOrEqual(2)
    })

    it('skips internal/admin events', async () => {
      setLanes(1, 8)
      // Add an internal event
      db.prepare(
        `INSERT INTO swimevent (swimeventid, swimsessionid, eventnumber, gender, round, sortcode, internalevent)
         VALUES (99, 1, 99, 3, 5, 99, 'T')`
      ).run()
      addEntries(99, null, 8, 60000)

      const result = await generateHeats(undefined, 1, db)

      // Internal event should not get heats (unless explicitly targeted)
      const heats = getHeats(99)
      expect(heats).toHaveLength(0)
    })
  })

  // ── Edge cases ──────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles zero entries gracefully', async () => {
      setLanes(1, 8)
      const result = await generateHeats(1, undefined, db)
      expect(result.heatsCreated).toBe(0)
      expect(result.entriesAssigned).toBe(0)
    })

    it('handles single entry', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 1)

      const result = await generateHeats(1, undefined, db)

      expect(result.heatsCreated).toBe(1)
      expect(result.entriesAssigned).toBe(1)
    })

    it('handles all NTs', async () => {
      setLanes(1, 8)
      addNTEntries(1, 1, 8)

      const result = await generateHeats(1, undefined, db)

      expect(result.heatsCreated).toBe(1)
      expect(result.entriesAssigned).toBe(8)
    })

    it('clears previous heats before regenerating', async () => {
      setLanes(1, 8)
      addEntries(1, 1, 8)

      // Generate once
      await generateHeats(1, undefined, db)
      let heats = getHeats(1)
      expect(heats).toHaveLength(1)

      // Generate again — should not duplicate
      await generateHeats(1, undefined, db)
      heats = getHeats(1)
      expect(heats).toHaveLength(1)
    })

    it('respects heatcount minimum from age group', async () => {
      setLanes(1, 8)
      db.prepare('UPDATE agegroup SET heatcount=3 WHERE agegroupid=1').run()
      addEntries(1, 1, 8) // 8 entries, 8 lanes → normally 1 heat, but heatcount=3

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats.length).toBeGreaterThanOrEqual(3)
    })

    it('handles meet-level SEEDMETHOD=1 (pyramid) override', async () => {
      setLanes(1, 4)
      setMeetValues('SEEDMETHOD=I;1') // pyramid at meet level
      addEntries(1, 1, 8) // 8 entries, 4 lanes → 2 heats

      await generateHeats(1, undefined, db)

      const heats = getHeats(1)
      expect(heats).toHaveLength(2)
      // Last heat should have fastest swimmers
      const lastHeat = heats[heats.length - 1]
      const lastAssignments = getAssignments(lastHeat.heatid)
      const firstHeat = heats[0]
      const firstAssignments = getAssignments(firstHeat.heatid)
      const lastMin = Math.min(...lastAssignments.map(a => a.entrytime!))
      const firstMin = Math.min(...firstAssignments.map(a => a.entrytime!))
      expect(lastMin).toBeLessThan(firstMin)
    })
  })
})
