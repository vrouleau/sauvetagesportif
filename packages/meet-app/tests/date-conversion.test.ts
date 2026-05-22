/**
 * Date conversion tests — verifies OLE ↔ ISO ↔ SQLite roundtrips.
 *
 * Covers: parseBirthYear, parseBirthDate, parseOleDate, oleToIsoTimestamp,
 *         isoToOle, formatDaytime, and encodeGbin date handling.
 *
 * Run: npx vitest run tests/date-conversion.test.ts
 */
import { describe, it, expect } from 'vitest'
import { encodeGbin, decodeGbin, D_NULL_SENTINEL } from '../src/main/smb'
import type { ColDef } from '../src/main/smb'

// We need to test internal functions from db.ts — import them via a test helper
// Since they're not exported, we'll test them indirectly through the public API
// or re-implement the logic here for unit testing.

// ── OLE epoch constant ────────────────────────────────────────────────────────
const OLE_EPOCH_MS = Date.UTC(1899, 11, 30)

// ── Re-implement the conversion functions for direct testing ──────────────────
// (These mirror the implementations in db.ts exactly)

function parseBirthYear(birthdate: string | number | null): number {
  if (birthdate == null) return 2000
  if (typeof birthdate === 'number') {
    if (birthdate > 0 && birthdate < 200000) {
      const ms = OLE_EPOCH_MS + birthdate * 86400000
      const d = new Date(ms)
      const y = d.getUTCFullYear()
      if (y > 1900 && y < 2100) return y
    }
    return 2000
  }
  const s = String(birthdate).trim()
  if (/^\d{4}-/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10)
    if (y > 1900 && y < 2100) return y
  }
  const dbl = parseFloat(s)
  if (!isNaN(dbl) && dbl > 0 && dbl < 200000) {
    const ms = OLE_EPOCH_MS + dbl * 86400000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    if (y > 1900 && y < 2100) return y
  }
  return 2000
}

