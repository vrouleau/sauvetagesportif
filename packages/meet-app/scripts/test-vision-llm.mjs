/**
 * Test vision LLM on scan images.
 * Tries:
 * 1. OpenAI GPT-4o (if OPENAI_API_KEY is set)
 * 2. Anthropic Claude (if ANTHROPIC_API_KEY is set)
 *
 * Run: set OPENAI_API_KEY=sk-... && node scripts/test-vision-llm.mjs
 * Or:  set ANTHROPIC_API_KEY=sk-ant-... && node scripts/test-vision-llm.mjs
 */
import fs from 'fs'

const images = ['scan_1.png', 'scan_2.png', 'scan_3.png']

const prompt = `This is a photo of a timing sheet from a lifesaving sport competition. 
The sheet has two rows of handwritten times in boxes labeled "Chrono 1" and "Chrono 2".
Each time is in the format M:SS.HH (minutes:seconds.hundredths).

Please read the handwritten times and return them in this exact format:
Chrono 1: M:SS.HH
Chrono 2: M:SS.HH

If you cannot read a time clearly, write "unclear" for that line.
Only return the two lines, nothing else.`

// --- OpenAI ---
async function tryOpenAI(imageBase64) {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      }],
      max_tokens: 100,
    }),
  })
  
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI error ${response.status}: ${err}`)
  }
  
  const data = await response.json()
  return data.choices[0].message.content
}

// --- Anthropic ---
async function tryAnthropic(imageBase64) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  })
  
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic error ${response.status}: ${err}`)
  }
  
  const data = await response.json()
  return data.content[0].text
}

// --- Main ---
const openaiKey = process.env.OPENAI_API_KEY
const anthropicKey = process.env.ANTHROPIC_API_KEY

if (!openaiKey && !anthropicKey) {
  console.log('No API key found. Set one of:')
  console.log('  set OPENAI_API_KEY=sk-...')
  console.log('  set ANTHROPIC_API_KEY=sk-ant-...')
  process.exit(1)
}

console.log('Using:', openaiKey ? 'OpenAI GPT-4o' : 'Anthropic Claude')
console.log()

for (const img of images) {
  console.log(`=== ${img} ===`)
  const buffer = fs.readFileSync(img)
  const base64 = buffer.toString('base64')
  
  try {
    let result
    if (openaiKey) {
      result = await tryOpenAI(base64)
    } else {
      result = await tryAnthropic(base64)
    }
    console.log(result)
  } catch (e) {
    console.log('Error:', e.message)
  }
  console.log()
}
