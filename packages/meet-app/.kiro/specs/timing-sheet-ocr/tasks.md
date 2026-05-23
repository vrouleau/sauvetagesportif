# Implementation Plan: Timing Sheet OCR Scanning

## Overview

Build the shared infrastructure for camera-based timing sheet scanning, then implement 3 swappable OCR engines for prototyping. The shared foundation (sheet generation, barcode scanning, image capture, storage, validation UI) is built once; only the OCR recognition layer varies between prototypes.

## Tasks

### Phase 1: Shared Foundation

- [x] 1. Create the local SQLite schema for timing scans. Add `src/main/timingScanDb.ts` with the `timing_scan` table creation (auto-run on app start), and CRUD functions: `insertScan`, `getUnprocessedScans`, `getScansForHeat`, `updateScanOcrResult`, `validateScan`, `markScanError`.
  - **Files to create:** `packages/meet-app/src/main/timingScanDb.ts`
  - **Files to modify:** `packages/meet-app/src/main/index.ts` (initialize scan DB on app ready)

- [x] 2. Define the barcode encoding scheme and implement parser. Create `src/main/timingBarcode.ts` with `encodeBarcode(eventNumber, heatNumber, lane, judgeNumber): string` and `decodeBarcode(raw: string): { eventNumber, heatNumber, lane, judgeNumber }`. Format: `E{n}-H{n}-L{n}-J{n}`.
  - **Files to create:** `packages/meet-app/src/main/timingBarcode.ts`

- [x] 3. Implement timing sheet PDF generator. Create `src/main/timingSheets.ts` using HTML-based generation (reuses Electron printToPDF pattern) to produce sheets with 3 lane strips per page. Each strip has: barcode (Code128), event/heat/lane/judge info, athlete name, 5 boxed digit cells with pre-printed separators, and 4 corner registration marks.
  - **Files to create:** `packages/meet-app/src/main/timingSheets.ts`

- [x] 4. Create the camera scanner page. Add `src/renderer/src/pages/TimingScanPage.tsx` with: webcam video feed via `getUserMedia`, zxing-js barcode detection loop (~10fps), auto-capture on decode, beep sound, visual confirmation overlay, debounce (3s same barcode), scan counter.
  - **Files to create:** `packages/meet-app/src/renderer/src/pages/TimingScanPage.tsx`

- [x] 5. Wire IPC handlers for scanning. Add handlers in `src/main/index.ts`: `timing:save-scan` (receives image + metadata from renderer, stores in SQLite), `timing:get-unprocessed`, `timing:get-scans-for-heat`. Add corresponding preload API entries.
  - **Files to modify:** `packages/meet-app/src/main/index.ts`, `packages/meet-app/src/preload/index.ts`

- [x] 6. Implement image processing pipeline. Create `src/main/timingImageProcess.ts` with: registration mark detection (threshold + contour finding), perspective correction (simplified for prototype), digit box cropping (known relative positions from sheet layout).
  - **Files to create:** `packages/meet-app/src/main/timingImageProcess.ts`

- [x] 7. Define the OCR engine interface. Create `src/main/ocrEngine.ts` with the `OcrEngine` interface (`initialize`, `recognizeDigit`, `recognizeTime`, `dispose`) and `OcrResult`/`TimeOcrResult` types. Add time parsing utilities: `parseTimeToMs` and `formatMsToTime`.
  - **Files to create:** `packages/meet-app/src/main/ocrEngine.ts`

- [x] 8. Create the processing queue page. Add `src/renderer/src/pages/TimingProcessPage.tsx` with: list of unprocessed/recognized scans, per-scan detail view (original image, cropped digits, recognized time, confidence indicator), editable time field, Accept/Correct/Skip/Flag buttons, keyboard shortcuts (Enter/Tab/Esc), OCR engine selector dropdown.
  - **Files to create:** `packages/meet-app/src/renderer/src/pages/TimingProcessPage.tsx`

- [x] 9. Wire IPC handlers for OCR processing and validation. Add handlers: `timing:run-ocr` (runs selected engine on a scan), `timing:validate-scan`, `timing:mark-error`, `timing:commit-to-results` (writes validated times to swimresult backuptime1/2 fields). Add preload entries.
  - **Files to modify:** `packages/meet-app/src/main/index.ts`, `packages/meet-app/src/preload/index.ts`

- [x] 10. Add navigation entries for the two new pages (Scan, Process) in the app's sidebar/navigation. Register routes in `App.tsx`.
  - **Files to modify:** `packages/meet-app/src/renderer/src/App.tsx`

### Phase 2: OCR Prototype A — Tesseract.js

