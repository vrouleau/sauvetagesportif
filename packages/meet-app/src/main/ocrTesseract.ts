/**
 * Prototype A: Tesseract.js OCR engine.
 *
 * Uses Tesseract WASM for single-character digit recognition.
 * Configuration: PSM 10 (single character), whitelist 0-9.
 *
 * Install: npm install tesseract.js
 */

import type { OcrEngine, OcrResult, CroppedDigit, TimeOcrResult } from './ocrEngine'
import { assembleTimeString } from './ocrEngine'

export class TesseractOcrEngine implements OcrEngine {
  readonly name = 'tesseract' as const
  private worker: any = null

  async initialize(): Promise<void> {
    try {
      const Tesseract = await import('tesseract.js')
      // Use local worker and trained data for offline operation
      this.worker = await Tesseract.createWorker('eng', undefined, {
        // In production, trained data is bundled; in dev, downloaded on first use
        cacheMethod: 'write',
      })
      // Configure for single digit recognition
      await this.worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '10', // PSM 10 = single character
      })
    } catch (e) {
      throw new Error(
        `Failed to initialize Tesseract.js: ${e instanceof Error ? e.message : String(e)}. ` +
        'Make sure tesseract.js is installed: npm install tesseract.js'
      )
    }
  }

  async recognizeDigit(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.worker) throw new Error('Tesseract not initialized')

    const { data } = await this.worker.recognize(imageBuffer)
    const text = data.text.trim().charAt(0) || '0'
    const confidence = data.confidence / 100 // Tesseract returns 0-100

    return { text, confidence }
  }

  async recognizeTime(digits: CroppedDigit[]): Promise<TimeOcrResult> {
    if (!this.worker) throw new Error('Tesseract not initialized')

    const digitResults: OcrResult[] = []

    for (const digit of digits) {
      const result = await this.recognizeDigit(digit.imageData)
      digitResults.push(result)
    }

    const timeString = assembleTimeString(digitResults)
    const overallConfidence = digitResults.length > 0
      ? digitResults.reduce((min, r) => Math.min(min, r.confidence), 1)
      : 0

    return { timeString, digitResults, overallConfidence }
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
    }
  }
}
