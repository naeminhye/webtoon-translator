'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INPUT_SIZE  = 1024;         // mayocream/comic-text-detector-onnx expects 1024×1024
const CONF_THRESH = 0.3; // recall-biased; the content script re-filters for auto-jobs
const IOU_THRESH  = 0.45;

// ---------------------------------------------------------------------------
// Model bytes: Cache Storage (populated by background/worker.js's
// comicDetectorDownload — the primary path for every install type, including
// a packed Chrome-Web-Store extension) first, then a bundled
// extension/models/comic-text-detector.onnx as a "Load unpacked" dev
// convenience (gitignored — see extension/models/README.md). Mirrors
// offscreen/paddle-runner.js's loadModelBytes/PADDLE_CACHE_NAME pattern —
// keep the cache name/URL in sync with worker.js's COMIC_DETECTOR_* consts.
// ---------------------------------------------------------------------------

const COMIC_DETECTOR_RELEASE_URL = 'https://github.com/naeminhye/webtoon-translator/releases/download/comic-text-detector-v1/comic-text-detector.onnx';
const COMIC_DETECTOR_CACHE_NAME  = 'comic-text-detector-models-v1';
const BUNDLED_MODEL_PATH = 'models/comic-text-detector.onnx';

const NOT_INSTALLED_MSG =
  'Bubble detector model not installed — open the extension popup, go to ' +
  'General → Auto-detect bubbles, and click "Download model".';

async function loadModelBytes() {
  const cache  = await caches.open(COMIC_DETECTOR_CACHE_NAME);
  const cached = await cache.match(COMIC_DETECTOR_RELEASE_URL);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  try {
    const res = await fetch(chrome.runtime.getURL(BUNDLED_MODEL_PATH));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch (_) { /* not bundled either — fall through to the error below */ }

  throw new Error(NOT_INSTALLED_MSG);
}

// ---------------------------------------------------------------------------
// Session singleton with warm-up
// ---------------------------------------------------------------------------

// Multi-threaded WASM is unusable in MV3: ORT spawns its thread pool via
// blob: worker scripts, and the extension-pages CSP cannot allow blob:
// script sources (importScripts NetworkError). Keep WASM single-threaded;
// WebGPU is the fast path.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths  = chrome.runtime.getURL('vendor/ort/');

// ORT 1.18 calls GPUAdapter.requestAdapterInfo(), which newer Chrome removed
// in favour of the GPUAdapter.info property. Polyfill it so the WebGPU EP
// can initialise. (Fixed upstream in onnxruntime-web ≥1.19 — drop this when
// the vendored bundle is upgraded.)
if (typeof GPUAdapter !== 'undefined' && !GPUAdapter.prototype.requestAdapterInfo) {
  GPUAdapter.prototype.requestAdapterInfo = function () {
    return Promise.resolve(this.info);
  };
}

let _sessionPromise = null;

async function warmUp(session) {
  // Compile graph so first real inference is not penalised.
  const dummy = new ort.Tensor(
    'float32',
    new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE),
    [1, 3, INPUT_SIZE, INPUT_SIZE],
  );
  await session.run({ images: dummy });
}

function getSession() {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    const bytes = await loadModelBytes();

    // Try WebGPU first, fall back to WASM explicitly so the console shows
    // which execution provider is actually in use. The warm-up run() is
    // covered by this same try/catch — a WebGPU session can construct
    // successfully but still fail once run() executes (e.g. Metal-backend
    // op/buffer limits on macOS); without covering warm-up here too, that
    // failure would propagate straight out of getSession() with no WASM
    // fallback, since by that point the if/else below has already committed
    // to the (broken) WebGPU session.
    let session;
    if (navigator.gpu) {
      try {
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        await warmUp(session);
        console.info('[ort-runner] execution provider: webgpu');
      } catch (err) {
        console.warn('[ort-runner] WebGPU init/warm-up failed, falling back to WASM:', err);
        session = null;
      }
    } else {
      console.warn('[ort-runner] navigator.gpu absent — WebGPU unavailable in this context');
    }
    if (!session) {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      await warmUp(session);
      console.info('[ort-runner] execution provider: wasm (single-thread)');
    }
    console.debug('[ort-runner] session ready (warm-up done)');
    return session;
  })().catch(err => {
    _sessionPromise = null; // allow retry on next call
    throw err;
  });
  return _sessionPromise;
}

// Kick off warm-up immediately when offscreen document loads.
getSession().catch(err => console.warn('[ort-runner] warm-up failed:', err));

// ---------------------------------------------------------------------------
// Preprocess: dataUrl → Float32Array CHW tensor + letterbox metadata
// ---------------------------------------------------------------------------

async function preprocess(dataUrl, inputSize) {
  const blob   = await fetch(dataUrl).then(r => r.blob());
  const bitmap = await createImageBitmap(blob);

  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // Letterbox: scale to fit inside inputSize×inputSize
  const scale = Math.min(inputSize / srcW, inputSize / srcH);
  const dstW  = Math.round(srcW * scale);
  const dstH  = Math.round(srcH * scale);
  const padX  = Math.floor((inputSize - dstW) / 2);
  const padY  = Math.floor((inputSize - dstH) / 2);

  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const ctx    = canvas.getContext('2d');

  // fill with pad colour
  ctx.fillStyle = `rgb(114,114,114)`;
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(bitmap, padX, padY, dstW, dstH);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const { data }  = imageData;                          // RGBA uint8
  const pixels    = inputSize * inputSize;
  const tensor    = new Float32Array(3 * pixels);

  // HWC RGBA → CHW RGB, normalise to [0,1]
  for (let i = 0; i < pixels; i++) {
    tensor[i]              = data[i * 4]     / 255; // R
    tensor[pixels + i]     = data[i * 4 + 1] / 255; // G
    tensor[pixels * 2 + i] = data[i * 4 + 2] / 255; // B
  }

  return { tensor, scale, padX, padY, srcW, srcH };
}

