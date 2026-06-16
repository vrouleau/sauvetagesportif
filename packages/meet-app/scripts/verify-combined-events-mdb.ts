/**
 * Temporary verification script — tests regenerateCombinedEvents against the CQS MDB.
 *
 * Usage: npx tsx scripts/verify-combined-events-mdb.ts
 *
 * Reads events/agegroups/swimstyles/bsglobal from the CQS MDB via a JSON export,
 * loads them into a temp SQLite DB, runs regeneration, and compares.
 */

import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// ── Inline the combinedEvents logic (can't import due to electron dep) ────────

interface CategoryConfig {
  ageMin: number
  ageMax: number
  gender: number
  name: string
  pointsForPlaces: string
  sortbyresfirst: string
  finalusetype: string
  isSpecialNoEvents: boolean
}

interface CombinedEventsConfig { categories: CategoryConfig[] }

interface EventWithAgeGroup {
  swimeventid: number
  eventnumber: number
  eventgender: number
  internalevent: string | null
  agemin: number
  agemax: number
  gender: number
  relaycount: number
}

interface CombinedEventDef {
  combinedeventid: number
  name: string
  titleforprints: string
  sumtype: string
  pointsforplaces: string
  maxresults: string
  sortbyresfirst: string
  penalty: string
  inpercent: string
  completedsq: string
  finalusetype: string
  agegroupeventid: number
  eventIds: number[]
}

function loadConfig(): CombinedEventsConfig {
  const raw = readFileSync(join(__dirname, '../../../config/combined-events-config.json'), 'utf-8')
  return JSON.parse(raw)
}

function queryEventsWithAgeGroups(db: Database.Database): EventWithAgeGroup[] {
  // Check meet type: for beach meets, skip distance filter (distance = max participants, not meters)
  const meetTypeRow = db.prepare(
    `SELECT data FROM bsglobal WHERE name = 'MEET_TYPE'`
  ).get() as { data: string } | undefined
  const isBeach = (meetTypeRow?.data || 'POOL').toUpperCase() === 'BEACH'
  const distanceFilter = isBeach ? '' : 'AND ss.distance >= 25'

  return db.prepare(`
    SELECT e.swimeventid, e.eventnumber, e.gender AS eventgender, e.internalevent,
           ag.agemin, ag.agemax, ag.gender,
           ss.relaycount
    FROM swimevent e
    JOIN agegroup ag ON ag.swimeventid = e.swimeventid
    JOIN swimstyle ss ON e.swimstyleid = ss.swimstyleid
    WHERE ss.relaycount = 1
      ${distanceFilter}
      AND (e.internalevent IS NULL OR e.internalevent = 'F')
      AND e.eventnumber IS NOT NULL
      AND (e.preveventid IS NULL OR e.preveventid < 1)
    ORDER BY e.eventnumber, ag.sortcode
  `).all() as EventWithAgeGroup[]
}

