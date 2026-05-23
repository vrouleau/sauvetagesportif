/**
 * Try preprocessing (sharpen, threshold) before Tesseract OCR.
 */
import Tesseract from 'tesseract.js'
import sharp from 'sharp'

const worker = await Tesseract.createWorker('eng')
await worker.setParameters({
  tessedit_char_whitelist: '0123456789:.',
  tessedit_pageseg_mode: '6',
})

for (const img of ['scan_1.png', 'scan_2.png', 'scan_3.png']) {
  console.log(`\n=== ${img} ===`)
  const meta = await sharp(img).metadata()
  const w = meta.width
  const h = meta.height
  
  // Crop lower 40%
  const cropped = await sharp(img)
    .extract({ left: 0, top: Math.round(h * 0.6), width: w, height: Math.round(h * 0.4) })
    .toBuffer()
  
  // Raw crop
  const r1 = await worker.recognize(cropped)
  console.log('  Raw:', JSON.stringify(r1.data.text.trim()), `(${r1.data.confidence}%)`)
  
  // Grayscale + sharpen
  const sharpened = await sharp(cropped).grayscale().sharpen({ sigma: 2 }).toBuffer()
  const r2 = await worker.recognize(sharpened)
  console.log('  Sharpened:', JSON.stringify(r2.data.text.trim()), `(${r2.data.confidence}%)`)
  
  // High contrast (normalize)
  const normalized = await sharp(cropped).grayscale().normalize().toBuffer()
  const r3 = await worker.recognize(normalized)
  console.log('  Normalized:', JSON.stringify(r3.data.text.trim()), `(${r3.data.confidence}%)`)
  
  // Threshold to pure B&W
  const thresholded = await sharp(cropped).grayscale().threshold(128).toBuffer()
  const r4 = await worker.recognize(thresholded)
  console.log('  Threshold:', JSON.stringify(r4.data.text.trim()), `(${r4.data.confidence}%)`)
  
  // Sharpen + normalize + larger
  const enhanced = await sharp(cropped)
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .resize(w * 2, null) // 2x upscale
    .toBuffer()
  const r5 = await worker.recognize(enhanced)
  console.log('  Enhanced 2x:', JSON.stringify(r5.data.text.trim()), `(${r5.data.confidence}%)`)
  
  // Save best for inspection
  await sharp(cropped).grayscale().normalize().sharpen({ sigma: 1.5 }).toFile(img.replace('.png', '_enhanced.png'))
}

await worker.terminate()
console.log('\nDone.')
