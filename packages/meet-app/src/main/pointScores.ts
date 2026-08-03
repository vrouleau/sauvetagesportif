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
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
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

export interface SplashAgeGroupRange {
  from: number // -1 = no lower limit
  to: number // -1 = no upper limit
}

export interface SplashPlacePoint {
  position: number
  individual: number
  relay: number
}

export interface SplashPointScoreConfig {
  pointscoreid: number
  name: string
  titleforprints?: string
  attributes: Record<string, string>
  ageGroups: SplashAgeGroupRange[]
  placePoints: SplashPlacePoint[]
}

export interface PointScoresConfig {
  description?: string
  splashPointScore: SplashPointScoreConfig
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
  let config: PointScoresConfig
  try {
    config = JSON.parse(raw) as PointScoresConfig
  } catch (e) {
    throw new Error(
      `Failed to parse point scores config at ${configPath}: ${(e as Error).message}`
    )
  }

  // Self-heal: an existing userData copy predating `splashPointScore` (added when the
  // BSGLOBAL export was fixed to use Splash's real POINTSCORE schema/key instead of an
  // invented one) would otherwise crash every regeneratePointScores() call forever, since
  // the copy-bundled-default-on-first-run logic above only fires when the file is fully
  // absent. Patch in just the missing piece from the bundled default and persist it, leaving
  // any user customization to `definitions`/`assignments` untouched.
  if (!config.splashPointScore && existsSync(bundledConfigPath)) {
    const bundled = JSON.parse(readFileSync(bundledConfigPath, 'utf-8')) as PointScoresConfig
    config = { ...config, splashPointScore: bundled.splashPointScore }
    if (configPath === userConfigPath) {
      writeFileSync(userConfigPath, JSON.stringify(config, null, 2), 'utf-8')
    }
  }

  return config
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

/**
 * Build the BSGLOBAL POINTSCORE XML (singular key — Splash's real, native points-standings
 * config). Verified against 4 real Splash-native .mdb files: the wrapping element structure,
 * <POINTSCORE> attribute set, and nested <AGEGROUPS>/<PLACEPOINTS> shape below all match what
 * those files actually contain. Splash supports exactly one active config per meet, not a
 * catalog of named scales — unlike the legacy `definitions`/`assignments` config below.
 */
export function buildSplashPointScoreXml(cfg: SplashPointScoreConfig): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-16"?>')
  lines.push('<POINTSCOREDEFINITION>')
  lines.push('  <POINTSCORES>')

  const attrParts = [
    `pointscoreid="${cfg.pointscoreid}"`,
    `name="${escapeXml(cfg.name)}"`,
  ]
  if (cfg.titleforprints) attrParts.push(`titleforprints="${escapeXml(cfg.titleforprints)}"`)
  for (const [key, value] of Object.entries(cfg.attributes)) {
    attrParts.push(`${key}="${escapeXml(value)}"`)
  }
  lines.push(`    <POINTSCORE ${attrParts.join(' ')}>`)

  lines.push('      <AGEGROUPS>')
  for (const ag of cfg.ageGroups) {
    lines.push(`        <AGEGROUP from="${ag.from}" to="${ag.to}" />`)
  }
  lines.push('      </AGEGROUPS>')

  lines.push('      <PLACEPOINTS>')
  for (const pp of cfg.placePoints) {
    lines.push(`        <PLACEPOINT position="${pp.position}" individual="${pp.individual}" relay="${pp.relay}" />`)
  }
  lines.push('      </PLACEPOINTS>')

  lines.push('    </POINTSCORE>')
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
 * Regenerate the POINTSCORE XML and write it to BSGLOBAL.
 * Also applies scoretype assignments to matching age groups.
 *
 * Call this when creating a meet from scratch or after age group mutations.
 */
export function regeneratePointScores(db: Database.Database): void {
  // Step 1: Load config from external JSON file
  const config = loadPointScoresConfig()

  // Step 2: Build the Splash-native XML from splashPointScore
  const xml = buildSplashPointScoreXml(config.splashPointScore)

  // Step 3: Upsert into BSGLOBAL under the real Splash key name (singular). Also drop any
  // stale 'POINTSCORES' (plural) row from an earlier version of this app — that key was never
  // real Splash schema, so restoring it into a live-shared Postgres database left Splash's own
  // points-standings report with no config to find.
  db.prepare(`DELETE FROM bsglobal WHERE name = 'POINTSCORES'`).run()
  db.prepare(
    `INSERT INTO bsglobal (name, data) VALUES ('POINTSCORE', ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data`
  ).run(xml)

  // Step 4: Apply scoretype assignments to age groups
  applyPointScoreAssignments(db, config.assignments)
}