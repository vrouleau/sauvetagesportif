import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
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

  function decodeXmlEntities(s: string): string {
    return s
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {}
    const re = /([\w:.-]+)="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) out[m[1]] = decodeXmlEntities(m[2])
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

function encodeCourse(c: string | undefined): number | null {
  switch ((c ?? '').toUpperCase()) {
    case 'LCM': return 1; case 'SCY': return 2; case 'SCM': return 3
    default: return null
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

  // Also write to MEETVALUES (the canonical Splash format)
  {
    const mvRow = db.prepare(`SELECT data FROM bsglobal WHERE name='MEETVALUES'`).get() as { data: string | null } | undefined
    const existing: Record<string, string> = {}
    if (mvRow?.data) {
      for (const line of mvRow.data.split(/\r?\n/)) {
        const eq = line.indexOf('=')
        if (eq >= 0) existing[line.slice(0, eq)] = line.slice(eq + 1)
      }
    }
    if (meetAttrs.name) existing['NAME'] = `S;${meetAttrs.name}`
    if (meetAttrs.city) existing['CITY'] = `S;${meetAttrs.city}`
    if (meetAttrs.nation) existing['NATION'] = `S;${meetAttrs.nation}`
    if (meetAttrs.course) {
      const courseMap: Record<string, string> = { LCM: '1', SCY: '2', SCM: '3' }
      existing['COURSE'] = `I;${courseMap[meetAttrs.course] ?? '1'}`
    }
    const data = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\r\n')
    bsglobalStmt.run('MEETVALUES', data)
  }

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
      `INSERT INTO swimresult (swimresultid, athleteid, swimeventid, agegroupid, heatid, lane, entrytime, entrycourse, usetimetype)
       VALUES (?,?,?,?,?,?,?,?,0)
       ON CONFLICT(swimresultid) DO UPDATE SET
         athleteid=excluded.athleteid, swimeventid=excluded.swimeventid,
         agegroupid=excluded.agegroupid,
         heatid=excluded.heatid, lane=excluded.lane, entrytime=excluded.entrytime,
         entrycourse=excluded.entrycourse`),
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
        const agegroupid = parseInt(ra.agegroupid ?? '0', 10) || null
        const entrycourse = ra.entrycourse ? encodeCourse(ra.entrycourse) : null
        try {
          stmts.upsertResult.run(
            resId, athId,
            parseInt(ra.eventid ?? '0', 10),
            agegroupid,
            parseInt(ra.heatid ?? '0', 10) || null,
            parseInt(ra.lane ?? '0', 10) || null,
            entrytime,
            entrycourse
          )
          summary.results++
        } catch (e) {
          summary.errors.push(`Result ${resId}: ${e}`)
        }
      }

      // Also handle <ENTRY> elements (registrations without results yet)
      const entElem = child(ath, 'ENTRIES')
      for (const ent of children(entElem ?? ath, 'ENTRY')) {
        const ea2 = ent.attrs
        // ENTRY elements don't have a resultid — generate one from eventid + athleteid
        const eventIdVal = parseInt(ea2.eventid ?? '0', 10)
        if (!eventIdVal) continue
        const entryId = parseInt(ea2.entryid ?? '0', 10) || (athId * 100000 + eventIdVal)
        const entrytime = lenexTimeToMs(ea2.entrytime)
        const agegroupid = parseInt(ea2.agegroupid ?? '0', 10) || null
        const entrycourse = ea2.entrycourse ? encodeCourse(ea2.entrycourse) : null
        try {
          stmts.upsertResult.run(
            entryId, athId,
            eventIdVal,
            agegroupid,
            null,  // no heat yet
            null,  // no lane yet
            entrytime,
            entrycourse
          )
          summary.results++
        } catch (e) {
          summary.errors.push(`Entry ${entryId} (athlete ${athId}, event ${eventIdVal}): ${e}`)
        }
      }
    }
  }

  return summary
}

// ══════════════════════════════════════════════════════════════════════════════
// ── LENEX Results Export ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Decode helpers (reverse of encode*) ───────────────────────────────────────

function decodeGender(g: number | null): string {
  if (g === 1) return 'M'
  if (g === 2) return 'F'
  return 'X'
}

