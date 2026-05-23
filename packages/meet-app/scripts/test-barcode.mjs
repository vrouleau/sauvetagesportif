/**
 * Quick test: generate a Code128 barcode image and try to decode it with Quagga2.
 * Run: node scripts/test-barcode.mjs
 */
import Quagga from '@ericblade/quagga2'
import { createCanvas } from 'canvas'

// Minimal Code128B encoder (same as timingSheets.ts)
const CODE128B_PATTERNS = [
  '212222','222122','222221','121223','121322',
  '131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231',
  '113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222',
  '321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123',
  '131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131',
  '113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123',
  '311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422',
  '121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211',
  '241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112',
  '124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141',
  '114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214',
  '211232',  // 105 Start B
  '2331112', // 106 Stop
]

function encodeCode128(text) {
  const values = [104] // Start B
  for (let i = 0; i < text.length; i++) {
    values.push(text.charCodeAt(i) - 32)
  }
  let checksum = values[0]
  for (let i = 1; i < values.length; i++) checksum += values[i] * i
  values.push(checksum % 103)
  values.push(106) // Stop

  const bars = []
  for (const val of values) {
    for (const ch of CODE128B_PATTERNS[val]) bars.push(parseInt(ch))
  }
  return bars
}

// Generate barcode image
const text = 'E1-H1-L5'
const bars = encodeCode128(text)
const totalModules = bars.reduce((a, b) => a + b, 0)
const quietZone = 20
const moduleWidth = 3
const width = (totalModules + quietZone * 2) * moduleWidth
const height = 100

const canvas = createCanvas(width, height)
const ctx = canvas.getContext('2d')
ctx.fillStyle = '#fff'
ctx.fillRect(0, 0, width, height)

let x = quietZone * moduleWidth
let isBar = true
for (const w of bars) {
  if (isBar) {
    ctx.fillStyle = '#000'
    ctx.fillRect(x, 0, w * moduleWidth, height)
  }
  x += w * moduleWidth
  isBar = !isBar
}

// Save as PNG buffer
const buffer = canvas.toBuffer('image/png')
const fs = await import('fs')
fs.writeFileSync('test_barcode.png', buffer)
console.log(`Generated barcode image: ${width}x${height}, text="${text}"`)
console.log('Saved to test_barcode.png')

// Try to decode with Quagga2
console.log('\nAttempting decode with Quagga2...')
Quagga.decodeSingle({
  src: 'data:image/png;base64,' + buffer.toString('base64'),
  numOfWorkers: 0,
  decoder: { readers: ['code_128_reader'] },
  locate: true,
}, (result) => {
  if (result && result.codeResult) {
    console.log('✓ Decoded:', result.codeResult.code)
    console.log('  Format:', result.codeResult.format)
  } else {
    console.log('✗ Failed to decode barcode')
    console.log('  Result:', JSON.stringify(result, null, 2))
  }
})
