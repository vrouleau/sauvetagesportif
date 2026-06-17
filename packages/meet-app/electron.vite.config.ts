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

import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-pg-worker',
        closeBundle() {
          // Copy pgWorker.js to the output directory alongside the bundled main
          const src = resolve('src/main/pgWorker.js')
          const outDir = resolve('out/main')
          if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
          copyFileSync(src, resolve(outDir, 'pgWorker.js'))
        }
      }
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('../shared-ui/src')
      }
    },
    plugins: [react()]
  }
})