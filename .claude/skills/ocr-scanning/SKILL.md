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
- Each printed blank strip now carries its own Code128 barcode **`FV-<batch>-<nn>`** (batch = 4 random unambiguous chars per print job, nn = strip number), so the scanner captures it hands-free like any other strip (same stable-then-capture logic). Stored as `barcode_raw = 'BLANK-<batch>-<nn>'` (`blankScanIdFromCode`) with event/heat/lane/swimEventId = 0; unique per strip, so re-presenting a strip replaces its scan and two blank strips never collide. The printed prefix is short on purpose (FV-, not BLANK-): longer codes -> narrower bars -> Quagga read ~75% vs 100% in a synthetic test. Layout: barcode on top, id/name/chrono rows tightened to fit the 3.2in strip (verified by rendering). Scan page regex `BLANK_CODE_RE` mirrors `BLANK_SHEET_CODE_RE` (a test keeps them in sync).
- Blank strips printed before the barcode existed cannot be scanned anymore (the manual capture button / Space bar were removed): reprint them.
- Gemini (`recognizeScan` in `geminiBackground.ts`) uses `BLANK_SHEET_PROMPT` for these (reads E/H/L + C1/C2),
  then `findBlankSheetCandidates` maps event number + heat + lane to the seeded swimresult/relay.
  A prelim and its final share `eventnumber`, so 2 candidates are possible: `pickBlankSheetTarget` takes the
  only one without a time, else leaves `swimEventId = 0` for the operator (round dropdown in Traitement)
- Traitement: blank scans have editable Épr./Série/Couloir; Accept is blocked until they resolve to a seeded
  entry; `timing:validate-scan` takes the confirmed `target` and refuses a blank scan without one
- **Identity misreads are the dangerous kind**: a wrong event/heat/lane files the times under the WRONG swimmer, silently, whenever that entry exists and has no time. Real case: a written E2-H7-L2 was read E7-H1-L2 (2 read as 7, 7 read as 1). So the Traitement panel lists **"Mal lu ? Autres lectures possibles"**: `findBlankSheetAlternatives` (IPC `timing:find-blank-alternatives`) swaps digits for look-alikes (1<->7, 2<->7, 0<->6, 5<->6, 4<->9, 3<->8, see `digitVariants`), keeps only entries that exist in the meet (relays too), excludes the reading itself, sorts open entries (no time) first then fewest swapped digits (max 8). Clicking one fills Epr./Serie/Couloir. The header turns orange when the current reading has no swimmer or already has a time.
- Pure logic + prompts: `src/main/blankTimingSheet.ts`; tests: `tests/blank-timing-sheet.test.ts`

