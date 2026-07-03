/**
 * offscreen/ocr.js — Tesseract.js OCR runner.
 *
 * Engine JS/WASM and the Korean model (best_int, 1.5MB) are all bundled in
 * vendor/tesseract — fully offline, no CDN dependency, no remote code (MV3).
 *
 * Progress (model load / recognition) is broadcast as OCR_STATUS messages;
 * the background forwards them to content scripts so the dialog can show
 * live status.
 */

const VENDOR = chrome.runtime.getURL('vendor/tesseract/');

let workerPromise = null;

// ── Tesseract recognition tuning ────────────────────────────────────────────
// Dialogue crops are short, isolated snippets — not full documents/paragraphs,
// which is what Tesseract's own default page-segmentation mode assumes.

/** Builds a string of code points [start, end] inclusive — used below to spell out Hangul ranges without a giant literal in source. */
function _charRange(start, end) {
  let s = '';
  for (let cp = start; cp <= end; cp++) s += String.fromCodePoint(cp);
  return s;
}

// Restricts recognition to characters that can plausibly appear in webtoon
// dialogue, so background/bubble-outline noise can't get misread as stray
// Latin letters or symbols (e.g. past observed garbage like "14 [", "2001 {").
// Digits are intentionally kept (real numbers do appear in dialogue) — only
// Latin letters and odd symbols are excluded by omission. Adjust the ranges/
// punctuation below if legitimate characters turn out excluded during testing.
const OCR_CHAR_WHITELIST =
  _charRange(0x3131, 0x318E) +  // Hangul Compatibility Jamo (standalone ㄱ, ㅏ, etc.)
  _charRange(0xAC00, 0xD7A3) +  // precomposed Hangul syllables
  '0123456789' +
  '.,?!…~"\'“”‘’';

const OCR_UPSCALE_FACTOR = 2; // multiplier applied to the final crop right before Tesseract sees it (see _upscaleForOcr) — very small/blurry source crops may benefit from more (e.g. 3x), but that needs visual/accuracy testing to confirm, not just assumed

function broadcast(status, progress, message) {
  try {
    chrome.runtime.sendMessage(
      { type: 'OCR_STATUS', payload: { status, progress, message } },
      () => void chrome.runtime.lastError // no listener — fine
    );
  } catch (_) { /* extension reloading */ }
}

function getWorker() {
  if (!workerPromise) {
    broadcast('initializing');
    workerPromise = Tesseract.createWorker('kor', Tesseract.OEM.LSTM_ONLY, {
      workerPath: VENDOR + 'worker.min.js',
      corePath:   VENDOR + 'tesseract-core-simd-lstm.wasm.js',
      // Bundled model (best_int, 1.5MB) — fully offline, no CDN dependency
      langPath:   VENDOR + 'lang',
      cacheMethod: 'none', // local file — IndexedDB cache is pointless
      // MV3 CSP only allows 'self' scripts — tesseract's default blob: URL
      // worker is blocked, so spawn the worker from workerPath directly
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === 'loading language traineddata') broadcast('downloading-model', m.progress);
        else if (m.status === 'recognizing text')        broadcast('recognizing', m.progress);
      },
    }).then(worker => {
      broadcast('ready');
      return worker;
    }).catch(err => {
      workerPromise = null; // allow retry after a failed init (e.g. offline)
      broadcast('error', undefined, err.message || String(err));
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Upscales a data: URL image by `factor` using the canvas's built-in
 * high-quality (bicubic-equivalent) resampling — the last pixel-level step
 * before Tesseract sees the crop, run AFTER every region-detection/margin/
 * refinement step upstream has already picked the final crop, so it never
 * interferes with any of that earlier pixel analysis.
 */
async function _upscaleForOcr(dataUrl, factor) {
  const res    = await fetch(dataUrl);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(Math.round(bitmap.width * factor), Math.round(bitmap.height * factor));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to encode upscaled OCR image'));
    reader.readAsDataURL(outBlob);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'OCR_RUN') return;
  (async () => {
    try {
      const worker = await getWorker();
      // SINGLE_LINE when the caller knows this crop is one isolated text
      // block (see worker.js's refineOcrCropToTextCluster/isSingleLine) —
      // SINGLE_BLOCK (multi-line dialogue) otherwise/by default, since
      // Tesseract's own default PSM assumes a full multi-paragraph document,
      // not a short dialogue snippet.
      await worker.setParameters({
        tessedit_pageseg_mode: message.payload.isSingleLine ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: OCR_CHAR_WHITELIST,
      });
      const upscaledDataUrl = await _upscaleForOcr(message.payload.dataUrl, OCR_UPSCALE_FACTOR);
      const { data } = await worker.recognize(upscaledDataUrl);
      broadcast('ready');
      // Webtoon bubbles wrap lines arbitrarily — collapse to one line
      const text = (data.text || '').replace(/\s+/g, ' ').trim();
      // confidence: 0-100 average across all recognised words
      const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
      sendResponse({ ok: true, text, confidence });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message port open for the async response
});
