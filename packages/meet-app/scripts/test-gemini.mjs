/**
 * Test Gemini API directly with a scan image.
 * Run: node scripts/test-gemini.mjs
 */
import fs from 'fs'

const configPath = 'C:\\Users\\eoivnru\\AppData\\Roaming\\@meetmgr\\meet-app\\gemini-config.json'
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
const apiKey = config.apiKey

console.log('API key:', apiKey.substring(0, 10) + '...')

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`

const prompt = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times in digit boxes labeled "Chrono 1" and "Chrono 2".
Each time is in the format M:SS.HH (1 digit for minutes, 2 for seconds, 2 for hundredths).
The separators : and . are pre-printed between the boxes.

Read the handwritten digits carefully and return ONLY the two times in this exact format:
C1:M:SS.HH
C2:M:SS.HH

If you cannot read a time clearly, write "unclear" for that line. Return nothing else.`

const imagePath = 'scan_1.png'
if (!fs.existsSync(imagePath)) {
  console.error('scan_1.png not found')
  process.exit(1)
}

const base64 = fs.readFileSync(imagePath).toString('base64')
console.log('Image size:', fs.statSync(imagePath).size, 'bytes')
console.log('Calling Gemini...')

const start = Date.now()
const response = await fetch(GEMINI_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64 } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 1000 },
  }),
})

const elapsed = Date.now() - start
console.log(`Response status: ${response.status} (${elapsed}ms)`)

if (!response.ok) {
  const err = await response.text()
  console.error('Error:', err)
  process.exit(1)
}

const data = await response.json()
console.log('\nFull response:')
console.log(JSON.stringify(data, null, 2).substring(0, 2000))
const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
console.log('\nGemini response:')
console.log(text)