### Traitement scan list (grouped by event)
- The left list is one **collapsible group per event** (`src/renderer/src/scanGroups.ts`, tests `tests/scan-groups.test.ts`): title `Epr. N . <event name>` (+ round name when a prelim and its final share the number), `validated/total` counter, green check when complete. Event names come from IPC `timing:get-event-labels` (`listEventLabels`), fetched once and again only for events not seen yet.
- The flat array stays the source of truth and is **sorted in display order** (`sortScans`: blank sheets with no resolved event first = group "Fiches vierges a identifier", then event, heat, lane), so arrow keys / Prec / Suiv walk it as displayed. `applyScans` re-sorts every poll and keeps the **current scan selected by id** (Gemini resolving a blank sheet's event moves it to another group).
- Groups start collapsed; the group of the current scan opens by itself; "Tout" / "Replier" buttons expand/collapse all.

### Barcode format
`E{eventNumber}-U{swimEventId}-H{heatNumber}-L{lane}` — e.g. `E5-U1496-H2-L3` = Event 5, Heat 2, Lane 3.
`swimEventId` (the internal `swimevent` primary key) is what validate-scan actually
matches on — it's always unique, unlike `eventNumber`, which a prelim and its final
can share (see "Prelim/Final event numbering" below).

### Capture timing (stable-then-capture)
Scanner (`TimingScanPage.tsx` + pure `src/renderer/src/captureQuality.ts`, tests `tests/capture-quality.test.ts`):
- Barcode decode (Quagga, ~200 ms loop, on a copy <= 1280 px wide) does **not** save anymore; it calls `tracker.noteDecode(code, grabTime)`.
- A 100 ms sampling loop measures motion (mean abs diff of 320 px gray frames) and sharpness (variance of Laplacian) and feeds the `StableCaptureTracker`, which keeps the last 6 full-res `ImageBitmap`s.
- It saves the **sharpest frame of the still period** once the scene was still >= 300 ms AND the code was decoded from a frame at/after the stillness start (so a swapped/removed strip never gets captured). Timeout 1.5 s -> saves anyway (if no frame was kept for the decoded moment, the ring frame closest to it is used: never dropped) with `lowQuality` (amber "image possiblement floue" badge, operator re-presents the strip).
- Hand-held, fast flipping (the real setup: strips held in hand in front of the laptop camera): a strip that is replaced by the next one, or leaves view, before it ever settled is **still saved** from its sharpest frame (`lowQuality`), never silently dropped. Tracker keeps that best frame outside the 10-frame ring (`held`).
- Tune on site without rebuilding: DevTools (F12) -> `localStorage.setItem('timing-capture-config', JSON.stringify({ motionThreshold: 4, stableMs: 200 }))`, reload. Keys = `CaptureConfig`. Hand tremor keeps `mvt` around 6-9, hence the default 10; read your normal "holding still" value off the readout and set it just above.
- Same code re-arms only after it has been out of view 1.5 s (re-presenting replaces the old scan: `timing:save-scan` deletes the previous scan of that barcode). A different code arms immediately.
- Beep/flash fire at the actual capture, not at first decode (the operator waits for the beep before flipping to the next sheet). One high beep = OK; **two low beeps = captured but `lowQuality`**, present the sheet again. "Hold still" prompt while a code is seen but the strip moves.
- Camera: requests 1920x1080 @30 and continuous autofocus when supported. Exposure is not touched (manual exposure risks dark images; use more light instead).
- Thresholds live in `DEFAULT_CAPTURE_CONFIG` (starting values, **not yet tuned on the real camera**); the page shows a live `mvt / nettete` readout bottom-left to tune them: a sheet held in the hand reads ~6-9 on `mvt` even when held as steady as possible (measured), so `motionThreshold` defaults to 10 (stableMs 250, maxWaitMs 1500).
- Blank sheets are captured only through their printed FV- barcode (the manual button / Space bar were removed; blank strips printed before the barcode existed can no longer be scanned: reprint them).
- Debug panel (top-right of the camera view: `decodes`, `noteCalls`, `rejected` + raw text, `tracker:` state, `decisions`, `saveRes`, ERR lines): hidden by default; `npm run dev:debug` (sets `VITE_SCAN_DEBUG=1`) or `localStorage.setItem('timing-scan-debug','1')` + reload. Start there when "no pictures are taken": the first counter that stops climbing is the failing stage (a trailing control char in the decoded text once made every read fail the format check).

### Scan storage
Separate SQLite: `{userData}/timing_scans.sqlite`
- `timing_scan` table: image blob, barcode, event/heat/lane, status, recognized/validated times
- Statuses: `unprocessed` → `recognized` (Gemini filled) → `validated` (operator confirmed)
- Cleared via "Vider les scans" button or `npm run clean`
- **Archive (File menu)**: "Sauvegarder les fiches scannees (.scans)..." / "Charger des fiches scannees (.scans)..." (`saveScansToFile` / `loadScansFromFile` in index.ts, pure logic in `src/main/scanArchive.ts`, tests `tests/scan-archive.test.ts`). A `.scans` file is a plain SQLite copy of `timing_scan` (`VACUUM INTO`, images included) + a `scan_archive_meta` table (meet name/type, saved at). Not in the `.smb` (separate DB). **Load REPLACES the current scans** (all or nothing, ids kept, columns matched by name so older archives load; the dialog says how many will be replaced). If the archive's meet name differs from the open meet, the dialog warns and defaults to Annuler: validating a loaded sheet writes into the OPEN meet. Workflow: restore the `.smb`, then load the `.scans`, browse in Traitement (filter Valides / Tous). Documented in the in-app guide (`meet-pool_{fr,en}.md`, Save and Backup).
- The scan DB is a **separate file from the meet DB** and its scans point at that meet's event ids (barcode `U<swimEventId>`). When the meet is replaced, `flushScansForReplacedMeet` (index.ts) asks "N fiche(s) appartiennent a l'ancienne competition ... Supprimer ?" and clears them (`clearAllScans` + `resetGeminiAttempted`): after **SMB restore** and **new meet**, result carries `scansCleared`. Otherwise old sheets could be accepted into the new meet's entries (same ids, other swimmers). Deliberately NOT flushed: LENEX import (re-importing entries mid-meet keeps event ids, pending scans must survive) and PG connect/disconnect.

### Gemini OCR
- Changing/comparing models → `ocr-model-benchmark` skill (`npm run bench:ocr`)
- **Prompt = plain transcription of the three boxes, code does the rest** (`CHRONO_PROMPT` / `BLANK_SHEET_PROMPT` + `TIME_READING_RULES` + `normalizeChronoTime` in `blankTimingSheet.ts`). The model answers `C1:<min>|<sec>|<hund>` exactly as written (empty box = empty); the parser pads: empty minutes -> 0, empty hundredths -> 00, a lone digit is the UNITS digit (`1|5|6` = 1:05.06, never 1:05.60), seconds 60 or more or empty, extra digits/boxes, junk -> **blank** for the operator (never rewritten). Plain `M:SS.HH` answers are still accepted (same padding). Why: asked to produce `M:SS.HH` itself the model (a) copied the example's minute `1` into empty minutes boxes, (b) "normalized" impossible seconds (5:67.89 -> 1:07.89), (c) padded hundredths on the wrong side (6 -> 60). Don't reintroduce a full numeric example as the answer template; keep the examples in the rules text, with varied values.
- Models/keys tried in order (`src/main/ocrFallback.ts`, `AttemptChain`): **3.5 Flash-Lite free -> 2.5 Flash-Lite free -> 2.5 Flash-Lite paid**. Free-tier limits seen in AI Studio (Nov 2026, per project): 3.5 Flash-Lite 15 RPM / 500 RPD, 2.5 Flash-Lite 10 RPM / **20 RPD** (so 2.5 free runs out after ~20 strips). Verify the model IDs (`gemini-3.5-flash-lite` is the expected ID, unconfirmed): a wrong ID 404s and is skipped for 10 min.
- An attempt is skipped (no wasted call) while cooling down after a 429 (60 s, or the server `retryDelay`; 30 min when the quota is per-day), 404/403 (10 min) or 5xx/network error (15 s), or when it already used its known RPM in the last 60 s (limit-1). Empty/blocked answers and network errors move on to the next attempt; requests time out after 30 s.
- If nothing can be tried (all rate limited) `generate()` throws `GeminiBusyError`: the background loop leaves the scan queued and retries in 5 s instead of saving it with empty times. Any other error still stores empty times (operator types them).
- Cooldowns are module-wide (survive engine re-creation) and are cleared when keys are saved. `getCurrentGeminiTier()` = tier of the last answered request.
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
