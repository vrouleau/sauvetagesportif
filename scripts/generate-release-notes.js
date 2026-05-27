#!/usr/bin/env node
/**
 * Generate release notes from git commits since the last tag.
 * Groups commits by conventional-commit type and prepends to CHANGELOG.md.
 *
 * Usage (called automatically by release.js):
 *   node scripts/generate-release-notes.js <newVersion>
 */
const { execSync } = require('child_process')
const { readFileSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const CHANGELOG_PATH = join(root, 'CHANGELOG.md')

const CATEGORIES = {
  feat: '✨ Features',
  fix: '🐛 Bug Fixes',
  docs: '📝 Documentation',
  refactor: '♻️ Refactoring',
  perf: '⚡ Performance',
  chore: '🔧 Chores',
  ci: '🏗️ CI',
  test: '✅ Tests',
  style: '💄 Style',
}

function getLastTag() {
  try {
    return execSync('git describe --tags --abbrev=0', { cwd: root, encoding: 'utf-8' }).trim()
  } catch {
    // No tags exist — use initial commit
    return execSync('git rev-list --max-parents=0 HEAD', { cwd: root, encoding: 'utf-8' }).trim()
  }
}

function getCommitsSince(ref) {
  const log = execSync(
    `git log ${ref}..HEAD --pretty=format:"%s|||%h|||%an"`,
    { cwd: root, encoding: 'utf-8' }
  ).trim()
  if (!log) return []
  return log.split('\n').map(line => {
    const [subject, hash, author] = line.split('|||')
    return { subject, hash, author }
  })
}

function categorize(commits) {
  const grouped = {}
  const uncategorized = []

  for (const commit of commits) {
    // Skip release commits themselves
    if (commit.subject.startsWith('release:')) continue

    const match = commit.subject.match(/^(\w+)(?:\(.+?\))?:\s*(.+)$/)
    if (match) {
      const [, type, message] = match
      const category = CATEGORIES[type] || CATEGORIES.chore
      if (!grouped[category]) grouped[category] = []
      grouped[category].push({ message, hash: commit.hash, author: commit.author })
    } else {
      uncategorized.push({ message: commit.subject, hash: commit.hash, author: commit.author })
    }
  }

  if (uncategorized.length > 0) {
    grouped['Other'] = uncategorized
  }

  return grouped
}

function generateMarkdown(version, grouped) {
  const date = new Date().toISOString().split('T')[0]
  let md = `## [${version}] - ${date}\n\n`

  // Order: features first, then fixes, then the rest
  const order = Object.values(CATEGORIES).concat(['Other'])
  for (const category of order) {
    if (!grouped[category]) continue
    md += `### ${category}\n\n`
    for (const { message, hash } of grouped[category]) {
      md += `- ${message} (\`${hash}\`)\n`
    }
    md += '\n'
  }

  return md
}

// --- Main ---
function generate(newVersion) {
  const lastTag = getLastTag()
  const commits = getCommitsSince(lastTag)

  if (commits.length === 0) {
    console.log('  ℹ No commits since last tag — skipping release notes.')
    return
  }

  const grouped = categorize(commits)
  const notes = generateMarkdown(newVersion, grouped)

  // Prepend to CHANGELOG.md
  let existing = ''
  if (existsSync(CHANGELOG_PATH)) {
    existing = readFileSync(CHANGELOG_PATH, 'utf-8')
  }

  const header = existing.startsWith('# Changelog')
    ? ''
    : '# Changelog\n\n'

  if (existing.startsWith('# Changelog')) {
    // Insert after the header line
    const rest = existing.replace(/^# Changelog\n\n?/, '')
    writeFileSync(CHANGELOG_PATH, `# Changelog\n\n${notes}${rest}`, 'utf-8')
  } else {
    writeFileSync(CHANGELOG_PATH, `${header}${notes}${existing}`, 'utf-8')
  }

  console.log(`  ✓ CHANGELOG.md updated with ${commits.length} commit(s)`)
  return notes
}

// Allow direct invocation or require
if (require.main === module) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/generate-release-notes.js <version>')
    process.exit(1)
  }
  generate(version)
}

module.exports = { generate }
