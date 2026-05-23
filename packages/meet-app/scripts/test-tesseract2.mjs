/**
 * Test Tesseract.js on scan - no whitelist, see everything it reads.
 * Run: node scripts/test-tesseract2.mjs
 */
import Tesseract from 'tesseract.js'

const imagePath = 'scan_1.png'

console.log('Running full OCR (no whitelist) on', imagePath)
const worker = await Tesseract.createWorker('eng')

const { data } = await worker.recognize(imagePath)
console.log('\nFull text:')
console.log(data.text)
console.log('\nConfidence:', data.confidence)
console.log('\nWords found:', data.words?.length)
data.words?.forEach(w => {
  if (w.confidence > 50) {
    console.log(`  "${w.text}" (${w.confidence}%) at [${w.bbox.x0},${w.bbox.y0}]-[${w.bbox.x1},${w.bbox.y1}]`)
  }
})

await worker.terminate()
