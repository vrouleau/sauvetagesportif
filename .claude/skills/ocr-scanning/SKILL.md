---
name: ocr-scanning
description: Timing sheet scanning and OCR in meet-app — barcode format, sheet layout, blank sheets, scan storage, Gemini OCR, API key management, time entry/validation, timing:* IPC channels. Use when touching timingBarcode.ts, timingSheets.ts, timingScanDb.ts, ocrGemini.ts, geminiBackground.ts, TimingScanPage or TimingProcessPage.
---

## Timing Sheet OCR Scanning

### Workflow
1. **Print** timing sheets from the Reports tab ("Fiches chrono" — pick the events; sorted lane → event → heat so strips can be cut into one pile per lane judge; "Fiches chrono vierges" for blank strips) — portrait, 3 strips/page
2. **Scan** sheets in batch (Scanner tab) — camera reads Code128 barcode, captures image
3. **Process** (Traitement tab) — Gemini reads times in background, operator validates/corrects
4. **Accept** → writes `backuptime1`, `backuptime2`, averaged `swimtime` to `swimresult`

### Sheet layout
- Full-width Code128 barcode SVG (format: `E{eventNumber}-H{heatNumber}-L{lane}`)
- Event name, heat, lane, athlete name + club code (relay heats: team name + club code — lanes come from both `swimresult` and `relay`)
- Scan write-back (`_writeScanTimes` in `index.ts`) targets the `swimresult` seeded at event/heat/lane, falling back to the `relay` team there
- Two rows of underlined time fields (M : SS . HH — one line per group, separators pre-printed) labeled "Chrono 1" / "Chrono 2", each with the judge's "Initiales" line at the right
- Corner registration marks for future perspective correction

### Blank sheets (late arrivals / missing sheets)
- HeatsPage "🖨 Fiches vierges" (pool) → `timing:generate-blank-sheets` → `generateBlankTimingSheetsHtml`:
  same strip, no barcode; `Épreuve / Série / Couloir` hand-written on underlines (+ a swimmer line)
- Scanner: no barcode to trigger on → manual "📸 Capturer fiche vierge" button / Space bar;
  saved as `barcode_raw = 'BLANK-<ms>'` with event/heat/lane/swimEventId = 0
- Gemini (`recognizeScan` in `geminiBackground.ts`) uses `BLANK_SHEET_PROMPT` for these (reads E/H/L + C1/C2),
  then `findBlankSheetCandidates` maps event number + heat + lane to the seeded swimresult/relay.
  A prelim and its final share `eventnumber`, so 2 candidates are possible: `pickBlankSheetTarget` takes the
  only one without a time, else leaves `swimEventId = 0` for the operator (round dropdown in Traitement)
- Traitement: blank scans have editable Épr./Série/Couloir; Accept is blocked until they resolve to a seeded
  entry; `timing:validate-scan` takes the confirmed `target` and refuses a blank scan without one
- Pure logic + prompts: `src/main/blankTimingSheet.ts`; tests: `tests/blank-timing-sheet.test.ts`

### Barcode format
`E{eventNumber}-U{swimEventId}-H{heatNumber}-L{lane}` — e.g. `E5-U1496-H2-L3` = Event 5, Heat 2, Lane 3.
`swimEventId` (the internal `swimevent` primary key) is what validate-scan actually
matches on — it's always unique, unlike `eventNumber`, which a prelim and its final
can share (see "Prelim/Final event numbering" below).

### Capture timing (stable-then-capture)
Scanner (`TimingScanPage.tsx` + pure `src/renderer/src/captureQuality.ts`, tests `tests/capture-quality.test.ts`):
- Barcode decode (Quagga, ~200 ms loop, on a copy <= 1280 px wide) does **not** save anymore; it calls `tracker.noteDecode(code, grabTime)`.
- A 100 ms sampling loop measures motion (mean abs diff of 320 px gray frames) and sharpness (variance of Laplacian) and feeds the `StableCaptureTracker`, which keeps the last 6 full-res `ImageBitmap`s.
- It saves the **sharpest frame of the still period** once the scene was still >= 300 ms AND the code was decoded from a frame at/after the stillness start (so a swapped/removed strip never gets captured). Timeout 2 s -> saves anyway with `lowQuality` (amber "image possiblement floue" badge, operator re-presents the strip).
- Same code re-arms only after it has been out of view 1.5 s (re-presenting replaces the old scan: `timing:save-scan` deletes the previous scan of that barcode). A different code arms immediately.
- Beep/flash fire at the actual capture, not at first decode. "Hold still" prompt while a code is seen but the strip moves.
- Camera: requests 1920x1080 @30 and continuous autofocus when supported. Exposure is not touched (manual exposure risks dark images; use more light instead).
- Thresholds live in `DEFAULT_CAPTURE_CONFIG` (starting values, **not yet tuned on the real camera**); the page shows a live `mvt / nettete` readout bottom-left to tune them: still scene should read below `motionThreshold` (2.5), a moving strip well above.
- Blank-sheet capture (Space/button) is still immediate/manual.

### Scan storage
Separate SQLite: `{userData}/timing_scans.sqlite`
- `timing_scan` table: image blob, barcode, event/heat/lane, status, recognized/validated times
- Statuses: `unprocessed` → `recognized` (Gemini filled) → `validated` (operator confirmed)
- Cleared via "Vider les scans" button or `npm run clean`

### Gemini OCR
- Changing/comparing models → `ocr-model-benchmark` skill (`npm run bench:ocr`)
- Model: `gemini-2.5-flash-lite` (1.4s/scan, no thinking overhead)
- Fallback: `gemini-2.5-flash` if lite unavailable
- Background processing in main process (runs on any page)
- Dual API keys in BSGLOBAL: `GEMINI_KEY_FREE` + `GEMINI_KEY_PAID`
- Auto-fallback: free → paid on 429 → back to free after 60s

### Key management flow
1. Admin sets keys in team-app (Admin page → "Clés API Gemini")
2. Keys stored in PostgreSQL `bsglobal` table
3. Keys travel to meet-app via `.lxf` export: embedded as `.keys` JSON dotfile
   inside the zip archive (transparent). Team-app's own `.smb` import/export
   was removed (superseded by LXF) — this is now the only path.
4. Gemini OCR works automatically in meet-app (transparent to end users)

### Time entry
- Manual: type `14500` → parsed as `1:45.00` (same parser as HeatsPage)
- Gemini: auto-fills fields, operator confirms with Enter
- Both chronos required to accept
- Accept immediately writes to meet DB (`swimresult.backuptime1/2 + swimtime`)
