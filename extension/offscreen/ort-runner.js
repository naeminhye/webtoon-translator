/**
 * offscreen/ort-runner.js — ONNX Runtime Web inference runner.
 *
 * Runs inside the same offscreen document as ocr.js so it shares the
 * OffscreenCanvas / createImageBitmap APIs needed for image preprocessing.
 * ort.min.js must be loaded before this file (see ocr.html script order).
 *
 * Implements speech-bubble / text-region detection using a CRAFT-style or
 * YOLOv8 detector model stored at extension/models/bubble-detector.onnx.
 * When the model file is not present the handler responds gracefully so the
 * extension degrades to the existing manual-bbox flow.
 */

// ── WASM configuration ───────────────────────────────────────────────────────
// Must be set before any InferenceSession.create() call.
// numThreads=1 avoids the SharedArrayBuffer requirement (SAB needs COOP/COEP
// headers which chrome-extension:// offscreen documents don't guarantee).
ort.env.wasm.wasmPaths  = chrome.runtime.getURL('vendor/ort/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd       = true; // SIMD is supported in all modern Chrome

// ── Constants ────────────────────────────────────────────────────────────────
const MODEL_URL    = chrome.runtime.getURL('models/bubble-detector.onnx');
const INPUT_SIZE   = 640;   // model expects 640×640 input
const CONF_THRESH  = 0.35;  // minimum detection confidence
const IOU_THRESH   = 0.45;  // NMS IOU threshold

// ── Session lifecycle ────────────────────────────────────────────────────────
let sessionPromise = null;

function broadcastOnnx(status, progress, message) {
  try {
    chrome.runtime.sendMessage(
      { type: 'ONNX_STATUS', payload: { status, progress, message } },
      () => void chrome.runtime.lastError
    );
  } catch (_) { /* extension reloading */ }
}

function getSession() {
  if (!sessionPromise) {
    broadcastOnnx('loading-model');
    sessionPromise = ort.InferenceSession
      .create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      .then(s => {
        broadcastOnnx('model-ready');
        return s;
      })
      .catch(err => {
        sessionPromise = null; // allow retry
        broadcastOnnx('error', undefined, err.message || String(err));
        throw err;
      });
  }
  return sessionPromise;
}

// ── Image preprocessing ──────────────────────────────────────────────────────
/**
 * Letterbox-resize a dataUrl to INPUT_SIZE×INPUT_SIZE, convert to a
 * Float32 CHW tensor normalised to [0, 1] (YOLO convention).
 *
 * Returns { tensor, meta } where meta holds the letterbox parameters needed
 * to map output coordinates back to original image space.
 */
async function preprocessImage(dataUrl) {
  const blob   = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const srcW   = bitmap.width;
  const srcH   = bitmap.height;

  // Scale to fit within INPUT_SIZE while preserving aspect ratio
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW  = Math.round(srcW * scale);
  const newH  = Math.round(srcH * scale);
  const padX  = Math.floor((INPUT_SIZE - newW) / 2);
  const padY  = Math.floor((INPUT_SIZE - newH) / 2);

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx    = canvas.getContext('2d');
  // Grey padding matches the YOLO letterbox convention (128, 128, 128)
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, padX, padY, newW, newH);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE); // RGBA Uint8
  const n        = INPUT_SIZE * INPUT_SIZE;
  const float32  = new Float32Array(3 * n);

  // Interleaved RGBA → planar CHW, normalise to [0, 1]
  for (let i = 0; i < n; i++) {
    float32[0 * n + i] = data[i * 4 + 0] / 255; // R plane
    float32[1 * n + i] = data[i * 4 + 1] / 255; // G plane
    float32[2 * n + i] = data[i * 4 + 2] / 255; // B plane
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  return { tensor, meta: { scale, padX, padY, srcW, srcH } };
}

// ── Output decoding ──────────────────────────────────────────────────────────
/**
 * Decode a YOLOv8 raw output tensor [1, 5, N] where each anchor is
 * (cx, cy, w, h, conf) in letterboxed 640×640 space.
 * Returns boxes in original-image pixel coordinates, sorted by confidence.
 */
function decodeYolo(outputTensor, meta) {
  const { scale, padX, padY, srcW, srcH } = meta;
  const data = outputTensor.data; // Float32Array
  const N    = outputTensor.dims[2]; // number of anchors (typically 8400)
  const candidates = [];

  for (let i = 0; i < N; i++) {
    const conf = data[4 * N + i];
    if (conf < CONF_THRESH) continue;

    const cx = data[0 * N + i];
    const cy = data[1 * N + i];
    const bw = data[2 * N + i];
    const bh = data[3 * N + i];

    // De-letterbox → original image pixel coordinates
    const x1 = Math.max(0, (cx - bw / 2 - padX) / scale);
    const y1 = Math.max(0, (cy - bh / 2 - padY) / scale);
    const x2 = Math.min(srcW, (cx + bw / 2 - padX) / scale);
    const y2 = Math.min(srcH, (cy + bh / 2 - padY) / scale);

    if (x2 > x1 && y2 > y1) candidates.push({ x1, y1, x2, y2, conf });
  }

  return nms(candidates);
}

/**
 * Decode a CRAFT-style output: score_text heatmap [1, H, W, 1] or [1, 1, H, W].
 * Returns pixel-coordinate boxes from connected components on threshold mask.
 */
