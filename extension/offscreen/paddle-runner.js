/**
 * offscreen/paddle-runner.js — PaddleOCR (PP-OCRv4) Korean recognition runner.
 *
 * Runs inside the same offscreen document as ocr.js and ort-runner.js.
 * ort.min.js must be loaded before this file (see ocr.html script order).
 *
 * Uses the PP-OCRv4 Korean CRNN recognition model (ONNX) to read text from
 * a pre-cropped bubble image. Detection is not needed — the bubble bbox comes
 * from the existing ONNX detector or flood-fill.
 *
 * Model input:  [1, 3, 48, W]   float32, RGB, height=48, width dynamic
 * Model output: [1, T, V]       float32, CTC logits, T=W/4, V=vocab size
 * Normalization: (px/255 - 0.5) / 0.5  →  range [-1, 1]
 *
 * Place the real model at:  extension/models/paddle-kor-rec.onnx   (~10 MB)
 * and the character dict at: extension/models/paddle-kor-dict.txt
 * See scripts/download-paddle-model.py for instructions.
 */

const PADDLE_MODEL_URL = chrome.runtime.getURL('models/paddle-kor-rec.onnx');
const PADDLE_DICT_URL  = chrome.runtime.getURL('models/paddle-kor-dict.txt');
const PADDLE_INPUT_H   = 48;  // PP-OCRv4 rec model fixed height

// ── Lazy singletons ──────────────────────────────────────────────────────────
let paddleSessionPromise = null;
let paddleDictPromise    = null;

function getPaddleSession() {
  if (!paddleSessionPromise) {
    console.log('[Paddle] Loading session from', PADDLE_MODEL_URL);
    paddleSessionPromise = ort.InferenceSession
      .create(PADDLE_MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      .then(s => {
        console.log('[Paddle] Session ready. inputs:', s.inputNames, 'outputs:', s.outputNames);
        return s;
      })
      .catch(err => {
        paddleSessionPromise = null; // allow retry
        console.error('[Paddle] Session creation failed:', err.message, '\nModel URL:', PADDLE_MODEL_URL);
        throw err;
      });
  }
  return paddleSessionPromise;
}

function getPaddleDict() {
  if (!paddleDictPromise) {
    paddleDictPromise = fetch(PADDLE_DICT_URL)
      .then(r => r.text())
      .then(text => {
        // PP-OCR dict format: one character per line
        // Index 0 = blank (CTC), then dict chars, last = space
        const chars = text.trim().split('\n');
        return ['blank', ...chars, ' '];
      })
      .catch(err => {
        paddleDictPromise = null;
        console.error('[Paddle] Dict load failed:', err.message);
        throw err;
      });
  }
  return paddleDictPromise;
}

// ── Image preprocessing ──────────────────────────────────────────────────────
/**
 * Resize crop to height=48 (keep aspect ratio), convert to CHW Float32 tensor,
 * normalize to [-1, 1]. Width is rounded up to nearest multiple of 32.
 */
async function preprocessForPaddle(dataUrl) {
  const blob   = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const srcW   = bitmap.width;
  const srcH   = bitmap.height;

  const H = PADDLE_INPUT_H;
  const rawW = Math.round(srcW * H / srcH);
  const W    = Math.max(32, Math.ceil(rawW / 32) * 32);

  const canvas = new OffscreenCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, W, H);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, W, H); // RGBA Uint8
  const n        = W * H;
  const float32  = new Float32Array(3 * n);

  for (let i = 0; i < n; i++) {
    float32[0 * n + i] = (data[i * 4 + 0] / 255 - 0.5) / 0.5; // R
    float32[1 * n + i] = (data[i * 4 + 1] / 255 - 0.5) / 0.5; // G
    float32[2 * n + i] = (data[i * 4 + 2] / 255 - 0.5) / 0.5; // B
  }

  return new ort.Tensor('float32', float32, [1, 3, H, W]);
}

// ── CTC greedy decoder ───────────────────────────────────────────────────────
/**
 * Standard CTC greedy decode: argmax per timestep, collapse consecutive
 * duplicates, remove blank tokens (index 0).
 */
function ctcDecode(logits, dict, T, V) {
  let prev = -1;
  const chars = [];
  for (let t = 0; t < T; t++) {
    let best = 0, bestScore = -Infinity;
    for (let v = 0; v < V; v++) {
      const s = logits[t * V + v];
      if (s > bestScore) { bestScore = s; best = v; }
    }
    if (best !== 0 && best !== prev) chars.push(dict[best] || '');
    prev = best;
  }
  return chars.join('');
}

// ── Main recognition function ────────────────────────────────────────────────
async function runPaddleOcr(dataUrl) {
  const [session, dict] = await Promise.all([getPaddleSession(), getPaddleDict()]);
  const tensor = await preprocessForPaddle(dataUrl);

  const inputName = session.inputNames[0];
  const results   = await session.run({ [inputName]: tensor });

  const outputName = session.outputNames[0];
  const out        = results[outputName]; // [1, T, V]
  const T = out.dims[1];
  const V = out.dims[2];
  console.log('[Paddle] Output shape:', out.dims, 'dict size:', dict.length);

  const text = ctcDecode(out.data, dict, T, V).trim();
  return { ok: true, text, confidence: null, provider: 'paddle' };
}

// ── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'PADDLE_OCR_RUN') return;
  (async () => {
    try {
      const result = await runPaddleOcr(message.payload.dataUrl);
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err), provider: 'paddle' });
    }
  })();
  return true;
});
