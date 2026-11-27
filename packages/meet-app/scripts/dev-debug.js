// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// `npm run dev` with the scanner debug panel on (the renderer reads VITE_SCAN_DEBUG).
// A tiny wrapper so it works the same in PowerShell, cmd and bash (no `VAR=1 cmd` syntax).
//
// Run `npm run dev:debug` from a normal terminal, like `npm run dev` (see CLAUDE.md).

const { spawn } = require('child_process')

const child = spawn('npm run dev', { stdio: 'inherit', shell: true, env: { ...process.env, VITE_SCAN_DEBUG: '1' } })
child.on('exit', (code) => process.exit(code ?? 0))
