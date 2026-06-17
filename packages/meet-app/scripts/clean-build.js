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
 * Clean build: wipe the out/ directory, rebuild native modules for Electron,
 * then run the full Vite build.
 *
 * Usage: npm run clean
 */
const { execSync } = require('child_process')
const { rmSync, existsSync } = require('fs')
const { join } = require('path')
const { platform } = require('os')

const root = join(__dirname, '..')
const outDir = join(root, 'out')

// 1. Remove out/
if (existsSync(outDir)) {
  console.log('🧹 Removing out/ ...')
  rmSync(outDir, { recursive: true, force: true })
}

// 2. Remove timing scans SQLite database (userData)
const appDataPath = process.env.APPDATA || join(require('os').homedir(), 'AppData', 'Roaming')
const scanDbPath = join(appDataPath, '@meetmgr', 'meet-app', 'timing_scans.sqlite')
if (existsSync(scanDbPath)) {
  console.log('🧹 Removing timing_scans.sqlite ...')
  try {
    rmSync(scanDbPath, { force: true })
  } catch (e) {
    console.warn('  ⚠ Could not delete (app might be running):', e.message)
  }
}

// 2. Rebuild native modules (better-sqlite3) for Electron
console.log('🔨 Rebuilding native modules for Electron ...')
if (platform() === 'win32' && !process.env.GYP_MSVS_OVERRIDE_PATH) {
  process.env.GYP_MSVS_OVERRIDE_PATH =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools'
}
execSync('npx @electron/rebuild -f -w better-sqlite3 -m ../..', {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
})

// 3. Vite build (main + preload + renderer)
console.log('📦 Building with electron-vite ...')
execSync('npx electron-vite build', {
  stdio: 'inherit',
  cwd: root,
})

console.log('✅ Clean build complete.')