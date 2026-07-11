'use strict';

/**
 * offscreen/paddle-runner.js — in-browser PP-OCR (det + rec) runner for the
 * 'paddleocr-local' OCR engine.
 *
 * Loads two ONNX models with the same onnxruntime-web setup as ort-runner.js
 * (which is loaded first and already configures ort.env.wasm.*):
 *
 *   paddle-det.onnx        DBNet text-line detector (language-agnostic)
 *   paddle-rec-korean.onnx PP-OCRv4 Korean CTC recognizer
 *   models/korean_dict.txt recognizer charset (committed, bundled)
 *
 * The two .onnx files (~15 MB) are NOT bundled in the extension package —
 * they're fetched at runtime from a GitHub Release into the Cache Storage
 * API (see background/worker.js's paddleModelsDownload, triggered by the
 * "Download models" button in Settings → OCR Engine → PaddleOCR
 * (in-browser)). Cache Storage is shared across extension contexts by
 * origin, so this file just reads whatever worker.js already cached — no
 * message-passing needed for that part. A bundled extension/models/*.onnx
 * (placed there by scripts/fetch-paddle-models.py for a "Load unpacked" dev
 * setup) is tried as a secondary fallback; a genuinely missing model
 * produces an actionable error instead of an ORT parse failure.
 *
 * Pipeline: crop → det (find text lines) → per-line rec → CTC greedy decode →
 * join in reading order. Det boxes use an axis-aligned approximation of DB's
 * pyclipper unclip — fine for horizontal webtoon dialogue; a det miss falls
 * back to recognizing the whole crop as one line (upstream
 * refineOcrCropToTextCluster already tightened the crop to the text).
 */

// ── Tunables (PaddleOCR defaults unless noted) ──────────────────────────────

const PADDLE_DET_LIMIT_SIDE = 960;  // det input: longest side capped here
const PADDLE_DET_BIN_THRESH = 0.3;  // prob-map binarization threshold
const PADDLE_DET_BOX_THRESH = 0.6;  // min mean prob over a component
const PADDLE_DET_UNCLIP     = 1.6;  // DB unclip ratio (box expansion)
const PADDLE_DET_MIN_SIDE   = 3;    // drop components smaller than this (map px)
const PADDLE_REC_HEIGHT     = 48;   // PP-OCRv3/v4 rec input height
const PADDLE_REC_MAX_WIDTH  = 1280; // rec input width clamp
const PADDLE_REC_MIN_BOX_PX = 4;    // skip source boxes smaller than this

// ── Pure math (no browser APIs — also exercised by Node tests, see bottom) ──

/**
 * DBNet postprocess: binarize the prob map, extract connected components
 * (iterative 4-neighbour flood fill), score-filter, expand each box with an
 * axis-aligned approximation of DB's unclip (pyclipper offsets the polygon
 * outward by area*ratio/perimeter; for a w×h rect that offset is
 * w*h*ratio / (2*(w+h)) on every side), then map back to source-image pixels
 * and sort into reading order (rows top→bottom, left→right within a row).
 *
 * @param {Float32Array} probMap  [mapH*mapW] sigmoid probabilities
 * @returns {{x1,y1,x2,y2}[]} boxes in source-image pixel coords
 */
