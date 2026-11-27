// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Benchmark Gemini models on timing-sheet OCR (the "C1/C2" chrono strip).
 *
 * Runs the exact same prompt, parser and request shape as src/main/ocrGemini.ts,
 * but against any list of models, and scores them against known-good times.
 * Standalone: no Electron, no app database needed (unless you use --db).
 *
 * Run with Node >= 22.18 (native TypeScript type stripping), from packages/meet-app:
 *
 *   export GEMINI_API_KEY=...        # a paid-tier key avoids 429s on bigger sets
 *
 *   # A) a folder of JPEGs + a labels CSV ("file,c1,c2", times like 1:23.45)
 *   node scripts/benchmark-ocr.ts --images ./scans --labels ./scans/labels.csv \
 *        --models gemini-2.5-flash-lite,gemini-2.5-flash,gemini-3.1-flash-lite
 *
 *   # B) straight from the app's scan DB, using the human-validated times as truth
 *   #    (needs better-sqlite3 built for system Node: `npm rebuild better-sqlite3`)
 *   node scripts/benchmark-ocr.ts --db "%APPDATA%/sauvetagemeet/timing_scans.sqlite" --limit 50 \
 *        --models gemini-2.5-flash-lite,gemini-2.5-flash
 *
 * Options:
 *   --models a,b,c         model ids to compare (default: the two the app uses today)
 *   --limit N              use at most N sheets (random sample, seeded)
 *   --seed N               sample seed (default 1)
 *   --repeat N             run each sheet N times per model, to measure run-to-run noise (default 1)
 *   --thinking-budget N    send generationConfig.thinkingConfig.thinkingBudget=N (default: not sent,
 *                          i.e. identical to production). 0 turns thinking off on 2.5 models.
 *   --max-output-tokens N  default 1000 (same as production)
 *   --price m=in,out       USD per 1M tokens for model m (repeatable); enables a cost column
 *   --delay-ms N           pause between requests (default 250)
 *   --out DIR              where to write results.csv / summary.json (default ./ocr-benchmark-out)
 *
 * Scoring: a time is "correct" when it equals the label to the hundredth.
 * "Sheet correct" = both chronos right. "Unclear" = the model declined (counts as wrong
 * but is the safe failure: the app asks a human). "Confident-wrong" = a plausible time
 * that is incorrect: this is the dangerous failure and the number to minimise.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { CHRONO_PROMPT, parseChronoTimes } from '../src/main/blankTimingSheet.ts'

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const a: Record<string, string[]> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    ;(a[k] ??= []).push(v)
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const opt = (k: string, d?: string) => args[k]?.[0] ?? d
const MODELS = (opt('models', 'gemini-2.5-flash-lite,gemini-2.5-flash') as string).split(',').map((s) => s.trim()).filter(Boolean)
const LIMIT = opt('limit') ? Number(opt('limit')) : Infinity
const SEED = Number(opt('seed', '1'))
const REPEAT = Math.max(1, Number(opt('repeat', '1')))
const THINK = opt('thinking-budget')
const MAX_OUT = Number(opt('max-output-tokens', '1000'))
const DELAY = Number(opt('delay-ms', '250'))
const OUT = opt('out', './ocr-benchmark-out') as string
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''

const PRICES: Record<string, { in: number; out: number }> = {}
for (const p of args['price'] ?? []) {
  const m = p.match(/^(.+?)=([\d.]+),([\d.]+)$/)
  if (!m) { console.error(`Bad --price "${p}" (expected model=in,out)`); process.exit(2) }
  PRICES[m[1]] = { in: Number(m[2]), out: Number(m[3]) }
}

if (!API_KEY) { console.error('Set GEMINI_API_KEY (or GOOGLE_API_KEY).'); process.exit(2) }

// ── time helpers ─────────────────────────────────────────────────────────────

