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
 * - Body: records packed contiguously (no separator bytes)
 *
 * Column types:
 * - I;32 = int32 LE (4 bytes), I;16 = int16 LE (2 bytes)
 * - S;N = uint16 LE string length + UTF-8 content (len=0 → null)
 * - D;32 = 8-byte LE double (OLE Automation date)
 * - F;0 = 8-byte LE double (floating point / currency)
 * - M;0 = uint32 LE length + UTF-8 content (memo field, len=0 → null)
 *
 * Null disambiguation:
 * When a numeric field (I, D, F) stores its null-sentinel value, a trailing
 * 1-byte flag follows: 0x00 = value is real, 0x01 = value is null.
 * Sentinels: I → 0, F → 0.0, D → -36522.0 (OLE date for 1800-01-01 00:00:00).
 * S/M fields use len=0 for null (no flag needed).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import Database from 'better-sqlite3'

// ── Table definitions (column name, type, size) ───────────────────────────────

interface ColDef {
  name: string
  type: 'I' | 'S' | 'D' | 'F' | 'M'
  size: number
}

// Tables to include in SMB backup (order matters for FK dependencies).
// Column definitions must match the gbin header format that Splash expects.
// The column ORDER here defines the binary layout in the gbin file.
const SMB_TABLES: { name: string; cols: ColDef[] }[] = [
  {
    name: 'BSGLOBAL', cols: [
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'DATA', type: 'M', size: 0 },
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
      { name: 'COURSE', type: 'I', size: 16 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'ENDTIME', type: 'D', size: 32 },
      { name: 'FEEATHLETE', type: 'F', size: 0 },
      { name: 'FOLLOWING', type: 'S', size: 1 },
      { name: 'LANEMIN', type: 'I', size: 16 },
      { name: 'LANEMAX', type: 'I', size: 16 },
      { name: 'LANESBYPLACE', type: 'S', size: 100 },
      { name: 'MAXENTRIESATHLETE', type: 'I', size: 16 },
      { name: 'MAXENTRIESRELAY', type: 'I', size: 16 },
      { name: 'NAME', type: 'S', size: 100 },
      { name: 'OFFICIALMEETING', type: 'D', size: 32 },
      { name: 'POOLGLOBAL', type: 'S', size: 1 },
      { name: 'POOLTYPE', type: 'I', size: 16 },
      { name: 'REMARKS', type: 'M', size: 0 },
      { name: 'REMARKSJURY', type: 'M', size: 0 },
      { name: 'ROUNDTOTENTHS', type: 'S', size: 1 },
      { name: 'SESSIONNUMBER', type: 'I', size: 16 },
      { name: 'STARTDATE', type: 'D', size: 32 },
      { name: 'TIMING', type: 'I', size: 16 },
      { name: 'TLMEETING', type: 'D', size: 32 },
      { name: 'TOUCHPADMODE', type: 'I', size: 16 },
      { name: 'WARMUPFROM', type: 'D', size: 32 },
      { name: 'WARMUPUNTIL', type: 'D', size: 32 },
    ]
  },
  {
    name: 'CLUB', cols: [
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'BONUSPOINTS', type: 'I', size: 32 },
      { name: 'CLUBTYPE', type: 'I', size: 16 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'CONTACTNAME', type: 'S', size: 50 },
      { name: 'CONTACTINTERNET', type: 'S', size: 150 },
      { name: 'CONTACTCITY', type: 'S', size: 30 },
      { name: 'CONTACTCOUNTRY', type: 'S', size: 2 },
      { name: 'CONTACTEMAIL', type: 'S', size: 50 },
      { name: 'CONTACTFAX', type: 'S', size: 20 },
      { name: 'CONTACTPHONE', type: 'S', size: 20 },
      { name: 'CONTACTSTATE', type: 'S', size: 5 },
      { name: 'CONTACTSTREET', type: 'S', size: 50 },
      { name: 'CONTACTSTREET2', type: 'S', size: 50 },
      { name: 'CONTACTZIP', type: 'S', size: 10 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'LONGCODE', type: 'S', size: 20 },
      { name: 'ENTRYCLUBID', type: 'I', size: 32 },
      { name: 'ENTRYEMAILS', type: 'S', size: 255 },
      { name: 'NAME', type: 'S', size: 80 },
      { name: 'NAMEEN', type: 'S', size: 80 },
      { name: 'NATION', type: 'S', size: 3 },
      { name: 'REGION', type: 'S', size: 10 },
      { name: 'SHORTNAME', type: 'S', size: 30 },
      { name: 'SHORTNAMEEN', type: 'S', size: 30 },
      { name: 'SWRID', type: 'I', size: 32 },
      { name: 'TEAMNUMBER', type: 'I', size: 16 },
    ]
  },
  {
    name: 'ATHLETE', cols: [
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'CLUBID', type: 'I', size: 32 },
      { name: 'FIRSTNAME', type: 'S', size: 30 },
      { name: 'FIRSTNAME_UPPER', type: 'S', size: 5 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'LASTNAME', type: 'S', size: 50 },
      { name: 'LASTNAME_UPPER', type: 'S', size: 10 },
      { name: 'NAMEPREFIX', type: 'S', size: 20 },
      { name: 'BIRTHDATE', type: 'D', size: 32 },
      { name: 'DOMICILE', type: 'S', size: 50 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FIRSTNAMEEN', type: 'S', size: 30 },
      { name: 'HANDICAPEX', type: 'S', size: 20 },
      { name: 'HANDICAPS', type: 'I', size: 16 },
      { name: 'HANDICAPSB', type: 'I', size: 16 },
      { name: 'HANDICAPSM', type: 'I', size: 16 },
      { name: 'LASTNAMEEN', type: 'S', size: 50 },
      { name: 'LICENSE', type: 'S', size: 20 },
      { name: 'NATION', type: 'S', size: 3 },
      { name: 'SDMSID', type: 'I', size: 32 },
      { name: 'STATUS', type: 'I', size: 32 },
      { name: 'SWIMLEVEL', type: 'S', size: 10 },
      { name: 'SWRID', type: 'I', size: 32 },
      { name: 'SWRHASHKEY', type: 'I', size: 32 },
      { name: 'CLUBCODE2', type: 'S', size: 10 },
      { name: 'COACHNAME', type: 'S', size: 80 },
      { name: 'SCHOOLYEAR', type: 'S', size: 10 },
      { name: 'MIDDLENAME', type: 'S', size: 50 },
      { name: 'MIDDLENAMEEN', type: 'S', size: 50 },
    ]
  },
  {
    name: 'SWIMEVENT', cols: [
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'COMMENT', type: 'M', size: 0 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'DURATION', type: 'D', size: 32 },
      { name: 'ENTRYTIMECONVERSION', type: 'I', size: 16 },
      { name: 'ENTRYTIMEPERCENT', type: 'I', size: 16 },
      { name: 'EVENTNUMBER', type: 'I', size: 16 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FEE', type: 'F', size: 0 },
      { name: 'FINALORDER', type: 'I', size: 16 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'LANEMAX', type: 'I', size: 16 },
      { name: 'LYTENTRYLIST', type: 'I', size: 32 },
      { name: 'LYTSTARTLIST', type: 'I', size: 32 },
      { name: 'LYTRESULT2COLUMN', type: 'I', size: 32 },
      { name: 'LYTRESULT2SPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULT4SPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULTNOSPLIT', type: 'I', size: 32 },
      { name: 'LYTRESULTHTML', type: 'I', size: 32 },
      { name: 'MASTERS', type: 'S', size: 1 },
      { name: 'MAXENTRIES', type: 'I', size: 16 },
      { name: 'PFINEIGNORE', type: 'S', size: 1 },
      { name: 'PREVEVENTID', type: 'I', size: 32 },
      { name: 'QUALBYPLACE', type: 'I', size: 16 },
      { name: 'ROUND', type: 'I', size: 16 },
      { name: 'SEEDBONUSLAST', type: 'S', size: 1 },
      { name: 'SEEDEXHLAST', type: 'S', size: 1 },
      { name: 'SEEDLATEENTRYLAST', type: 'S', size: 1 },
      { name: 'SEEDINGGLOBAL', type: 'S', size: 1 },
      { name: 'SINGLEHEATS', type: 'I', size: 16 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SPLASHMECANEDIT', type: 'S', size: 1 },
      { name: 'SPONSOR', type: 'S', size: 50 },
      { name: 'SWIMSESSIONID', type: 'I', size: 32 },
      { name: 'SWIMSTYLEID', type: 'I', size: 32 },
      { name: 'TWOPERLANE', type: 'S', size: 1 },
      { name: 'ROUNDNAME', type: 'S', size: 50 },
      { name: 'COMBINEAGEGROUPS', type: 'S', size: 1 },
      { name: 'ROUNDONE', type: 'S', size: 20 },
      { name: 'INTERNALEVENT', type: 'S', size: 1 },
    ]
  },
  {
    name: 'AGEGROUP', cols: [
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEBYTOTAL', type: 'S', size: 1 },
      { name: 'AGEMAX', type: 'I', size: 16 },
      { name: 'AGEMAX2', type: 'I', size: 16 },
      { name: 'AGEMIN', type: 'I', size: 16 },
      { name: 'AGEMIN2', type: 'I', size: 16 },
      { name: 'ALLOFFICIAL', type: 'S', size: 1 },
      { name: 'ATHLETESTATUSES', type: 'I', size: 32 },
      { name: 'CLUBIDS', type: 'M', size: 0 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'EXTERNALID', type: 'S', size: 40 },
      { name: 'FASTHEATCOUNT', type: 'I', size: 16 },
      { name: 'FORCEPRELIM', type: 'S', size: 1 },
      { name: 'GENDER', type: 'I', size: 16 },
      { name: 'HANDICAPS', type: 'S', size: 100 },
      { name: 'HEATCOUNT', type: 'I', size: 16 },
      { name: 'HEATQUALIPRIORITY', type: 'S', size: 50 },
      { name: 'LEVELMAX', type: 'S', size: 5 },
      { name: 'LEVELMIN', type: 'S', size: 5 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'NATIONALITY', type: 'S', size: 3 },
      { name: 'NATIONREGIONS', type: 'M', size: 0 },
      { name: 'RESULTCOUNT', type: 'I', size: 16 },
      { name: 'SCORETYPE', type: 'I', size: 16 },
      { name: 'SEEDWITHTSONLY', type: 'S', size: 1 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMLEVELS', type: 'S', size: 255 },
      { name: 'USEFORMEDALS', type: 'S', size: 1 },
      { name: 'USEFORSCORING', type: 'S', size: 1 },
      { name: 'WINNERTITLE', type: 'S', size: 100 },
      { name: 'FOREIGNCOUNT', type: 'I', size: 16 },
      { name: 'FINALSEEDTYPE', type: 'I', size: 16 },
    ]
  },
  {
    name: 'HEAT', cols: [
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'AGEGROUPORDER', type: 'I', size: 32 },
      { name: 'DAYTIME', type: 'D', size: 32 },
      { name: 'FINALCODE', type: 'S', size: 2 },
      { name: 'HEATNUMBER', type: 'I', size: 16 },
      { name: 'RACESTATUS', type: 'I', size: 16 },
      { name: 'REMARKS', type: 'M', size: 0 },
      { name: 'SORTCODE', type: 'I', size: 32 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'NAME', type: 'S', size: 50 },
      { name: 'SEEDEVENTID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'RESERVECOUNT', type: 'I', size: 16 },
      { name: 'FOREIGNCOUNT', type: 'I', size: 16 },
    ]
  },
  {
    name: 'SWIMRESULT', cols: [
      { name: 'SWIMRESULTID', type: 'I', size: 32 },
      { name: 'ATHLETEID', type: 'I', size: 32 },
      { name: 'SWRABESTID', type: 'I', size: 32 },
      { name: 'SWRABESTTIME', type: 'I', size: 32 },
      { name: 'SWRSBESTID', type: 'I', size: 32 },
      { name: 'SWRSBESTTIME', type: 'I', size: 32 },
      { name: 'AGEGROUPID', type: 'I', size: 32 },
      { name: 'BACKUPTIME1', type: 'I', size: 32 },
      { name: 'BACKUPTIME2', type: 'I', size: 32 },
      { name: 'BACKUPTIME3', type: 'I', size: 32 },
      { name: 'BONUSENTRY', type: 'S', size: 1 },
      { name: 'COMMENT', type: 'S', size: 250 },
      { name: 'DSQITEMID', type: 'I', size: 32 },
      { name: 'DSQDAYTIME', type: 'D', size: 32 },
      { name: 'DSQNOTIFIED', type: 'S', size: 1 },
      { name: 'DSQNUMBER', type: 'I', size: 16 },
      { name: 'ENTRYCOURSE', type: 'I', size: 16 },
      { name: 'ENTRYTIME', type: 'I', size: 32 },
      { name: 'FINALFIX', type: 'S', size: 1 },
      { name: 'FINISHJUDGE', type: 'I', size: 16 },
      { name: 'HEATID', type: 'I', size: 32 },
      { name: 'INFOCODE', type: 'S', size: 5 },
      { name: 'LANE', type: 'I', size: 16 },
      { name: 'LATEENTRY', type: 'S', size: 1 },
      { name: 'MPOINTS', type: 'I', size: 16 },
      { name: 'PADTIME', type: 'I', size: 32 },
      { name: 'QTCITY', type: 'S', size: 30 },
      { name: 'QTCOURSE', type: 'I', size: 16 },
      { name: 'QTDATE', type: 'D', size: 32 },
      { name: 'QTNAME', type: 'S', size: 100 },
      { name: 'QTNATION', type: 'S', size: 3 },
      { name: 'QTTIME', type: 'I', size: 32 },
      { name: 'QUALCODE', type: 'S', size: 2 },
      { name: 'REACTIONTIME', type: 'I', size: 16 },
      { name: 'RESULTSTATUS', type: 'I', size: 16 },
      { name: 'SWIMEVENTID', type: 'I', size: 32 },
      { name: 'SWIMTIME', type: 'I', size: 32 },
      { name: 'USETIMETYPE', type: 'I', size: 16 },
      { name: 'DSQOFFICIALID', type: 'I', size: 32 },
      { name: 'RESERVECODE', type: 'S', size: 20 },
      { name: 'NOADVANCE', type: 'S', size: 1 },
      { name: 'OFFICIALSPLITS', type: 'S', size: 100 },
      { name: 'QTTIMING', type: 'I', size: 16 },
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

  // Body — records packed contiguously (no separator)
  const chunks: Buffer[] = []
  for (const row of rows) {
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
        // Null disambiguation flag when value is 0
        if (numVal === 0) {
          chunks.push(Buffer.from([val == null ? 0x01 : 0x00]))
        }
      } else if (col.type === 'S') {
        const strVal = val != null ? String(val) : ''
        const strBuf = Buffer.from(strVal, 'utf8')
        const lenBuf = Buffer.alloc(2)
        lenBuf.writeUInt16LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      } else if (col.type === 'D') {
        const dblVal = val != null ? Number(val) : D_NULL_SENTINEL
        const b = Buffer.alloc(8)
        b.writeDoubleLE(dblVal)
        chunks.push(b)
        // Null disambiguation flag when value is the sentinel
        if (dblVal === D_NULL_SENTINEL || dblVal === 0) {
          chunks.push(Buffer.from([val == null ? 0x01 : 0x00]))
        }
      } else if (col.type === 'F') {
        const dblVal = val != null ? Number(val) : 0
        const b = Buffer.alloc(8)
        b.writeDoubleLE(dblVal)
        chunks.push(b)
        // Null disambiguation flag when value is 0
        if (dblVal === 0) {
          chunks.push(Buffer.from([val == null ? 0x01 : 0x00]))
        }
      } else if (col.type === 'M') {
        const strVal = val != null ? String(val) : ''
        const strBuf = Buffer.from(strVal, 'utf8')
        const lenBuf = Buffer.alloc(4)
        lenBuf.writeUInt32LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      }
    }
  }

  return Buffer.concat([headerLenBuf, headerBuf, ...chunks])
}

// ── Null sentinel constants ────────────────────────────────────────────────────

const D_NULL_SENTINEL = -36522.0 // OLE date for 1800-01-01 00:00:00

// ── GBIN decoding ─────────────────────────────────────────────────────────────

function decodeGbin(data: Buffer): { cols: ColDef[]; rows: Record<string, unknown>[] } {
  const headerLen = data.readUInt16LE(0)
  const headerStr = data.subarray(2, 2 + headerLen).toString('ascii')
  const cols: ColDef[] = headerStr.split('\t').map(c => {
    const [name, type, size] = c.split(';')
    return { name, type: type as ColDef['type'], size: parseInt(size, 10) }
  })

  const rows: Record<string, unknown>[] = []
  let offset = 2 + headerLen

  while (offset < data.length) {
    const row: Record<string, unknown> = {}
    let valid = true
    for (const col of cols) {
      if (offset >= data.length) { valid = false; break }
      const key = col.name.toLowerCase()

      if (col.type === 'I') {
        const bytes = col.size <= 16 ? 2 : 4
        const val = bytes === 2 ? data.readInt16LE(offset) : data.readInt32LE(offset)
        offset += bytes
        if (val === 0 && offset < data.length) {
          const flag = data[offset]
          if (flag === 0x00 || flag === 0x01) {
            offset += 1
            row[key] = flag === 0x01 ? null : val
          } else {
            row[key] = val
          }
        } else {
          row[key] = val
        }
      } else if (col.type === 'S') {
        const slen = data.readUInt16LE(offset)
        offset += 2
        row[key] = slen > 0 ? data.subarray(offset, offset + slen).toString('utf8') : null
        offset += slen
      } else if (col.type === 'D') {
        const dbl = data.readDoubleLE(offset)
        offset += 8
        if (dbl === D_NULL_SENTINEL || dbl === 0) {
          if (offset < data.length) {
            const flag = data[offset]
            if (flag === 0x00 || flag === 0x01) {
              offset += 1
              row[key] = flag === 0x01 ? null : dbl
            } else {
              row[key] = dbl === 0 ? null : dbl
            }
          } else {
            row[key] = dbl === 0 ? null : dbl
          }
        } else {
          row[key] = dbl
        }
      } else if (col.type === 'F') {
        const dbl = data.readDoubleLE(offset)
        offset += 8
        if (dbl === 0) {
          if (offset < data.length) {
            const flag = data[offset]
            if (flag === 0x00 || flag === 0x01) {
              offset += 1
              row[key] = flag === 0x01 ? null : dbl
            } else {
              row[key] = null
            }
          } else {
            row[key] = null
          }
        } else {
          row[key] = dbl
        }
      } else if (col.type === 'M') {
        const mlen = data.readUInt32LE(offset)
        offset += 4
        row[key] = mlen > 0 ? data.subarray(offset, offset + mlen).toString('utf8') : null
        offset += mlen
      }
    }
    if (!valid) break
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
    'Application=SauvetageMeet',
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

export function restoreSMB(filePath: string, db: Database.Database): { tables: number; rows: number; detail: string } {
  const zipEntries = readZipEntries(filePath)
  const tableDetail: string[] = []
  let totalInserted = 0

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
      if (!gbinData) {
        tableDetail.push(`${tableDef.name}: not found in backup`)
        continue
      }

      const { cols: fileCols, rows } = decodeGbin(gbinData)
      if (rows.length === 0) {
        tableDetail.push(`${tableDef.name}: 0 rows`)
        continue
      }

      // Use intersection of file columns and our expected columns for INSERT
      const fileColNames = new Set(fileCols.map(c => c.name.toLowerCase()))
      const colNames = tableDef.cols.map(c => c.name.toLowerCase()).filter(c => fileColNames.has(c))
      const placeholders = colNames.map(() => '?').join(', ')
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${tableDef.name.toLowerCase()} (${colNames.join(', ')}) VALUES (${placeholders})`
      )

      let inserted = 0
      const insertAll = db.transaction((recs: Record<string, unknown>[]) => {
        for (const row of recs) {
          const vals = colNames.map(c => row[c] ?? null)
          inserted += stmt.run(...vals).changes
        }
      })

      insertAll(rows)
      tableDetail.push(`${tableDef.name}: ${inserted}/${rows.length}`)
      totalInserted += inserted
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }

  return { tables: SMB_TABLES.length, rows: totalInserted, detail: tableDetail.join(', ') }
}