function paddleDetPostprocess(probMap, mapW, mapH, ratioW, ratioH, srcW, srcH) {
  const bin = new Uint8Array(mapW * mapH);
  for (let i = 0; i < bin.length; i++) bin[i] = probMap[i] > PADDLE_DET_BIN_THRESH ? 1 : 0;

  const seen  = new Uint8Array(mapW * mapH);
  const stack = new Int32Array(mapW * mapH);
  const comps = [];

  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = mapW, maxX = 0, minY = mapH, maxY = 0, scoreSum = 0, count = 0;

    while (top > 0) {
      const p = stack[--top];
      const x = p % mapW, y = (p / mapW) | 0;
      scoreSum += probMap[p];
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0        && bin[p - 1]    && !seen[p - 1])    { seen[p - 1] = 1;    stack[top++] = p - 1; }
      if (x < mapW - 1 && bin[p + 1]    && !seen[p + 1])    { seen[p + 1] = 1;    stack[top++] = p + 1; }
      if (y > 0        && bin[p - mapW] && !seen[p - mapW]) { seen[p - mapW] = 1; stack[top++] = p - mapW; }
      if (y < mapH - 1 && bin[p + mapW] && !seen[p + mapW]) { seen[p + mapW] = 1; stack[top++] = p + mapW; }
    }

    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (Math.min(w, h) < PADDLE_DET_MIN_SIDE) continue;
    if (scoreSum / count < PADDLE_DET_BOX_THRESH) continue;

    const pad = (w * h * PADDLE_DET_UNCLIP) / (2 * (w + h));
    comps.push({
      x1: Math.max(0, (minX - pad) / ratioW),
      y1: Math.max(0, (minY - pad) / ratioH),
      x2: Math.min(srcW, (maxX + 1 + pad) / ratioW),
      y2: Math.min(srcH, (maxY + 1 + pad) / ratioH),
    });
  }

  // Reading order: group boxes into rows by y-center proximity (within 0.6×
  // the box height), rows top→bottom, boxes left→right inside a row.
  comps.sort((a, b) => (a.y1 + a.y2) - (b.y1 + b.y2));
  const rows = [];
  for (const box of comps) {
    const cy = (box.y1 + box.y2) / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) < 0.6 * (box.y2 - box.y1));
    if (row) {
      row.boxes.push(box);
      row.cy = (row.cy + cy) / 2;
    } else {
      rows.push({ cy, boxes: [box] });
    }
  }
  return rows.flatMap(r => r.boxes.sort((a, b) => a.x1 - b.x1));
}

/**
 * PaddleOCR CTC charset convention: index 0 is the CTC blank, then the dict
 * lines in file order, then — because the korean models ship with
 * use_space_char=true — a trailing space class.
 */
function paddleBuildCharset(dictText) {
  const dict = dictText.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
  return ['<blank>', ...dict, ' '];
}

/**
 * CTC greedy decode over [T, C] probabilities: argmax each timestep, collapse
 * repeats (a repeated char needs an intervening blank), skip blanks.
 * Returns confidence as the mean probability of kept characters (0-1).
 *
 * Throws when C and the charset disagree — a dict/model mismatch garbles
 * every character silently otherwise, so fail loud.
 */
function paddleCtcGreedyDecode(probs, T, C, charset) {
  if (C !== charset.length) {
    throw new Error(`PaddleOCR rec model has ${C} classes but charset has ${charset.length} — wrong or stale models/korean_dict.txt`);
  }
  let text = '', confSum = 0, kept = 0, prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0, bestP = probs[t * C];
    for (let c = 1; c < C; c++) {
      const p = probs[t * C + c];
      if (p > bestP) { bestP = p; best = c; }
    }
    if (best !== 0 && best !== prev) {
      text += charset[best];
      confSum += bestP;
      kept++;
    }
    prev = best;
  }
  return { text: text.trim(), confidence: kept ? confSum / kept : 0 };
}

