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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OCR_RUN') {
    (async () => {
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(message.payload.dataUrl);
        broadcast('ready');
        const text = (data.text || '').replace(/\s+/g, ' ').trim();
        const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
        sendResponse({ ok: true, text, confidence });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'OCR_DETECT') {
    (async () => {
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(message.payload.dataUrl);
        broadcast('ready');
        // Return paragraph-level blocks with pixel bounding boxes and text
        const blocks = (data.blocks || [])
          .filter(b => b.confidence > 30 && (b.text || '').trim().length > 0)
          .map(b => ({
            text: (b.text || '').replace(/\s+/g, ' ').trim(),
            confidence: b.confidence,
            bbox: { x0: b.bbox.x0, y0: b.bbox.y0, x1: b.bbox.x1, y1: b.bbox.y1 },
          }));
        sendResponse({ ok: true, blocks });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