function decodeCraft(outputTensor, meta) {
  const { scale, padX, padY, srcW, srcH } = meta;
  const dims   = outputTensor.dims; // [1, H, W, 1] or [1, 1, H, W]
  const data   = outputTensor.data;
  const mapH   = dims[1] === 1 ? dims[2] : dims[1]; // handle both layouts
  const mapW   = dims[1] === 1 ? dims[3] : dims[2];
  const THRESH = 0.5;

  // Build binary mask
  const mask = new Uint8Array(mapH * mapW);
  for (let i = 0; i < mapH * mapW; i++) {
    mask[i] = data[i] > THRESH ? 1 : 0;
  }

  // Connected components → bounding boxes (4-connected)
  const labels  = new Int32Array(mapH * mapW).fill(-1);
  let   nextId  = 0;
  const boxes   = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const idx = y * mapW + x;
      if (!mask[idx] || labels[idx] >= 0) continue;

      // BFS flood fill
      const id    = nextId++;
      const queue = [idx];
      let   x1m = x, y1m = y, x2m = x, y2m = y;

      while (queue.length) {
        const cur  = queue.pop();
        const cy   = Math.floor(cur / mapW);
        const cx   = cur % mapW;
        if (labels[cur] >= 0) continue;
        labels[cur] = id;
        x1m = Math.min(x1m, cx); y1m = Math.min(y1m, cy);
        x2m = Math.max(x2m, cx); y2m = Math.max(y2m, cy);

        const neighbors = [
          cur - 1, cur + 1, cur - mapW, cur + mapW,
        ];
        for (const nb of neighbors) {
          if (nb >= 0 && nb < mask.length && mask[nb] && labels[nb] < 0) {
            const ny = Math.floor(nb / mapW);
            const nx = nb % mapW;
            if (nx >= 0 && nx < mapW && ny >= 0 && ny < mapH) queue.push(nb);
          }
        }
      }

      // Map from heatmap coords → original image coords
      const hScaleX = INPUT_SIZE / mapW;
      const hScaleY = INPUT_SIZE / mapH;
      const px1 = Math.max(0, ((x1m * hScaleX) - padX) / scale);
      const py1 = Math.max(0, ((y1m * hScaleY) - padY) / scale);
      const px2 = Math.min(srcW, ((x2m + 1) * hScaleX - padX) / scale);
      const py2 = Math.min(srcH, ((y2m + 1) * hScaleY - padY) / scale);

      // Filter tiny noise components (< 1% of image area)
      const area = (px2 - px1) * (py2 - py1);
      if (area > srcW * srcH * 0.0005 && px2 > px1 && py2 > py1) {
        boxes.push({ x1: px1, y1: py1, x2: px2, y2: py2, conf: 0.9 });
      }
    }
  }

  return nms(boxes);
}

/**
 * Decode a YOLOv8 output in transposed format [1, N, 5+].
 * Some export pipelines (e.g. ultralytics with transpose=True) produce
 * (num_anchors, 4+num_classes) instead of the standard (4+num_classes, num_anchors).
 */
function decodeYoloTransposed(outputTensor, meta) {
  const { scale, padX, padY, srcW, srcH } = meta;
  const data       = outputTensor.data;
  const N          = outputTensor.dims[1]; // number of anchors
  const stride     = outputTensor.dims[2]; // columns per anchor (cx,cy,w,h,conf,…)
  const candidates = [];

  for (let i = 0; i < N; i++) {
    const base = i * stride;
    const conf = data[base + 4]; // confidence at column index 4
    if (conf < CONF_THRESH) continue;

    const cx = data[base + 0];
    const cy = data[base + 1];
    const bw = data[base + 2];
    const bh = data[base + 3];

    const x1 = Math.max(0, (cx - bw / 2 - padX) / scale);
    const y1 = Math.max(0, (cy - bh / 2 - padY) / scale);
    const x2 = Math.min(srcW, (cx + bw / 2 - padX) / scale);
    const y2 = Math.min(srcH, (cy + bh / 2 - padY) / scale);

    if (x2 > x1 && y2 > y1) candidates.push({ x1, y1, x2, y2, conf });
  }

  return nms(candidates);
}

// ── NMS ──────────────────────────────────────────────────────────────────────
function iou(a, b) {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const aA    = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bA    = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (aA + bA - inter + 1e-6);
}

function nms(boxes) {
  boxes.sort((a, b) => b.conf - a.conf);
  const kept       = [];
  const suppressed = new Set();
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (iou(boxes[i], boxes[j]) > IOU_THRESH) suppressed.add(j);
    }
  }
  return kept;
}

// ── Main detection function ──────────────────────────────────────────────────
async function detectBubbles(dataUrl) {
  const session = await getSession();
  const { tensor, meta } = await preprocessImage(dataUrl);

  // Run inference — input node name depends on model export
  const inputName = session.inputNames[0];
  const results   = await session.run({ [inputName]: tensor });

  // Auto-detect output format by inspecting output tensor shape
  const outputName = session.outputNames[0];
  const out        = results[outputName];
  const dims       = out.dims;

  let boxes;
  if (dims.length === 3 && dims[1] === 5) {
    // YOLOv8 format: [1, 5, N] — channel-first (standard export)
    boxes = decodeYolo(out, meta);
  } else if (dims.length === 3 && dims[2] >= 5) {
    // YOLOv8 transposed format: [1, N, 5+] — some exporters produce this
    boxes = decodeYoloTransposed(out, meta);
  } else {
    // CRAFT-style heatmap
    boxes = decodeCraft(out, meta);
  }

  // Convert pixel coords → percentage (matches the extension's bbox format)
  return boxes.map(b => ({
    x:    (b.x1 / meta.srcW) * 100,
    y:    (b.y1 / meta.srcH) * 100,
    w:    ((b.x2 - b.x1) / meta.srcW) * 100,
    h:    ((b.y2 - b.y1) / meta.srcH) * 100,
    conf: b.conf,
  }));
}

// ── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'ONNX_DETECT') return;
  (async () => {
    try {
      const bboxes = await detectBubbles(message.payload.dataUrl);
      sendResponse({ ok: true, bboxes });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
