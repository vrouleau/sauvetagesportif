/**
 * OCR Engine interface and shared types for timing sheet digit recognition.
 *
 * All OCR prototypes implement this interface, allowing the processing pipeline
 * to swap engines without changing any other code.
 */

/** Result of recognizing a single digit */
export interface OcrResult {
  /** Recognized character (single digit 0-9) */
  text: string
  /** Confidence score 0-1 */
  confidence: number
}

/** A cropped digit image ready for OCR */
export interface CroppedDigit {
  /** Position index in the time string (0-based) */
  index: number
  /** Grayscale image data (PNG or raw pixels) */
  imageData: Buffer
  /** Bounding box in the source image */
  bounds: { x: number; y: number; width: number; height: number }
}

/** Result of recognizing a full time from multiple digits */
export interface TimeOcrResult {
  /** Assembled time string, e.g. "1:23.45" */
  timeString: string
  /** Per-digit recognition results */
  digitResults: OcrResult[]
  /** Overall confidence (product or min of individual confidences) */
  overallConfidence: number
}

/** Abstract OCR engine interface */
export interface OcrEngine {
  /** Engine identifier */
  readonly name: 'tesseract' | 'paddle' | 'onnx' | 'ollama' | 'gemini'

  /** Initialize the engine (load models, spawn processes, etc.) */
  initialize(): Promise<void>

  /** Recognize a single digit from a cropped image */
  recognizeDigit(imageBuffer: Buffer): Promise<OcrResult>

  /** Recognize a full time from an array of cropped digit images */
  recognizeTime(digits: CroppedDigit[]): Promise<TimeOcrResult>

  /** Release resources (terminate workers, kill processes, close sessions) */
  dispose(): Promise<void>
}

// ── Time parsing utilities ────────────────────────────────────────────────────

/**
 * Parse a time string "M:SS.HH" to milliseconds.
 * Supports formats: "M:SS.HH", "SS.HH" (no minutes), "M:SS.HH.CC" (centièmes ignored)
 *
 * Examples:
 *   "1:23.45" → 83450
 *   "0:45.12" → 45120
 *   "2:01.00" → 121000
 */
export function parseTimeToMs(timeStr: string): number {
  // Try M:SS.HH format
  const full = timeStr.match(/^(\d):(\d{2})\.(\d{2})$/)
  if (full) {
    const [, min, sec, hundredths] = full
    return (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000 + parseInt(hundredths, 10) * 10
  }

  // Try SS.HH format (no minutes)
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
 * Assemble individual digit OCR results into a time string.
 * Inserts ':' after position 0 and '.' after position 3 for M:SS.HH format.
 *
 * Digit positions: [M, S, S, H, H] for 5-digit format
 * or [M, S, S, H, H, C, C] for 7-digit format
 */
export function assembleTimeString(digitResults: OcrResult[], format: '5' | '7' = '5'): string {
  const digits = digitResults.map((r) => r.text)
  if (format === '5' && digits.length === 5) {
    return `${digits[0]}:${digits[1]}${digits[2]}.${digits[3]}${digits[4]}`
  }
  if (format === '7' && digits.length === 7) {
    return `${digits[0]}:${digits[1]}${digits[2]}.${digits[3]}${digits[4]}.${digits[5]}${digits[6]}`
  }
  // Fallback: just join digits
  return digits.join('')
}