/** "1:23.45" | "23.45" | "1:23,4" → ms, or null if not a time. */
function toMs(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2})[.,](\d{1,2})$/)
  if (!m) return null
  const min = m[1] ? Number(m[1]) : 0
  const hund = Number(m[3].padEnd(2, '0'))
  return (min * 60 + Number(m[2])) * 1000 + hund * 10
}

// ── load sheets ──────────────────────────────────────────────────────────────

interface Sheet { id: string; image: Buffer; c1: number | null; c2: number | null }

async function loadFromFolder(dir: string, labelsPath: string): Promise<Sheet[]> {
  const labels = new Map<string, { c1: number | null; c2: number | null }>()
  const lines = readFileSync(labelsPath, 'utf-8').split(/\r?\n/).filter((l) => l.trim())
  for (const [i, line] of lines.entries()) {
    const [file, c1, c2] = line.split(/[,;\t]/).map((s) => s.trim())
    if (i === 0 && /file/i.test(file)) continue // header
    labels.set(basename(file), { c1: toMs(c1), c2: toMs(c2) })
  }
  const sheets: Sheet[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(jpe?g)$/i.test(f)) continue
    const lab = labels.get(f)
    if (!lab) continue
    sheets.push({ id: f, image: readFileSync(join(dir, f)), ...lab })
  }
  return sheets
}

async function loadFromDb(dbPath: string): Promise<Sheet[]> {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare(`
    SELECT scan_id, barcode_raw, image_blob, time_ms1, time_ms2
    FROM timing_scan
    WHERE status = 'validated' AND barcode_raw NOT LIKE 'BLANK-%'
      AND (time_ms1 > 0 OR time_ms2 > 0)
  `).all() as Array<{ scan_id: number; barcode_raw: string; image_blob: Buffer; time_ms1: number | null; time_ms2: number | null }>
  db.close()
  return rows.map((r) => ({
    id: `${r.scan_id}:${r.barcode_raw}`,
    image: r.image_blob,
    c1: r.time_ms1 || null,
    c2: r.time_ms2 || null,
  }))
}

function sample<T>(arr: T[], n: number, seed: number): T[] {
  if (arr.length <= n) return arr
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a.slice(0, n)
}

// ── Gemini call (mirrors ocrGemini.ts generate()) ────────────────────────────

interface CallResult { text: string; ms: number; inTok: number; outTok: number; error?: string }

