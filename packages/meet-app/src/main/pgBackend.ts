/**
 * PgBackend — Synchronous PostgreSQL queries via Worker thread.
 *
 * Pattern: Main thread blocks on Atomics.wait(SharedArrayBuffer) while
 * the Worker executes the async PG query. Result is transferred back
 * via a MessagePort + receiveMessageOnPort (synchronous read).
 *
 * This is the standard Node.js pattern for sync-over-async without deadlocks.
 */

import { Worker, MessageChannel, receiveMessageOnPort } from 'worker_threads'
import { join } from 'path'
import type { DbBackend, PreparedStatement } from './dbBackend'

/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...` style.
 */
function rewritePlaceholders(sql: string): string {
  let idx = 0
  return sql.replace(/\?/g, () => `$${++idx}`)
}

/**
 * Normalize PG result rows: Date → string, bigint → number.
 */
function normalizeRow(row: Record<string, any>): Record<string, any> {
  if (!row) return row
  const out: Record<string, any> = {}
  for (const [key, val] of Object.entries(row)) {
    if (val instanceof Date) {
      out[key] = val.toISOString().replace('T', ' ').replace('Z', '')
    } else if (typeof val === 'bigint') {
      out[key] = Number(val)
    } else {
      out[key] = val
    }
  }
  return out
}

export interface PgConnectionConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

let queryIdCounter = 0

export class PgBackend implements DbBackend {
  readonly type = 'pg' as const
  private worker: Worker
  private config: PgConnectionConfig
  private _closed = false

  constructor(config: PgConnectionConfig) {
    this.config = config
    const workerPath = join(__dirname, 'pgWorker.js')
    this.worker = new Worker(workerPath, {
      workerData: { config },
    })
    this.worker.unref()
  }

  prepare(sql: string): PreparedStatement {
    const pgSql = rewritePlaceholders(sql)
    return new PgStatement(this, pgSql)
  }

  exec(sql: string): void {
    this.querySync(sql)
  }

  /**
   * Match better-sqlite3's transaction API.
   * Returns a wrapped function that executes fn inside BEGIN/COMMIT.
   */
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this.querySync('BEGIN')
      try {
        const result = fn(...args)
        this.querySync('COMMIT')
        return result
      } catch (e) {
        this.querySync('ROLLBACK')
        throw e
      }
    }
  }

  close(): void {
    if (!this._closed) {
      this._closed = true
      this.worker.postMessage({ type: 'close' })
      setTimeout(() => this.worker.terminate(), 1000)
    }
  }

  /** Test the connection — async, used only during connect flow */
  async testConnection(): Promise<void> {
    const { Pool } = require('pg')
    const pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: 1,
      connectionTimeoutMillis: 5000,
    })
    try {
      const client = await pool.connect()
      await client.query('SELECT 1')
      client.release()
    } finally {
      await pool.end()
    }
  }

  /**
   * Execute a query synchronously by blocking on SharedArrayBuffer.
   * The Worker runs the async PG query and posts the result on a MessagePort.
   */
  querySync(sql: string, params?: any[]): { rows: any[]; rowCount: number } {
    const id = ++queryIdCounter

    // Create a dedicated channel for this query's response
    const { port1: workerPort, port2: mainPort } = new MessageChannel()

    // SharedArrayBuffer for signaling completion
    const signal = new SharedArrayBuffer(4)
    const int32 = new Int32Array(signal)
    Atomics.store(int32, 0, 0)

    // Send query + response port to worker
    this.worker.postMessage(
      { type: 'query', id, sql, params: params || [], signal, port: workerPort },
      [workerPort]
    )

    // Block until worker signals done (30s timeout)
    const waitResult = Atomics.wait(int32, 0, 0, 30000)
    if (waitResult === 'timed-out') {
      throw new Error(`PG query timed out (30s): ${sql.substring(0, 80)}`)
    }

    // Read result synchronously from the port
    const msg = receiveMessageOnPort(mainPort)
    mainPort.close()

    if (!msg) {
      throw new Error(`No response from PG worker for query: ${sql.substring(0, 80)}`)
    }

    const data = msg.message
    if (data.error) {
      throw new Error(`PG: ${data.error}`)
    }

    return { rows: data.rows || [], rowCount: data.rowCount ?? 0 }
  }
}

class PgStatement implements PreparedStatement {
  constructor(private backend: PgBackend, private sql: string) {}

  get(...params: any[]): any {
    const result = this.backend.querySync(this.sql, params)
    return result.rows[0] ? normalizeRow(result.rows[0]) : undefined
  }

  all(...params: any[]): any[] {
    const result = this.backend.querySync(this.sql, params)
    return result.rows.map(normalizeRow)
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.backend.querySync(this.sql, params)
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: 0,
    }
  }
}
