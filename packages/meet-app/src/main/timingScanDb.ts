/**
 * Local SQLite database for storing scanned timing sheet images and their
 * processing status. This is separate from the meet PostgreSQL database —
 * scans are local to the scanning machine.
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

let scanDb: Database.Database | null = null

/** Status of a timing scan record */
export type ScanStatus = 'unprocessed' | 'recognized' | 'validated' | 'error'

/** A timing scan record */
export interface TimingScan {
  scanId: number
  eventNumber: number
  heatNumber: number
  lane: number
  barcodeRaw: string
  imageBlob: Buffer
  scannedAt: string
  status: ScanStatus
  recognizedTime1: string | null  // Chrono 1
  recognizedTime2: string | null  // Chrono 2
  validatedTime1: string | null
  validatedTime2: string | null
  timeMs1: number | null          // Chrono 1 in ms
  timeMs2: number | null          // Chrono 2 in ms
  ocrEngine: string | null
  ocrConfidence: number | null
  processedAt: string | null
  validatedAt: string | null
  notes: string | null
}

/** Data needed to insert a new scan */
export type NewScan = Pick<TimingScan, 'eventNumber' | 'heatNumber' | 'lane' | 'barcodeRaw' | 'imageBlob' | 'scannedAt'>

// ── Database initialization ───────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS timing_scan (
  scan_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_number    INTEGER NOT NULL,
  heat_number     INTEGER NOT NULL,
  lane            INTEGER NOT NULL,
  barcode_raw     TEXT NOT NULL,
  image_blob      BLOB NOT NULL,
  scanned_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unprocessed',
  recognized_time1 TEXT,
  recognized_time2 TEXT,
  validated_time1  TEXT,
  validated_time2  TEXT,
  time_ms1        INTEGER,
  time_ms2        INTEGER,
  ocr_engine      TEXT,
  ocr_confidence  REAL,
  processed_at    TEXT,
  validated_at    TEXT,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS ix_timing_scan_status
  ON timing_scan (status);

CREATE INDEX IF NOT EXISTS ix_timing_scan_event_heat
  ON timing_scan (event_number, heat_number, lane);
