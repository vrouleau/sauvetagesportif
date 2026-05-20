/**
 * SMB file format handler (Splash Meet Backup)
 * 
 * An .smb file is a ZIP archive containing:
 * - geologix.ini: metadata (app version, record counts)
 * - TABLENAME-0001.gbin: binary-serialized table data
 *
 * GBIN format:
 * - 2-byte LE header length
 * - Header: tab-separated "COLNAME;TYPE;SIZE" column definitions
 * - Body: records separated by 1-byte prefix (first record has no prefix)
 * - I;32 = int32 LE (4 bytes), I;16 = int16 LE (2 bytes)
 * - S;N = uint16 LE string length + UTF-8 content
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import Database from 'better-sqlite3'

// ── Table definitions (column name, type, size) ───────────────────────────────

interface ColDef {
  name: string
  type: 'I' | 'S'
  size: number
}

// Tables to include in SMB backup (order matters for FK dependencies)
const SMB_TABLES: { name: string; cols: ColDef[] }[] = [
  {
    name: 'BSGLOBAL', cols: [
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'DATA', type: 'S', size: 4096 },
    ]
  },
  {
    name: 'SWIMSTYLE', cols: [
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'RELAYCOUNT', type: 'I', size: 16 },
      { name: 'STROKE', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'TECHNIQUE', type: 'I', size: 16 },
      { name: 'UNIQUEID', type: 'I', size: 16 },
    ]
  },
  {
    name: 'SWIMSESSION', cols: [
      { name: 'SWIMSESSIONID', type: 'I', size: 32 },
      { name: 'SESSIONNUMBER', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 100 },
      { name: 'DAYTIME', type: 'S', size: 30 },
      { name: 'ENDTIME', type: 'S', size: 30 },
      { name: 'COURSE', type: 'I', size: 16 },
      { name: 'LANEMIN', type: 'I', size: 16 },
      { name: 'LANEMAX', type: 'I', size: 16 },
      { name: 'TIMING', type: 'I', size: 16 },
      { name: 'TOUCHPADMODE', type: 'I', size: 16 },
      { name: 'ROUNDTOTENTHS', type: 'S', size: 1 },
      { name: 'FOLLOWING', type: 'S', size: 1 },
      { name: 'POOLGLOBAL', type: 'S', size: 1 },
      { name: 'REMARKS', type: 'S', size: 4096 },
      { name: 'REMARKSJURY', type: 'S', size: 4096 },
      { name: 'WARMUPFROM', type: 'S', size: 30 },
      { name: 'WARMUPUNTIL', type: 'S', size: 30 },
      { name: 'OFFICIALMEETING', type: 'S', size: 30 },
      { name: 'MAXENTRIESATHLETE', type: 'I', size: 16 },
      { name: 'MAXENTRIESRELAY', type: 'I', size: 16 },
      { name: 'FEEATHLETE', type: 'I', size: 32 },
    ]
  },
  {
    name: 'CLUB', cols: [
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'NAME', type: 'S', size: 80 },
      { name: 'NATION', type: 'S', size: 3 },
    ]
  },
  {
    name: 'ATHLETE', cols: [
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'FIRSTNAME', type: 'S', size: 30 },
      { name: 'LASTNAME', type: 'S', size: 50 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'BIRTHDATE', type: 'S', size: 30 },
      { name: 'NATION', type: 'S', size: 3 },
      { name: 'LICENSE', type: 'S', size: 20 },
      { name: 'DOMICILE', type: 'S', size: 50 },
    ]
  },
  {
    name: 'SWIMEVENT', cols: [
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMSESSIONID', type: 'I', size: 32 },
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'EVENTNUMBER', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'ROUND', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'INTERNALEVENT', type: 'S', size: 1 },
      { name: 'MASTERS', type: 'S', size: 1 },
      { name: 'ROUNDNAME', type: 'S', size: 50 },
      { name: 'DAYTIME', type: 'S', size: 30 },
    ]
  },
  {
    name: 'AGEGROUP', cols: [
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'AGEMIN', type: 'I', size: 16 },
      { name: 'AGEMAX', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'HEATCOUNT', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'USEFORMEDALS', type: 'S', size: 1 },
    ]
  },
  {
    name: 'HEAT', cols: [
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'HEATNUMBER', type: 'I', size: 16 },
      { name: 'RACESTATUS', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 50 },
    ]
  },
  {
    name: 'SWIMRESULT', cols: [
      { name: 'SWIMRESULTID', type: 'I', size: 32 },
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'LANE', type: 'I', size: 16 },
      { name: 'ENTRYTIME', type: 'I', size: 32 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
      { name: 'REACTIONTIME', type: 'I', size: 16 },
      { name: 'RESULTSTATUS', type: 'I', size: 16 },
      { name: 'USETIMETYPE', type: 'I', size: 16 },
    ]
  },
  {
    name: 'SPLIT', cols: [
      { name: 'SWIMRESULTID', type: 'I', size: 32 },
      { name: 'DISTANCE', type: 'I', size: 16 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
    ]
  },
]

// ── GBIN encoding ─────────────────────────────────────────────────────────────

function encodeGbin(tableDef: { name: string; cols: ColDef[] }, rows: Record<string, unknown>[]): Buffer {
  // Header
  const headerStr = tableDef.cols.map(c => `${c.name};${c.type};${c.size}`).join('\t')
  const headerBuf = Buffer.from(headerStr, 'ascii')
  const headerLenBuf = Buffer.alloc(2)
  headerLenBuf.writeUInt16LE(headerBuf.length)

  // Body
  const chunks: Buffer[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) chunks.push(Buffer.from([0x00])) // separator byte
    const row = rows[i]
    for (const col of tableDef.cols) {
      const val = row[col.name.toLowerCase()]
      if (col.type === 'I') {
        const numVal = val != null ? Number(val) : 0
        if (col.size <= 16) {
          const b = Buffer.alloc(2)
          b.writeInt16LE(numVal)
          chunks.push(b)
        } else {
          const b = Buffer.alloc(4)
          b.writeInt32LE(numVal)
          chunks.push(b)
        }
      } else {
        // String: 2-byte LE length + UTF-8 content
        const strVal = val != null ? String(val) : ''
        const strBuf = Buffer.from(strVal, 'utf8')
        const lenBuf = Buffer.alloc(2)
        lenBuf.writeUInt16LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      }
    }
  }

  return Buffer.concat([headerLenBuf, headerBuf, ...chunks])
}

// ── GBIN decoding ─────────────────────────────────────────────────────────────

function decodeGbin(data: Buffer): { cols: ColDef[]; rows: Record<string, unknown>[] } {
  const headerLen = data.readUInt16LE(0)
  const headerStr = data.subarray(2, 2 + headerLen).toString('ascii')
  const cols: ColDef[] = headerStr.split('\t').map(c => {
    const [name, type, size] = c.split(';')
    return { name, type: type as 'I' | 'S', size: parseInt(size, 10) }
  })

  const rows: Record<string, unknown>[] = []
  let offset = 2 + headerLen
  const body = data

  while (offset < body.length) {
    // Skip separator byte between records (not before first)
    if (rows.length > 0) offset += 1
    if (offset >= body.length) break

    const row: Record<string, unknown> = {}
    for (const col of cols) {
      if (offset >= body.length) break
      if (col.type === 'I') {
        if (col.size <= 16) {
          row[col.name.toLowerCase()] = body.readInt16LE(offset)
          offset += 2
        } else {
          row[col.name.toLowerCase()] = body.readInt32LE(offset)
          offset += 4
        }
      } else {
        const slen = body.readUInt16LE(offset)
        offset += 2
        if (slen > 0) {
          row[col.name.toLowerCase()] = body.subarray(offset, offset + slen).toString('utf8')
          offset += slen
        } else {
          row[col.name.toLowerCase()] = null
        }
      }
    }
    rows.push(row)
  }

  return { cols, rows }
}

// ── ZIP helpers (minimal PKZIP write) ─────────────────────────────────────────

interface ZipEntry { name: string; data: Buffer }

function createZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralHeaders: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data)
    const nameBytes = Buffer.from(entry.name, 'ascii')

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0) // signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(8, 8) // compression: deflate
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc32(entry.data), 14) // crc32
    local.writeUInt32LE(compressed.length, 18) // compressed size
    local.writeUInt32LE(entry.data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26) // filename length
    local.writeUInt16LE(0, 28) // extra field length
    nameBytes.copy(local, 30)

    localHeaders.push(local)
    localHeaders.push(compressed)

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(8, 10) // compression
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0, 14) // mod date
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    nameBytes.copy(central, 46)
    centralHeaders.push(central)

    offset += local.length + compressed.length
  }

  const centralDirOffset = offset
  const centralDir = Buffer.concat(centralHeaders)

  // End of central directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(centralDirOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd])
}

function readZipEntries(filePath: string): Map<string, Buffer> {
  const buf = readFileSync(filePath)
  const entries = new Map<string, Buffer>()
  let offset = 0

  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset)
    if (sig !== 0x04034b50) break // not a local file header

    const method = buf.readUInt16LE(offset + 8)
    const compressedSize = buf.readUInt32LE(offset + 18)
    const fileNameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const fileName = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString('ascii')
    const dataStart = offset + 30 + fileNameLen + extraLen
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)

    let content: Buffer
    if (method === 0) content = compressed
    else if (method === 8) content = inflateRawSync(compressed)
    else { offset = dataStart + compressedSize; continue }

    entries.set(fileName, content)
    offset = dataStart + compressedSize
  }

  return entries
}

// ── CRC32 ─────────────────────────────────────────────────────────────────────

const crcTable: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ── Public API ────────────────────────────────────────────────────────────────

export function saveSMB(filePath: string, db: Database.Database): { tables: number; rows: number } {
  const entries: ZipEntry[] = []
  const recordCounts: Record<string, number> = {}
  let totalRows = 0

  for (const tableDef of SMB_TABLES) {
    const tableName = tableDef.name.toLowerCase()
    const colNames = tableDef.cols.map(c => c.name.toLowerCase()).join(', ')
    const rows = db.prepare(`SELECT ${colNames} FROM ${tableName}`).all() as Record<string, unknown>[]

    recordCounts[tableDef.name] = rows.length
    totalRows += rows.length

    const gbin = encodeGbin(tableDef, rows)
    entries.push({ name: `${tableDef.name}-0001.gbin`, data: gbin })
  }

  // Generate geologix.ini
  const ini = [
    '[Geologix]',
    'Application=SplashMeet',
    'Version=1.0.0',
    'Identification=BACKUP_MM_MEET_11',
    '',
    '[RecordCount]',
    ...SMB_TABLES.map(t => `${t.name}=${recordCounts[t.name] ?? 0}`),
    '',
    '[Tables]',
    ...SMB_TABLES.map(t => `${t.name}=${recordCounts[t.name] > 0 ? 1 : 0}`),
    '',
  ].join('\r\n')

  entries.push({ name: 'geologix.ini', data: Buffer.from(ini, 'utf8') })

  const zip = createZip(entries)
  writeFileSync(filePath, zip)

  return { tables: SMB_TABLES.length, rows: totalRows }
}

export function restoreSMB(filePath: string, db: Database.Database): { tables: number; rows: number } {
  const zipEntries = readZipEntries(filePath)
  let totalRows = 0

  // Disable FK enforcement for bulk import — Splash encodes NULL integers as 0
  // which would fail FK checks mid-load even though the data is self-consistent.
  db.pragma('foreign_keys = OFF')
  try {
    // Clear existing data (reverse FK order)
    const reversed = [...SMB_TABLES].reverse()
    for (const tableDef of reversed) {
      db.prepare(`DELETE FROM ${tableDef.name.toLowerCase()}`).run()
    }

    // Import each table
    for (const tableDef of SMB_TABLES) {
      const fileName = `${tableDef.name}-0001.gbin`
      const gbinData = zipEntries.get(fileName)
      if (!gbinData) continue

      const { rows } = decodeGbin(gbinData)
      if (rows.length === 0) continue

      const colNames = tableDef.cols.map(c => c.name.toLowerCase())
      const placeholders = colNames.map(() => '?').join(', ')
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${tableDef.name.toLowerCase()} (${colNames.join(', ')}) VALUES (${placeholders})`
      )

      const insertAll = db.transaction((recs: Record<string, unknown>[]) => {
        for (const row of recs) {
          const vals = colNames.map(c => row[c] ?? null)
          stmt.run(...vals)
        }
      })

      insertAll(rows)
      totalRows += rows.length
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }

  return { tables: SMB_TABLES.length, rows: totalRows }
}
