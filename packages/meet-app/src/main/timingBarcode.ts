/**
 * Timing sheet barcode encoding/decoding.
 *
 * Format: E{eventNumber}-H{heatNumber}-L{lane}
 * Example: "E5-H2-L3" → Event 5, Heat 2, Lane 3
 *
 * Each strip has both chronos' time entries, so no judge identifier needed.
 */

export interface BarcodeData {
  eventNumber: number
  heatNumber: number
  lane: number
}

/**
 * Encode timing sheet identity into a barcode string.
 */
export function encodeBarcode(
  eventNumber: number,
  heatNumber: number,
  lane: number,
  _judgeNumber?: number // kept for API compat, ignored
): string {
  if (eventNumber < 1) throw new Error(`Invalid eventNumber: ${eventNumber}`)
  if (heatNumber < 1) throw new Error(`Invalid heatNumber: ${heatNumber}`)
  if (lane < 1) throw new Error(`Invalid lane: ${lane}`)
  return `E${eventNumber}-H${heatNumber}-L${lane}`
}

/**
 * Decode a barcode string back into its components.
 * Returns null if the string doesn't match the expected format.
 */
export function decodeBarcode(raw: string): BarcodeData | null {
  const match = raw.match(/^E(\d+)-H(\d+)-L(\d+)$/)
  if (!match) return null
  const [, eventStr, heatStr, laneStr] = match
  return {
    eventNumber: parseInt(eventStr, 10),
    heatNumber: parseInt(heatStr, 10),
    lane: parseInt(laneStr, 10),
  }
}
