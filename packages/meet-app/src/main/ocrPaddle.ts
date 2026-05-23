/**
 * Prototype B: PaddleOCR engine via Python subprocess.
 *
 * Communicates with a Python script via stdin/stdout JSON lines.
 * The Python script loads PaddleOCR with a lightweight model and
 * processes digit images on demand.
 *
 * Requires: Python 3.x with paddlepaddle + paddleocr installed.
 * See scripts/paddle_requirements.txt
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import type { OcrEngine, OcrResult, CroppedDigit, TimeOcrResult } from './ocrEngine'
import { assembleTimeString } from './ocrEngine'

export class PaddleOcrEngine implements OcrEngine {
  readonly name = 'paddle' as const
  private process: ChildProcess | null = null
  private ready = false
  private pendingRequests: Map<string, {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }> = new Map()
  private requestId = 0
  private buffer = ''

  async initialize(): Promise<void> {
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'paddle_ocr_server.py')
      : join(__dirname, '../../scripts/paddle_ocr_server.py')

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn('python', [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        this.process.stdout?.on('data', (data: Buffer) => {
          this.buffer += data.toString()
          this.processBuffer()
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim()
          if (msg) console.error('[PaddleOCR]', msg)
        })

        this.process.on('error', (err) => {
          if (!this.ready) {
            reject(new Error(`Failed to start PaddleOCR: ${err.message}. Is Python installed with paddleocr?`))
          }
        })

        this.process.on('close', (code) => {
          this.ready = false
          // Reject all pending requests
          for (const [, { reject: rej }] of this.pendingRequests) {
            rej(new Error(`PaddleOCR process exited with code ${code}`))
          }
          this.pendingRequests.clear()
        })

        // Wait for "ready" message
        const timeout = setTimeout(() => {
          if (!this.ready) reject(new Error('PaddleOCR startup timeout (30s)'))
        }, 30000)

        const checkReady = () => {
          if (this.ready) {
            clearTimeout(timeout)
            resolve()
          } else {
            setTimeout(checkReady, 100)
          }
        }
        checkReady()
      } catch (e) {
        reject(new Error(`Failed to spawn PaddleOCR: ${e instanceof Error ? e.message : String(e)}`))
      }
    })
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || '' // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'ready') {
          this.ready = true
        } else if (msg.type === 'result' && msg.id) {
          const pending = this.pendingRequests.get(msg.id)
          if (pending) {
            this.pendingRequests.delete(msg.id)
            pending.resolve(msg.data)
          }
        } else if (msg.type === 'error' && msg.id) {
          const pending = this.pendingRequests.get(msg.id)
          if (pending) {
            this.pendingRequests.delete(msg.id)
            pending.reject(new Error(msg.message || 'PaddleOCR error'))
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  }

  private sendRequest(action: string, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.ready) {
        reject(new Error('PaddleOCR not ready'))
        return
      }

      const id = String(++this.requestId)
      this.pendingRequests.set(id, { resolve, reject })

      const msg = JSON.stringify({ id, action, ...data }) + '\n'
      this.process.stdin?.write(msg)
    })
  }

  async recognizeDigit(imageBuffer: Buffer): Promise<OcrResult> {
    const result = await this.sendRequest('recognize_digit', {
      image: imageBuffer.toString('base64'),
    })
    return {
      text: String(result.text || '0').charAt(0),
      confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    }
  }

  async recognizeTime(digits: CroppedDigit[]): Promise<TimeOcrResult> {
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
    if (this.process) {
      try {
        this.process.stdin?.write(JSON.stringify({ action: 'quit' }) + '\n')
      } catch { /* ignore */ }
      setTimeout(() => {
        this.process?.kill()
        this.process = null
      }, 1000)
    }
    this.ready = false
    this.pendingRequests.clear()
  }
}
