#!/usr/bin/env node
/**
 * Release script: bumps version in all package.json files, commits, and creates a git tag.
 *
 * Usage:
 *   node scripts/release.js 0.2.0
 *   node scripts/release.js patch    (0.1.0 → 0.1.1)
 *   node scripts/release.js minor    (0.1.0 → 0.2.0)
 *   node scripts/release.js major    (0.1.0 → 1.0.0)
 *
 * This will:
 *   1. Update version in all package.json files
 *   2. Run npm install to update package-lock.json
 *   3. Commit: "release: v0.2.0"
 *   4. Tag: v0.2.0
 *   5. Print instructions to push
 */
const { execSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')

// All package.json files to update
const PACKAGE_FILES = [
  'package.json',
  'packages/meet-app/package.json',
  'packages/team-app/package.json',
  'packages/team-app/frontend/package.json',
]

function readPkg(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf-8'))
}

function writePkg(path, pkg) {
  writeFileSync(join(root, path), JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
}

function bumpVersion(current, bump) {
  const [major, minor, patch] = current.split('.').map(Number)
  switch (bump) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
    default: return bump // explicit version string
  }
}

// --- Main ---
const arg = process.argv[2]
if (!arg) {
  console.error('Usage: node scripts/release.js <version|patch|minor|major>')
  console.error('  e.g. node scripts/release.js 0.2.0')
  console.error('       node scripts/release.js minor')
  process.exit(1)
}

// Get current version from root package.json
const rootPkg = readPkg('package.json')
const currentVersion = rootPkg.version || '0.1.0'
const newVersion = bumpVersion(currentVersion, arg)

// Validate
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`Invalid version: "${newVersion}"`)
  process.exit(1)
}

console.log(`Bumping: ${currentVersion} → ${newVersion}`)
console.log()

// Update all package.json files
for (const file of PACKAGE_FILES) {
  try {
    const pkg = readPkg(file)
    pkg.version = newVersion
    writePkg(file, pkg)
    console.log(`  ✓ ${file}`)
  } catch (e) {
    console.log(`  ⚠ ${file} (skipped: ${e.message})`)
  }
}

// Update package-lock.json
console.log('\n  Updating package-lock.json...')
execSync('npm install --package-lock-only', { cwd: root, stdio: 'pipe' })
console.log('  ✓ package-lock.json')

// Git commit + tag
console.log()
execSync('git add -A', { cwd: root })
execSync(`git commit -m "release: v${newVersion}"`, { cwd: root, stdio: 'inherit' })
execSync(`git tag v${newVersion}`, { cwd: root })

console.log(`
✅ Version bumped to v${newVersion}

To publish the release:
  git push && git push --tags

This will trigger the Release CI workflow which builds:
  - Windows installer (.exe)
  - macOS DMG
  - Docker images (ghcr.io)
`)
