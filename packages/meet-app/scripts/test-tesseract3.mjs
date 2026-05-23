/**
 * Try aggressive crops on the scan images to find the handwritten digits.
 * The sheet layout has:
 * - Top: event info
 * - Middle: barcode (full width)
 * - Bottom: two rows of digit boxes (Chrono 1, Chrono 2)
 *
 * When the user holds the sheet in front of the camera, the digit area
 * is roughly in the lower 40-60% of the frame.
 */
import Tesseract from 'tesseract.js'
import sharp from 'sharp'

const images = ['scan_1.png', 'scan_2.png', 'scan_3.png']

const worker = await Tesseract.createWorker('eng')
await worker.setParameters({
  tessedit_char_whitelist: '0123456789:.',
  tessedit_pageseg_mode: '6', // Assume uniform block of text
})

for (const img of images) {
  console.log(`\n=== ${img} ===`)
  const meta = await sharp(img).metadata()
  const w = meta.width
  const h = meta.height
  
  // Try many different crops to find where the digits are
  const crops = [
    // Lower portions (where digit boxes should be)
    { name: 'lower-40%', left: 0, top: Math.round(h*0.6), width: w, height: Math.round(h*0.4) },
    { name: 'lower-50% left-half', left: 0, top: Math.round(h*0.5), width: Math.round(w*0.5), height: Math.round(h*0.5) },
    { name: 'lower-50% right-half', left: Math.round(w*0.5), top: Math.round(h*0.5), width: Math.round(w*0.5), height: Math.round(h*0.5) },
    { name: 'middle-band', left: 0, top: Math.round(h*0.35), width: w, height: Math.round(h*0.35) },
    { name: 'center-60%', left: Math.round(w*0.2), top: Math.round(h*0.3), width: Math.round(w*0.6), height: Math.round(h*0.4) },
  ]
  
  for (const crop of crops) {
    try {
      const buf = await sharp(img).extract(crop).toBuffer()
      const result = await worker.recognize(buf)
      const text = result.data.text.trim().replace(/\s+/g, ' ')
      if (text && result.data.confidence > 20) {
        console.log(`  ${crop.name}: "${text}" (conf: ${result.data.confidence}%)`)
      }
    } catch (e) {
      // skip invalid crops
    }
  }
  
  // Also save the lower-40% crop for visual inspection
  await sharp(img)
    .extract({ left: 0, top: Math.round(h*0.6), width: w, height: Math.round(h*0.4) })
    .toFile(img.replace('.png', '_lower.png'))
  console.log(`  Saved ${img.replace('.png', '_lower.png')} for inspection`)
}

await worker.terminate()
console.log('\nDone.')