function findMatchingEvents(events: EventWithAgeGroup[], category: CategoryConfig): number[] {
  const matchedIds = new Set<number>()
  for (const event of events) {
    const ageMinMatch = event.agemin === category.ageMin
    const ageMaxMatch = category.ageMax === -1
      ? (event.agemax === -1 || event.agemax === 99)
      : event.agemax === category.ageMax
    if (!ageMinMatch || !ageMaxMatch) continue
    if (category.gender === 0) {
      if (event.eventgender === 0 || event.eventgender === 3) matchedIds.add(event.swimeventid)
    } else {
      if (event.gender === category.gender) matchedIds.add(event.swimeventid)
    }
  }
  return Array.from(matchedIds)
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function buildCombinedEventsXml(definitions: CombinedEventDef[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-16"?>')
  lines.push('<COMBINEDEVENTDEFINITION>')
  lines.push('  <COMBINEDEVENTS>')
  for (const def of definitions) {
    const attrs = [
      `combinedeventid="${def.combinedeventid}"`,
      `name="${escapeXml(def.name)}"`,
      `titleforprints="${escapeXml(def.titleforprints)}"`,
      `sumtype="${def.sumtype}"`,
      `pointsforplaces="${def.pointsforplaces}"`,
      `maxresults="${def.maxresults}"`,
      `sortbyresfirst="${def.sortbyresfirst}"`,
      `penalty="${def.penalty}"`,
      `inpercent="${def.inpercent}"`,
      `completedsq="${def.completedsq}"`,
      `finalusetype="${def.finalusetype}"`,
    ]
    if (def.eventIds.length > 0) attrs.push(`agegroupeventid="${def.agegroupeventid}"`)
    const attrStr = attrs.join(' ')
    if (def.eventIds.length === 0) {
      lines.push(`    <COMBINEDEVENT ${attrStr} />`)
    } else {
      lines.push(`    <COMBINEDEVENT ${attrStr}>`)
      lines.push('      <EVENTS>')
      for (const eventId of def.eventIds) lines.push(`        <EVENT eventid="${eventId}" mandatory="F" />`)
      lines.push('      </EVENTS>')
      lines.push('    </COMBINEDEVENT>')
    }
  }
  lines.push('  </COMBINEDEVENTS>')
  lines.push('</COMBINEDEVENTDEFINITION>')
  return lines.join('\r\n')
}

function regenerate(db: Database.Database): string {
  const config = loadConfig()
  const eventsWithAgeGroups = queryEventsWithAgeGroups(db)
  const definitions: CombinedEventDef[] = []
  for (const category of config.categories) {
    if (category.isSpecialNoEvents) {
      definitions.push({
        combinedeventid: 0, name: category.name, titleforprints: category.name,
        sumtype: '2', pointsforplaces: category.pointsForPlaces, maxresults: '100',
        sortbyresfirst: category.sortbyresfirst, penalty: '10', inpercent: 'T',
        completedsq: 'F', finalusetype: category.finalusetype, agegroupeventid: 0, eventIds: [],
      })
      continue
    }
    const matchingEventIds = findMatchingEvents(eventsWithAgeGroups, category)
    if (matchingEventIds.length === 0) continue
    matchingEventIds.sort((a, b) => a - b)
    const firstEventId = matchingEventIds[0]
    definitions.push({
      combinedeventid: firstEventId, name: category.name, titleforprints: category.name,
      sumtype: '2', pointsforplaces: category.pointsForPlaces, maxresults: '100',
      sortbyresfirst: category.sortbyresfirst, penalty: '10', inpercent: 'T',
      completedsq: 'F', finalusetype: category.finalusetype,
      agegroupeventid: firstEventId, eventIds: matchingEventIds,
    })
  }
  return buildCombinedEventsXml(definitions)
}

// ── Export from MDB via PowerShell ────────────────────────────────────────────

const MDB_PATH = 'C:\\ProgramData\\Meet Manager\\Meets\\CQS Piscine 2026 - CSSG.mdb'

console.log('Exporting data from MDB:', MDB_PATH)

// PowerShell script to export tables as JSON — write to temp file to avoid escaping issues

const psScriptPath = join(tmpdir(), `export-mdb-${randomBytes(4).toString('hex')}.ps1`)
const psScript = `
$conn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${MDB_PATH}")
$conn.Open()
$tables = @{}

$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT SWIMSTYLEID, DISTANCE, RELAYCOUNT, STROKE, NAME FROM SWIMSTYLE"
$a = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$a.Fill($dt) | Out-Null
$tables["swimstyle"] = @($dt.Rows | ForEach-Object { @{swimstyleid=[int]$_.SWIMSTYLEID; distance=[int]$_.DISTANCE; relaycount=[int]$_.RELAYCOUNT; stroke=[int]$_.STROKE; name=[string]$_.NAME} })

$cmd.CommandText = "SELECT SWIMEVENTID, SWIMSTYLEID, EVENTNUMBER, GENDER, INTERNALEVENT, COMBINEAGEGROUPS, PREVEVENTID FROM SWIMEVENT WHERE EVENTNUMBER IS NOT NULL"
$dt = New-Object System.Data.DataTable
$a = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$a.Fill($dt) | Out-Null
$tables["swimevent"] = @($dt.Rows | ForEach-Object { @{swimeventid=[int]$_.SWIMEVENTID; swimstyleid=[int]$_.SWIMSTYLEID; eventnumber=[int]$_.EVENTNUMBER; gender=[int]$_.GENDER; internalevent=[string]$_.INTERNALEVENT; combineagegroups=[string]$_.COMBINEAGEGROUPS; preveventid=[int]$_.PREVEVENTID} })

$cmd.CommandText = "SELECT AGEGROUPID, SWIMEVENTID, AGEMIN, AGEMAX, GENDER, SORTCODE FROM AGEGROUP"
$dt = New-Object System.Data.DataTable
$a = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$a.Fill($dt) | Out-Null
$tables["agegroup"] = @($dt.Rows | ForEach-Object { @{agegroupid=[int]$_.AGEGROUPID; swimeventid=[int]$_.SWIMEVENTID; agemin=[int]$_.AGEMIN; agemax=[int]$_.AGEMAX; gender=[int]$_.GENDER; sortcode=[int]$_.SORTCODE} })

$cmd.CommandText = "SELECT DATA FROM BSGLOBAL WHERE NAME='COMBINEDEVENTS'"
$dt = New-Object System.Data.DataTable
$a = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$a.Fill($dt) | Out-Null
$tables["combinedevents"] = if($dt.Rows.Count -gt 0){[string]$dt.Rows[0].DATA}else{""}

$conn.Close()
$tables | ConvertTo-Json -Depth 5 -Compress
`
writeFileSync(psScriptPath, psScript, 'utf-8')

const jsonOutput = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
try { unlinkSync(psScriptPath) } catch {}
const mdbData = JSON.parse(jsonOutput)

console.log(`  swimstyle: ${mdbData.swimstyle.length} rows`)
console.log(`  swimevent: ${mdbData.swimevent.length} rows`)
console.log(`  agegroup: ${mdbData.agegroup.length} rows`)

// ── Load into SQLite ──────────────────────────────────────────────────────────

const dbPath = join(tmpdir(), `verify-cqs-${randomBytes(4).toString('hex')}.db`)
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE swimstyle (swimstyleid INTEGER PRIMARY KEY, distance INTEGER, relaycount INTEGER, stroke INTEGER, name TEXT);
  CREATE TABLE swimevent (swimeventid INTEGER PRIMARY KEY, swimstyleid INTEGER, eventnumber INTEGER, gender INTEGER, internalevent TEXT, combineagegroups TEXT, preveventid INTEGER);
  CREATE TABLE agegroup (agegroupid INTEGER PRIMARY KEY, swimeventid INTEGER, agemin INTEGER, agemax INTEGER, gender INTEGER, sortcode INTEGER);
  CREATE TABLE bsglobal (name TEXT PRIMARY KEY, data TEXT);
`)

const insStyle = db.prepare('INSERT INTO swimstyle VALUES (?,?,?,?,?)')
for (const r of mdbData.swimstyle) insStyle.run(r.swimstyleid, r.distance, r.relaycount, r.stroke, r.name)

const insEvent = db.prepare('INSERT INTO swimevent VALUES (?,?,?,?,?,?,?)')
for (const r of mdbData.swimevent) insEvent.run(r.swimeventid, r.swimstyleid, r.eventnumber, r.gender, r.internalevent || 'F', r.combineagegroups || 'F', r.preveventid ?? -1)

// Debug: check what's in the DB
const evCount = (db.prepare('SELECT COUNT(*) as c FROM swimevent WHERE preveventid < 1').get() as any).c
const evFinals = (db.prepare('SELECT COUNT(*) as c FROM swimevent WHERE preveventid >= 1').get() as any).c
console.log(`  DB check: ${evCount} normal events, ${evFinals} finals (preveventid >= 1)`)
const strokeCheck = db.prepare('SELECT stroke, COUNT(*) as c FROM swimstyle GROUP BY stroke').all()
console.log('  Stroke distribution:', strokeCheck)
const queryResult = queryEventsWithAgeGroups(db)
console.log(`  Query returned: ${queryResult.length} event-agegroup pairs`)

const insAg = db.prepare('INSERT INTO agegroup VALUES (?,?,?,?,?,?)')
for (const r of mdbData.agegroup) insAg.run(r.agegroupid, r.swimeventid, r.agemin, r.agemax, r.gender, r.sortcode)

// ── Run regeneration ──────────────────────────────────────────────────────────

console.log('\nRegenerating combined events...')
const generatedXml = regenerate(db)
const originalXml = mdbData.combinedevents as string

// ── Compare ───────────────────────────────────────────────────────────────────

console.log('\n═══ COMPARISON ═══')

function extractCategories(xml: string): Map<string, { ids: number[]; points: string }> {
  const map = new Map<string, { ids: number[]; points: string }>()
  const catRegex = /name="([^"]+)"[^>]*pointsforplaces="([^"]+)"[^>]*>?\s*(?:<EVENTS>([\s\S]*?)<\/EVENTS>)?/g
  let match
  while ((match = catRegex.exec(xml)) !== null) {
    const name = match[1]
    const points = match[2]
    const eventsBlock = match[3] ?? ''
    const ids: number[] = []
    const idRegex = /eventid="(\d+)"/g
    let idMatch
    while ((idMatch = idRegex.exec(eventsBlock)) !== null) ids.push(parseInt(idMatch[1]))
    map.set(name, { ids: ids.sort((a, b) => a - b), points })
  }
  return map
}

const originalCats = extractCategories(originalXml)
const generatedCats = extractCategories(generatedXml)

console.log(`\nOriginal categories: ${originalCats.size}`)
console.log(`Generated categories: ${generatedCats.size}`)

let allMatch = true

// Compare by matching on event IDs (names may differ slightly)
for (const [origName, origData] of originalCats) {
  // Find generated category with same event IDs
  let found = false
  for (const [genName, genData] of generatedCats) {
    if (origData.ids.join(',') === genData.ids.join(',')) {
      console.log(`  ✓ "${origName}" ↔ "${genName}" — ${origData.ids.length} events match, points: ${origData.points === genData.points ? 'match' : 'DIFFER (' + genData.points + ')'}`)
      found = true
      break
    }
  }
  if (!found) {
    // Try partial match
    let bestMatch = ''
    let bestOverlap = 0
    for (const [genName, genData] of generatedCats) {
      const overlap = origData.ids.filter(id => genData.ids.includes(id)).length
      if (overlap > bestOverlap) { bestOverlap = overlap; bestMatch = genName }
    }
    if (bestOverlap > 0) {
      const genData = generatedCats.get(bestMatch)!
      console.log(`  ~ "${origName}" ≈ "${bestMatch}" — ${bestOverlap}/${origData.ids.length} events overlap`)
      console.log(`    Original IDs:  [${origData.ids.join(',')}]`)
      console.log(`    Generated IDs: [${genData.ids.join(',')}]`)
    } else {
      console.log(`  ✗ "${origName}" — NO MATCH (IDs: [${origData.ids.join(',')}])`)
    }
    allMatch = false
  }
}

// Check for extra generated categories
for (const [genName, genData] of generatedCats) {
  if (genData.ids.length === 0) continue // skip special no-events
  let found = false
  for (const [, origData] of originalCats) {
    if (origData.ids.join(',') === genData.ids.join(',')) { found = true; break }
  }
  if (!found) console.log(`  ⚠ EXTRA generated: "${genName}" — [${genData.ids.join(',')}]`)
}

console.log(`\n${allMatch ? '✓ ALL CATEGORIES MATCH' : '✗ SOME MISMATCHES — review above'}`)

// Cleanup
db.close()
try { unlinkSync(dbPath) } catch {}