// ---------------------------------------------------------------------------
// Postprocess: blk output [1, 64512, 7] → boxes in original coords
//
// mayocream/comic-text-detector-onnx uses YOLOv5-style HWC layout:
//   each anchor row = [cx, cy, w, h, obj_conf, cls1_conf, cls2_conf]
//   coords are in model-input pixel space (0..INPUT_SIZE)
//   confidences are ALREADY sigmoid'd in the exported graph (standard YOLOv5
//   Detect layer) — applying sigmoid again maps raw ~0 values to 0.5, which
//   passes any sane threshold and floods NMS with tens of thousands of boxes
// ---------------------------------------------------------------------------

function postprocess(outputData, scale, padX, padY, srcW, srcH, confThresh, iouThresh) {
  // outputData shape: [1, 64512, 7] flattened → stride 7 per anchor
  const STRIDE = 7;
  const numAnchors = outputData.length / STRIDE;

  const candidates = [];
  for (let i = 0; i < numAnchors; i++) {
    const base     = i * STRIDE;
    const objConf  = outputData[base + 4];
    if (objConf < confThresh) continue;

    const clsConf  = Math.max(outputData[base + 5], outputData[base + 6]);
    const score    = objConf * clsConf;
    if (score < confThresh) continue;

    const cx = outputData[base];
    const cy = outputData[base + 1];
    const bw = outputData[base + 2];
    const bh = outputData[base + 3];

    // decode from model-input space back to original image coords
    const x1 = ((cx - bw / 2) - padX) / scale;
    const y1 = ((cy - bh / 2) - padY) / scale;
    const x2 = ((cx + bw / 2) - padX) / scale;
    const y2 = ((cy + bh / 2) - padY) / scale;

    candidates.push({
      x1: Math.max(0, x1),
      y1: Math.max(0, y1),
      x2: Math.min(srcW, x2),
      y2: Math.min(srcH, y2),
      score,
    });
  }

  return nms(candidates, iouThresh);
}

function iou(a, b) {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const aA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bA = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (aA + bA - inter);
}

function nms(boxes, iouThresh) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  const suppressed = new Uint8Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed[i]) continue;
    kept.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (!suppressed[j] && iou(boxes[i], boxes[j]) > iouThresh) {
        suppressed[j] = 1;
      }
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

// Serialize ALL ONNX Runtime inference in this offscreen document — not just
// detection jobs against each other. onnxruntime-web's WebGPU EP throws
// "Session mismatch" if .run() is called concurrently across *different*
// sessions sharing the same GPU device/queue (this bubble detector's session
// vs paddle-runner.js's det/rec sessions — e.g. auto-detect scanning bubbles
// while a PaddleOCR request is also in flight). self._ortJobQueue is the
// single shared queue every ORT-calling file in this document chains onto;
// declared via `self.` (not `let`) so it's unambiguously visible to
// paddle-runner.js regardless of <script> load order or scoping subtleties.
self._ortJobQueue ??= Promise.resolve();

function runDetection(payload) {
  const job = self._ortJobQueue.then(() => _runDetection(payload));
  self._ortJobQueue = job.catch(() => {}); // keep queue alive after a failed job
  return job;
}

async function _runDetection({ dataUrl, tileIndex, confThreshold, iouThreshold }) {
  const session = await getSession();
  const thresh  = confThreshold ?? CONF_THRESH;
  const iouT    = iouThreshold  ?? IOU_THRESH;

  const t0 = performance.now();
  const { tensor, scale, padX, padY, srcW, srcH } = await preprocess(dataUrl, INPUT_SIZE);
  const t1 = performance.now();

  const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results     = await session.run({ images: inputTensor });
  const t2 = performance.now();

  const outputData = results['blk'].data;
  const boxes      = postprocess(outputData, scale, padX, padY, srcW, srcH, thresh, iouT);
  const t3 = performance.now();

  console.debug(
    `[ort-runner] tile=${tileIndex ?? '-'} pre=${(t1-t0).toFixed(1)}ms` +
    ` run=${(t2-t1).toFixed(1)}ms post=${(t3-t2).toFixed(1)}ms boxes=${boxes.length}`,
  );

  return { boxes, tileIndex };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 'DETECT_RUN' (not 'DETECT_BUBBLES'): runtime.sendMessage from a content
  // script is delivered to ALL extension contexts including this offscreen
  // document, so the background→offscreen leg needs a distinct type (same
  // reason the OCR flow uses OCR_REGION vs OCR_RUN).
  if (message.type !== 'DETECT_RUN') return false;
  runDetection(message.payload)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message, boxes: [], tileIndex: message.payload?.tileIndex }));
  return true; // keep channel open for async response
});
