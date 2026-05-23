/**
 * Prototype C: ONNX digit model engine.
 *
 * Uses a small CNN model (MNIST-style) for single-digit recognition.
 * Input: 28×28 grayscale image → Output: digit 0-9 with confidence.
 *
 * Install: npm install onnxruntime-node
 * Model: resources/mnist_digit_model.onnx (bundled)
 */

import { join } from 'path'
import { app } from 'electron'
import { existsSync } from 'fs'
import type { OcrEngine, OcrResult, CroppedDigit, TimeOcrResult } from './ocrEngine'
import { assembleTimeString } from './ocrEngine'

export class OnnxOcrEngine implements OcrEngine {
  readonly name = 'onnx' as const
  private session: any = null
  private ort: any = null

  async initialize(): Promise<void> {
    try {
      this.ort = await import('onnxruntime-node')
    } catch {
      throw new Error(
        'onnxruntime-node is not installed. Run: npm install onnxruntime-node'
      )
    }

    // Resolve model path
    const modelPath = app.isPackaged
      ? join(process.resourcesPath, 'mnist_digit_model.onnx')
      : join(__dirname, '../../resources/mnist_digit_model.onnx')

    if (!existsSync(modelPath)) {
      throw new Error(
        `ONNX model not found at: ${modelPath}. ` +
        'Place a MNIST digit model at resources/mnist_digit_model.onnx'
      )
    }

    this.session = await this.ort.InferenceSession.create(modelPath)
  }

  async recognizeDigit(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.session || !this.ort) throw new Error('ONNX not initialized')

    // Convert image to 28x28 grayscale float tensor
    // The image should already be 28x28 grayscale PNG from the crop pipeline
    const pixels = await this.imageToTensor(imageBuffer)

    // Create input tensor (batch=1, channels=1, height=28, width=28)
    const inputTensor = new this.ort.Tensor('float32', pixels, [1, 1, 28, 28])

    // Run inference
    const feeds: Record<string, any> = {}
    const inputName = this.session.inputNames[0] || 'input'
    feeds[inputName] = inputTensor

    const results = await this.session.run(feeds)
    const outputName = this.session.outputNames[0] || 'output'
    const output = results[outputName]

    // Apply softmax and find best digit
    const logits = Array.from(output.data as Float32Array)
    const probs = softmax(logits)
    const maxIdx = probs.indexOf(Math.max(...probs))

    return {
      text: String(maxIdx),
      confidence: probs[maxIdx],
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
    if (this.session) {
      // InferenceSession doesn't have a close method in all versions
      this.session = null
    }
    this.ort = null
  }

  /**
   * Convert a PNG/JPEG image buffer to a normalized float32 array.
   * Expected input: 28x28 grayscale image.
   * Output: 784 float values normalized to [0, 1] (MNIST convention: white=0, black=1)
   */
  private async imageToTensor(imageBuffer: Buffer): Promise<Float32Array> {
    // Try to use sharp for reliable image decoding
    try {
      const sharp = (await import('sharp')).default
      const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(28, 28, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })

      const pixels = new Float32Array(784)
      for (let i = 0; i < 784; i++) {
        // MNIST convention: invert (white background = 0, black ink = 1)
        pixels[i] = 1.0 - (data[i] / 255.0)
      }
      return pixels
    } catch {
      // Fallback: assume raw 28x28 grayscale data
      const pixels = new Float32Array(784)
      for (let i = 0; i < Math.min(imageBuffer.length, 784); i++) {
        pixels[i] = 1.0 - (imageBuffer[i] / 255.0)
      }
      return pixels
    }
  }
}

/** Softmax function for converting logits to probabilities */
function softmax(logits: number[]): number[] {
  const max = Math.max(...logits)
  const exps = logits.map((l) => Math.exp(l - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}
