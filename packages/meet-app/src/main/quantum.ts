import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'

// ── Shared entry shape used by both schedule and active-heat ─────────────────

export interface ScheduleEntry {
  lane: number
  athleteId: number
  lastName: string
  firstName: string
  birthdate?: string   // "YYYY-MM-DD"
  gender?: string
  nation: string
  clubCode: string
  clubName?: string
  entryTime?: string   // "NT" or "MM:SS.cc" — converted to HH:MM:SS.cc on send
}

export interface ScheduleEvent {
  eventId: number
  eventNumber: number
  gender: string
  distance: number
  order?: number
  round?: string        // PRE | FIN | TIM | BREAK
  status?: string       // SEEDED | …
  daytime?: string      // "HH:MM"
  swimstyleName?: string
  heats: Array<{
    heatId: number
    heatNumber: number
    heatName?: string   // "Série 1"
    heatOrder?: number
    entries: ScheduleEntry[]
  }>
}

export interface ActiveHeat {
  eventId: number
  eventNumber: number
  heatId: number
  heatNumber: number
  gender: string
  distance: number
  round?: string
  swimstyleName?: string
  entries: ScheduleEntry[]
}

export interface QuantumResult {
  heatId: number
  results: Array<{
    lane: number
    swimtime: string
    reactiontime: number
    status: string
    splits: Array<{ distance: number; swimtime: string }>
  }>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toQuantumTime(t?: string): string {
  if (!t || t === 'NT') return 'NT'
  const parts = t.split(':')
  // MM:SS.cc → 00:MM:SS.cc
  if (parts.length === 2) return `00:${parts[0].padStart(2, '0')}:${parts[1]}`
  if (parts.length === 3) return t
  return 'NT'
}

function entryXml(e: ScheduleEntry, indent: string): string {
  const entrytime = toQuantumTime(e.entryTime)
  const clubname  = (e.clubName ?? e.clubCode).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const firstname = e.firstName.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const lastname  = e.lastName.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return [
    `${indent}<ENTRY lane="${e.lane}" entrytime="${entrytime}" clubname="${clubname}" code="${e.clubCode}">`,
    `${indent}  <ATHLETE firstname="${firstname}" lastname="${lastname}"` +
      (e.birthdate ? ` birthdate="${e.birthdate}"` : '') +
      (e.gender    ? ` gender="${e.gender}"`        : '') +
      ` nation="${e.nation}" athleteid="${e.athleteId}">`,
    `${indent}    <HANDICAP />`,
    `${indent}  </ATHLETE>`,
    `${indent}</ENTRY>`,
  ].join('\n')
}

const VERSION_STRING = 'VERSION;SPLASH Meet Manager 11.84087'

// ── QuantumBridge ─────────────────────────────────────────────────────────────

export class QuantumBridge {
  private folder: string | null = null
  private webContents: WebContents | null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private activeHeat: ActiveHeat | null = null
  private schedule: ScheduleEvent[] = []

  constructor(webContents: WebContents) {
    this.webContents = webContents
  }

  configure(folder: string): void {
    this.stop()
    this.folder = folder
    this.start()
  }

  setActiveHeat(heat: ActiveHeat): void {
    this.activeHeat = heat
  }

  setSchedule(events: ScheduleEvent[]): void {
    this.schedule = events
  }

  // ── XML builders ────────────────────────────────────────────────────────────

