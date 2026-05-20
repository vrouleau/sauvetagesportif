import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import Database from 'better-sqlite3'

// ── ZIP reader ────────────────────────────────────────────────────────────────

function readZipFirstEntry(filePath: string): string {
  const buf = readFileSync(filePath)
  if (buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error('Not a valid ZIP/LXF file')
  }
  const method = buf.readUInt16LE(8)
  const compressedSize = buf.readUInt32LE(18)
  const fileNameLen = buf.readUInt16LE(26)
  const extraLen = buf.readUInt16LE(28)
  const dataStart = 30 + fileNameLen + extraLen
  const compressed = buf.subarray(dataStart, dataStart + compressedSize)
  if (method === 0) return compressed.toString('utf8')
  if (method === 8) return inflateRawSync(compressed).toString('utf8')
  throw new Error(`Unsupported ZIP compression method: ${method}`)
}

// ── Minimal XML tree parser ───────────────────────────────────────────────────

interface XmlElem {
  tag: string
  attrs: Record<string, string>
  children: XmlElem[]
}

function parseXml(xml: string): XmlElem {
  const root: XmlElem = { tag: '__root__', attrs: {}, children: [] }
  const stack: XmlElem[] = [root]

  function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {}
    const re = /([\w:.-]+)="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) out[m[1]] = m[2]
    return out
  }

  const tagRe = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>/gs
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, tag, attribs, self] = m
    if (tag.startsWith('?') || tag.startsWith('!')) continue
    if (closing) {
      if (stack.length > 1) stack.pop()
    } else {
      const elem: XmlElem = { tag: tag.toUpperCase(), attrs: parseAttrs(attribs), children: [] }
      stack[stack.length - 1].children.push(elem)
      if (!self) stack.push(elem)
    }
  }
  return root.children[0] ?? root
}

