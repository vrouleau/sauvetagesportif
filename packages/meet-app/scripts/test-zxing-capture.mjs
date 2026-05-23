/**
 * Test zxing-wasm decoding against the debug capture image.
 * Run: node scripts/test-zxing-capture.mjs
 */
import { readBarcodesFromImageFile } from 'zxing-wasm'
import fs from 'fs'

const imagePath = 'C:\\Users\\eoivnru\\AppData\\Roaming\\@meetmgr\\meet-app\\debug_capture.png'

if (!fs.existsSync(imagePath)) {
  console.error('Image not found:', imagePath)
  process.exit(1)
}

const buffer = fs.readFileSync(imagePath)
console.log('Image size:', buffer.length, 'bytes')
console.log('Testing with zxing-wasm readBarcodesFromImageFile...')

try {
  const results = await readBarcodesFromImageFile(buffer, { formats: ['Code128'] })
  console.log('Results count:', results.length)
  if (results.length > 0) {
    for (const r of results) {
      console.log('✓ Found:', r.text, '| format:', r.format)
    }
  } else {
    console.log('✗ No barcode found')
    
    // Try with all formats
    console.log('\nRetrying with all formats...')
    const results2 = await readBarcodesFromImageFile(buffer, { formats: [] })
    console.log('Results count:', results2.length)
    for (const r of results2) {
      console.log('  Found:', r.text, '| format:', r.format)
    }
    if (results2.length === 0) {
      console.log('  ✗ No barcode found with any format')
    }
  }
} catch (err) {
  console.error('Error:', err)
}
