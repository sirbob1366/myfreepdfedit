# Tesseract.js (self-hosted)

Used by `/pdf-ocr/`. Everything OCR runs on-device; nothing is uploaded.

## Files

| File | Source |
|---|---|
| `tesseract.min.js`, `worker.min.js` | `tesseract.js@6.0.1` npm package (Apache-2.0) |
| `core/tesseract-core-simd-lstm.wasm.js`, `core/tesseract-core-lstm.wasm.js` | `tesseract.js-core@6.1.2` (single-file builds, wasm inlined) |
| `lang/*.traineddata.gz` | `@tesseract.js-data/<lang>` npm packages, `4.0.0_best_int` variant (int-quantized "best" models — good accuracy/size tradeoff) |

## Integration notes

- `createWorker(lang, OEM.LSTM_ONLY, { workerPath, corePath, langPath })` with:
  - `workerPath: '/vendor/tesseract/worker.min.js'`
  - `corePath: '/vendor/tesseract/core'` — the worker picks the simd or non-simd
    `tesseract-core-*-lstm.wasm.js` automatically (LSTM-only is the v6 default;
    we did not vendor the legacy-engine cores).
  - `langPath: '/vendor/tesseract/lang'` — the worker fetches
    `<langPath>/<lang>.traineddata.gz` (gzip is the default).
- Searchable PDFs are produced by Tesseract's own PDF renderer
  (`worker.recognize(img, {}, { pdf: true })`), which lays an invisible
  glyphless-font text layer over the page image — this is what makes
  non-Latin scripts searchable, and why we don't hand-place text via pdf-lib.
- `user_defined_dpi` is set to the render scale so each output page keeps the
  original PDF page dimensions.
- Languages vendored: eng, spa, fra, deu, ita, por, rus, ara, chi_sim, jpn, hin.
  To add more: `npm pack @tesseract.js-data/<lang>`, copy
  `package/4.0.0_best_int/<lang>.traineddata.gz` here, and add an `<option>`
  in `/pdf-ocr/index.html`.
