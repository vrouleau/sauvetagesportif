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