  private buildSchedule(): string {
    if (!this.schedule.length) return ''

    const eventLines = this.schedule.map((ev, i) => {
      const order      = ev.order ?? i + 1
      const round      = ev.round ?? 'PRE'
      const swimstyle  = ev.swimstyleName?.replace(/&/g, '&amp;').replace(/"/g, '&quot;') ?? ''
      const genderAttr = ev.gender !== 'X' ? ` gender="${ev.gender}"` : ''
      const numAttr    = ev.eventNumber > 0 ? ` number="${ev.eventNumber}"` : ''
      const dayAttr    = ev.daytime ? ` daytime="${ev.daytime}"` : ''
      const statAttr   = ev.status  ? ` status="${ev.status}"`  : ''

      const swimstyleEl = ev.distance > 0
        ? `      <SWIMSTYLE distance="${ev.distance}" relaycount="1" swimstyleid="${ev.eventId}" name="${swimstyle}" stroke="UNKNOWN" />`
        : `      <SWIMSTYLE stroke="UNKNOWN" />`

      if (ev.heats.length === 0) {
        return [
          `    <EVENT eventid="${ev.eventId}"${dayAttr}${numAttr}${genderAttr} order="${order}" round="${round}"${statAttr}>`,
          swimstyleEl,
          `      <HEATS />`,
          `    </EVENT>`,
        ].join('\n')
      }

      const heatLines = ev.heats.map((h) => {
        const heatName  = h.heatName  ?? `Série ${h.heatNumber}`
        const heatOrder = h.heatOrder ?? h.heatNumber
        const entryLines = h.entries.map((e) => entryXml(e, '          ')).join('\n')
        return [
          `        <HEAT heatid="${h.heatId}" name="${heatName}" number="${h.heatNumber}" order="${heatOrder}">`,
          `          <ENTRIES>`,
          entryLines,
          `          </ENTRIES>`,
          `        </HEAT>`,
        ].join('\n')
      }).join('\n')

      return [
        `    <EVENT eventid="${ev.eventId}"${dayAttr}${numAttr}${genderAttr} order="${order}" round="${round}"${statAttr}>`,
        swimstyleEl,
        `      <HEATS>`,
        heatLines,
        `      </HEATS>`,
        `    </EVENT>`,
      ].join('\n')
    }).join('\n')

    return [
      'SEND NAMES;START',
      '<STARTLIST>',
      '  <EVENTS>',
      eventLines,
      '  </EVENTS>',
      '</STARTLIST>',
      'SEND NAMES;END',
    ].join('\n')
  }

  private buildStartList(eventId: string, heatId: string): string {
    const h = this.activeHeat
    if (!h) return ''

    const round     = h.round ?? 'PRE'
    const swimstyle = h.swimstyleName?.replace(/&/g, '&amp;').replace(/"/g, '&quot;') ?? ''
    const heatName  = `Série ${h.heatNumber}`
    const entryLines = h.entries.map((e) => entryXml(e, '            ')).join('\n')

    return [
      'SEND NAMES;START',
      '<STARTLIST>',
      '  <EVENTS>',
      `    <EVENT eventid="${eventId}" gender="${h.gender}" number="${h.eventNumber}" order="0" round="${round}">`,
      `      <SWIMSTYLE distance="${h.distance}" relaycount="1" swimstyleid="${eventId}" name="${swimstyle}" stroke="UNKNOWN" />`,
      '      <HEATS>',
      `        <HEAT heatid="${heatId}" name="${heatName}" number="${h.heatNumber}" order="${h.heatNumber}">`,
      '          <ENTRIES>',
      entryLines,
      '          </ENTRIES>',
      '        </HEAT>',
      '      </HEATS>',
      '    </EVENT>',
      '  </EVENTS>',
      '</STARTLIST>',
      'SEND NAMES;END',
    ].join('\n')
  }

  // ── Result parser ────────────────────────────────────────────────────────────

  private parseResults(content: string): QuantumResult | null {
    const startIdx = content.indexOf('SEND RESULTS;START')
    const endIdx   = content.indexOf('SEND RESULTS;END')
    if (startIdx === -1 || endIdx === -1) return null

    const xml = content.slice(startIdx + 'SEND RESULTS;START'.length, endIdx)

    // Extract heatid from <HEAT heatid="N" ...>
    const heatId = parseInt(xml.match(/<HEAT[^>]*heatid="(\d+)"/i)?.[1] ?? '0')

    const results: QuantumResult['results'] = []
    const resultPattern = /<RESULT([^>]*)>([\s\S]*?)<\/RESULT>|<RESULT([^>]*)\/>/gi
    let m: RegExpExecArray | null
    while ((m = resultPattern.exec(xml)) !== null) {
      const attrs = m[1] ?? m[3] ?? ''
      const inner = m[2] ?? ''

      const lane         = parseInt(attrs.match(/lane="(\d+)"/i)?.[1] ?? '0')
      const swimtime     = attrs.match(/swimtime="([^"]+)"/i)?.[1] ?? ''
      const reactiontime = parseFloat(attrs.match(/reactiontime="([^"]+)"/i)?.[1] ?? '0')
      const status       = attrs.match(/status="([^"]*)"/i)?.[1] ?? ''

      const splits: Array<{ distance: number; swimtime: string }> = []
      const splitPat = /<SPLIT([^>]*)\/>/gi
      let sm: RegExpExecArray | null
      while ((sm = splitPat.exec(inner)) !== null) {
        const sa   = sm[1]
        const dist = parseInt(sa.match(/distance="(\d+)"/i)?.[1] ?? '0')
        const st   = sa.match(/swimtime="([^"]+)"/i)?.[1] ?? ''
        if (dist && st) splits.push({ distance: dist, swimtime: st })
      }
      results.push({ lane, swimtime, reactiontime, status, splits })
    }
    return results.length ? { heatId, results } : null
  }

