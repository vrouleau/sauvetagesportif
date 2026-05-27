/**
 * pgWorker.js — Worker thread that executes PostgreSQL queries.
 *
 * Protocol:
 * - Main thread posts: { type: 'query', id, sql, params, signal: SharedArrayBuffer, port: MessagePort }
 * - Worker executes query via pg Pool
 * - Worker posts result on the transferred MessagePort
 * - Worker signals completion via Atomics.notify on the SharedArrayBuffer
 * - Main thread unblocks (Atomics.wait returns) and reads from the port
 */
const { parentPort, workerData } = require('worker_threads')
const { Pool, types } = require('pg')

// ── Disable automatic Date parsing for timestamp columns ──────────────────────
// PG type OIDs: 1114 = timestamp without time zone, 1184 = timestamp with time zone
// Return raw strings so formatDaytime() in db.ts can parse them correctly
// without timezone conversion issues.
types.setTypeParser(1114, (val) => val) // timestamp → raw string
types.setTypeParser(1184, (val) => val) // timestamptz → raw string

let pool = null

function getPool(config) {
  if (!pool && config) {
    pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  }
  return pool
}

// Initialize pool from workerData
if (workerData && workerData.config) {
  getPool(workerData.config)
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'close') {
    if (pool) {
      await pool.end()
      pool = null
    }
    return
  }

  if (msg.type === 'query') {
    const { sql, params, signal, port } = msg
    const int32 = new Int32Array(signal)

    let response
    try {
      const p = getPool()
      if (!p) throw new Error('PG pool not initialized')
      const result = await p.query(sql, params || [])
      response = { rows: result.rows, rowCount: result.rowCount }
    } catch (e) {
      response = { error: e.message || String(e) }
    }

    // Post result on the transferred port BEFORE signaling
    // (so it's available when main thread reads after Atomics.wait returns)
    port.postMessage(response)
    port.close()

    // Signal main thread that result is ready
    Atomics.store(int32, 0, 1)
    Atomics.notify(int32, 0)
  }
})
