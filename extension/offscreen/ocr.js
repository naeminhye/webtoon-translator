/**
 * offscreen/ocr.js — Tesseract.js OCR runner.
 *
 * Engine JS/WASM is bundled in vendor/tesseract (MV3 forbids remote code).
 * The Korean language model (~few MB) is data, not code: it is lazy-downloaded
 * from tessdata.projectnaptha.com on first use and cached in IndexedDB by
 * tesseract.js, so users who never enter Translate mode never download it.
 */

const VENDOR = chrome.runtime.getURL('vendor/tesseract/');

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('kor', Tesseract.OEM.LSTM_ONLY, {
      workerPath: VENDOR + 'worker.min.js',
      corePath:   VENDOR + 'tesseract-core-simd-lstm.wasm.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0_fast',
    }).catch(err => {
      workerPromise = null; // allow retry after a failed init (e.g. offline)
      throw err;
    });
  }
  return workerPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'OCR_RUN') return;
  (async () => {
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(message.payload.dataUrl);
      // Webtoon bubbles wrap lines arbitrarily — collapse to one line
      const text = (data.text || '').replace(/\s+/g, ' ').trim();
      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message port open for the async response
});
