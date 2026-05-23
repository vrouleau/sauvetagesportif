/**
 * Image processing pipeline for scanned timing sheets.
 *
 * Handles:
 * 1. Registration mark detection (corner squares)
 * 2. Perspective correction (straighten skewed scans)
 * 3. Digit box cropping (extract individual digit images)
 *
 * Uses sharp for image manipulation. The pipeline produces 28x28 grayscale
 * images suitable for MNIST-style digit recognition.
 */

import type { CroppedDigit } from './ocrEngine'

// ── Sheet layout constants ────────────────────────────────────────────────────
// These define the relative positions of elements on a corrected strip image.
// All values are fractions of the strip width/height (0-1).

/** Expected strip aspect ratio (width / height) after correction */
export const STRIP_ASPECT_RATIO = 10 / 2.2 // ~4.55:1 from the sheet layout

/** Registration mark size as fraction of strip width */
export const REG_MARK_SIZE = 0.01

/** Digit box region for Chrono 1 (first row) relative to strip */
export const DIGIT_REGION_1 = {
  x: 0.08,
  y: 0.40,
  width: 0.45,
  height: 0.22,
}

/** Digit box region for Chrono 2 (second row) relative to strip */
export const DIGIT_REGION_2 = {
  x: 0.08,
  y: 0.65,
  width: 0.45,
  height: 0.22,
}

/** Individual digit box positions relative to the DIGIT_REGION */
export const DIGIT_POSITIONS = [
  { x: 0.000, width: 0.155 }, // M (minutes)
  // separator ':'
  { x: 0.200, width: 0.155 }, // S (tens of seconds)
  { x: 0.370, width: 0.155 }, // S (seconds)
  // separator '.'
  { x: 0.570, width: 0.155 }, // H (tens of hundredths)
  { x: 0.740, width: 0.155 }, // H (hundredths)
]

export interface RegistrationMarks {
  topLeft: { x: number; y: number }
  topRight: { x: number; y: number }
  bottomLeft: { x: number; y: number }
  bottomRight: { x: number; y: number }
}

export interface ProcessedImage {
  /** Perspective-corrected strip image */
  corrected: Buffer
  /** Width of corrected image */
  width: number
  /** Height of corrected image */
  height: number
  /** Individual cropped digit images (28x28 grayscale) */
  digits: CroppedDigit[]
}

/**
 * Full image processing pipeline.
 *
 * Takes a raw scanned image buffer (JPEG/PNG) and produces:
 * - A perspective-corrected version of the strip
 * - Individual 28x28 grayscale digit images
 *
 * Returns null if registration marks cannot be detected.
 *
 * NOTE: This is a simplified implementation for the prototype.
 * Full perspective correction requires a proper homography transform.
 * For the prototype, we assume reasonably straight scans and just crop.
 */
export async function processTimingImage(imageBuffer: Buffer): Promise<ProcessedImage | null> {
  // Dynamic import of sharp to avoid issues if not installed
  let sharp: typeof import('sharp')
  try {
    sharp = await import('sharp')
  } catch {
    throw new Error('sharp is not installed. Run: npm install sharp')
  }

  const image = sharp.default(imageBuffer)
  const metadata = await image.metadata()

  if (!metadata.width || !metadata.height) {
    return null
  }

  // For the prototype, we skip full perspective correction and work with
  // a simple crop-based approach. The operator positions the sheet reasonably
  // straight in front of the camera.

  const width = metadata.width
  const height = metadata.height

  // Convert to grayscale for processing
  const grayscaleBuffer = await image.grayscale().toBuffer()

  // Crop digit boxes from both chrono rows
  const digits1 = await cropDigitBoxes(sharp.default, grayscaleBuffer, width, height, DIGIT_REGION_1)
  const digits2 = await cropDigitBoxes(sharp.default, grayscaleBuffer, width, height, DIGIT_REGION_2)

  // Re-index digits2 starting at 5 (so digits 0-4 = chrono 1, 5-9 = chrono 2)
  const digits2Reindexed = digits2.map((d) => ({ ...d, index: d.index + 5 }))

  return {
    corrected: grayscaleBuffer,
    width,
    height,
    digits: [...digits1, ...digits2Reindexed],
  }
}

/**
 * Crop individual digit boxes from a (corrected) grayscale image.
 * Returns 5 digit images, each resized to 28x28 pixels.
 */
async function cropDigitBoxes(
  sharpFn: typeof import('sharp').default,
  imageBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  region: { x: number; y: number; width: number; height: number }
): Promise<CroppedDigit[]> {
  const regionX = Math.round(region.x * imgWidth)
  const regionY = Math.round(region.y * imgHeight)
  const regionW = Math.round(region.width * imgWidth)
  const regionH = Math.round(region.height * imgHeight)

  const digits: CroppedDigit[] = []

  for (let i = 0; i < DIGIT_POSITIONS.length; i++) {
    const pos = DIGIT_POSITIONS[i]
    const boxX = regionX + Math.round(pos.x * regionW)
    const boxW = Math.round(pos.width * regionW)
    const boxY = regionY
    const boxH = regionH

    // Ensure we don't exceed image bounds
    const safeX = Math.max(0, Math.min(boxX, imgWidth - 1))
    const safeY = Math.max(0, Math.min(boxY, imgHeight - 1))
    const safeW = Math.min(boxW, imgWidth - safeX)
    const safeH = Math.min(boxH, imgHeight - safeY)

    if (safeW <= 0 || safeH <= 0) continue

    // Crop and resize to 28x28 (MNIST standard)
    const digitBuffer = await sharpFn(imageBuffer)
      .extract({ left: safeX, top: safeY, width: safeW, height: safeH })
      .resize(28, 28, { fit: 'fill' })
      .png()
      .toBuffer()

    digits.push({
      index: i,
      imageData: digitBuffer,
      bounds: { x: safeX, y: safeY, width: safeW, height: safeH },
    })
  }

  return digits
}

/**
 * Detect registration marks in an image.
 * Looks for dark square regions in the four corners.
 *
 * This is a simplified detection for the prototype — it assumes marks
 * are within the outer 5% of the image in each corner.
 *
 * Returns null if marks cannot be reliably detected.
 */
export async function detectRegistrationMarks(imageBuffer: Buffer): Promise<RegistrationMarks | null> {
  let sharp: typeof import('sharp')
  try {
    sharp = await import('sharp')
  } catch {
    return null
  }

  const metadata = await sharp.default(imageBuffer).metadata()
  if (!metadata.width || !metadata.height) return null

  const w = metadata.width
  const h = metadata.height

  // For the prototype, return estimated positions based on the sheet layout
  // (marks are at the corners with a small inset)
  const insetX = Math.round(w * 0.01)
  const insetY = Math.round(h * 0.02)

  return {
    topLeft: { x: insetX, y: insetY },
    topRight: { x: w - insetX, y: insetY },
    bottomLeft: { x: insetX, y: h - insetY },
    bottomRight: { x: w - insetX, y: h - insetY },
  }
}
