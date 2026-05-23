/**
 * Try to read the full scan images with Tesseract - no whitelist, 
 * full page mode, see everything it can find.
 * Also try PSM modes optimized for sparse text.
 */
import Tesseract from 'tesseract.js'
import sharp from 'sharp'

for (const img of ['scan_1.png', 'scan_2.png', 'scan_3.png']) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`=== ${img} ===`)
  console.log('='.repeat(60))
  
  // Try full image, no restrictions, different PSM modes
  const psmModes = [
    { mode: '3', desc: 'Fully automatic' },
    { mode: '6', desc: 'Uniform block' },
    { mode: '11', desc: 'Sparse text' },
    { mode: '12', desc: 'Sparse text with OSD' },
  ]
  
  for (const psm of psmModes) {
    const worker = await Tesseract.createWorker('eng')
    await worker.setParameters({
      tessedit_pageseg_mode: psm.mode,
    })
    const { data } = await worker.recognize(img)
    const text = data.text.trim()
    if (text) {
      console.log(`\n  PSM ${psm.mode} (${psm.desc}):`)
      console.log(`  Confidence: ${data.confidence}%`)
      console.log(`  Text: "${text}"`)
    }
    await worker.terminate()
  }
  
  // Now try with just digits whitelist, PSM 11 (sparse), on full image
  const worker2 = await Tesseract.createWorker('eng')
  await worker2.setParameters({
    tessedit_char_whitelist: '0123456789:.',
    tessedit_pageseg_mode: '11',
  })
  const { data: d2 } = await worker2.recognize(img)
  console.log(`\n  Digits-only sparse: "${d2.text.trim()}" (${d2.confidence}%)`)
  await worker2.terminate()
}

console.log('\nDone.')
