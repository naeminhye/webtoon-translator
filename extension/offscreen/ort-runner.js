'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_URL   = chrome.runtime.getURL('models/comic-text-detector.onnx');
const INPUT_SIZE  = 640;          // model expects 640×640
const PAD_VALUE   = 114 / 255;   // YOLO letterbox grey
const CONF_THRESH = 0.35;
const IOU_THRESH  = 0.45;

// ---------------------------------------------------------------------------
// Session singleton with warm-up
// ---------------------------------------------------------------------------

let _sessionPromise = null;

function getSession() {
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    // warm-up: compile graph so first real inference is not penalised
    const dummy = new ort.Tensor(
      'float32',
      new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE),
      [1, 3, INPUT_SIZE, INPUT_SIZE],
    );
    await session.run({ images: dummy });
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
// Postprocess: YOLOv8n output [1,5,8400] → boxes in original coords
// ---------------------------------------------------------------------------

function postprocess(outputData, scale, padX, padY, srcW, srcH, confThresh, iouThresh) {
  // outputData shape: [1, 5, 8400]  — transposed from usual [1,8400,5]
  // rows: cx, cy, w, h, conf  (each of length 8400)
  const numAnchors = 8400;
  const cx   = outputData.subarray(0 * numAnchors, 1 * numAnchors);
  const cy   = outputData.subarray(1 * numAnchors, 2 * numAnchors);
  const bw   = outputData.subarray(2 * numAnchors, 3 * numAnchors);
  const bh   = outputData.subarray(3 * numAnchors, 4 * numAnchors);
  const conf = outputData.subarray(4 * numAnchors, 5 * numAnchors);

  const candidates = [];
  for (let i = 0; i < numAnchors; i++) {
    if (conf[i] < confThresh) continue;
    // decode from model-input space back to original image coords
    const x1 = ((cx[i] - bw[i] / 2) - padX) / scale;
    const y1 = ((cy[i] - bh[i] / 2) - padY) / scale;
    const x2 = ((cx[i] + bw[i] / 2) - padX) / scale;
    const y2 = ((cy[i] + bh[i] / 2) - padY) / scale;
    candidates.push({
      x1: Math.max(0, x1),
      y1: Math.max(0, y1),
      x2: Math.min(srcW, x2),
      y2: Math.min(srcH, y2),
      score: conf[i],
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

async function runDetection({ dataUrl, tileIndex, confThreshold, iouThreshold }) {
  const session = await getSession();
  const thresh  = confThreshold ?? CONF_THRESH;
  const iouT    = iouThreshold  ?? IOU_THRESH;

  const t0 = performance.now();
  const { tensor, scale, padX, padY, srcW, srcH } = await preprocess(dataUrl, INPUT_SIZE);
  const t1 = performance.now();

  const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results     = await session.run({ images: inputTensor });
  const t2 = performance.now();

  const outputData = results['output0'].data;
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
  if (message.type !== 'DETECT_BUBBLES') return false;
  runDetection(message.payload)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message, boxes: [], tileIndex: message.payload?.tileIndex }));
  return true; // keep channel open for async response
});
