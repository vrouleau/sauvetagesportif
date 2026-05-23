/**
 * Test Tesseract.js OCR on a captured scan image.
 * Run: node scripts/test-tesseract.mjs
 */
import Tesseract from 'tesseract.js'
import sharp from 'sharp'

const imagePath = 'scan_1.png'

console.log('Loading image...')
const metadata = await sharp(imagePath).metadata()
console.log(`Image: ${metadata.width}x${metadata.height} ${metadata.format}`)

// First, let's try full-image OCR to see what Tesseract finds
console.log('\n--- Full image OCR ---')
const worker = await Tesseract.createWorker('eng')
await worker.setParameters({
  tessedit_char_whitelist: '0123456789:.',
})

const { data } = await worker.recognize(imagePath)
console.log('Full text found:', JSON.stringify(data.text.trim()))
console.log('Confidence:', data.confidence)

// Now try cropping to where digits might be
// The sheet has digit boxes in the lower portion
// Let's try different crop regions
const regions = [
  { name: 'bottom-half', top: 360, left: 0, width: 1280, height: 360 },
  { name: 'bottom-third', top: 480, left: 0, width: 1280, height: 240 },
  { name: 'center', top: 240, left: 200, width: 880, height: 300 },
  { name: 'lower-left', top: 400, left: 0, width: 640, height: 320 },
]

for (const region of regions) {
  const cropped = await sharp(imagePath)
    .extract(region)
    .toBuffer()
  
  const result = await worker.recognize(cropped)
  const text = result.data.text.trim()
  if (text) {
    console.log(`\n${region.name}: "${text}" (confidence: ${result.data.confidence})`)
  } else {
    console.log(`\n${region.name}: (nothing found)`)
  }
}

await worker.terminate()
console.log('\nDone.')
