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
 * Standalone diagnostic tool — NOT part of the app, does not import or touch db.ts/schema.ts.
 * Only reuses smb.ts's already-exported, generic gbin/zip read+write helpers
 * (readZipEntries/decodeGbin/encodeGbin/createZip) — none of which are modified here.
 *
 * Purpose: take an .smb file already produced by the unmodified app (e.g. `meet.smb` from
 * File → Exporter meet) and rewrite every row's ID (and every foreign-key reference to it)
 * into a disjoint per-table range, so the resulting file has ZERO id values shared across
 * tables — unlike our own exporter's current output, where e.g. SWIMEVENTID=1, AGEGROUPID=1,
 * and SWIMSESSIONID=1 can all exist simultaneously in the same file.
 *
 * This exists to test one specific hypothesis about the "Invalid class typecast" crash real
 * Splash throws deleting a Final after restoring one of our .smb files: that Splash's own id
 * space is a single counter shared across every table (observed: real, populated Splash .mdb
 * files have heavily overlapping/interleaved id ranges across SWIMEVENT/AGEGROUP/CLUB/ATHLETE/
 * HEAT — never independent per-table counters like ours), and that a generic object-identity
 * cache keyed loosely on that assumption returns the wrong cached object type when two rows
 * from different tables share a literal id.
 *
 * RESULT (2026-08-14): confirmed live against real Splash — both crashes (converting an imported
 * Timed Final into a Prelim/Final split, and deleting an already-split Final) stopped after
 * restoring a *-noncolliding.smb produced by this tool. This tool itself changed nothing in the
 * app; it only proved the hypothesis. The real, permanent fix lives in `nextId()` (src/main/db.ts)
 * — it now computes a single id shared across every table (mirroring the PG backend's existing
 * `nextval('gen_bs_global_uid')`, and real Splash's own BSUIDTABLE/BS_GLOBAL_UID counter,
 * confirmed by directly querying a real Splash .mdb) instead of a per-table MAX+1. This script is
 * kept only as a standalone diagnostic for re-testing this specific hypothesis in isolation
 * against an already-exported .smb, without needing a rebuild.
 *
 * Usage:
 *   npx tsx scripts/remap_smb_ids.ts <input.smb> [output.smb]
 * Default output: <input>-noncolliding.smb next to the input file.
 */

import { readZipEntries, decodeGbin, encodeGbin, createZip, type ColDef, type ZipEntry } from '../src/main/smb'
import { writeFileSync } from 'node:fs'
import { basename, dirname, join, extname } from 'node:path'

// Disjoint offset per table's own PK column — large enough that no realistic export's original
// ids (all small, since our own app numbers each table from 1) could ever collide with another
// table's offset band once shifted.
const TABLE_OFFSETS: Record<string, number> = {
  DSQITEM: 100_000,
  SWIMSTYLE: 200_000,
  SWIMSESSION: 300_000,
  CLUB: 400_000,
  ATHLETE: 500_000,
  SWIMEVENT: 600_000,
  AGEGROUP: 700_000,
  HEAT: 800_000,
  SWIMRESULT: 900_000,
  RELAY: 1_000_000,
}

// table -> its own PK column name (lowercase, matching decodeGbin's row keys)
const PK_COLUMN: Record<string, string> = {
  DSQITEM: 'dsqitemid',
  SWIMSTYLE: 'swimstyleid',
  SWIMSESSION: 'swimsessionid',
  CLUB: 'clubid',
  ATHLETE: 'athleteid',
  SWIMEVENT: 'swimeventid',
  AGEGROUP: 'agegroupid',
  HEAT: 'heatid',
  SWIMRESULT: 'swimresultid',
  RELAY: 'relayid',
}