async function callGemini(model: string, image: Buffer): Promise<CallResult> {
  const generationConfig: Record<string, unknown> = { temperature: 0, maxOutputTokens: MAX_OUT }
  if (THINK !== undefined) generationConfig.thinkingConfig = { thinkingBudget: Number(THINK) }
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: CHRONO_PROMPT },
      { inline_data: { mime_type: 'image/jpeg', data: image.toString('base64') } },
    ] }],
    generationConfig,
  })
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'
  const url = `${base}/v1beta/models/${model}:generateContent`

  let lastErr = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = performance.now()
    try {
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY }, body })
      const ms = performance.now() - t0
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = `HTTP ${resp.status}`
        await sleep(2000 * 2 ** attempt)
        continue
      }
      if (!resp.ok) return { text: '', ms, inTok: 0, outTok: 0, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` }
      const data = await resp.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
      }
      const u = data.usageMetadata ?? {}
      return {
        // same extraction as production: first part only
        text: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '',
        ms,
        inTok: u.promptTokenCount ?? 0,
        // thinking tokens are billed as output
        outTok: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      }
    } catch (e) {
      lastErr = String(e)
      await sleep(1000 * 2 ** attempt)
    }
  }
  return { text: '', ms: 0, inTok: 0, outTok: 0, error: lastErr || 'failed' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── run ──────────────────────────────────────────────────────────────────────

interface Row {
  model: string; sheet: string; run: number
  truth1: number | null; truth2: number | null
  got1: string; got2: string
  ok1: boolean; ok2: boolean
  unclear1: boolean; unclear2: boolean
  ms: number; inTok: number; outTok: number; error: string
}

function score(truth: number | null, got: string) {
  const unclear = !got || got.toLowerCase() === 'unclear' || toMs(got) === null
  if (truth === null) return { ok: unclear, unclear, scored: false } // no label for this chrono
  return { ok: !unclear && toMs(got) === truth, unclear, scored: true }
}

function pct(n: number, d: number) { return d ? `${((100 * n) / d).toFixed(1)}%` : '–' }
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

async function main() {
  let sheets: Sheet[]
  if (opt('db')) sheets = await loadFromDb(opt('db') as string)
  else if (opt('images') && opt('labels')) sheets = await loadFromFolder(opt('images') as string, opt('labels') as string)
  else { console.error('Give either --db FILE or --images DIR --labels CSV (see header of this script).'); process.exit(2) }

  sheets = sample(sheets, LIMIT, SEED)
  if (!sheets.length) { console.error('No labelled sheets found.'); process.exit(1) }
  console.log(`${sheets.length} sheets × ${MODELS.length} models × ${REPEAT} run(s)  [thinking-budget=${THINK ?? 'default'}]\n`)

  const rows: Row[] = []
  let done = 0
  const total = sheets.length * MODELS.length * REPEAT
  // interleave models per sheet so a mid-run rate limit / outage hits all models evenly
  for (const sh of sheets) {
    for (let run = 0; run < REPEAT; run++) {
      for (const model of MODELS) {
        const r = await callGemini(model, sh.image)
        const parsed = parseChronoTimes(r.text)
        const s1 = score(sh.c1, parsed.time1)
        const s2 = score(sh.c2, parsed.time2)
        rows.push({
          model, sheet: sh.id, run,
          truth1: sh.c1, truth2: sh.c2, got1: parsed.time1, got2: parsed.time2,
          ok1: s1.ok, ok2: s2.ok, unclear1: s1.unclear && s1.scored, unclear2: s2.unclear && s2.scored,
          ms: r.ms, inTok: r.inTok, outTok: r.outTok, error: r.error ?? '',
        })
        process.stdout.write(`\r${++done}/${total}`)
        await sleep(DELAY)
      }
    }
  }
  process.stdout.write('\n\n')

  // ── summarise ──
  const summary = MODELS.map((model) => {
    const rs = rows.filter((r) => r.model === model)
    const valid = rs.filter((r) => !r.error)
    let timesScored = 0, timesOk = 0, unclear = 0, confidentWrong = 0, sheetsOk = 0
    for (const r of valid) {
      const pairs: Array<[number | null, boolean, boolean]> = [[r.truth1, r.ok1, r.unclear1], [r.truth2, r.ok2, r.unclear2]]
      let sheetGood = true
      for (const [truth, ok, un] of pairs) {
        if (truth === null) continue
        timesScored++
        if (ok) timesOk++
        else { sheetGood = false; if (un) unclear++; else confidentWrong++ }
      }
      if (sheetGood) sheetsOk++
    }
    const inTok = valid.reduce((a, r) => a + r.inTok, 0)
    const outTok = valid.reduce((a, r) => a + r.outTok, 0)
    const p = PRICES[model]
    const costPer1000 = p && valid.length
      ? ((inTok * p.in + outTok * p.out) / 1e6 / valid.length) * 1000
      : null
    return {
      model,
      requests: rs.length, apiErrors: rs.length - valid.length,
      sheetAccuracy: valid.length ? sheetsOk / valid.length : 0,
      timeAccuracy: timesScored ? timesOk / timesScored : 0,
      unclearRate: timesScored ? unclear / timesScored : 0,
      confidentWrongRate: timesScored ? confidentWrong / timesScored : 0,
      confidentWrong, unclear,
      p50ms: Math.round(quantile(valid.map((r) => r.ms), 0.5)),
      p95ms: Math.round(quantile(valid.map((r) => r.ms), 0.95)),
      avgInTok: valid.length ? Math.round(inTok / valid.length) : 0,
      avgOutTok: valid.length ? Math.round(outTok / valid.length) : 0,
      costPer1000Sheets: costPer1000,
    }
  })

  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  console.log(pad('model', 26) + pad('sheets✓', 9) + pad('times✓', 9) + pad('unclear', 9) + pad('WRONG', 9) + pad('err', 5) +
    pad('p50 ms', 8) + pad('p95 ms', 8) + pad('in/out tok', 12) + '$/1000 sheets')
  for (const s of summary) {
    console.log(
      pad(s.model, 26) + pad(`${(s.sheetAccuracy * 100).toFixed(1)}%`, 9) + pad(`${(s.timeAccuracy * 100).toFixed(1)}%`, 9) +
      pad(`${(s.unclearRate * 100).toFixed(1)}%`, 9) +
      pad(`${(s.confidentWrongRate * 100).toFixed(1)}%`, 9) + pad(s.apiErrors, 5) +
      pad(s.p50ms, 8) + pad(s.p95ms, 8) + pad(`${s.avgInTok}/${s.avgOutTok}`, 12) +
      (s.costPer1000Sheets === null ? 'n/a (use --price)' : `$${s.costPer1000Sheets.toFixed(3)}`),
    )
  }
  console.log('\nWRONG = confident but incorrect time (worst case: silently bad result). unclear = model abstained.')

  // run-to-run stability (only meaningful with --repeat > 1)
  if (REPEAT > 1) {
    console.log('\nStability (same sheet, same model, answers identical across runs):')
    for (const model of MODELS) {
      const by = new Map<string, string[]>()
      for (const r of rows.filter((x) => x.model === model && !x.error)) {
        by.set(r.sheet, [...(by.get(r.sheet) ?? []), `${r.got1}|${r.got2}`])
      }
      const stable = [...by.values()].filter((v) => new Set(v).size === 1).length
      console.log(`  ${pad(model, 26)} ${pct(stable, by.size)}`)
    }
  }

  // sheets where models disagree with truth — the interesting ones to eyeball
  const bad = rows.filter((r) => !r.error && ((r.truth1 !== null && !r.ok1) || (r.truth2 !== null && !r.ok2)))
  if (bad.length) {
    console.log(`\nFirst misreads (see results.csv for all ${bad.length}):`)
    for (const r of bad.slice(0, 10)) {
      console.log(`  ${pad(r.model, 24)} ${pad(r.sheet, 28)} truth ${fmt(r.truth1)}/${fmt(r.truth2)}  got ${r.got1 || '∅'}/${r.got2 || '∅'}`)
    }
  }

  mkdirSync(OUT, { recursive: true })
  const csv = ['model,sheet,run,truth1,truth2,got1,got2,ok1,ok2,unclear1,unclear2,ms,in_tokens,out_tokens,error',
    ...rows.map((r) => [r.model, JSON.stringify(r.sheet), r.run, fmt(r.truth1), fmt(r.truth2), r.got1, r.got2, r.ok1, r.ok2,
      r.unclear1, r.unclear2, Math.round(r.ms), r.inTok, r.outTok, JSON.stringify(r.error)].join(','))].join('\n')
  writeFileSync(join(OUT, 'results.csv'), csv)
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ args: { models: MODELS, sheets: sheets.length, repeat: REPEAT, thinkingBudget: THINK ?? null }, summary }, null, 2))
  console.log(`\nWrote ${join(OUT, 'results.csv')} and ${join(OUT, 'summary.json')}`)
}

function fmt(ms: number | null) {
  if (ms === null) return ''
  const cs = Math.round(ms / 10), m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), h = cs % 100
  return `${m}:${String(s).padStart(2, '0')}.${String(h).padStart(2, '0')}`
}

main().catch((e) => { console.error(e); process.exit(1) })
