/**
 * Rebuild native modules for Electron.
 * Sets GYP_MSVS_OVERRIDE_PATH on Windows if not already set,
 * so node-gyp finds VS Build Tools even when VS Community is also installed.
 */
const { execSync } = require('child_process')
const { platform } = require('os')

if (platform() === 'win32' && !process.env.GYP_MSVS_OVERRIDE_PATH) {
  process.env.GYP_MSVS_OVERRIDE_PATH =
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools'
}

// Rebuild all native modules for Electron's Node version
const nativeModules = ['better-sqlite3', 'sharp']

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

// onnxruntime-node ships pre-built binaries, no rebuild needed
// but verify it's accessible
try {
  require.resolve('onnxruntime-node')
  console.log('onnxruntime-node: pre-built binaries OK')
} catch {
  // Not installed, skip
}
