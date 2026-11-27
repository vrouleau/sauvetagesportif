// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

/**
 * Scan archive: the scanned timing sheets (images + recognised / validated times) saved to a
 * `.scans` file next to the meet's `.smb`, so a finished meet's sheets can be browsed later
 * (File menu: save / load scans).
 *
 * A `.scans` file is a plain SQLite database: a copy of the `timing_scan` table (made with
 * VACUUM INTO) plus a small `scan_archive_meta` table saying which meet it came from.
 * Loading REPLACES the current scans (scan ids are preserved).
 *
 * Pure (no electron): works on anything with better-sqlite3's exec/prepare surface, so it can
 * be unit tested.
 */

export interface SqlDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
}

export const ARCHIVE_FORMAT_VERSION = 1

export interface ArchiveMeta {
  meetName: string
  meetType: string
  /** ISO timestamp */
  savedAt: string
}

export interface ArchiveInfo extends ArchiveMeta {
  total: number
  validated: number
  /** Not validated yet (unprocessed / recognised / error) */
  pending: number
}

export class InvalidScanArchiveError extends Error {
  constructor() {
    super("Ce fichier n'est pas une sauvegarde de fiches valide.")
    this.name = 'InvalidScanArchiveError'
  }
}

/** SQL string literal for a file path (single quotes doubled). */
const sqlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * Write a consistent copy of the scan database to `filePath` (VACUUM INTO: includes anything
 * still in the WAL, and refuses to overwrite, so the caller removes an existing file first).
 */
export function copyScansTo(db: SqlDb, filePath: string): void {
  db.exec(`VACUUM INTO ${sqlQuote(filePath)}`)
}

/** Create the metadata table of a freshly written archive. */
export function writeArchiveMeta(archiveDb: SqlDb, meta: ArchiveMeta): void {
  archiveDb.exec('CREATE TABLE IF NOT EXISTS scan_archive_meta (key TEXT PRIMARY KEY, value TEXT)')
  const put = archiveDb.prepare('INSERT OR REPLACE INTO scan_archive_meta (key, value) VALUES (?, ?)')
  put.run('format', String(ARCHIVE_FORMAT_VERSION))
  put.run('meet_name', meta.meetName)
  put.run('meet_type', meta.meetType)
  put.run('saved_at', meta.savedAt)
}

/** Describe an archive; throws InvalidScanArchiveError when the file isn't one. */
export function readArchiveInfo(archiveDb: SqlDb): ArchiveInfo {
  let hasTable: unknown
  try {
    hasTable = archiveDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timing_scan'").get()
  } catch {
    throw new InvalidScanArchiveError() // not an SQLite file at all
  }
  if (!hasTable) throw new InvalidScanArchiveError()

  const meta: Record<string, string> = {}
  try {
    for (const r of archiveDb.prepare('SELECT key, value FROM scan_archive_meta').all() as Array<{ key: string; value: string | null }>) {
      meta[r.key] = r.value ?? ''
    }
  } catch { /* archive without metadata (a raw copy of timing_scans.sqlite): still loadable */ }

  const rows = archiveDb.prepare('SELECT status, COUNT(*) AS n FROM timing_scan GROUP BY status').all() as Array<{ status: string; n: number }>
  let total = 0
  let validated = 0
  for (const r of rows) {
    total += Number(r.n)
    if (r.status === 'validated') validated += Number(r.n)
  }
  return {
    meetName: meta.meet_name ?? '',
    meetType: meta.meet_type ?? '',
    savedAt: meta.saved_at ?? '',
    total,
    validated,
    pending: total - validated,
  }
}

/**
 * Replace the content of `db`'s timing_scan table with the archive's. Columns are matched by
 * name, so an archive from an older/newer schema loads what both sides have. All or nothing.
 * Returns how many scans are in the table afterwards.
 */
export function replaceScansFromArchive(db: SqlDb, archivePath: string): number {
  db.exec(`ATTACH DATABASE ${sqlQuote(archivePath)} AS scan_archive`)
  try {
    const names = (schema: string) =>
      (db.prepare(`PRAGMA ${schema}.table_info(timing_scan)`).all() as Array<{ name: string }>).map((c) => c.name)
    const archiveCols = new Set(names('scan_archive'))
    const common = names('main').filter((c) => archiveCols.has(c))
    for (const required of ['scan_id', 'barcode_raw', 'image_blob']) {
      if (!common.includes(required)) throw new InvalidScanArchiveError()
    }
    const list = common.map((c) => `"${c}"`).join(', ')

    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM timing_scan')
      db.exec(`INSERT INTO timing_scan (${list}) SELECT ${list} FROM scan_archive.timing_scan`)
      const n = Number((db.prepare('SELECT COUNT(*) AS n FROM timing_scan').get() as { n: number }).n)
      db.exec('COMMIT')
      return n
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.exec('DETACH DATABASE scan_archive')
  }
}

/** Default file name: `fiches-<meet name>-<yyyy-mm-dd>.scans`, safe on every OS. */
export function archiveFileName(meetName: string, now: Date = new Date()): string {
  const safe = meetName
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  const day = now.toISOString().slice(0, 10)
  return `fiches-${safe ? safe + '-' : ''}${day}.scans`
}
