/**
 * ConnectionManager — Manages the active database backend (SQLite or PostgreSQL).
 *
 * Provides a single `getDb()` function that returns the current DbBackend.
 * The rest of db.ts calls getDb() instead of getLocalDb() directly.
 */

import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import type { DbBackend } from './dbBackend'
import { SqliteBackend } from './sqliteBackend'
import { PgBackend, type PgConnectionConfig } from './pgBackend'

// ── State ─────────────────────────────────────────────────────────────────────

let activeBackend: DbBackend | null = null
let activeConfig: PgConnectionConfig | null = null

// ── Public API ────────────────────────────────────────────────────────────────

/** Get the active database backend. Defaults to SQLite if nothing is configured. */
export function getDb(): DbBackend {
  if (!activeBackend) {
    // Default: local SQLite
    const dbPath = join(app.getPath('userData'), 'meet.db')
    const backend = new SqliteBackend(dbPath)
    activeBackend = backend
    // Run schema DDL for SQLite (lazy import to avoid circular dependency)
    const { runSchemaInit } = require('./db')
    runSchemaInit(backend)
  }
  return activeBackend
}

/** Check if currently connected to PostgreSQL */
export function isPgConnected(): boolean {
  return activeBackend?.type === 'pg'
}

/** Get current PG connection info (for display in title bar) */
export function getConnectionInfo(): { type: 'sqlite' | 'pg'; label: string } {
  if (!activeBackend || activeBackend.type === 'sqlite') {
    return { type: 'sqlite', label: 'Local (SQLite)' }
  }
  const cfg = activeConfig!
  return { type: 'pg', label: `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}` }
}

/** Connect to a PostgreSQL database. Throws on failure. */
export async function connectToPg(config: PgConnectionConfig): Promise<void> {
  // Test connection first
  const testBackend = new PgBackend(config)
  await testBackend.testConnection()

  // Success — close old backend and switch
  if (activeBackend) {
    activeBackend.close()
  }
  activeBackend = testBackend
  activeConfig = config

  // Persist the connection config
  saveConnectionConfig(config)
}

/** Disconnect from PostgreSQL and revert to local SQLite */
export function disconnectPg(): void {
  if (activeBackend?.type === 'pg') {
    activeBackend.close()
    activeBackend = null
    activeConfig = null
  }
  // Clear saved config
  clearConnectionConfig()
  // getDb() will re-create SQLite backend on next call
}

/** Try to restore a previously saved PG connection on app startup */
export async function restoreSavedConnection(): Promise<boolean> {
  const config = loadConnectionConfig()
  if (!config) return false

  try {
    await connectToPg(config)
    return true
  } catch {
    // Saved connection no longer works — fall back to SQLite silently
    clearConnectionConfig()
    return false
  }
}

/** Close the active backend (call on app quit) */
export function closeDb(): void {
  if (activeBackend) {
    activeBackend.close()
    activeBackend = null
    activeConfig = null
  }
}

// ── Config persistence ────────────────────────────────────────────────────────

const CONFIG_FILE = 'pg-connection.json'

function getConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

function saveConnectionConfig(config: PgConnectionConfig): void {
  const data = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    // Encrypt password using Electron's safeStorage
    password: safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(config.password).toString('base64')
      : config.password,
    encrypted: safeStorage.isEncryptionAvailable(),
  }
  writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function loadConnectionConfig(): PgConnectionConfig | null {
  const path = getConfigPath()
  if (!existsSync(path)) return null

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    let password = raw.password
    if (raw.encrypted && safeStorage.isEncryptionAvailable()) {
      password = safeStorage.decryptString(Buffer.from(raw.password, 'base64'))
    }
    return {
      host: raw.host,
      port: raw.port,
      database: raw.database,
      user: raw.user,
      password,
    }
  } catch {
    return null
  }
}

function clearConnectionConfig(): void {
  const path = getConfigPath()
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