function parseBirthDate(birthdate: string | number | null): string {
  if (birthdate == null) return '2000-01-01'
  if (typeof birthdate === 'number') {
    if (birthdate > 0 && birthdate < 200000) {
      const ms = OLE_EPOCH_MS + birthdate * 86400000
      const d = new Date(ms)
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
    return '2000-01-01'
  }
  const s = String(birthdate).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const dbl = parseFloat(s)
  if (!isNaN(dbl) && dbl > 0 && dbl < 200000) {
    const ms = OLE_EPOCH_MS + dbl * 86400000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return '2000-01-01'
}

function parseOleDate(d: string | number | null): string | undefined {
  if (d == null) return undefined
  if (typeof d === 'number') {
    if (d <= 0 || d === -36522) return undefined
    const ms = OLE_EPOCH_MS + d * 86400000
    const dt = new Date(ms)
    const y = dt.getUTCFullYear()
    if (y < 1900 || y > 2100) return undefined
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(dt.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const str = String(d).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10)
  const num = parseFloat(str)
  if (!isNaN(num) && num > 0 && num < 200000) {
    const ms = OLE_EPOCH_MS + num * 86400000
    const dt = new Date(ms)
    const y = dt.getUTCFullYear()
    if (y < 1900 || y > 2100) return undefined
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(dt.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return undefined
}

function oleToIsoTimestamp(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'number') {
    if (v === 0 || v === -36522) return null
    const ms = OLE_EPOCH_MS + v * 86400000
    const dt = new Date(ms)
    if (dt.getUTCFullYear() < 1900 || dt.getUTCFullYear() > 2100) return null
    return dt.toISOString().replace('T', ' ').slice(0, 19)
  }
  const str = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 19)
  const num = parseFloat(str)
  if (!isNaN(num) && num !== 0 && num !== -36522) {
    const ms = OLE_EPOCH_MS + num * 86400000
    const dt = new Date(ms)
    if (dt.getUTCFullYear() < 1900 || dt.getUTCFullYear() > 2100) return null
    return dt.toISOString().replace('T', ' ').slice(0, 19)
  }
  return null
}

function isoToOle(v: unknown): number {
  if (v == null) return -36522
  const str = String(v).trim()
  const num = parseFloat(str)
  if (!isNaN(num) && !/^\d{4}-/.test(str)) return num
  const dt = new Date(str)
  if (isNaN(dt.getTime())) return -36522
  return (dt.getTime() - OLE_EPOCH_MS) / 86400000
}

function formatDaytime(d: string | number | null): string | undefined {
  if (d == null) return undefined
  if (typeof d === 'number') {
    const frac = Math.abs(d) % 1
    if (frac === 0) return undefined
    const totalMinutes = Math.round(frac * 24 * 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}:${String(minutes).padStart(2, '0')}`
  }
  const str = String(d)
  const match = str.match(/(\d{2}):(\d{2})/)
  if (match) return `${parseInt(match[1])}:${match[2]}`
  const num = parseFloat(str)
  if (!isNaN(num)) {
    const frac = Math.abs(num) % 1
    if (frac === 0) return undefined
    const totalMinutes = Math.round(frac * 24 * 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}:${String(minutes).padStart(2, '0')}`
  }
  return undefined
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseBirthYear', () => {
  it('parses ISO date string', () => {
    expect(parseBirthYear('1978-08-23')).toBe(1978)
    expect(parseBirthYear('2010-03-15 00:00:00')).toBe(2010)
  })

  it('parses OLE double as string (SMB restore format)', () => {
    expect(parseBirthYear('28725.0')).toBe(1978)  // 1978-08-23
    expect(parseBirthYear('40247.0')).toBe(2010)  // 2010-03-15
  })

  it('parses OLE double as number (SQLite dynamic typing)', () => {
    expect(parseBirthYear(28725)).toBe(1978)
    expect(parseBirthYear(40247)).toBe(2010)
  })

  it('returns 2000 for null/undefined', () => {
    expect(parseBirthYear(null)).toBe(2000)
  })

  it('returns 2000 for invalid/corrupt data', () => {
    expect(parseBirthYear('garbage')).toBe(2000)
    expect(parseBirthYear('')).toBe(2000)
    expect(parseBirthYear(0)).toBe(2000)
    expect(parseBirthYear(-36522)).toBe(2000)
  })

  it('returns 2000 for out-of-range years', () => {
    // Years outside 1900-2100 should fallback
    expect(parseBirthYear(0)).toBe(2000)
    expect(parseBirthYear(-36522)).toBe(2000)
  })
})

describe('parseBirthDate', () => {
  it('parses ISO date string', () => {
    expect(parseBirthDate('1978-08-23')).toBe('1978-08-23')
    expect(parseBirthDate('2010-03-15 00:00:00')).toBe('2010-03-15')
  })

  it('parses OLE double as string', () => {
    expect(parseBirthDate('28725.0')).toBe('1978-08-23')
  })

  it('parses OLE double as number', () => {
    expect(parseBirthDate(28725)).toBe('1978-08-23')
  })

  it('returns fallback for null', () => {
    expect(parseBirthDate(null)).toBe('2000-01-01')
  })
})

describe('parseOleDate', () => {
  it('parses positive OLE double (real date)', () => {
    // 46188 days from 1899-12-30 = 2026-06-15
    const result = parseOleDate(46188)
    expect(result).toBe('2026-06-15')
    expect(parseOleDate(28725)).toBe('1978-08-23')
  })

  it('parses OLE double as string', () => {
    expect(parseOleDate('28725.0')).toBe('1978-08-23')
  })

  it('parses ISO date string', () => {
    expect(parseOleDate('2026-06-15')).toBe('2026-06-15')
    expect(parseOleDate('2026-06-15 08:00:00')).toBe('2026-06-15')
  })

  it('returns undefined for null sentinel', () => {
    expect(parseOleDate(-36522)).toBeUndefined()
    expect(parseOleDate('-36522.0')).toBeUndefined()
  })

  it('returns undefined for zero', () => {
    expect(parseOleDate(0)).toBeUndefined()
    expect(parseOleDate('0.0')).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(parseOleDate(null)).toBeUndefined()
  })

  it('returns undefined for negative values', () => {
    expect(parseOleDate(-100)).toBeUndefined()
  })
})

describe('oleToIsoTimestamp', () => {
  it('converts OLE double to ISO timestamp', () => {
    expect(oleToIsoTimestamp(28725)).toBe('1978-08-23 00:00:00')
  })

  it('converts OLE double with time fraction', () => {
    const result = oleToIsoTimestamp(28725.5)  // 1978-08-23 12:00 UTC
    expect(result).toBe('1978-08-23 12:00:00')
  })

  it('converts OLE string to ISO timestamp', () => {
    expect(oleToIsoTimestamp('28725.0')).toBe('1978-08-23 00:00:00')
  })

  it('passes through ISO timestamp', () => {
    expect(oleToIsoTimestamp('2026-06-15 08:00:00')).toBe('2026-06-15 08:00:00')
  })

  it('returns null for null sentinel', () => {
    expect(oleToIsoTimestamp(-36522)).toBeNull()
    expect(oleToIsoTimestamp(0)).toBeNull()
    expect(oleToIsoTimestamp(null)).toBeNull()
  })
})

describe('isoToOle', () => {
  it('converts ISO date to OLE double', () => {
    // isoToOle uses new Date() which parses ISO dates as UTC when format is YYYY-MM-DD
    const ole = isoToOle('1978-08-23T00:00:00.000Z')
    expect(Math.round(ole)).toBe(28725)
  })

  it('converts ISO timestamp to OLE double with fraction', () => {
    const ole = isoToOle('2026-06-15T12:00:00.000Z')
    expect(Math.floor(ole)).toBe(46188)
    expect(ole % 1).toBeCloseTo(0.5, 4)  // noon = 0.5
  })

  it('passes through existing OLE double string', () => {
    expect(isoToOle('28725.0')).toBe(28725)
  })

  it('returns null sentinel for null', () => {
    expect(isoToOle(null)).toBe(-36522)
  })

  it('returns null sentinel for invalid date', () => {
    expect(isoToOle('garbage')).toBe(-36522)
  })
})

describe('formatDaytime', () => {
  it('extracts time from OLE double with null sentinel date', () => {
    expect(formatDaytime(-36522.333333333336)).toBe('8:00')
    expect(formatDaytime(-36522.375)).toBe('9:00')
    expect(formatDaytime(-36522.5)).toBe('12:00')
    expect(formatDaytime(-36522.25)).toBe('6:00')
  })

  it('extracts time from OLE string', () => {
    expect(formatDaytime('-36522.333333333336')).toBe('8:00')
    expect(formatDaytime('-36522.375')).toBe('9:00')
  })

  it('extracts time from ISO timestamp string', () => {
    expect(formatDaytime('2026-06-15 08:30:00')).toBe('8:30')
    expect(formatDaytime('2000-01-01 14:15:00')).toBe('14:15')
  })

  it('returns undefined for null', () => {
    expect(formatDaytime(null)).toBeUndefined()
  })

  it('returns undefined for zero (no time)', () => {
    expect(formatDaytime(0)).toBeUndefined()
    expect(formatDaytime('0.0')).toBeUndefined()
  })

  it('returns undefined for null sentinel without time', () => {
    expect(formatDaytime(-36522)).toBeUndefined()
    expect(formatDaytime('-36522.0')).toBeUndefined()
  })
})

describe('OLE ↔ ISO roundtrip', () => {
  it('ISO → OLE → ISO preserves date', () => {
    const iso = '1978-08-23T00:00:00.000Z'
    const ole = isoToOle(iso)
    const back = oleToIsoTimestamp(ole)
    expect(back).toBe('1978-08-23 00:00:00')
  })

  it('OLE → ISO → OLE preserves value (date-only)', () => {
    const ole = 28725  // 1978-08-23
    const iso = oleToIsoTimestamp(ole)!
    expect(iso).toBe('1978-08-23 00:00:00')
    // isoToOle parses the ISO string back
    const back = isoToOle(iso + 'Z')  // make it UTC-explicit
    expect(back).toBeCloseTo(ole, 0)
  })

  it('birthdate roundtrip: OLE number → parseBirthDate → isoToOle', () => {
    const oleNum = 28725  // 1978-08-23
    const isoDate = parseBirthDate(oleNum)
    expect(isoDate).toBe('1978-08-23')
    const back = isoToOle(isoDate + 'T00:00:00.000Z')
    expect(Math.round(back)).toBe(oleNum)
  })
})

describe('encodeGbin date handling with ISO strings', () => {
  const cols: ColDef[] = [
    { name: 'ID', type: 'I', size: 32 },
    { name: 'BIRTHDATE', type: 'D', size: 32 },
  ]

  it('encodes ISO date string as OLE double', () => {
    const rows = [{ id: 1, birthdate: '1978-08-23' }]
    const encoded = encodeGbin({ name: 'TEST', cols }, rows)
    const { rows: decoded } = decodeGbin(encoded)
    // Should decode back to the OLE double for 1978-08-23
    expect(decoded[0].birthdate).toBeCloseTo(28725, 0)
  })

  it('encodes ISO timestamp as OLE double', () => {
    const rows = [{ id: 1, birthdate: '2026-06-15T12:00:00.000Z' }]
    const encoded = encodeGbin({ name: 'TEST', cols }, rows)
    const { rows: decoded } = decodeGbin(encoded)
    expect(Math.floor(decoded[0].birthdate as number)).toBe(46188)
    expect((decoded[0].birthdate as number) % 1).toBeCloseTo(0.5, 4)
  })

  it('encodes OLE double number as-is', () => {
    const rows = [{ id: 1, birthdate: 28725.0 }]
    const encoded = encodeGbin({ name: 'TEST', cols }, rows)
    const { rows: decoded } = decodeGbin(encoded)
    expect(decoded[0].birthdate).toBe(28725.0)
  })

  it('encodes OLE double string as number', () => {
    const rows = [{ id: 1, birthdate: '28725.0' }]
    const encoded = encodeGbin({ name: 'TEST', cols }, rows)
    const { rows: decoded } = decodeGbin(encoded)
    expect(decoded[0].birthdate).toBeCloseTo(28725, 0)
  })

  it('encodes null as null sentinel', () => {
    const rows = [{ id: 1, birthdate: null }]
    const encoded = encodeGbin({ name: 'TEST', cols }, rows)
    const { rows: decoded } = decodeGbin(encoded)
    expect(decoded[0].birthdate).toBeNull()
  })
})
