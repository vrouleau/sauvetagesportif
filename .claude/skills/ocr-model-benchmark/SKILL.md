---
name: ocr-model-benchmark
description: How to choose and change the Gemini model used for timing-sheet OCR in meet-app, and how to benchmark candidates (accuracy, confident-wrong rate, latency, cost) with scripts/benchmark-ocr.ts / `npm run bench:ocr`. Use when asked whether a newer or cheaper Gemini model would be better, when editing GEMINI_MODELS in ocrGemini.ts, or when OCR misreads times.
---

## Gemini model selection for timing-sheet OCR

### Where the model is set
- `packages/meet-app/src/main/ocrFallback.ts` → `DEFAULT_ATTEMPTS` (ordered list of model + key tier; `ocrGemini.ts` walks it, skipping attempts in cooldown or over their known RPM).
- Today: `gemini-3.5-flash-lite` (free key), `gemini-2.5-flash-lite` (free key), `gemini-2.5-flash-lite` (paid key). Request: temperature 0, `maxOutputTokens: 1000`, one JPEG + `CHRONO_PROMPT` (or `BLANK_SHEET_PROMPT`, `src/main/blankTimingSheet.ts`). No `thinkingConfig` is sent.
- Workload is tiny: one small image + short prompt + ~20 output tokens per strip, so cost per sheet is a fraction of a cent. **Accuracy and the "confident-wrong" rate matter far more than a 2–3x price difference**; fewer manual corrections is the real saving.

### Never decide from price lists alone
- Third-party price trackers disagree on newer models and go stale. Prices/model IDs/deprecation dates must come from Google's pricing and models pages (ai.google.dev/gemini-api/docs/pricing, .../models). That host may be blocked in cloud sessions — then ask the user to check, don't guess.
- Older Gemini models are retired on a schedule; check the shutdown date of whatever is in `GEMINI_MODELS`.
- Research notes (Nov 2026, unverified third-party figures, USD per 1M tokens in/out): 2.5 Flash-Lite ≈ 0.10/0.40; 2.5 Flash ≈ 0.30/2.50; 3.1 Flash-Lite ≈ 0.25/1.50; newer Flash tiers (3.5/3.8) higher. Re-verify before use.

### Benchmark procedure
1. Collect ground truth: **50+ real sheets**, including messy handwriting and blank-sheet strips. Either the app's `timing_scans.sqlite` (validated scans, human-accepted times = truth) or a folder of JPEGs + `labels.csv` (`file,c1,c2`, times `M:SS.HH`).
2. Run (Node >= 22.18, from `packages/meet-app`, `GEMINI_API_KEY` set, paid-tier key for larger sets):
   ```bash
   npm run bench:ocr -- --images ./scans --labels ./scans/labels.csv \
     --models gemini-2.5-flash-lite,gemini-2.5-flash,<candidate> \
     --price <model>=<in>,<out> ...        # one --price per model, for the cost column
   npm rebuild better-sqlite3 && npm run bench:ocr -- --db <path>/timing_scans.sqlite --limit 50 --models ...
   ```
   Useful flags: `--repeat 3` (run-to-run stability), `--thinking-budget 0` (thinking off on 2.5 models; default = identical to production), `--limit/--seed`, `--out DIR`.
   After a DB run, `npm rebuild better-sqlite3` is for system Node; run `npm run rebuild` before `npm run dev` again (see meet-app CLAUDE.md).
3. Read the table: `sheets✓`/`times✓` (exact to the hundredth), `unclear` (model abstained → safe, operator is asked), **`WRONG`** (confident but incorrect → silent bad result, the number to minimise), p50/p95 latency, tokens, `$/1000 sheets`. `results.csv` lists every misread for eyeballing the images.

### Decision rule
- Prefer the model with the lowest WRONG rate; among near-equals, lower latency, then cost.
- A candidate must not regress WRONG vs. current primary. Slight increase in `unclear` is acceptable.
- Thinking models: tokens used for thinking count against `maxOutputTokens` (1000) and are billed as output; if a 2.5 Flash answer comes back empty/truncated, that's why — compare with `--thinking-budget 0`.
- To switch: edit `DEFAULT_ATTEMPTS` (and the `ocr-fallback` test), update the model lines in `.claude/skills/ocr-scanning/SKILL.md` ("Gemini OCR") and `packages/meet-app/CLAUDE.md` (`ocrGemini.ts` / `ocrFallback.ts` lines).

### Script internals
`packages/meet-app/scripts/benchmark-ocr.ts` is standalone (no Electron): imports only `CHRONO_PROMPT` / `parseChronoTimes` from `blankTimingSheet.ts`, mirrors `generate()` in `ocrGemini.ts`, retries 429/5xx with backoff, interleaves models per sheet so outages hit all evenly. `GEMINI_BASE_URL` overrides the endpoint (useful for a local mock when testing the script offline). Keep its request shape in sync with `ocrGemini.ts` if that changes.
