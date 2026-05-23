/**
 * Test Ollama vision model on scan images.
 * Run: node scripts/test-ollama.mjs
 */
import fs from 'fs'

const OLLAMA_URL = 'http://localhost:11434'

// Check Ollama is running
try {
  const resp = await fetch(`${OLLAMA_URL}/api/tags`)
  const data = await resp.json()
  console.log('Ollama models:', data.models?.map(m => m.name).join(', ') || 'none')
} catch (e) {
  console.error('Cannot connect to Ollama. Is it running?')
  console.error('Start it with: ollama serve')
  process.exit(1)
}

const prompt = `This image shows a timing sheet from a lifesaving sport competition.
There are two rows of handwritten times in boxes labeled "Chrono 1" and "Chrono 2".
Each time is written as digits in the format M:SS.HH (minutes:seconds.hundredths).

Read the handwritten digits and return ONLY the two times in this exact format:
C1:M:SS.HH
C2:M:SS.HH

If you cannot read a time, write "unclear" for that line.`

for (const img of ['scan_1.png', 'scan_2.png', 'scan_3.png']) {
  if (!fs.existsSync(img)) {
    console.log(`${img}: not found, skipping`)
    continue
  }
  
  console.log(`\n=== ${img} ===`)
  const base64 = fs.readFileSync(img).toString('base64')
  
  const start = Date.now()
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llava:7b',
      prompt,
      images: [base64],
      stream: false,
      options: { temperature: 0, num_predict: 50 },
    }),
  })
  
  if (!resp.ok) {
    console.log('Error:', resp.status, await resp.text())
    continue
  }
  
  const result = await resp.json()
  const elapsed = Date.now() - start
  console.log(`Response (${elapsed}ms):`)
  console.log(result.response)
}
