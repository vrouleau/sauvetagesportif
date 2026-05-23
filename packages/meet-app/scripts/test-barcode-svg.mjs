/**
 * Test: render our SVG barcode to a PNG (simulating what a camera would see
 * from the printed sheet) and try to decode with Quagga2.
 *
 * Run: node scripts/test-barcode-svg.mjs
 */
import Quagga from '@ericblade/quagga2'
import { createCanvas } from 'canvas'

// Same Code128B encoder as timingSheets.ts
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
    const code = text.charCodeAt(i) - 32
    if (code < 0 || code > 95) continue
    values.push(code)
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

const text = 'E1-H1-L5'
const bars = encodeCode128(text)
const totalModules = bars.reduce((a, b) => a + b, 0)
const quietZone = 10
const fullWidth = totalModules + quietZone * 2

// Test at different scales to simulate camera distance
const scales = [1, 2, 3, 5]

for (const scale of scales) {
  const moduleWidth = scale
  const width = fullWidth * moduleWidth
  const height = 50 * scale

  // Simulate what the camera sees: barcode on a white page with some margin
  const pageWidth = width + 100
  const pageHeight = height + 60
  const canvas = createCanvas(pageWidth, pageHeight)
  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pageWidth, pageHeight)

  // Draw barcode centered
  const offsetX = 50
  const offsetY = 30
  let x = offsetX + quietZone * moduleWidth
  let isBar = true
  for (const w of bars) {
    if (isBar) {
      ctx.fillStyle = '#000000'
      ctx.fillRect(x, offsetY, w * moduleWidth, height)
    }
    x += w * moduleWidth
    isBar = !isBar
  }

  const buffer = canvas.toBuffer('image/png')
  const dataUrl = 'data:image/png;base64,' + buffer.toString('base64')

  console.log(`\nScale ${scale}x: ${pageWidth}x${pageHeight}px (barcode ${width}x${height})`)

  // Try decode
  const result = await new Promise((resolve) => {
    Quagga.decodeSingle({
      src: dataUrl,
      numOfWorkers: 0,
      decoder: { readers: ['code_128_reader'] },
      locate: true,
    }, (res) => {
      if (res && res.codeResult && res.codeResult.code) {
        resolve(res.codeResult.code)
      } else {
        resolve(null)
      }
    })
  })

  if (result) {
    console.log(`  ✓ Decoded: "${result}"`)
  } else {
    console.log(`  ✗ Failed to decode`)
  }
}

// Now test with a simulated "camera photo" - barcode is small portion of a larger image
// (like what a webcam would capture)
console.log('\n--- Simulating webcam capture (barcode is small in frame) ---')

const webcamSizes = [
  { w: 640, h: 480, barcodeScale: 2 },
  { w: 1280, h: 720, barcodeScale: 2 },
  { w: 1280, h: 720, barcodeScale: 3 },
]

for (const { w, h, barcodeScale } of webcamSizes) {
  const moduleWidth = barcodeScale
  const barcodeWidth = fullWidth * moduleWidth
  const barcodeHeight = 50 * barcodeScale

  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // Gray background (simulating a desk/paper)
  ctx.fillStyle = '#e0e0e0'
  ctx.fillRect(0, 0, w, h)

  // White paper area in center
  const paperW = w * 0.7
  const paperH = h * 0.6
  const paperX = (w - paperW) / 2
  const paperY = (h - paperH) / 2
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(paperX, paperY, paperW, paperH)

  // Draw barcode on the paper
  const barcodeX = paperX + (paperW - barcodeWidth) / 2
  const barcodeY = paperY + 20
  let bx = barcodeX + quietZone * moduleWidth
  let bIsBar = true
  for (const bw of bars) {
    if (bIsBar) {
      ctx.fillStyle = '#000000'
      ctx.fillRect(bx, barcodeY, bw * moduleWidth, barcodeHeight)
    }
    bx += bw * moduleWidth
    bIsBar = !bIsBar
  }

  const buffer = canvas.toBuffer('image/png')
  const dataUrl = 'data:image/png;base64,' + buffer.toString('base64')

  console.log(`\nWebcam ${w}x${h}, barcode scale=${barcodeScale} (${barcodeWidth}px wide, ${((barcodeWidth/w)*100).toFixed(0)}% of frame)`)

  const result = await new Promise((resolve) => {
    Quagga.decodeSingle({
      src: dataUrl,
      numOfWorkers: 0,
      decoder: { readers: ['code_128_reader'] },
      locate: true,
    }, (res) => {
      if (res && res.codeResult && res.codeResult.code) {
        resolve(res.codeResult.code)
      } else {
        resolve(null)
      }
    })
  })

  if (result) {
    console.log(`  ✓ Decoded: "${result}"`)
  } else {
    console.log(`  ✗ Failed to decode`)
  }
}