`

/**
 * Get or create the scan database instance.
 * The database file is stored in the app's userData directory.
 */
export function getScanDb(): Database.Database {
  if (scanDb) return scanDb

  const dbPath = join(app.getPath('userData'), 'timing_scans.sqlite')
  scanDb = new Database(dbPath)
  scanDb.pragma('journal_mode = WAL')

  // Check if the table exists with the old schema (has judge_number column)
  // If so, drop it and recreate with the new schema
  const tableInfo = scanDb.prepare("PRAGMA table_info(timing_scan)").all() as Array<{ name: string }>
  const hasJudgeNumber = tableInfo.some((col) => col.name === 'judge_number')
  if (hasJudgeNumber) {
    scanDb.exec('DROP TABLE IF EXISTS timing_scan')
  }

  scanDb.exec(SCHEMA_SQL)
  return scanDb
}

/** Close the scan database (call on app quit) */
export function closeScanDb(): void {
  if (scanDb) {
    scanDb.close()
    scanDb = null
  }
}

// ── CRUD operations ───────────────────────────────────────────────────────────

/** Insert a new scan record. Returns the new scan_id. */
export function insertScan(scan: NewScan): number {
  const db = getScanDb()
  const stmt = db.prepare(`
    INSERT INTO timing_scan (event_number, heat_number, lane, barcode_raw, image_blob, scanned_at)
    VALUES (@eventNumber, @heatNumber, @lane, @barcodeRaw, @imageBlob, @scannedAt)
  `)
  const result = stmt.run({
    eventNumber: scan.eventNumber,
    heatNumber: scan.heatNumber,
    lane: scan.lane,
    barcodeRaw: scan.barcodeRaw,
    imageBlob: scan.imageBlob,
    scannedAt: scan.scannedAt,
  })
  return result.lastInsertRowid as number
}

/** Get all scans with a given status */
export function getScansByStatus(status: ScanStatus): TimingScan[] {
  const db = getScanDb()
  const rows = db.prepare(`
    SELECT * FROM timing_scan WHERE status = ? ORDER BY scanned_at DESC
  `).all(status) as RawScanRow[]
  return rows.map(mapRow)
}

/** Get all unprocessed scans */
export function getUnprocessedScans(): TimingScan[] {
  return getScansByStatus('unprocessed')
}

/** Get scans for a specific event/heat */
export function getScansForHeat(eventNumber: number, heatNumber: number): TimingScan[] {
  const db = getScanDb()
  const rows = db.prepare(`
    SELECT * FROM timing_scan
    WHERE event_number = ? AND heat_number = ?
    ORDER BY lane
  `).all(eventNumber, heatNumber) as RawScanRow[]
  return rows.map(mapRow)
}

/** Get a single scan by ID */
export function getScanById(scanId: number): TimingScan | null {
  const db = getScanDb()
  const row = db.prepare(`SELECT * FROM timing_scan WHERE scan_id = ?`).get(scanId) as RawScanRow | undefined
  return row ? mapRow(row) : null
}

/** Check if a scan already exists for this barcode (duplicate detection) */
export function findExistingScan(barcodeRaw: string): TimingScan | null {
  const db = getScanDb()
  const row = db.prepare(`
    SELECT * FROM timing_scan WHERE barcode_raw = ? ORDER BY scanned_at DESC LIMIT 1
  `).get(barcodeRaw) as RawScanRow | undefined
  return row ? mapRow(row) : null
}

/** Update a scan with OCR recognition results (both chrono times) */
export function updateScanOcrResult(scanId: number, result: {
  recognizedTime1: string
  recognizedTime2: string
  ocrEngine: string
  ocrConfidence: number
}): void {
  const db = getScanDb()
  db.prepare(`
    UPDATE timing_scan
    SET recognized_time1 = ?, recognized_time2 = ?, ocr_engine = ?, ocr_confidence = ?,
        status = 'recognized', processed_at = ?
    WHERE scan_id = ?
  `).run(result.recognizedTime1, result.recognizedTime2, result.ocrEngine, result.ocrConfidence, new Date().toISOString(), scanId)
}

/** Validate a scan (operator confirmed both times) */
export function validateScan(scanId: number, validatedTime1: string, timeMs1: number, validatedTime2: string, timeMs2: number): void {
  const db = getScanDb()
  db.prepare(`
    UPDATE timing_scan
    SET validated_time1 = ?, time_ms1 = ?, validated_time2 = ?, time_ms2 = ?,
        status = 'validated', validated_at = ?
    WHERE scan_id = ?
  `).run(validatedTime1, timeMs1, validatedTime2, timeMs2, new Date().toISOString(), scanId)
}

/** Mark a scan as having an error */
export function markScanError(scanId: number, notes: string): void {
  const db = getScanDb()
  db.prepare(`
    UPDATE timing_scan
    SET status = 'error', notes = ?
    WHERE scan_id = ?
  `).run(notes, scanId)
}

/** Delete a scan (e.g. rescan replaces it) */
export function deleteScan(scanId: number): void {
  const db = getScanDb()
  db.prepare(`DELETE FROM timing_scan WHERE scan_id = ?`).run(scanId)
}

/** Delete ALL scans (reset the database) */
export function clearAllScans(): number {
  const db = getScanDb()
  const result = db.prepare(`DELETE FROM timing_scan`).run()
  return result.changes
}

/** Get summary counts by status */
export function getScanSummary(): Record<ScanStatus, number> {
  const db = getScanDb()
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM timing_scan GROUP BY status
  `).all() as Array<{ status: string; count: number }>

  const summary: Record<ScanStatus, number> = {
    unprocessed: 0,
    recognized: 0,
    validated: 0,
    error: 0,
  }
  for (const row of rows) {
    if (row.status in summary) {
      summary[row.status as ScanStatus] = row.count
    }
  }
  return summary
}

/** Get all validated scans for a heat */
export function getValidatedScansForHeat(eventNumber: number, heatNumber: number): TimingScan[] {
  const db = getScanDb()
  const rows = db.prepare(`
    SELECT * FROM timing_scan
    WHERE event_number = ? AND heat_number = ? AND status = 'validated'
    ORDER BY lane
  `).all(eventNumber, heatNumber) as RawScanRow[]
  return rows.map(mapRow)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface RawScanRow {
  scan_id: number
  event_number: number
  heat_number: number
  lane: number
  barcode_raw: string
  image_blob: Buffer
  scanned_at: string
  status: string
  recognized_time1: string | null
  recognized_time2: string | null
  validated_time1: string | null
  validated_time2: string | null
  time_ms1: number | null
  time_ms2: number | null
  ocr_engine: string | null
  ocr_confidence: number | null
  processed_at: string | null
  validated_at: string | null
  notes: string | null
}

function mapRow(row: RawScanRow): TimingScan {
  return {
    scanId: row.scan_id,
    eventNumber: row.event_number,
    heatNumber: row.heat_number,
    lane: row.lane,
    barcodeRaw: row.barcode_raw,
    imageBlob: row.image_blob,
    scannedAt: row.scanned_at,
    status: row.status as ScanStatus,
    recognizedTime1: row.recognized_time1,
    recognizedTime2: row.recognized_time2,
    validatedTime1: row.validated_time1,
    validatedTime2: row.validated_time2,
    timeMs1: row.time_ms1,
    timeMs2: row.time_ms2,
    ocrEngine: row.ocr_engine,
    ocrConfidence: row.ocr_confidence,
    processedAt: row.processed_at,
    validatedAt: row.validated_at,
    notes: row.notes,
  }
}
