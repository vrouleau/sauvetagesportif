/**
 * Rebuild better-sqlite3 for Electron.
 * Sets GYP_MSVS_OVERRIDE_PATH on Windows if not already set,
 * so node-gyp finds VS Build Tools even when VS Community is also installed.
 */
const { execSync } = require('child_process')
const { platform } = require('os')

if (platform() === 'win32' && !process.env.GYP_MSVS_OVERRIDE_PATH) {
  process.env.GYP_MSVS_OVERRIDE_PATH =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools'
}

execSync('npx @electron/rebuild -f -w better-sqlite3 -m ../..', {
  stdio: 'inherit',
  env: process.env,
  cwd: __dirname + '/..',
})