  // ── File I/O ─────────────────────────────────────────────────────────────────

  private get sendFile(): string    { return join(this.folder!, 'splash_send.txt') }
  private get receiveFile(): string { return join(this.folder!, 'splash_receive.txt') }

  private write(content: string): void {
    if (!this.folder) return
    try { writeFileSync(this.sendFile, content, 'utf8') }
    catch (e) { console.error('[Quantum] write error:', e) }
  }

  private read(): string {
    if (!this.folder) return ''
    try {
      if (!existsSync(this.receiveFile)) return ''
      const content = readFileSync(this.receiveFile, 'utf8')
      if (content.trim()) {
        writeFileSync(this.receiveFile, '', 'utf8')
        return content
      }
    } catch (e) { console.error('[Quantum] read error:', e) }
    return ''
  }

  // ── Message handler ──────────────────────────────────────────────────────────

  private handle(content: string): void {
    const lines = content.split(/\r?\n/)
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue

      if (t.startsWith('VERSION;')) {
        this.webContents?.send('quantum:connected', t)
        continue
      }

      if (t.startsWith('ASK NAMES')) {
        if (t.includes(';')) {
          const eventId = t.match(/EVENTID=(\d+)/i)?.[1] ?? '0'
          const heatId  = t.match(/HEATID=(\d+)/i)?.[1]  ?? '0'
          const response = this.buildStartList(eventId, heatId)
          if (response) this.write(response)
        } else {
          const response = this.buildSchedule()
          if (response) this.write(response)
        }
        continue
      }

      if (t.startsWith('STATUS;')) {
        const eventId = t.match(/EVENTID=(\d+)/i)?.[1]
        const heatId  = t.match(/HEATID=(\d+)/i)?.[1]
        const status  = t.match(/;(READY|OFFICIAL)$/i)?.[1]?.toUpperCase()
        if (eventId && heatId && status) {
          this.webContents?.send('quantum:heat-status', { eventId, heatId, status })
        }
        continue
      }
    }

    if (content.includes('SEND RESULTS;START') && content.includes('SEND RESULTS;END')) {
      const parsed = this.parseResults(content)
      if (parsed) this.webContents?.send('quantum:result', parsed)
    }
  }

  private poll(): void {
    const content = this.read()
    if (content) this.handle(content)
  }

  private start(): void {
    this.write(VERSION_STRING)
    this.pollTimer    = setInterval(() => this.poll(), 150)
    this.heartbeatTimer = setInterval(() => this.write(VERSION_STRING), 6000)
  }

  stop(): void {
    if (this.pollTimer)     { clearInterval(this.pollTimer);     this.pollTimer     = null }
    if (this.heartbeatTimer){ clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  destroy(): void {
    this.stop()
    this.webContents = null
  }
}