// table -> [{ column, refersTo }] — every FK column and which table's PK-map it must use.
// SWIMEVENT.preveventid is self-referential (refersTo: SWIMEVENT) and uses -1 as its own
// "no link" sentinel (never NULL — see smb.ts's own preveventid export comment) so -1 must be
// left untouched rather than translated.
const FK_COLUMNS: Record<string, Array<{ column: string; refersTo: string }>> = {
  SWIMEVENT: [
    { column: 'swimstyleid', refersTo: 'SWIMSTYLE' },
    { column: 'swimsessionid', refersTo: 'SWIMSESSION' },
    { column: 'preveventid', refersTo: 'SWIMEVENT' },
  ],
  AGEGROUP: [{ column: 'swimeventid', refersTo: 'SWIMEVENT' }],
  ATHLETE: [{ column: 'clubid', refersTo: 'CLUB' }],
  HEAT: [{ column: 'swimeventid', refersTo: 'SWIMEVENT' }, { column: 'agegroupid', refersTo: 'AGEGROUP' }],
  SWIMRESULT: [
    { column: 'athleteid', refersTo: 'ATHLETE' },
    { column: 'agegroupid', refersTo: 'AGEGROUP' },
    { column: 'heatid', refersTo: 'HEAT' },
    { column: 'swimeventid', refersTo: 'SWIMEVENT' },
    { column: 'dsqitemid', refersTo: 'DSQITEM' },
  ],
  SPLIT: [{ column: 'swimresultid', refersTo: 'SWIMRESULT' }],
  RELAY: [
    { column: 'agegroupid', refersTo: 'AGEGROUP' },
    { column: 'clubid', refersTo: 'CLUB' },
    { column: 'heatid', refersTo: 'HEAT' },
    { column: 'swimeventid', refersTo: 'SWIMEVENT' },
    { column: 'dsqitemid', refersTo: 'DSQITEM' },
  ],
  RELAYSPLIT: [{ column: 'relayid', refersTo: 'RELAY' }],
  RELAYPOSITION: [{ column: 'relayid', refersTo: 'RELAY' }, { column: 'athleteid', refersTo: 'ATHLETE' }],
}

function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/remap_smb_ids.ts <input.smb> [output.smb]')
    process.exit(1)
  }
  const outputPath = process.argv[3] ?? join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}-noncolliding.smb`)

  const zipEntries = readZipEntries(inputPath)
  const decoded = new Map<string, { cols: ColDef[]; rows: Record<string, unknown>[] }>()
  for (const [name, data] of zipEntries) {
    if (!name.toUpperCase().endsWith('.GBIN')) continue
    const table = name.replace(/-0001\.gbin$/i, '').toUpperCase()
    decoded.set(table, decodeGbin(data))
  }

  // Pass 1: build old-id -> new-id maps for every table with a PK column.
  const idMaps = new Map<string, Map<number, number>>()
  for (const [table, offset] of Object.entries(TABLE_OFFSETS)) {
    const entry = decoded.get(table)
    const pkCol = PK_COLUMN[table]
    if (!entry) continue
    const map = new Map<number, number>()
    for (const row of entry.rows) {
      const oldId = row[pkCol] as number | null
      if (oldId == null) continue
      map.set(oldId, oldId + offset)
    }
    idMaps.set(table, map)
  }

  // Pass 2: rewrite every table's own PK and every FK column pointing at a remapped table.
  let totalRewrittenPks = 0
  let totalRewrittenFks = 0
  for (const [table, entry] of decoded) {
    const pkCol = PK_COLUMN[table]
    const pkMap = idMaps.get(table)
    const fkDefs = FK_COLUMNS[table] ?? []

    entry.rows = entry.rows.map(row => {
      const newRow = { ...row }
      if (pkCol && pkMap && newRow[pkCol] != null) {
        newRow[pkCol] = pkMap.get(newRow[pkCol] as number) ?? newRow[pkCol]
        totalRewrittenPks++
      }
      for (const { column, refersTo } of fkDefs) {
        const val = newRow[column] as number | null
        if (val == null) continue
        if (table === 'SWIMEVENT' && column === 'preveventid' && val === -1) continue  // sentinel, never remap
        const refMap = idMaps.get(refersTo)
        const mapped = refMap?.get(val)
        if (mapped != null) {
          newRow[column] = mapped
          totalRewrittenFks++
        }
      }
      return newRow
    })
  }

  console.log(`Rewrote ${totalRewrittenPks} primary keys and ${totalRewrittenFks} foreign-key references across ${decoded.size} tables.`)
  for (const [table, map] of idMaps) {
    if (map.size > 0) {
      const sample = [...map.entries()].slice(0, 3).map(([o, n]) => `${o}→${n}`).join(', ')
      console.log(`  ${table}: ${map.size} ids remapped (e.g. ${sample})`)
    }
  }

  // Re-encode every gbin table with its remapped rows; copy non-gbin entries (geologix.ini) verbatim.
  const outEntries: ZipEntry[] = []
  for (const [name, data] of zipEntries) {
    if (!name.toUpperCase().endsWith('.GBIN')) {
      outEntries.push({ name, data })
      continue
    }
    const table = name.replace(/-0001\.gbin$/i, '').toUpperCase()
    const entry = decoded.get(table)!
    outEntries.push({ name, data: encodeGbin({ name: table, cols: entry.cols }, entry.rows) })
  }

  writeFileSync(outputPath, createZip(outEntries))
  console.log(`\nWrote ${outputPath}`)
}

main()
