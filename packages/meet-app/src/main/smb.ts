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

export interface ColDef {
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
    name: 'DSQITEM', cols: [
      { name: 'DSQITEMID', type: 'I', size: 32 },
      { name: 'CODE', type: 'S', size: 10 },
      { name: 'LENEXCODE', type: 'S', size: 10 },
      { name: 'NAME', type: 'S', size: 250 },
      { name: 'OPTIONS', type: 'S', size: 5 },
      { name: 'SORTCODE', type: 'I', size: 16 },
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

export function encodeGbin(tableDef: { name: string; cols: ColDef[] }, rows: Record<string, unknown>[]): Buffer {
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
        let numVal = val != null ? Number(val) : 0
        let isNull = val == null
        // Treat Splash "no time" sentinel (max int32) as null
        if (col.size > 16 && numVal === 2147483647) {
          numVal = 0
          isNull = true
        }
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
          chunks.push(Buffer.from([isNull ? 0x01 : 0x00]))
        }
      } else if (col.type === 'S') {
        const strVal = val != null ? String(val) : ''
        const strBuf = Buffer.from(strVal, 'utf8')
        const lenBuf = Buffer.alloc(2)
        lenBuf.writeUInt16LE(strBuf.length)
        chunks.push(lenBuf)
        if (strBuf.length > 0) chunks.push(strBuf)
      } else if (col.type === 'D') {
        let dblVal: number
        if (val == null) {
          dblVal = D_NULL_SENTINEL
        } else if (typeof val === 'number') {
          dblVal = val
        } else {
          // Could be an ISO date string (from syncDown) or a stringified OLE double
          const str = String(val).trim()
          const asNum = parseFloat(str)
          if (!isNaN(asNum) && !/^\d{4}-/.test(str)) {
            // Looks like a plain number (OLE double as text)
            dblVal = asNum
          } else {
            // Try parsing as ISO date → convert to OLE double
            const dt = new Date(str)
            if (!isNaN(dt.getTime())) {
              dblVal = (dt.getTime() - OLE_EPOCH_MS) / 86400000
            } else {
              dblVal = D_NULL_SENTINEL
            }
          }
        }
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

export const D_NULL_SENTINEL = -36522.0 // OLE date for 1800-01-01 00:00:00

/** OLE Automation epoch: 1899-12-30 in milliseconds since Unix epoch */
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)

// ── GBIN decoding ─────────────────────────────────────────────────────────────

export function decodeGbin(data: Buffer): { cols: ColDef[]; rows: Record<string, unknown>[] } {
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
        } else if (bytes === 4 && val === 2147483647) {
          // Splash "no time" sentinel (max int32) → treat as null
          row[key] = null
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

export interface ZipEntry { name: string; data: Buffer }

export function createZip(entries: ZipEntry[]): Buffer {
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
    let rows = db.prepare(`SELECT ${colNames} FROM ${tableName}`).all() as Record<string, unknown>[]

    // Reverse-map canonical round encoding → Splash MDB encoding for SWIMEVENT
    // so that Splash can read the exported SMB correctly.
    // Canonical: 1=PRE, 2=SEM, 4=FIN, 5=TIM
    // Splash:    2=PRE, 2=SEM, 9=FIN, 1=TIM
    if (tableName === 'swimevent') {
      rows = rows.map(row => {
        const round = row['round'] as number | null
        let newRow = row
        if (round === 1) newRow = { ...newRow, round: 2, eventnumber: 0, gender: 0 }   // PRE → MDB 2 (reset eventnumber & gender)
        else if (round === 4) newRow = { ...newRow, round: 9 }   // FIN → MDB 9
        else if (round === 5) newRow = { ...newRow, round: 1 }   // TIM → MDB 1
        return newRow
      })
    }

    recordCounts[tableDef.name] = rows.length
    totalRows += rows.length

    const gbin = encodeGbin(tableDef, rows)
    entries.push({ name: `${tableDef.name}-0001.gbin`, data: gbin })
  }

  // Generate geologix.ini (matching Splash Meet Manager 11 format)
  // Read DDL versions from BSGLOBAL if available
  const bsgRows = db.prepare(`SELECT name, data FROM bsglobal WHERE name LIKE 'BSDB_DDL_VERSION%'`).all() as Array<{ name: string; data: string | null }>
  const ddlVersions: Record<string, string> = {}
  for (const r of bsgRows) {
    ddlVersions[r.name] = r.data ?? ''
  }

  // All tables Splash expects in the ini (even if we don't export them all)
  const allTableNames = [
    'BSGLOBAL', 'BSSWKATALOGITEM', 'BSPICTURE', 'DSQITEM',
    'SWIMSTYLE', 'SWIMSESSION', 'SWIMEVENT', 'AGEGROUP',
    'RECORDLIST', 'RECORDAGEGROUP', 'RECORDLISTAGEGROUP',
    'RECORD', 'RECORDSPLIT', 'RECORDPOSITION',
    'TIMESTANDARDLIST', 'TIMESTANDARD',
    'CLUB', 'ATHLETE', 'OFFICIAL', 'EVENTRECORD',
    'HEAT', 'JUDGE', 'SWIMRESULT', 'SPLIT',
    'RELAY', 'RELAYPOSITION', 'RELAYSPLIT',
    'RESULTPLACE', 'TIMINGDATA', 'SPLASHMEMESSAGE',
  ]

  const ini = [
    '[Geologix]',
    'Application=Meet Manager 11',
    'Version=11.84087',
    'Identification=BACKUP_MM_MEET_11',
    'NullDateYear=1800',
    'ExtraFiles=0',
    '',
    '[BSGLOBAL]',
    `BSDB_DDL_VERSION_APPLICATION=${ddlVersions['BSDB_DDL_VERSION_APPLICATION'] ?? '20260101'}`,
    `BSDB_DDL_VERSION_PICTURE=${ddlVersions['BSDB_DDL_VERSION_PICTURE'] ?? '01.01'}`,
    `BSDB_DDL_VERSION_SW_KATALOG=${ddlVersions['BSDB_DDL_VERSION_SW_KATALOG'] ?? '01.00'}`,
    '',
    '[RecordCount]',
    ...allTableNames.map(t => `${t}=${recordCounts[t] ?? 0}`),
    '',
    '[Tables]',
    ...allTableNames.map(t => `${t}=${(recordCounts[t] ?? 0) > 0 ? 1 : 0}`),
    '',
  ].join('\r\n')

  entries.push({ name: 'geologix.ini', data: Buffer.from(ini, 'ascii') })

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
  if (typeof db.pragma === 'function') {
    db.pragma('foreign_keys = OFF')
  } else {
    // PostgreSQL: disable FK triggers temporarily
    try { db.exec('SET session_replication_role = replica') } catch { /* ignore */ }
  }
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
      const isPg = typeof (db as any).pragma !== 'function'
      const insertSql = isPg
        ? `INSERT INTO ${tableDef.name.toLowerCase()} (${colNames.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
        : `INSERT OR IGNORE INTO ${tableDef.name.toLowerCase()} (${colNames.join(', ')}) VALUES (${placeholders})`
      const stmt = db.prepare(insertSql)

      let inserted = 0
      // For PG: identify date columns that need sentinel filtering
      const dateColIndices = new Set<number>()
      if (isPg) {
        const colDefsLower = tableDef.cols.map(c => ({ name: c.name.toLowerCase(), type: c.type }))
        colNames.forEach((cn, idx) => {
          const def = colDefsLower.find(d => d.name === cn)
          if (def && def.type === 'D') dateColIndices.add(idx)
        })
      }

      const insertAll = db.transaction((recs: Record<string, unknown>[]) => {
        for (const row of recs) {
          const vals = colNames.map((c, idx) => {
            const v = row[c] ?? null
            // For PG date columns: convert invalid OLE date values to null
            // Valid OLE dates are roughly 2-73000 (1900-2100). Anything else is garbage.
            if (isPg && dateColIndices.has(idx)) {
              if (v === null || v === undefined) return null
              const numVal = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN)
              if (isNaN(numVal) || numVal < 2 || numVal > 73000 || !isFinite(numVal)) return null
            }
            return v
          })
          inserted += stmt.run(...vals).changes
        }
      })

      insertAll(rows)
      tableDetail.push(`${tableDef.name}: ${inserted}/${rows.length}`)
      totalInserted += inserted
    }

    // ── Post-import normalization: Splash time sentinel → NULL ──
    // Splash uses 2147483647 (0x7FFFFFFF, max int32) as "no time" for time fields.
    // This is an application-level convention, not a GBIN null sentinel (which is 0).
    // Normalize these to NULL so msToDisplay() returns undefined → "NT".
    db.prepare(`UPDATE swimresult SET entrytime = NULL WHERE entrytime >= 2147483647`).run()
    db.prepare(`UPDATE swimresult SET swimtime = NULL WHERE swimtime >= 2147483647`).run()

    // ── Post-import normalization: Splash MDB round encoding → canonical ──
    // Splash MDB uses: 1=TimedFinal, 2=Prelim, 9=Final, 11=Break/Pause
    // Our canonical:   1=Prelim,     2=Semi,   4=Final, 5=TimedFinal
    // Detect MDB encoding by presence of round=9 or round=11 (never used in canonical)
    normalizeRoundEncoding(db)
  } finally {
    if (typeof db.pragma === 'function') {
      db.pragma('foreign_keys = ON')
    } else {
      // PostgreSQL: re-enable FK triggers
      try { db.exec('SET session_replication_role = DEFAULT') } catch { /* ignore */ }
    }
  }

  return { tables: SMB_TABLES.length, rows: totalInserted, detail: tableDetail.join(', ') }
}

// ── Round encoding normalization ──────────────────────────────────────────────
//
// Splash Meet Manager (MDB) uses a different round encoding than our canonical
// Lenex-based encoding. When restoring an SMB from Splash, we detect and convert.
//
// Splash MDB encoding:
//   1 = Timed Final (MASTERS heats that are swum as timed finals)
//   2 = Prelim/Heats (preliminary round)
//   9 = Final (linked to a prelim via preveventid)
//  11 = Break/Pause/Admin event (no swimstyle, internal)
//
// Canonical encoding (matches Lenex and our app's createEvent logic):
//   1 = Prelim (PRE)
//   2 = Semifinal (SEM)
//   4 = Final (FIN)
//   5 = Timed Final / Direct Final (TIM)
//  11 = Break/Pause (unchanged, handled via internalevent flag)

function normalizeRoundEncoding(db: Database.Database): void {
  // SMB files always use Splash MDB round encoding (written by saveSMB or by Splash itself).
  // Normalize to our canonical encoding on restore.
  //
  // Safety check: if no events use MDB-specific values (9=Final, 11=Break),
  // and no events have round=1 or round=2, skip normalization (empty or pre-normalized DB).
  const hasEvents = db.prepare(
    `SELECT COUNT(*) AS c FROM swimevent WHERE round IS NOT NULL`
  ).get() as { c: number }

  if (hasEvents.c === 0) return

  // Map round values: MDB → canonical
  // 1 (MDB TimedFinal) → 5 (canonical TIM)
  // 2 (MDB Prelim)     → 1 (canonical PRE)
  // 9 (MDB Final)      → 4 (canonical FIN)
  // 11 (MDB Break)     → 11 (unchanged, admin events)
  // Use a temp value to avoid collisions during remapping (1→5, 2→1 would collide)
  db.prepare(`UPDATE swimevent SET round = -1 WHERE round = 1`).run()
  db.prepare(`UPDATE swimevent SET round = -2 WHERE round = 2`).run()
  db.prepare(`UPDATE swimevent SET round = -9 WHERE round = 9`).run()
  db.prepare(`UPDATE swimevent SET round = 5 WHERE round = -1`).run()  // MDB 1 → TIM
  db.prepare(`UPDATE swimevent SET round = 1 WHERE round = -2`).run()  // MDB 2 → PRE
  db.prepare(`UPDATE swimevent SET round = 4 WHERE round = -9`).run()  // MDB 9 → FIN

  // Mark round=11 (Break/Pause) events as internal
  db.prepare(`UPDATE swimevent SET internalevent = 'T' WHERE round = 11`).run()

  // Fix PRE events that have gender=0 and/or eventnumber=0.
  // In Splash MDB, prelim events store gender=0 and eventnumber=0 because
  // the display values are derived from the paired Timed Final event.
  // The TIM event always immediately precedes its PRE event (sortcode - 1).
  // Fallback: use the FIN event that references this PRE via preveventid.
  const preEvents = db.prepare(`
    SELECT e.swimeventid, e.swimsessionid, e.swimstyleid, e.eventnumber, e.gender, e.sortcode
    FROM swimevent e
    WHERE e.round = 1 AND e.gender = 0 AND e.swimstyleid IS NOT NULL
  `).all() as Array<{
    swimeventid: number; swimsessionid: number; swimstyleid: number
    eventnumber: number; gender: number; sortcode: number
  }>

  for (const pre of preEvents) {
    // Strategy 1: paired TIM event at sortcode - 1 (same session, same swimstyle)
    let gender: number | null = null
    const timEvent = db.prepare(`
      SELECT gender FROM swimevent
      WHERE swimsessionid = ? AND swimstyleid = ? AND round = 5 AND sortcode = ?
      LIMIT 1
    `).get(pre.swimsessionid, pre.swimstyleid, pre.sortcode - 1) as { gender: number } | undefined

    if (timEvent && timEvent.gender !== 0) {
      gender = timEvent.gender
    }

    // Strategy 2: FIN event that references this PRE via preveventid
    if (!gender) {
      const finEvent = db.prepare(`
        SELECT gender FROM swimevent WHERE preveventid = ? AND round = 4 LIMIT 1
      `).get(pre.swimeventid) as { gender: number } | undefined
      if (finEvent && finEvent.gender !== 0) {
        gender = finEvent.gender
      }
    }

    if (gender) {
      db.prepare(`UPDATE swimevent SET gender = ? WHERE swimeventid = ?`).run(gender, pre.swimeventid)
    }
  }

  // Fix PRE events with eventnumber=0.
  // Splash auto-assigns sequential numbers (1, 2, 3...) to prelim events that
  // have eventnumber=0 in the MDB. We replicate this by numbering them in
  // session-number + sortcode order.
  const zeroNumPrelims = db.prepare(`
    SELECT e.swimeventid, e.sortcode, s.sessionnumber
    FROM swimevent e
    JOIN swimsession s ON s.swimsessionid = e.swimsessionid
    WHERE e.round = 1 AND (e.eventnumber = 0 OR e.eventnumber IS NULL)
      AND e.swimstyleid IS NOT NULL
    ORDER BY s.sessionnumber, e.sortcode
  `).all() as Array<{ swimeventid: number; sortcode: number; sessionnumber: number }>

  if (zeroNumPrelims.length > 0) {
    const updateNum = db.prepare(`UPDATE swimevent SET eventnumber = ? WHERE swimeventid = ?`)
    let seq = 1
    for (const pre of zeroNumPrelims) {
      updateNum.run(seq, pre.swimeventid)
      seq++
    }
  }
}
