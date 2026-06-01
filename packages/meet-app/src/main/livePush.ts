/**
 * LivePushModule — Pushes swim results to team-app in real time.
 *
 * Observes swimresult writes (from Quantum, manual entry, or Gemini OCR)
 * and POSTs them to the team-app live results endpoint.
 *
 * Features:
 * - Debounce: batches results arriving within 500ms into a single POST
 * - Persistent queue: stores payloads on disk when team-app is unreachable
 * - Retry: attempts to flush the queue every 10s
 * - Status: exposes connection state for the UI (connected/disconnected/queued)
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { DbBackend } from './dbBackend'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveResultPayload {
  event_id: number
  heat_number: number
  lane: number
  athlete_id: number | null
  athlete_name: string
  club_name: string
  swimtime_ms: number | null
  reaction_time_ms: number | null
  status: string
  dsq_reason?: string
  splits?: Array<{ distance: number; swimtime_ms: number }>
}

export interface LiveStatusPayload {
  event_id: number
  heat_number: number
  official: boolean
}

export interface LiveAnnouncementPayload {
  type: 'call_to_marshall' | 'call_to_scratch'
  event_id: number
  event_number: number
  event_name: string
  gender: string
}

export type PushStatus = 'connected' | 'disconnected' | 'queued'

type StatusListener = (status: PushStatus, queueSize: number) => void

// ── LivePushModule ────────────────────────────────────────────────────────────

export class LivePushModule {
  private url: string = ''
  private secret: string = ''
  private enabled: boolean = false

  private debounceBuffer: LiveResultPayload[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly DEBOUNCE_MS = 500

  private queue: Array<{ type: string; payload: unknown; timestamp: string }> = []
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private readonly RETRY_INTERVAL_MS = 10_000
  private readonly MAX_QUEUE_SIZE = 1000

  private _status: PushStatus = 'disconnected'
  private _listeners: StatusListener[] = []

  private get queuePath(): string {
    return join(app.getPath('userData'), 'live_push_queue.json')
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  /**
   * Read config from bsglobal and start the module if configured.
   * Call this on app startup and after SMB/LXF import.
   */
  initialize(db: DbBackend): void {
    const getVal = (key: string): string => {
      const row = db.prepare(`SELECT data FROM bsglobal WHERE name = ?`).get(key) as { data: string } | undefined
      return row?.data ?? ''
    }

    this.url = getVal('LIVE_URL')
    this.secret = getVal('LIVE_PUSH_SECRET')
    const enabledFlag = getVal('LIVE_ENABLED')

    // Auto-enable if both URL and secret are present
    if (this.url && this.secret) {
      this.enabled = enabledFlag !== 'F'  // default to enabled if not explicitly disabled
      if (!enabledFlag || enabledFlag === '') {
        // Write LIVE_ENABLED=T to bsglobal
        db.prepare(`INSERT OR REPLACE INTO bsglobal (name, data) VALUES (?, ?)`).run('LIVE_ENABLED', 'T')
      }
    } else {
      this.enabled = false
    }

    // Load persisted queue
    this.loadQueue()

    // Start retry loop if queue has items
    if (this.queue.length > 0) {
      this.startRetryLoop()
      this.setStatus('queued')
    } else if (this.enabled) {
      this.setStatus('disconnected')  // will become 'connected' on first successful push
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called after a swimresult write (any source: Quantum, manual, Gemini OCR).
   * Adds the result to the debounce buffer.
   */
  notifyResultWrite(result: LiveResultPayload): void {
    if (!this.enabled) return

    this.debounceBuffer.push(result)

    // Reset debounce timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flushDebounce(), this.DEBOUNCE_MS)
  }

  /**
   * Called when a heat's official status changes.
   */
  notifyHeatStatus(payload: LiveStatusPayload): void {
    if (!this.enabled) return
    this.enqueue('status', payload)
    this.attemptFlush()
  }

  /**
   * Send a meet announcement (call to marshall, call to scratch).
   */
  notifyAnnouncement(payload: LiveAnnouncementPayload): void {
    if (!this.enabled) return
    this.enqueue('announcement', payload)
    this.attemptFlush()
  }

  /**
   * Push event metadata after heat generation.
   */
  notifyEvents(payload: { events: unknown[] }): void {
    if (!this.enabled) return
    this.enqueue('events', payload)
    this.attemptFlush()
  }

  /**
   * Push start list entries after heat generation.
   */
  notifyStartlist(payload: { entries: unknown[] }): void {
    if (!this.enabled) return
    this.enqueue('startlist', payload)
    this.attemptFlush()
  }

  /**
   * Push all existing results (catch-up after reconnection).
   */
  pushAll(db: DbBackend): void {
    if (!this.enabled) return

    const rows = db.prepare(`
      SELECT sr.swimresultid, sr.swimeventid, sr.lane, sr.swimtime, sr.reactiontime,
             sr.resultstatus, sr.athleteid,
             a.lastname, a.firstname, c.name AS clubname,
             h.heatnumber
      FROM swimresult sr
      LEFT JOIN athlete a ON sr.athleteid = a.athleteid
      LEFT JOIN club c ON a.clubid = c.clubid
      LEFT JOIN heat h ON sr.heatid = h.heatid
      WHERE sr.swimtime IS NOT NULL AND sr.swimtime > 0
    `).all() as Array<{
      swimresultid: number; swimeventid: number; lane: number; swimtime: number
      reactiontime: number | null; resultstatus: number | null
      athleteid: number | null; lastname: string; firstname: string
      clubname: string; heatnumber: number
    }>

    const results: LiveResultPayload[] = rows.map(r => ({
      event_id: r.swimeventid,
      heat_number: r.heatnumber,
      lane: r.lane,
      athlete_id: r.athleteid,
      athlete_name: `${r.lastname}, ${r.firstname}`,
      club_name: r.clubname || '',
      swimtime_ms: r.swimtime,
      reaction_time_ms: r.reactiontime,
      status: this.decodeStatus(r.resultstatus),
    }))

    if (results.length > 0) {
      this.enqueue('results', { results })
      this.attemptFlush()
    }
  }

  /**
   * Get current connection status.
   */
  getStatus(): PushStatus {
    return this._status
  }

  /**
   * Get queue size.
   */
  getQueueSize(): number {
    return this.queue.length
  }

  /**
   * Register a status change listener.
   */
  onStatusChange(listener: StatusListener): () => void {
    this._listeners.push(listener)
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener)
    }
  }

  /**
   * Reload config (call after settings change or SMB/LXF import).
   */
  reload(db: DbBackend): void {
    this.initialize(db)
  }

  /**
   * Stop the module (call on app quit).
   */
  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.saveQueue()
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private flushDebounce(): void {
    if (this.debounceBuffer.length === 0) return

    const batch = [...this.debounceBuffer]
    this.debounceBuffer = []
    this.debounceTimer = null

    this.enqueue('results', { results: batch })
    this.attemptFlush()
  }

  private enqueue(type: string, payload: unknown): void {
    this.queue.push({
      type,
      payload,
      timestamp: new Date().toISOString(),
    })

    // Enforce max queue size
    while (this.queue.length > this.MAX_QUEUE_SIZE) {
      this.queue.shift()
      console.warn('[LivePush] Queue overflow — dropping oldest item')
    }

    this.saveQueue()
  }

  private async attemptFlush(): Promise<void> {
    if (this.queue.length === 0) return
    if (!this.url || !this.secret) return

    const toSend = [...this.queue]
    let allSuccess = true

    for (const item of toSend) {
      const endpoint = this.getEndpoint(item.type)
      if (!endpoint) {
        // Unknown type — discard
        this.queue.shift()
        continue
      }

      try {
        const response = await fetch(`${this.url}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Live-Secret': this.secret,
          },
          body: JSON.stringify(item.payload),
          signal: AbortSignal.timeout(10_000),
        })

        if (response.ok) {
          // Remove from queue
          const idx = this.queue.indexOf(item)
          if (idx >= 0) this.queue.splice(idx, 1)
          this.setStatus('connected')
        } else if (response.status === 401) {
          // Invalid secret — stop trying
          console.error('[LivePush] Invalid secret (401) — disabling push')
          this.enabled = false
          this.setStatus('disconnected')
          return
        } else if (response.status === 409) {
          // Live mode not active on server — stop trying
          console.warn('[LivePush] Live mode not active on server (409)')
          this.setStatus('disconnected')
          allSuccess = false
          break
        } else {
          // Server error — keep in queue, retry later
          console.warn(`[LivePush] Server returned ${response.status}`)
          allSuccess = false
          break
        }
      } catch (e) {
        // Network error — keep in queue
        console.warn('[LivePush] Network error:', (e as Error).message)
        allSuccess = false
        this.setStatus(this.queue.length > 0 ? 'queued' : 'disconnected')
        break
      }
    }

    this.saveQueue()

    if (this.queue.length > 0 && !allSuccess) {
      this.startRetryLoop()
      this.setStatus('queued')
    } else if (this.queue.length === 0) {
      this.stopRetryLoop()
    }
  }

  private getEndpoint(type: string): string | null {
    switch (type) {
      case 'results': return '/api/live/push-results'
      case 'status': return '/api/live/push-status'
      case 'events': return '/api/live/push-events'
      case 'startlist': return '/api/live/push-startlist'
      case 'announcement': return '/api/live/push-announcement'
      default: return null
    }
  }

  private startRetryLoop(): void {
    if (this.retryTimer) return
    this.retryTimer = setInterval(() => this.attemptFlush(), this.RETRY_INTERVAL_MS)
  }

  private stopRetryLoop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
      this.retryTimer = null
    }
  }

  private setStatus(status: PushStatus): void {
    if (this._status !== status) {
      this._status = status
      for (const listener of this._listeners) {
        try { listener(status, this.queue.length) } catch { /* ignore */ }
      }
    }
  }

  private loadQueue(): void {
    try {
      if (existsSync(this.queuePath)) {
        const data = readFileSync(this.queuePath, 'utf8')
        this.queue = JSON.parse(data)
      }
    } catch {
      this.queue = []
    }
  }

  private saveQueue(): void {
    try {
      writeFileSync(this.queuePath, JSON.stringify(this.queue), 'utf8')
    } catch (e) {
      console.error('[LivePush] Failed to save queue:', e)
    }
  }

  private decodeStatus(resultstatus: number | null): string {
    switch (resultstatus) {
      case 1: return 'DNS'
      case 2: return 'DNF'
      case 3: return 'DSQ'
      default: return ''
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const livePush = new LivePushModule()
