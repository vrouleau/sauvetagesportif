/**
 * Point Scores Definition Generator
 *
 * Auto-generates the POINTSCORES XML stored in BSGLOBAL.
 * This XML defines point scoring scales (points per placement) and assigns
 * them to age group categories for Canadian lifesaving competitions.
 *
 * Definitions are loaded from an external JSON config file bundled with the app,
 * editable at runtime on the installation path.
 */

import { app } from 'electron'
import { existsSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface PointScoreDefinition {
  pointscoreid: number
  name: string
  points: number[]
}

export interface PointScoreAssignment {
  ageMin: number
  ageMax: number // -1 = no upper limit
  gender: number // 0=mixed, 1=male, 2=female
  pointscoreid: number
}

export interface PointScoresConfig {
  description?: string
  definitions: PointScoreDefinition[]
  assignments: PointScoreAssignment[]
}

// ── Config Loading ────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'point-scores-config.json'

export function loadPointScoresConfig(): PointScoresConfig {
  const userDataPath = app.getPath('userData')
  const userConfigPath = join(userDataPath, CONFIG_FILENAME)

  // Bundled default: in resources/ directory (packaged) or shared config (dev)
  const bundledConfigPath = app.isPackaged
    ? join(process.resourcesPath, CONFIG_FILENAME)
    : join(__dirname, '../../../../config', CONFIG_FILENAME)

  // Copy bundled default to user data on first run (or if user deleted it)
  if (!existsSync(userConfigPath) && existsSync(bundledConfigPath)) {
    copyFileSync(bundledConfigPath, userConfigPath)
  }

  // Read from user data (allows runtime modifications)
  const configPath = existsSync(userConfigPath) ? userConfigPath : bundledConfigPath

  if (!existsSync(configPath)) {
    throw new Error(
      `Point scores config not found. Expected at:\n` +
        `  User: ${userConfigPath}\n` +
        `  Bundled: ${bundledConfigPath}`
    )
  }

  const raw = readFileSync(configPath, 'utf-8')
  try {
    return JSON.parse(raw) as PointScoresConfig
  } catch (e) {
    throw new Error(
      `Failed to parse point scores config at ${configPath}: ${(e as Error).message}`
    )
  }
}

// ── XML Serialization ─────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildPointScoresXml(definitions: PointScoreDefinition[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-16"?>')
  lines.push('<POINTSCOREDEFINITION>')
  lines.push('  <POINTSCORES>')

  for (const def of definitions) {
    const pointsStr = def.points.join(',')
    lines.push(
      `    <POINTSCORE pointscoreid="${def.pointscoreid}" ` +
      `name="${escapeXml(def.name)}" ` +
      `points="${pointsStr}" />`
    )
  }

  lines.push('  </POINTSCORES>')
  lines.push('</POINTSCOREDEFINITION>')
  return lines.join('\r\n')
}

// ── Age Group Assignment ──────────────────────────────────────────────────────

/**
 * Apply scoretype to age groups based on the assignment config.
 * Matches age groups by agemin/agemax/gender and sets their scoretype
 * to the corresponding pointscoreid.
 */
export function applyPointScoreAssignments(
  db: Database.Database,
  assignments: PointScoreAssignment[]
): void {
  const stmt = db.prepare(
    `UPDATE agegroup SET scoretype = ?
     WHERE agemin = ? AND agemax = ? AND gender = ?`
  )

  for (const a of assignments) {
    const ageMax = a.ageMax === -1 ? 99 : a.ageMax
    stmt.run(a.pointscoreid, a.ageMin, ageMax, a.gender)
    // Also handle -1 stored as -1 in the DB
    if (a.ageMax === -1) {
      stmt.run(a.pointscoreid, a.ageMin, -1, a.gender)
    }
  }
}

// ── Main Orchestrator ─────────────────────────────────────────────────────────

/**
 * Regenerate the POINTSCORES XML and write it to BSGLOBAL.
 * Also applies scoretype assignments to matching age groups.
 *
 * Call this when creating a meet from scratch or after age group mutations.
 */
export function regeneratePointScores(db: Database.Database): void {
  // Step 1: Load config from external JSON file
  const config = loadPointScoresConfig()

  // Step 2: Build XML from definitions
  const xml = buildPointScoresXml(config.definitions)

  // Step 3: Upsert into BSGLOBAL
  db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES ('POINTSCORES', ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data`
  ).run(xml)

  // Step 4: Apply scoretype assignments to age groups
  applyPointScoreAssignments(db, config.assignments)
}
