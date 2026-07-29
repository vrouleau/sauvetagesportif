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
 * Rebuild native modules for Electron.
 * Sets GYP_MSVS_OVERRIDE_PATH on Windows if not already set,
 * so node-gyp finds VS Build Tools even when VS Community is also installed.
 */
const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { platform } = require('os')
const path = require('path')

if (platform() === 'win32' && !process.env.GYP_MSVS_OVERRIDE_PATH) {
  process.env.GYP_MSVS_OVERRIDE_PATH =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools'
}

// electron's npm package doesn't run its own binary download via a lifecycle
// script (no postinstall in its package.json) — do it explicitly so a fresh
// `npm install` doesn't leave `electron-vite dev` unable to find the binary.
try {
  const electronDir = path.dirname(require.resolve('electron/package.json'))
  if (!existsSync(path.join(electronDir, 'dist'))) {
    console.log('Downloading Electron binary...')
    execSync('node install.js', { stdio: 'inherit', cwd: electronDir })
  }
} catch {
  // electron not installed, skip
}

// Rebuild all native modules for Electron's Node version
const nativeModules = ['better-sqlite3']

for (const mod of nativeModules) {
  try {
    require.resolve(mod)
    console.log(`Rebuilding ${mod} for Electron...`)
    execSync(`npx @electron/rebuild -f -w ${mod} -m ../..`, {
      stdio: 'inherit',
      env: process.env,
      cwd: __dirname + '/..',
    })
  } catch {
    // Module not installed, skip
  }
}