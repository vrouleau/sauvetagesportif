/**
 * Test Quagga2 decoding against the debug capture image.
 * Run: node scripts/test-decode-capture.mjs
 */
import Quagga from '@ericblade/quagga2'
import fs from 'fs'
import path from 'path'

const imagePath = 'C:\\Users\\eoivnru\\AppData\\Roaming\\@meetmgr\\meet-app\\debug_capture.png'

if (!fs.existsSync(imagePath)) {
  console.error('Image not found:', imagePath)
  process.exit(1)
}

const buffer = fs.readFileSync(imagePath)
const base64 = buffer.toString('base64')
const dataUrl = `data:image/png;base64,${base64}`

console.log('Image size:', buffer.length, 'bytes')
console.log('Testing with code_128_reader...')

Quagga.decodeSingle({
  src: dataUrl,
  numOfWorkers: 0,
  decoder: {
    readers: ['code_128_reader'],
  },
  locate: true,
}, (result) => {
  if (result && result.codeResult && result.codeResult.code) {
    console.log('✓ SUCCESS:', result.codeResult.code)
    console.log('  Format:', result.codeResult.format)
  } else {
    console.log('✗ No barcode found with locate=true')
    console.log()
    
    // Try again with locate=false (assumes barcode fills the image)
    console.log('Retrying with locate=false...')
    Quagga.decodeSingle({
      src: dataUrl,
      numOfWorkers: 0,
      decoder: {
        readers: ['code_128_reader'],
      },
      locate: false,
    }, (result2) => {
      if (result2 && result2.codeResult && result2.codeResult.code) {
        console.log('✓ SUCCESS (locate=false):', result2.codeResult.code)
      } else {
        console.log('✗ Still no barcode found')
        console.log()
        console.log('Trying with multiple readers...')
        Quagga.decodeSingle({
          src: dataUrl,
          numOfWorkers: 0,
          decoder: {
            readers: ['code_128_reader', 'ean_reader', 'code_39_reader', 'codabar_reader'],
            multiple: true,
          },
          locate: true,
          locator: {
            halfSample: false,
            patchSize: 'large',
          },
        }, (result3) => {
          if (result3 && result3.codeResult && result3.codeResult.code) {
            console.log('✓ Found with multi-reader:', result3.codeResult.code, result3.codeResult.format)
          } else {
            console.log('✗ No barcode detected with any reader')
            console.log('  The barcode may be too small, angled, or low contrast in the image.')
            console.log('  Try holding the sheet closer to the camera so the barcode fills more of the frame.')
          }
        })
      }
    })
  }
})