// ── Browser-only part: sessions, canvases, message handler ──────────────────
// Guarded so the pure functions above can be require()d from Node for tests.

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {

  // Mirrors background/worker.js's PADDLE_MODELS_RELEASE/PADDLE_CACHE_NAME —
  // keep in sync. These are the URLs worker.js's "Download models" flow
  // fetches into Cache Storage; reading with the identical URL as cache key
  // is what makes the two contexts share the same cached bytes.
  const PADDLE_MODELS_RELEASE = 'https://github.com/naeminhye/webtoon-translator/releases/download/paddle-models-v1/';
  const PADDLE_CACHE_NAME     = 'paddle-ocr-models-v1';
  const DET_REMOTE_URL = PADDLE_MODELS_RELEASE + 'paddle-det.onnx';
  const REC_REMOTE_URL = PADDLE_MODELS_RELEASE + 'paddle-rec-korean.onnx';
  const DICT_URL       = chrome.runtime.getURL('models/korean_dict.txt');

  const NOT_INSTALLED_MSG = label =>
    `PaddleOCR ${label} model not installed — open the extension popup, go to ` +
    `OCR Engine → PaddleOCR (in-browser), and click "Download models".`;

  // ort.env.wasm.* (single-thread, wasmPaths) is configured by ort-runner.js,
  // loaded before this file — do not reconfigure here.

  // Resolves model bytes in priority order: (1) Cache Storage, populated by
  // worker.js's paddleModelsDownload — the primary path for every install
  // type, including a packed Chrome-Web-Store extension; (2) a bundled
  // extension/models/*.onnx — a "Load unpacked" dev convenience left over
  // from scripts/fetch-paddle-models.py, tried only if the cache is empty.
  async function loadModelBytes(remoteUrl, bundledPath, label) {
    const cache = await caches.open(PADDLE_CACHE_NAME);
    const cached = await cache.match(remoteUrl);
    if (cached) return new Uint8Array(await cached.arrayBuffer());

    try {
      const res = await fetch(chrome.runtime.getURL(bundledPath));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (_) { /* not bundled either — fall through to the error below */ }

    throw new Error(NOT_INSTALLED_MSG(label));
  }

  async function createSession(bytes, label) {
    let session;
    if (navigator.gpu) {
      try {
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        console.info(`[paddle-runner] ${label}: execution provider webgpu`);
      } catch (err) {
        console.warn(`[paddle-runner] ${label}: WebGPU init failed, falling back to WASM:`, err);
      }
    }
    if (!session) {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      console.info(`[paddle-runner] ${label}: execution provider wasm (single-thread)`);
    }
    return session;
  }

  // Lazy singletons — no eager warm-up: ~15 MB of models most users never
  // select shouldn't load on every offscreen-document creation.
  let _detPromise = null, _recPromise = null, _charsetPromise = null;
  const getDet = () => (_detPromise ??= loadModelBytes(DET_REMOTE_URL, 'models/paddle-det.onnx', 'detector')
    .then(bytes => createSession(bytes, 'det'))
    .catch(err => { _detPromise = null; throw err; }));
  const getRec = () => (_recPromise ??= loadModelBytes(REC_REMOTE_URL, 'models/paddle-rec-korean.onnx', 'recognizer')
    .then(bytes => createSession(bytes, 'rec'))
    .catch(err => { _recPromise = null; throw err; }));
  const getCharset = () => (_charsetPromise ??= fetch(DICT_URL)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    .then(paddleBuildCharset)
    .catch(err => { _charsetPromise = null; throw err; }));

  async function dataUrlToCanvas(dataUrl) {
    const blob   = await fetch(dataUrl).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  // Det preprocess: scale so the longest side ≤ PADDLE_DET_LIMIT_SIDE, round
  // each dim UP to a multiple of 32 (stretch, not letterbox — matches
  // PaddleOCR's DetResizeForTest), ImageNet-normalize to CHW float32.
  function detPreprocess(srcCanvas) {
    const srcW = srcCanvas.width, srcH = srcCanvas.height;
    const scale = Math.min(1, PADDLE_DET_LIMIT_SIDE / Math.max(srcW, srcH));
    const dstW = Math.max(32, Math.ceil((srcW * scale) / 32) * 32);
    const dstH = Math.max(32, Math.ceil((srcH * scale) / 32) * 32);

    const canvas = new OffscreenCanvas(dstW, dstH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);

    const { data } = ctx.getImageData(0, 0, dstW, dstH);
    const pixels = dstW * dstH;
    const tensor = new Float32Array(3 * pixels);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < pixels; i++) {
      tensor[i]              = (data[i * 4]     / 255 - mean[0]) / std[0];
      tensor[pixels + i]     = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
      tensor[pixels * 2 + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
    }
    return { tensor, dstW, dstH, ratioW: dstW / srcW, ratioH: dstH / srcH };
  }

  // Rec preprocess: crop the line, resize to height 48, width rounded UP to a
  // multiple of 32 (bucketing limits WebGPU shader recompiles across widths),
  // pad the remainder with mid-gray (normalizes to ~0), map to [-1, 1] CHW.
  function recPreprocess(srcCanvas, box) {
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const rawW = Math.round(PADDLE_REC_HEIGHT * (bw / bh));
    const drawW = Math.max(16, Math.min(PADDLE_REC_MAX_WIDTH, rawW));
    const padW = Math.min(PADDLE_REC_MAX_WIDTH, Math.ceil(drawW / 32) * 32);

    const canvas = new OffscreenCanvas(padW, PADDLE_REC_HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = 'rgb(127,127,127)';
    ctx.fillRect(0, 0, padW, PADDLE_REC_HEIGHT);
    ctx.drawImage(srcCanvas, box.x1, box.y1, bw, bh, 0, 0, drawW, PADDLE_REC_HEIGHT);

    const { data } = ctx.getImageData(0, 0, padW, PADDLE_REC_HEIGHT);
    const pixels = padW * PADDLE_REC_HEIGHT;
    const tensor = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i++) {
      tensor[i]              = (data[i * 4]     / 255 - 0.5) / 0.5;
      tensor[pixels + i]     = (data[i * 4 + 1] / 255 - 0.5) / 0.5;
      tensor[pixels * 2 + i] = (data[i * 4 + 2] / 255 - 0.5) / 0.5;
    }
    return { tensor, width: padW };
  }

  async function runPaddleOcr(dataUrl) {
    const [det, rec, charset] = await Promise.all([getDet(), getRec(), getCharset()]);
    const srcCanvas = await dataUrlToCanvas(dataUrl);
    const srcW = srcCanvas.width, srcH = srcCanvas.height;

    const t0 = performance.now();
    const { tensor, dstW, dstH, ratioW, ratioH } = detPreprocess(srcCanvas);
    const detOut = await det.run({
      [det.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, dstH, dstW]),
    });
    const probMap = detOut[det.outputNames[0]].data; // [1,1,dstH,dstW]
    let boxes = paddleDetPostprocess(probMap, dstW, dstH, ratioW, ratioH, srcW, srcH);
    const t1 = performance.now();

    // Det found nothing → recognize the whole crop as a single line rather
    // than failing (the upstream crop refinement already isolated the text).
    if (boxes.length === 0) boxes = [{ x1: 0, y1: 0, x2: srcW, y2: srcH }];

    const lines = [];
    for (const box of boxes) {
      if (box.x2 - box.x1 < PADDLE_REC_MIN_BOX_PX || box.y2 - box.y1 < PADDLE_REC_MIN_BOX_PX) continue;
      const { tensor: recTensor, width } = recPreprocess(srcCanvas, box);
      const recOut = await rec.run({
        [rec.inputNames[0]]: new ort.Tensor('float32', recTensor, [1, 3, PADDLE_REC_HEIGHT, width]),
      });
      const out = recOut[rec.outputNames[0]];       // [1, T, C]
      const [, T, C] = out.dims;
      const line = paddleCtcGreedyDecode(out.data, T, C, charset);
      if (line.text) lines.push(line);
    }
    const t2 = performance.now();

    console.debug(
      `[paddle-runner] det=${(t1 - t0).toFixed(1)}ms boxes=${boxes.length}` +
      ` rec=${(t2 - t1).toFixed(1)}ms lines=${lines.length}`,
    );

    const text = lines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
    const confidence = lines.length
      ? (lines.reduce((s, l) => s + l.confidence, 0) / lines.length) * 100
      : 0;
    return { ok: true, text, confidence, provider: 'paddleocr-local' };
  }

  // Serialize jobs — same rationale as ort-runner.js's detect queue: the WASM
  // backend is single-threaded, concurrent runs just interleave.
  let _paddleQueue = Promise.resolve();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Distinct from the background-facing OCR_REGION for the same reason
    // ort-runner.js uses DETECT_RUN vs DETECT_BUBBLES: runtime.sendMessage
    // reaches every extension context including this one.
    if (message.type !== 'PADDLE_OCR_RUN') return false;
    const job = _paddleQueue.then(() => runPaddleOcr(message.payload.dataUrl));
    _paddleQueue = job.catch(() => {});
    job.then(sendResponse)
       .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  });
}

// Node test hook — inert in the extension (no `module` in browser contexts).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { paddleDetPostprocess, paddleBuildCharset, paddleCtcGreedyDecode,
                     PADDLE_DET_BIN_THRESH, PADDLE_DET_BOX_THRESH, PADDLE_DET_UNCLIP };
}
