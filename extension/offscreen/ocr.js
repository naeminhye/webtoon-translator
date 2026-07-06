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

// Worker pool — allows parallel OCR for batch viewport translation.
// Each worker handles one recognize() at a time; pool distributes concurrent requests.
const POOL_SIZE = 3;
const _pool     = [];   // Promise<TesseractWorker>[]
const _busy     = [];   // boolean[]
let   _poolInit = false;

// ── Tesseract recognition tuning ────────────────────────────────────────────
// Dialogue crops are short, isolated snippets — not full documents/paragraphs,
// which is what Tesseract's own default page-segmentation mode assumes.

// tessedit_char_whitelist was tried here to restrict recognition to Hangul +
// digits + dialogue punctuation, but Tesseract's whitelist/blacklist
// mechanism does NOT function under OEM.LSTM_ONLY (confirmed: tesseract-ocr/
// tesseract#751 — "Blacklist and whitelist unsupported with LSTM (4.0)"; also
// tesseract-ocr/tesseract#998) — it's silently ignored, not an error, so it
// looked harmless in testing but never actually filtered anything. Switching
// to the legacy engine to make it work isn't viable here: the bundled WASM
// core is LSTM-only (tesseract-core-simd-lstm.wasm.js — no legacy support
// compiled in), and shipping a second core just for this would be a much
// bigger change. Left unimplemented rather than kept as dead/misleading
// config — revisit if a legacy-capable core is ever bundled.

const OCR_UPSCALE_FACTOR = 2; // multiplier applied to the final crop right before Tesseract sees it (see _upscaleForOcr) — very small/blurry source crops may benefit from more (e.g. 3x), but that needs visual/accuracy testing to confirm, not just assumed

function broadcast(status, progress, message) {
  try {
    chrome.runtime.sendMessage(
      { type: 'OCR_STATUS', payload: { status, progress, message } },
      () => void chrome.runtime.lastError // no listener — fine
    );
  } catch (_) { /* extension reloading */ }
}

function _createWorkerInstance(isPrimary) {
  return Tesseract.createWorker('kor', Tesseract.OEM.LSTM_ONLY, {
    workerPath: VENDOR + 'worker.min.js',
    corePath:   VENDOR + 'tesseract-core-simd-lstm.wasm.js',
    langPath:   VENDOR + 'lang',
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: isPrimary
      ? (m) => {
          if (m.status === 'loading language traineddata') broadcast('downloading-model', m.progress);
          else if (m.status === 'recognizing text')        broadcast('recognizing', m.progress);
        }
      : () => {},
  }).then(worker => {
    if (isPrimary) broadcast('ready');
    return worker;
  }).catch(err => {
    if (isPrimary) { broadcast('error', undefined, err.message || String(err)); }
    throw err;
  });
}

function _ensurePool() {
  if (_poolInit) return;
  _poolInit = true;
  broadcast('initializing');
  for (let i = 0; i < POOL_SIZE; i++) {
    _pool.push(_createWorkerInstance(i === 0));
    _busy.push(false);
  }
}

async function _acquireWorker() {
  _ensurePool();
  while (true) {
    const i = _busy.findIndex(b => !b);
    if (i !== -1) {
      _busy[i] = true;
      return { worker: await _pool[i], index: i };
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

function _releaseWorker(index) {
  _busy[index] = false;
}

// Legacy: kept for any callers still referencing getWorker() — returns primary worker.
function getWorker() {
  _ensurePool();
  return _pool[0];
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
    let workerIndex = -1;
    try {
      const { worker, index } = await _acquireWorker();
      workerIndex = index;
      await worker.setParameters({
        tessedit_pageseg_mode: message.payload.isSingleLine ? Tesseract.PSM.SINGLE_LINE : Tesseract.PSM.SINGLE_BLOCK,
      });
      const upscaledDataUrl = await _upscaleForOcr(message.payload.dataUrl, OCR_UPSCALE_FACTOR);
      const { data } = await worker.recognize(upscaledDataUrl);
      if (workerIndex === 0) broadcast('ready');
      const text = (data.text || '').replace(/\s+/g, ' ').trim();
      const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
      sendResponse({ ok: true, text, confidence });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    } finally {
      if (workerIndex !== -1) _releaseWorker(workerIndex);
    }
  })();
  return true;
});