function decodeStroke(s: number | null): string {
  switch (s) {
    case 1: return 'FREE'
    case 2: return 'BACK'
    case 3: return 'BREAST'
    case 4: return 'FLY'
    case 5: return 'MEDLEY'
    case 6: return 'FREE'   // relay free
    case 7: return 'MEDLEY' // relay medley
    default: return 'FREE'
  }
}

function decodeRound(r: number | null): string {
  switch (r) {
    case 1: return 'PRE'
    case 2: return 'SEM'
    case 4: return 'FIN'
    case 5: return 'TIM'
    default: return 'TIM'
  }
}

function decodeCourse(c: number | null): string {
  switch (c) {
    case 1: return 'LCM'
    case 2: return 'SCY'
    case 3: return 'SCM'
    default: return 'LCM'
  }
}

function msToLenexTime(ms: number | null): string | null {
  if (!ms || ms <= 0) return null
  const totalCs = Math.round(ms / 10)
  const cs = totalCs % 100
  const totalSecs = Math.floor(totalCs / 100)
  const ss = totalSecs % 60
  const totalMins = Math.floor(totalSecs / 60)
  const mm = totalMins % 60
  const hh = Math.floor(totalMins / 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function decodeResultStatus(s: number | null): string | null {
  switch (s) {
    case 1: return 'DNS'
    case 2: return 'DNF'
    case 3: return 'DSQ'
    default: return null
  }
}

// ── XML escaping ──────────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function attr(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  return ` ${name}="${escXml(String(value))}"`
}

// ── ZIP writer (minimal, single-entry) ────────────────────────────────────────

function writeZipSingleEntry(filePath: string, entryName: string, content: string): void {
  const data = Buffer.from(content, 'utf8')
  const compressed = deflateRawSync(data)
  const nameBytes = Buffer.from(entryName, 'utf8')
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF

  // CRC-32
  const crc = crc32(data)

  // Local file header
  const localHeader = Buffer.alloc(30 + nameBytes.length)
  localHeader.writeUInt32LE(0x04034b50, 0)  // signature
  localHeader.writeUInt16LE(20, 4)           // version needed
  localHeader.writeUInt16LE(0, 6)            // flags
  localHeader.writeUInt16LE(8, 8)            // compression: deflate
  localHeader.writeUInt16LE(dosTime, 10)
  localHeader.writeUInt16LE(dosDate, 12)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(compressed.length, 18)
  localHeader.writeUInt32LE(data.length, 22)
  localHeader.writeUInt16LE(nameBytes.length, 26)
  localHeader.writeUInt16LE(0, 28)           // extra field length
  nameBytes.copy(localHeader, 30)

  // Central directory header
  const centralHeader = Buffer.alloc(46 + nameBytes.length)
  centralHeader.writeUInt32LE(0x02014b50, 0)  // signature
  centralHeader.writeUInt16LE(20, 4)           // version made by
  centralHeader.writeUInt16LE(20, 6)           // version needed
  centralHeader.writeUInt16LE(0, 8)            // flags
  centralHeader.writeUInt16LE(8, 10)           // compression
  centralHeader.writeUInt16LE(dosTime, 12)
  centralHeader.writeUInt16LE(dosDate, 14)
  centralHeader.writeUInt32LE(crc, 16)
  centralHeader.writeUInt32LE(compressed.length, 20)
  centralHeader.writeUInt32LE(data.length, 24)
  centralHeader.writeUInt16LE(nameBytes.length, 28)
  centralHeader.writeUInt16LE(0, 30)           // extra field length
  centralHeader.writeUInt16LE(0, 32)           // comment length
  centralHeader.writeUInt16LE(0, 34)           // disk number start
  centralHeader.writeUInt16LE(0, 36)           // internal attrs
  centralHeader.writeUInt32LE(0, 38)           // external attrs
  centralHeader.writeUInt32LE(0, 42)           // local header offset
  nameBytes.copy(centralHeader, 46)

  const centralDirOffset = localHeader.length + compressed.length

  // End of central directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)   // disk number
  eocd.writeUInt16LE(0, 6)   // disk with central dir
  eocd.writeUInt16LE(1, 8)   // entries on this disk
  eocd.writeUInt16LE(1, 10)  // total entries
  eocd.writeUInt32LE(centralHeader.length, 12)
  eocd.writeUInt32LE(centralDirOffset, 16)
  eocd.writeUInt16LE(0, 20)  // comment length

  writeFileSync(filePath, Buffer.concat([localHeader, compressed, centralHeader, eocd]))
}

// CRC-32 (standard polynomial)
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ── Export summary ────────────────────────────────────────────────────────────

export interface ExportSummary {
  sessions: number
  events: number
  clubs: number
  athletes: number
  results: number
}

// ── Main export function ──────────────────────────────────────────────────────

export function exportLenexResults(filePath: string, db: Database.Database): ExportSummary {
  const summary: ExportSummary = { sessions: 0, events: 0, clubs: 0, athletes: 0, results: 0 }

  // ── Read meet metadata from bsglobal ────────────────────────────────────────
  const globals = db.prepare(`SELECT name, data FROM bsglobal`).all() as Array<{ name: string; data: string | null }>
  const g: Record<string, string> = {}
  for (const row of globals) g[row.name] = row.data ?? ''

  // Parse MEETVALUES (primary source, same as real Splash)
  const mv: Record<string, string> = {}
  if (g['MEETVALUES']) {
    for (const line of g['MEETVALUES'].split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq)
      const rest = line.slice(eq + 1)
      const semi = rest.indexOf(';')
      mv[key] = semi >= 0 ? rest.slice(semi + 1) : rest
    }
  }

  const meetName = mv['NAME'] || g['MeetName'] || 'Meet'
  const meetCity = mv['CITY'] || g['MeetCity'] || ''
  const meetNation = mv['NATION'] || g['MeetNation'] || ''
  const meetCourse = decodeCourse(parseInt(mv['COURSE'] || g['MeetCourse'] || '1', 10))

  // ── Sessions ────────────────────────────────────────────────────────────────
  const sessions = db.prepare(
    `SELECT swimsessionid, sessionnumber, name, course FROM swimsession ORDER BY sessionnumber`
  ).all() as Array<{ swimsessionid: number; sessionnumber: number; name: string | null; course: number | null }>

  // ── Events (skip internal/break events) ─────────────────────────────────────
  const events = db.prepare(
    `SELECT e.swimeventid, e.swimsessionid, e.eventnumber, e.gender, e.round, e.roundname,
            e.sortcode, e.swimstyleid,
            s.distance, s.stroke, s.relaycount, s.name AS stylename
     FROM swimevent e
     LEFT JOIN swimstyle s ON s.swimstyleid = e.swimstyleid
     WHERE e.internalevent = 'F'
     ORDER BY e.sortcode, e.eventnumber`
  ).all() as Array<{
    swimeventid: number; swimsessionid: number; eventnumber: number
    gender: number; round: number; roundname: string | null; sortcode: number
    swimstyleid: number | null; distance: number | null; stroke: number | null
    relaycount: number | null; stylename: string | null
  }>

  // ── Age groups ──────────────────────────────────────────────────────────────
  const ageGroups = db.prepare(
    `SELECT agegroupid, swimeventid, name, agemin, agemax, gender FROM agegroup ORDER BY sortcode`
  ).all() as Array<{
    agegroupid: number; swimeventid: number; name: string | null
    agemin: number | null; agemax: number | null; gender: number | null
  }>
  const agByEvent = new Map<number, typeof ageGroups>()
  for (const ag of ageGroups) {
    const list = agByEvent.get(ag.swimeventid) ?? []
    list.push(ag)
    agByEvent.set(ag.swimeventid, list)
  }

  // ── Heats ───────────────────────────────────────────────────────────────────
  const heats = db.prepare(
    `SELECT heatid, swimeventid, heatnumber, racestatus FROM heat ORDER BY sortcode, heatnumber`
  ).all() as Array<{ heatid: number; swimeventid: number; heatnumber: number; racestatus: number | null }>
  const heatsByEvent = new Map<number, typeof heats>()
  for (const h of heats) {
    const list = heatsByEvent.get(h.swimeventid) ?? []
    list.push(h)
    heatsByEvent.set(h.swimeventid, list)
  }

  // ── Results with athlete + club info ────────────────────────────────────────
  const results = db.prepare(
    `SELECT r.swimresultid, r.athleteid, r.swimeventid, r.agegroupid,
            r.heatid, r.lane, r.swimtime, r.reactiontime, r.resultstatus,
            a.firstname, a.lastname, a.birthdate, a.gender AS athgender,
            a.nation AS athnation, a.license, a.clubid
     FROM swimresult r
     JOIN athlete a ON a.athleteid = r.athleteid
     WHERE r.swimtime IS NOT NULL OR r.resultstatus IS NOT NULL
     ORDER BY r.swimeventid, r.heatid, r.lane`
  ).all() as Array<{
    swimresultid: number; athleteid: number; swimeventid: number; agegroupid: number | null
    heatid: number | null; lane: number | null; swimtime: number | null
    reactiontime: number | null; resultstatus: number | null
    firstname: string | null; lastname: string | null; birthdate: string | null
    athgender: number | null; athnation: string | null; license: string | null
    clubid: number | null
  }>

  // ── Splits ──────────────────────────────────────────────────────────────────
  const splits = db.prepare(
    `SELECT swimresultid, distance, swimtime FROM split ORDER BY swimresultid, distance`
  ).all() as Array<{ swimresultid: number; distance: number; swimtime: number | null }>
  const splitsByResult = new Map<number, typeof splits>()
  for (const sp of splits) {
    const list = splitsByResult.get(sp.swimresultid) ?? []
    list.push(sp)
    splitsByResult.set(sp.swimresultid, list)
  }

  // ── Clubs ───────────────────────────────────────────────────────────────────
  const clubs = db.prepare(
    `SELECT clubid, code, name, nation FROM club ORDER BY clubid`
  ).all() as Array<{ clubid: number; code: string | null; name: string | null; nation: string | null }>

  // Build club map and determine which clubs have results
  const clubMap = new Map<number, typeof clubs[0]>()
  for (const c of clubs) clubMap.set(c.clubid, c)

  // Group results by club → athlete
  const athleteResults = new Map<number, typeof results>()
  const clubsWithResults = new Set<number>()
  const athletesWithResults = new Set<number>()
  for (const r of results) {
    const list = athleteResults.get(r.athleteid) ?? []
    list.push(r)
    athleteResults.set(r.athleteid, list)
    athletesWithResults.add(r.athleteid)
    if (r.clubid) clubsWithResults.add(r.clubid)
  }

  // Athletes grouped by club
  const athletesByClub = new Map<number, Array<{ athleteid: number; firstname: string; lastname: string; birthdate: string | null; gender: number; nation: string | null; license: string | null }>>()
  for (const r of results) {
    if (!r.clubid) continue
    if (!athletesByClub.has(r.clubid)) athletesByClub.set(r.clubid, [])
    const list = athletesByClub.get(r.clubid)!
    if (!list.find(a => a.athleteid === r.athleteid)) {
      list.push({
        athleteid: r.athleteid,
        firstname: r.firstname ?? '',
        lastname: r.lastname ?? '',
        birthdate: r.birthdate,
        gender: r.athgender ?? 3,
        nation: r.athnation,
        license: r.license,
      })
    }
  }

  // ── Build XML ───────────────────────────────────────────────────────────────
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<LENEX version="3.0">')
  lines.push('  <MEETS>')
  lines.push(`    <MEET${attr('name', meetName)}${attr('city', meetCity)}${attr('nation', meetNation)}${attr('course', meetCourse)}>`)

  // Sessions + Events + AgeGroups + Heats
  lines.push('      <SESSIONS>')
  for (const sess of sessions) {
    lines.push(`        <SESSION${attr('number', sess.sessionnumber)}${attr('name', sess.name)}${attr('course', decodeCourse(sess.course))}>`)
    lines.push('          <EVENTS>')

    const sessEvents = events.filter(e => e.swimsessionid === sess.swimsessionid)
    for (const ev of sessEvents) {
      lines.push(`            <EVENT${attr('eventid', ev.swimeventid)}${attr('number', ev.eventnumber)}${attr('gender', decodeGender(ev.gender))}${attr('round', decodeRound(ev.round))}${attr('order', ev.sortcode)}>`)

      // SWIMSTYLE
      if (ev.swimstyleid) {
        lines.push(`              <SWIMSTYLE${attr('swimstyleid', ev.swimstyleid)}${attr('distance', ev.distance)}${attr('stroke', decodeStroke(ev.stroke))}${attr('relaycount', ev.relaycount ?? 1)}${attr('name', ev.stylename)} />`)
      }

      // AGEGROUPS
      const evAgs = agByEvent.get(ev.swimeventid)
      if (evAgs && evAgs.length > 0) {
        lines.push('              <AGEGROUPS>')
        for (const ag of evAgs) {
          lines.push(`                <AGEGROUP${attr('agegroupid', ag.agegroupid)}${attr('name', ag.name)}${attr('agemin', ag.agemin)}${attr('agemax', ag.agemax)}${attr('gender', decodeGender(ag.gender))} />`)
        }
        lines.push('              </AGEGROUPS>')
      }

      // HEATS
      const evHeats = heatsByEvent.get(ev.swimeventid)
      if (evHeats && evHeats.length > 0) {
        lines.push('              <HEATS>')
        for (const h of evHeats) {
          const heatStatus = h.racestatus && h.racestatus >= 8 ? 'OFFICIAL' : h.racestatus === 4 ? 'SEEDED' : undefined
          lines.push(`                <HEAT${attr('heatid', h.heatid)}${attr('number', h.heatnumber)}${attr('status', heatStatus)} />`)
        }
        lines.push('              </HEATS>')
      }

      lines.push('            </EVENT>')
      summary.events++
    }

    lines.push('          </EVENTS>')
    lines.push('        </SESSION>')
    summary.sessions++
  }
  lines.push('      </SESSIONS>')

  // Clubs + Athletes + Results
  lines.push('      <CLUBS>')
  for (const [clubId, athletes] of athletesByClub) {
    const club = clubMap.get(clubId)
    if (!club) continue
    lines.push(`        <CLUB${attr('clubid', clubId)}${attr('code', club.code)}${attr('name', club.name)}${attr('nation', club.nation)}>`)
    lines.push('          <ATHLETES>')

    for (const ath of athletes) {
      lines.push(`            <ATHLETE${attr('athleteid', ath.athleteid)}${attr('firstname', ath.firstname)}${attr('lastname', ath.lastname)}${attr('birthdate', ath.birthdate)}${attr('gender', decodeGender(ath.gender))}${attr('nation', ath.nation)}${attr('license', ath.license)}>`)
      lines.push('              <RESULTS>')

      const athResults = athleteResults.get(ath.athleteid) ?? []
      for (const r of athResults) {
        const timeStr = msToLenexTime(r.swimtime)
        const status = decodeResultStatus(r.resultstatus)
        const rtStr = r.reactiontime != null ? msToLenexTime(r.reactiontime) : null
        lines.push(`                <RESULT${attr('resultid', r.swimresultid)}${attr('eventid', r.swimeventid)}${attr('heatid', r.heatid)}${attr('lane', r.lane)}${attr('swimtime', timeStr)}${attr('reactiontime', rtStr)}${attr('status', status)}>`)

        // Splits
        const resSplits = splitsByResult.get(r.swimresultid)
        if (resSplits && resSplits.length > 0) {
          lines.push('                  <SPLITS>')
          for (const sp of resSplits) {
            const spTime = msToLenexTime(sp.swimtime)
            if (spTime) {
              lines.push(`                    <SPLIT${attr('distance', sp.distance)}${attr('swimtime', spTime)} />`)
            }
          }
          lines.push('                  </SPLITS>')
        }

        lines.push('                </RESULT>')
        summary.results++
      }

      lines.push('              </RESULTS>')
      lines.push('            </ATHLETE>')
      summary.athletes++
    }

    lines.push('          </ATHLETES>')
    lines.push('        </CLUB>')
    summary.clubs++
  }
  lines.push('      </CLUBS>')

  lines.push('    </MEET>')
  lines.push('  </MEETS>')
  lines.push('</LENEX>')

  const xml = lines.join('\n')
  writeZipSingleEntry(filePath, 'results.lef', xml)

  return summary
}
