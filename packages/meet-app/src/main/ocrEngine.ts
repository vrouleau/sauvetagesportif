/**
 * OCR Engine interface and time parsing utilities.
 */

/** Abstract OCR engine interface */
export interface OcrEngine {
  readonly name: string
  initialize(): Promise<void>
  dispose(): Promise<void>
}

// ── Time parsing utilities ────────────────────────────────────────────────────

/**
 * Parse a time string "M:SS.HH" to milliseconds.
 *
 * Examples:
 *   "1:23.45" → 83450
 *   "0:45.12" → 45120
 *   "2:01.00" → 121000
 */
export function parseTimeToMs(timeStr: string): number {
  const full = timeStr.match(/^(\d):(\d{2})\.(\d{2})$/)
  if (full) {
    const [, min, sec, hundredths] = full
    return (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000 + parseInt(hundredths, 10) * 10
  }

  const short = timeStr.match(/^(\d{2})\.(\d{2})$/)
  if (short) {
    const [, sec, hundredths] = short
    return parseInt(sec, 10) * 1000 + parseInt(hundredths, 10) * 10
  }

  throw new Error(`Invalid time format: "${timeStr}". Expected M:SS.HH or SS.HH`)
}

/**
 * Format milliseconds to "M:SS.HH" string.
 *
 * Examples:
 *   83450 → "1:23.45"
 *   45120 → "0:45.12"
 *   121000 → "2:01.00"
 */
export function formatMsToTime(ms: number): string {
  if (ms < 0) throw new Error(`Cannot format negative time: ${ms}`)
  const totalHundredths = Math.round(ms / 10)
  const hundredths = totalHundredths % 100
  const totalSeconds = Math.floor(totalHundredths / 100)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

/**
 * Assemble individual digit results into a time string (M:SS.HH).
 */
export function assembleTimeString(digitResults: Array<{ text: string }>, format: '5' | '7' = '5'): string {
  const digits = digitResults.map((r) => r.text)
  if (format === '5' && digits.length === 5) {
    return `${digits[0]}:${digits[1]}${digits[2]}.${digits[3]}${digits[4]}`
  }
  if (format === '7' && digits.length === 7) {
    return `${digits[0]}:${digits[1]}${digits[2]}.${digits[3]}${digits[4]}.${digits[5]}${digits[6]}`
  }
  return digits.join('')
}
