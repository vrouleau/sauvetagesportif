/**
 * OCR engine using a local Ollama vision model (e.g. moondream, llava).
 *
 * Ollama must be running locally (http://localhost:11434).
 * Install: https://ollama.com/download
 * Pull a vision model: ollama pull moondream
 *
 * This sends the full strip image to the vision model and asks it
 * to read the two handwritten times.
 */

import type { OcrEngine, OcrResult, CroppedDigit, TimeOcrResult } from './ocrEngine'

const OLLAMA_URL = 'http://localhost:11434'

const PROMPT = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times in boxes labeled "Chrono 1" and "Chrono 2".
Each time is written as digits in the format M:SS.HH (minutes:seconds.hundredths).

Read the handwritten digits and return ONLY the two times in this exact format:
C1:M:SS.HH
C2:M:SS.HH

For example:
C1:1:23.45
C2:1:24.02

If you cannot read a time, write "unclear" for that line.`

export class OllamaOcrEngine implements OcrEngine {
  readonly name = 'ollama' as const
  private model = 'moondream'
  private available = false

  async initialize(): Promise<void> {
    // Check if Ollama is running and has a vision model
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`)
      if (!resp.ok) throw new Error(`Ollama not responding: ${resp.status}`)

      const data = await resp.json() as { models: Array<{ name: string }> }
      const models = data.models?.map((m) => m.name) ?? []

      // Prefer moondream (small, fast), then llava, then any available
      const visionModels = ['moondream', 'llava', 'llava:7b', 'llava:13b', 'bakllava']
      for (const vm of visionModels) {
        if (models.some((m) => m.startsWith(vm))) {
          this.model = models.find((m) => m.startsWith(vm))!
          break
        }
      }

      // If no known vision model, try the first available
      if (!models.some((m) => m.startsWith(this.model))) {
        if (models.length > 0) {
          this.model = models[0]
        } else {
          throw new Error(
            'No models found in Ollama. Pull a vision model: ollama pull moondream'
          )
        }
      }

      this.available = true
      console.log(`[OllamaOCR] Using model: ${this.model}`)
    } catch (e) {
      throw new Error(
        `Cannot connect to Ollama at ${OLLAMA_URL}. ` +
        `Make sure Ollama is running (ollama serve). Error: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  async recognizeDigit(imageBuffer: Buffer): Promise<OcrResult> {
    // Not used for this engine — we process the full image at once
    return { text: '0', confidence: 0 }
  }

  async recognizeTime(digits: CroppedDigit[]): Promise<TimeOcrResult> {
    // Not used — we use recognizeFullImage instead
    return { timeString: '', digitResults: [], overallConfidence: 0 }
  }

  /**
   * Recognize both chrono times from a full strip image.
   * Returns { time1, time2, confidence }
   */
  async recognizeFullImage(imageBuffer: Buffer): Promise<{
    time1: string
    time2: string
    confidence: number
  }> {
    if (!this.available) throw new Error('Ollama not initialized')

    const base64 = imageBuffer.toString('base64')

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: PROMPT,
        images: [base64],
        stream: false,
        options: {
          temperature: 0,
          num_predict: 50,
        },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Ollama error ${response.status}: ${err}`)
    }

    const result = await response.json() as { response: string }
    const text = result.response.trim()

    // Parse the response
    return parseOllamaResponse(text)
  }

  async dispose(): Promise<void> {
    this.available = false
  }
}

/**
 * Parse Ollama response text into structured times.
 * Expected format:
 *   C1:1:23.45
 *   C2:1:24.02
 */
function parseOllamaResponse(text: string): { time1: string; time2: string; confidence: number } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  let time1 = ''
  let time2 = ''

  for (const line of lines) {
    // Try C1: or Chrono 1: prefix
    const m1 = line.match(/^(?:C1|Chrono\s*1)\s*[:=]\s*(.+)$/i)
    if (m1) {
      time1 = m1[1].trim()
      continue
    }
    const m2 = line.match(/^(?:C2|Chrono\s*2)\s*[:=]\s*(.+)$/i)
    if (m2) {
      time2 = m2[1].trim()
      continue
    }
  }

  // If we didn't find prefixed lines, try to extract any time-like patterns
  if (!time1 && !time2) {
    const timePattern = /(\d{1,2}:\d{2}\.\d{2})/g
    const matches = text.match(timePattern)
    if (matches && matches.length >= 1) time1 = matches[0]
    if (matches && matches.length >= 2) time2 = matches[1]
  }

  const confidence = (time1 && time1 !== 'unclear' && time2 && time2 !== 'unclear') ? 0.8 : 0.3

  return { time1, time2, confidence }
}