- [x] 11. Implement Tesseract.js OCR engine. Create `src/main/ocrTesseract.ts` implementing `OcrEngine`. Configure: PSM 10 (single character), whitelist `0123456789`, English trained data. Handle worker lifecycle (create on initialize, terminate on dispose).
  - **Files to create:** `packages/meet-app/src/main/ocrTesseract.ts`
  - **Files to modify:** `packages/meet-app/package.json` (add tesseract.js)

### Phase 3: OCR Prototype B — PaddleOCR

- [x] 12. Create PaddleOCR Python bridge script. Add `scripts/paddle_ocr_server.py` — a stdin/stdout JSON-lines server that loads PaddleOCR (lightweight model), accepts base64 images, returns recognized digits with confidence. Include a `requirements.txt` for the Python dependencies.
  - **Files to create:** `packages/meet-app/scripts/paddle_ocr_server.py`, `packages/meet-app/scripts/paddle_requirements.txt`

- [x] 13. Implement PaddleOCR engine wrapper. Create `src/main/ocrPaddle.ts` implementing `OcrEngine`. Spawns the Python subprocess, communicates via JSON lines on stdin/stdout, handles process lifecycle and error recovery.
  - **Files to create:** `packages/meet-app/src/main/ocrPaddle.ts`

### Phase 4: OCR Prototype C — ONNX Digit Model

- [x] 14. Obtain and bundle a pre-trained MNIST ONNX model. Download or export a simple CNN digit classifier to `resources/mnist_digit_model.onnx`. Document the model architecture and expected input format (28×28 grayscale, normalized 0-1).
  - **Files to create:** `packages/meet-app/resources/mnist_digit_model.onnx`, `packages/meet-app/resources/MNIST_MODEL_README.md`

- [x] 15. Implement ONNX digit model engine. Create `src/main/ocrOnnx.ts` implementing `OcrEngine`. Load model via `onnxruntime-node`, preprocess images (resize 28×28, grayscale, normalize), run inference, apply softmax for confidence. Add `onnxruntime-node` to dependencies.
  - **Files to create:** `packages/meet-app/src/main/ocrOnnx.ts`
  - **Files to modify:** `packages/meet-app/package.json` (add onnxruntime-node)

### Phase 5: Integration & Testing Harness

- [ ] 16. Create a test harness page/script for comparing OCR engines. Add a "Benchmark" section to the processing page (or a separate dev page) that runs all 3 engines on the same set of scans and displays a comparison table: per-digit accuracy, per-time accuracy, average confidence, processing time.
  - **Files to create:** `packages/meet-app/src/renderer/src/pages/TimingBenchmarkPage.tsx` (optional, could be a section in TimingProcessPage)

- [ ] 17. Implement results commit logic. In `src/main/timingScanDb.ts`, add `commitHeatResults(eventNumber, heatNumber)` that: groups validated scans by lane, maps judge 1 → backuptime1, judge 2 → backuptime2, computes average → swimtime, updates the meet PostgreSQL database via existing `db.ts` patterns.
  - **Files to modify:** `packages/meet-app/src/main/timingScanDb.ts`, `packages/meet-app/src/main/db.ts`

- [ ] 18. Add timing sheet generation IPC and UI trigger. Wire `timing:generate-sheets` handler that generates PDF for a session or heat. Add a "Print Timing Sheets" button in the HeatsPage or a dedicated menu entry. Open the generated PDF in the system viewer or Electron print dialog.
  - **Files to modify:** `packages/meet-app/src/main/index.ts`, `packages/meet-app/src/preload/index.ts`, `packages/meet-app/src/renderer/src/pages/HeatsPage.tsx`

## Task Dependency Graph

```json
{
  "waves": [
    {"tasks": ["1", "2", "7"]},
    {"tasks": ["3", "4", "6"]},
    {"tasks": ["5", "8"]},
    {"tasks": ["9", "10"]},
    {"tasks": ["11", "12", "14"]},
    {"tasks": ["13", "15"]},
    {"tasks": ["16", "17", "18"]}
  ]
}
```

## Notes

- The local SQLite scan database is separate from the meet PostgreSQL database. Scans are local to the scanning machine; only validated results are committed to the shared meet DB.
- The sheet layout (digit box positions, registration mark positions) must be defined as constants shared between the PDF generator and the image processing pipeline.
- For the prototype phase, focus on accuracy measurement over polish. The validation UI can be minimal as long as it supports the accept/correct/flag workflow.
- PaddleOCR (Prototype B) requires Python to be installed on the machine. This is acceptable for prototyping but would need a bundling solution for production.
- The ONNX model (Prototype C) starts with a generic MNIST model. If accuracy is promising, we can fine-tune on actual judge handwriting samples collected during meets.
- Camera resolution: request at least 1280×720 for readable digit capture. Higher is better for OCR accuracy.
- The barcode scheme uses event *number* (not ID) because that's what judges see on the printed program. The system resolves number → ID when committing results.