function child(elem: XmlElem, tag: string): XmlElem | undefined {
  return elem.children.find(c => c.tag === tag.toUpperCase())
}
function children(elem: XmlElem, tag: string): XmlElem[] {
  return elem.children.filter(c => c.tag === tag.toUpperCase())
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodeGender(g: string | undefined): number {
  if (g === 'F') return 2
  if (g === 'M') return 1
  return 3
}

function encodeStroke(s: string | undefined): number {
  switch ((s ?? '').toUpperCase()) {
    case 'FREE': return 1; case 'BACK': return 2; case 'BREAST': return 3
    case 'FLY': return 4; case 'MEDLEY': return 5; case 'RELAY': return 6
    default: return 1
  }
}

function encodeRound(r: string | undefined): number {
  switch ((r ?? '').toUpperCase()) {
    case 'PRE': return 1; case 'SEM': return 2; case 'FIN': return 4; case 'TIM': return 5
    default: return 5
  }
}

function encodeHeatStatus(s: string | undefined): number {
  switch ((s ?? '').toUpperCase()) {
    case 'SEEDED': return 4
    case 'OFFICIAL': case 'UNOFF': return 8
    default: return 0
  }
}

// LENEX time format: "HH:MM:SS.cc" → integer milliseconds
function lenexTimeToMs(t: string | undefined): number | null {
  if (!t) return null
  const parts = t.split(':')
  if (parts.length !== 3) return null
  const hh = parseInt(parts[0], 10)
  const mm = parseInt(parts[1], 10)
  const [ssStr, ccStr = '00'] = parts[2].split('.')
  const ss = parseInt(ssStr, 10)
  const cc = parseInt(ccStr.padEnd(2, '0').slice(0, 2), 10)
  if (isNaN(hh) || isNaN(mm) || isNaN(ss)) return null
  const ms = hh * 3600000 + mm * 60000 + ss * 1000 + cc * 10
  return ms === 0 ? null : ms
}

// ── Import summary ────────────────────────────────────────────────────────────

export interface ImportSummary {
  sessions: number
  events: number
  ageGroups: number
  heats: number
  clubs: number
  athletes: number
  results: number
  errors: string[]
}

// ── Main import function (now uses local SQLite) ──────────────────────────────

export function importLenex(filePath: string, db: Database.Database): ImportSummary {
  const summary: ImportSummary = {
    sessions: 0, events: 0, ageGroups: 0,
    heats: 0, clubs: 0, athletes: 0, results: 0, errors: [],
  }

  const xml = readZipFirstEntry(filePath)
  const lenex = parseXml(xml)
  const meet = child(child(lenex, 'MEETS')!, 'MEET')
  if (!meet) throw new Error('No MEET element found in LENEX file')

  // Store MEET-level attributes in bsglobal (key-value store)
  const meetAttrs = meet.attrs
  const bsglobalStmt = db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data=excluded.data`
  )
  if (meetAttrs.name) bsglobalStmt.run('MeetName', meetAttrs.name)
  if (meetAttrs.city) bsglobalStmt.run('MeetCity', meetAttrs.city)
  if (meetAttrs.nation) bsglobalStmt.run('MeetNation', meetAttrs.nation)
  if (meetAttrs.course) {
    const courseMap: Record<string, string> = { LCM: '1', SCY: '2', SCM: '3' }
    bsglobalStmt.run('MeetCourse', courseMap[meetAttrs.course] ?? '1')
  }
  if (meetAttrs.organizer) bsglobalStmt.run('MeetOrganizer', meetAttrs.organizer)
  if (meetAttrs.organizer_url) bsglobalStmt.run('MeetOrganizerUrl', meetAttrs.organizer_url)
  // Pool info from POOL element
  const pool = child(meet, 'POOL')
  if (pool) {
    if (pool.attrs.name) bsglobalStmt.run('PoolName', pool.attrs.name)
    if (pool.attrs.lanes) bsglobalStmt.run('PoolLanes', pool.attrs.lanes)
    if (pool.attrs.lanemin) bsglobalStmt.run('PoolLaneMin', pool.attrs.lanemin)
    if (pool.attrs.lanemax) bsglobalStmt.run('PoolLaneMax', pool.attrs.lanemax)
  }
  // Facility/venue from FACILITY
  const facility = child(meet, 'FACILITY')
  if (facility) {
    if (facility.attrs.name) bsglobalStmt.run('PoolName', facility.attrs.name)
    if (facility.attrs.street) bsglobalStmt.run('PoolStreet', facility.attrs.street)
    if (facility.attrs.city) bsglobalStmt.run('PoolCity', facility.attrs.city)
    if (facility.attrs.state) bsglobalStmt.run('PoolState', facility.attrs.state)
    if (facility.attrs.zip) bsglobalStmt.run('PoolZip', facility.attrs.zip)
  }
  // Contact from CONTACT
  const contact = child(meet, 'CONTACT')
  if (contact) {
    if (contact.attrs.name) bsglobalStmt.run('ContactName', contact.attrs.name)
    if (contact.attrs.street) bsglobalStmt.run('ContactStreet', contact.attrs.street)
    if (contact.attrs.street2) bsglobalStmt.run('ContactStreet2', contact.attrs.street2)
    if (contact.attrs.city) bsglobalStmt.run('ContactCity', contact.attrs.city)
    if (contact.attrs.zip) bsglobalStmt.run('ContactZip', contact.attrs.zip)
    if (contact.attrs.phone) bsglobalStmt.run('ContactPhone', contact.attrs.phone)
    if (contact.attrs.fax) bsglobalStmt.run('ContactFax', contact.attrs.fax)
    if (contact.attrs.email) bsglobalStmt.run('ContactEmail', contact.attrs.email)
    if (contact.attrs.internet) bsglobalStmt.run('ContactInternet', contact.attrs.internet)
  }

  // Prepared statements
  const stmts = {
    findSession: db.prepare(`SELECT swimsessionid FROM swimsession WHERE sessionnumber=?`),
    updateSession: db.prepare(`UPDATE swimsession SET name=? WHERE swimsessionid=?`),
    maxSessionId: db.prepare(`SELECT COALESCE(MAX(swimsessionid),0)+1 AS next FROM swimsession`),
    insertSession: db.prepare(
      `INSERT INTO swimsession (swimsessionid, sessionnumber, name, course, following, poolglobal, roundtotenths)
       VALUES (?,?,?,1,'F','F','F')`),
    upsertStyle: db.prepare(
      `INSERT INTO swimstyle (swimstyleid, distance, relaycount, stroke, name)
       VALUES (?,?,?,?,?)
       ON CONFLICT(swimstyleid) DO UPDATE SET distance=excluded.distance, relaycount=excluded.relaycount, stroke=excluded.stroke, name=excluded.name`),
    upsertEvent: db.prepare(
      `INSERT INTO swimevent
         (swimeventid, swimsessionid, eventnumber, gender, round, swimstyleid, sortcode,
          internalevent, splashmecanedit, masters, pfineignore, seedbonuslast,
          seedexhlast, seedlateentrylast, seedingglobal, twoperlane, combineagegroups, roundname)
       VALUES (?,?,?,?,?,?,?,'F','F',?,'F','F','F','F','F','F','F',?)
       ON CONFLICT(swimeventid) DO UPDATE SET
         swimsessionid=excluded.swimsessionid, eventnumber=excluded.eventnumber,
         gender=excluded.gender, round=excluded.round, swimstyleid=excluded.swimstyleid,
         sortcode=excluded.sortcode, internalevent=excluded.internalevent,
         masters=excluded.masters, roundname=excluded.roundname`),
    upsertAgeGroup: db.prepare(
      `INSERT INTO agegroup
         (agegroupid, swimeventid, name, agemin, agemax, gender, heatcount, sortcode,
          useformedals, useforscoring, allofficial, agebytotal, forceprelim, seedwithtsonly)
       VALUES (?,?,?,?,?,?,1,?,'T','T','T','F','F','F')
       ON CONFLICT(agegroupid) DO UPDATE SET
         swimeventid=excluded.swimeventid, agemin=excluded.agemin,
         agemax=excluded.agemax, gender=excluded.gender, sortcode=excluded.sortcode`),
    upsertHeat: db.prepare(
      `INSERT INTO heat (heatid, swimeventid, heatnumber, racestatus, sortcode)
       VALUES (?,?,?,?,?)
       ON CONFLICT(heatid) DO UPDATE SET
         swimeventid=excluded.swimeventid, heatnumber=excluded.heatnumber,
         racestatus=excluded.racestatus, sortcode=excluded.sortcode`),
    upsertClub: db.prepare(
      `INSERT INTO club (clubid, code, name) VALUES (?,?,?)
       ON CONFLICT(clubid) DO UPDATE SET code=excluded.code, name=excluded.name`),
    upsertAthlete: db.prepare(
      `INSERT INTO athlete (athleteid, firstname, lastname, birthdate, gender, nation, license, clubid)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(athleteid) DO UPDATE SET
         firstname=excluded.firstname, lastname=excluded.lastname, birthdate=excluded.birthdate,
         gender=excluded.gender, nation=excluded.nation, license=excluded.license, clubid=excluded.clubid`),
    upsertResult: db.prepare(
      `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, heatid, lane, entrytime, usetimetype)
       VALUES (?,?,?,?,?,?,0)
       ON CONFLICT(swimresultid) DO UPDATE SET
         athleteid=excluded.athleteid, swimeventid=excluded.swimeventid,
         heatid=excluded.heatid, lane=excluded.lane, entrytime=excluded.entrytime`),
  }

  // ── Sessions → swimsession ─────────────────────────────────────────────
  const sessionsElem = child(meet, 'SESSIONS')
  for (const sess of children(sessionsElem ?? meet, 'SESSION')) {
    const a = sess.attrs
    const num = parseInt(a.number ?? '0', 10)
    let swimsessionid: number
    try {
      const existing = stmts.findSession.get(num) as { swimsessionid: number } | undefined
      const sessName = (a.name ?? '').slice(0, 100)
      if (existing) {
        swimsessionid = existing.swimsessionid
        stmts.updateSession.run(sessName, swimsessionid)
      } else {
        const r = stmts.maxSessionId.get() as { next: number }
        swimsessionid = r.next
        stmts.insertSession.run(swimsessionid, num, sessName)
      }
      summary.sessions++
    } catch (e) {
      summary.errors.push(`Session ${num}: ${e}`)
      continue
    }

    // ── Events → swimevent ───────────────────────────────────────────────
    const eventsElem = child(sess, 'EVENTS')
    for (const event of children(eventsElem ?? sess, 'EVENT')) {
      const ea = event.attrs
      const eventId = parseInt(ea.eventid ?? '0', 10)
      if (!eventId) continue

      const style = child(event, 'SWIMSTYLE')
      const sa = style?.attrs ?? {}
      const styleId = parseInt(sa.swimstyleid ?? '0', 10)
      const distance = parseInt(sa.distance ?? '0', 10)
      const relaycount = parseInt(sa.relaycount ?? '1', 10)
      const strokeCode = encodeStroke(sa.stroke)
      const styleName = sa.name ?? ''

      if (styleId) {
        try {
          stmts.upsertStyle.run(styleId, distance, relaycount, strokeCode, styleName)
        } catch (e) {
          summary.errors.push(`Swimstyle ${styleId}: ${e}`)
        }
      }

      const gender = encodeGender(ea.gender)
      const round = encodeRound(ea.round)
      const sortcode = parseInt(ea.order ?? ea.number ?? '0', 10)
      const isMasters = ea.type === 'MASTERS' ? 'T' : 'F'
      const isInternal = (ea.type === 'ADMIN' || ea.type === 'PAUSE') ? 'T' : 'F'
      const evName = ea.name ?? styleName
      try {
        stmts.upsertEvent.run(
          eventId, swimsessionid, parseInt(ea.number ?? '0', 10),
          gender, round, styleId || null, sortcode, isMasters, evName
        )
        summary.events++
      } catch (e) {
        summary.errors.push(`Event ${eventId}: ${e}`)
      }

      // Age groups
      const agElem = child(event, 'AGEGROUPS')
      let agIdx = 0
      for (const ag of children(agElem ?? event, 'AGEGROUP')) {
        const aa = ag.attrs
        const agId = parseInt(aa.agegroupid ?? '0', 10)
        if (!agId) continue
        const agemax = parseInt(aa.agemax ?? '-1', 10)
        const finalSeedType = aa.finalseedtype ? parseInt(aa.finalseedtype, 10) : null
        try {
          stmts.upsertAgeGroup.run(
            agId, eventId, aa.name ?? '', parseInt(aa.agemin ?? '0', 10),
            agemax < 0 ? null : agemax, gender, agIdx
          )
          // Store finalseedtype if present in LENEX
          if (finalSeedType != null) {
            db.prepare(`UPDATE agegroup SET finalseedtype=? WHERE agegroupid=?`).run(finalSeedType, agId)
          }
          summary.ageGroups++
          agIdx++
        } catch (e) {
          summary.errors.push(`AgeGroup ${agId}: ${e}`)
        }
      }

      // Heats
      const heatsElem = child(event, 'HEATS')
      for (const heat of children(heatsElem ?? event, 'HEAT')) {
        const ha = heat.attrs
        const heatId = parseInt(ha.heatid ?? '0', 10)
        if (!heatId) continue
        try {
          stmts.upsertHeat.run(
            heatId, eventId,
            parseInt(ha.number ?? '0', 10),
            encodeHeatStatus(ha.status),
            parseInt(ha.order ?? ha.number ?? '0', 10)
          )
          summary.heats++
        } catch (e) {
          summary.errors.push(`Heat ${heatId}: ${e}`)
        }
      }
    }
  }

  // ── Clubs → club; Athletes → athlete; Results → swimresult ────────────
  const clubsElem = child(meet, 'CLUBS')
  for (const club of children(clubsElem ?? meet, 'CLUB')) {
    const ca = club.attrs
    const clubId = parseInt(ca.clubid ?? '0', 10)
    if (!clubId) continue
    try {
      stmts.upsertClub.run(clubId, ca.code ?? '', ca.name ?? '')
      summary.clubs++
    } catch (e) {
      summary.errors.push(`Club ${clubId}: ${e}`)
    }

    const athElem = child(club, 'ATHLETES')
    for (const ath of children(athElem ?? club, 'ATHLETE')) {
      const aa = ath.attrs
      const athId = parseInt(aa.athleteid ?? '0', 10)
      if (!athId) continue
      try {
        stmts.upsertAthlete.run(
          athId, aa.firstname ?? '', aa.lastname ?? '',
          aa.birthdate || null, encodeGender(aa.gender),
          aa.nation ?? '', aa.license || null, clubId
        )
        summary.athletes++
      } catch (e) {
        summary.errors.push(`Athlete ${athId}: ${e}`)
      }

      const resElem = child(ath, 'RESULTS')
      for (const res of children(resElem ?? ath, 'RESULT')) {
        const ra = res.attrs
        const resId = parseInt(ra.resultid ?? '0', 10)
        if (!resId) continue
        const entrytime = lenexTimeToMs(ra.entrytime)
        try {
          stmts.upsertResult.run(
            resId, athId,
            parseInt(ra.eventid ?? '0', 10),
            parseInt(ra.heatid ?? '0', 10),
            parseInt(ra.lane ?? '0', 10),
            entrytime
          )
          summary.results++
        } catch (e) {
          summary.errors.push(`Result ${resId}: ${e}`)
        }
      }
    }
  }

  return summary
}
