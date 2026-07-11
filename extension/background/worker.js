/**
 * background/worker.js — chrome.storage.local persistence + OCR/translation pipeline
 */

// Naver/Kakao CDNs enforce a Referer check — requests without one get
// ERR_CONNECTION_RESET. Derive a plausible Referer from the image URL so
// every cross-origin panel fetch succeeds without hardcoding per-site values.
function _refererFor(imageUrl) {
  try {
    const u = new URL(imageUrl);
    // pstatic.net → Naver; fallback to same origin as caller
    if (u.hostname.endsWith('pstatic.net')) return 'https://comic.naver.com/';
    if (u.hostname.endsWith('kakaocdn.net') || u.hostname.endsWith('kakao.com')) return 'https://page.kakao.com/';
    return u.origin + '/';
  } catch { return ''; }
}

function _fetchImage(imageUrl) {
  const referer = _refererFor(imageUrl);
  // Use the `referrer` fetch init option — NOT headers['Referer'] (a forbidden header
  // that browsers silently strip). The fetch init `referrer` field IS the correct API
  // for controlling the Referer sent on the request.
  return fetch(imageUrl, { credentials: 'omit', ...(referer ? { referrer: referer } : {}) });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_TRANSLATIONS':   handleSave(message.payload).then(sendResponse);   return true;
    case 'LOAD_TRANSLATIONS':   handleLoad(message.payload).then(sendResponse);   return true;
    case 'DELETE_ANNOTATION':   handleDelete(message.payload).then(sendResponse); return true;
    case 'CLEAR_CHAPTER':       handleClear(message.payload).then(sendResponse);  return true;
    case 'OCR_REGION':
      handleOcr(message.payload)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'OCR_STITCH':
      handleOcrStitch(message.payload)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'CROP_IMAGE':
      handleCropImage(message.payload)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'DETECT_BUBBLES':
      handleDetectBubbles(message.payload)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message || String(err), boxes: [], tileIndex: message.payload?.tileIndex }));
      return true;
    case 'OCR_STATUS':
      // Relay engine progress from the offscreen document to content scripts
      // (runtime.sendMessage never reaches content scripts directly)
      chrome.tabs.query({
        url: [
          'https://comic.naver.com/*', 'https://m.comic.naver.com/*',
          'https://page.kakao.com/*', 'https://ridibooks.com/*',
        ],
      }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id != null) {
            chrome.tabs.sendMessage(tab.id, message, () => void chrome.runtime.lastError);
          }
        }
      });
      return false;
    case 'PADDLE_MODELS_STATUS':
      paddleModelsStatus().then(sendResponse);
      return true;
    case 'PADDLE_MODELS_DOWNLOAD':
      paddleModelsDownload().then(sendResponse);
      return true;
    case 'PADDLE_MODELS_CLEAR':
      paddleModelsClear().then(sendResponse);
      return true;
    case 'GET_OCR_STATS':
      chrome.storage.local.get({ [OCR_STATS_KEY]: {} })
        .then(stored => sendResponse({ ok: true, stats: stored[OCR_STATS_KEY] }));
      return true;
    case 'RESET_OCR_STATS':
      chrome.storage.local.set({ [OCR_STATS_KEY]: {} })
        .then(() => sendResponse({ ok: true }));
      return true;
  }
});

// Bitmap cache for tile compositing — adjacent tiles overlap by 128px, so the
// same webtoon image is typically needed by 2+ tiles. Small LRU keyed by URL.
const _tileBitmapCache = new Map(); // url → ImageBitmap
const TILE_BITMAP_CACHE_MAX = 8;

async function _getTileBitmap(url) {
  if (_tileBitmapCache.has(url)) {
    const bmp = _tileBitmapCache.get(url);
    _tileBitmapCache.delete(url); // refresh LRU order
    _tileBitmapCache.set(url, bmp);
    return bmp;
  }
  const res    = await _fetchImage(url);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);
  _tileBitmapCache.set(url, bitmap);
  if (_tileBitmapCache.size > TILE_BITMAP_CACHE_MAX) {
    const [oldestUrl, oldest] = _tileBitmapCache.entries().next().value;
    _tileBitmapCache.delete(oldestUrl);
    oldest.close();
  }
  return bitmap;
}

// Composites the tile in the service worker (cross-origin fetch is allowed
// here via host_permissions, so no canvas taint) and forwards the resulting
// dataUrl to the offscreen ONNX runner.
// Two payload shapes from the content script:
//  { dataUrl, tileIndex }            — tile already composited in-page (blob:
//                                      image sites, CORS-clean hosts)
//  { imageUrl, sy, sh, tileIndex }   — tainting hosts: fetch the original here
//                                      (host_permissions bypasses CORS) and
//                                      crop the [sy, sy+sh] height fraction
async function handleDetectBubbles({ dataUrl: precomposed, imageUrl, sy, sh, tileIndex }) {
  let dataUrl = precomposed;
  if (!dataUrl) {
    const bitmap = await _getTileBitmap(imageUrl);
    const cropY = Math.round(sy * bitmap.height);
    const cropH = Math.max(1, Math.min(bitmap.height - cropY, Math.round(sh * bitmap.height)));
    const canvas = new OffscreenCanvas(bitmap.width, cropH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, cropY, bitmap.width, cropH, 0, 0, bitmap.width, cropH);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to encode tile'));
      reader.readAsDataURL(blob);
    });
  }
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: 'DETECT_RUN', payload: { dataUrl, tileIndex } });
}

async function handleSave({ site, titleId, chapterId, annotations }) {
  const key      = storageKey(site, titleId, chapterId);
  const existing = await getLocal(key) || { site, titleId, chapterId, annotations: [] };

  for (const incoming of annotations) {
    const incomingKey = annKey(incoming);
    const idx = existing.annotations.findIndex(a => annKey(a) === incomingKey);
    if (idx >= 0) existing.annotations[idx] = incoming;
    else          existing.annotations.push(incoming);
  }

  await chrome.storage.local.set({ [key]: existing });
  return { ok: true };
}

async function handleLoad({ site, titleId, chapterId }) {
  const key  = storageKey(site, titleId, chapterId);
  const data = await getLocal(key);
  const raw  = data?.annotations || [];

  // Dedupe
  const seen = new Map();
  for (const ann of raw) {
    const k = annKey(ann);
    const existing = seen.get(k);
    if (!existing || new Date(ann.createdAt) >= new Date(existing.createdAt)) seen.set(k, ann);
  }

  return { annotations: [...seen.values()] };
}

async function handleDelete({ site, titleId, chapterId, annKey: keyToDelete }) {
  const key  = storageKey(site, titleId, chapterId);
  const data = await getLocal(key);
  if (data) {
    data.annotations = data.annotations.filter(a => annKey(a) !== keyToDelete);
    await chrome.storage.local.set({ [key]: data });
  }
  return { ok: true, removed: data ? data.annotations.length : 0 };
}

async function handleClear({ site, titleId, chapterId }) {
  await chrome.storage.local.remove(storageKey(site, titleId, chapterId));
  return { ok: true };
}

// ── OCR ───────────────────────────────────────────────────────────────────────
// Three providers: 'tesseract' (offline, offscreen doc),
// 'paddleocr' (self-hosted HTTP server, see server/paddleocr/) and
// 'paddleocr-local' (PP-OCR ONNX in the offscreen doc, see offscreen/paddle-runner.js).
// If the content script couldn't crop (tainted canvas), imageUrl + bbox are sent
// instead of dataUrl; the service worker fetches + crops here using OffscreenCanvas.

const OCR_PROVIDER_KEY  = 'wt:ocr-provider';
const PADDLE_URL_KEY    = 'wt:paddleocr-url';

// Mirrors popup/settings.js — keep in sync. Used when the stored URL is ''.
const DEFAULT_PADDLE_URL = 'http://127.0.0.1:8868';

// ── OCR confidence stats (per-provider, local-only) ────────────────────────────
// Tracks call count + running average confidence per provider so Settings can
// show "which engine reports higher confidence on this device" — self-reported
// certainty from each engine, NOT a verified accuracy measurement (there's no
// ground truth here to compare against). Stored under one flat key rather than
// per-chapter like annotations, since this is a device-wide rollup, not
// per-title data.
const OCR_STATS_KEY = 'wt:ocr-stats';

// Serializes read-modify-write cycles against storage.local so concurrent OCR
// completions (e.g. several auto-detect jobs finishing close together) can't
// lose an update to each other — same rationale as offscreen/paddle-runner.js's
// self._ortJobQueue.
let _statsQueue = Promise.resolve();

function recordOcrStat(provider, confidence) {
  if (!provider) return;
  const job = _statsQueue.then(async () => {
    const stored = await chrome.storage.local.get({ [OCR_STATS_KEY]: {} });
    const stats = stored[OCR_STATS_KEY];
    const s = stats[provider] || { count: 0, confCount: 0, confSum: 0 };
    s.count++;
    if (typeof confidence === 'number') {
      s.confCount++;
      s.confSum += confidence;
    }
    stats[provider] = s;
    await chrome.storage.local.set({ [OCR_STATS_KEY]: stats });
  });
  _statsQueue = job.catch(() => {}); // keep queue alive after a failed write
  return job;
}

// ── OCR crop refinement: text-cluster detection within the inset crop ──────
// The percentage-inset fix (bundle.js's OCR_CROP_INSET_PCT) assumes bubble
// margin is roughly evenly distributed around the text, which isn't true for
// lopsided/asymmetric bubble shapes — inset alone can still leave noise on
// one side while clipping text on the other. This is a second, more precise
// pass: within the already-inset crop, find the actual dark-pixel text
// cluster and re-crop tightly to that instead.
//
// Runs here (not the content script) because handleOcr is the one place
// every OCR request funnels through no matter its origin — same-origin
// direct crop, cross-origin background-fetched crop (fetchAndCrop above), or
// a stitched multi-panel crop (handleOcrStitch calls back into handleOcr) —
// so this is the only point guaranteed to have decodable pixels for ALL of
// them. The content script never sees pixels for the common CDN
// cross-origin-tainted-canvas case, since cropping already happens over here.
//
// Black-text-on-light-background only (task scope) — colored/non-black text
// won't cross the dark/light split Otsu's method finds (see _otsuThreshold),
// finds no dark-pixel cluster, and falls straight through to the inset-only
// crop below (never blocks OCR).

const OCR_TEXT_DILATE_PX              = 2;    // merges individual character strokes into connected line blocks; same separable-dilation algorithm as bundle.js's dilateMask (duplicated here — content script and service worker are separate execution contexts in this codebase, nothing to import between them)
const OCR_TEXT_MERGE_DISTANCE_PX      = 14;   // gap (px) within which two SMALL text blocks are merged into the cluster; needs tuning against real multi-line bubbles. Large blocks ignore this entirely — see OCR_TEXT_MERGE_SIZE_RATIO
const OCR_TEXT_MERGE_SIZE_RATIO       = 0.45; // a block whose own bbox area is >= this fraction of the largest block found in the crop is always merged in, regardless of gap distance — fixes irregular line spacing (e.g. a bubble narrowing near its tail) dropping a real, full-size text line just because it sits farther from the rest than OCR_TEXT_MERGE_DISTANCE_PX allows. Only blocks BELOW this ratio still go through the distance check. Needs tuning alongside OCR_TEXT_MERGE_DISTANCE_PX — too low and real noise blobs start qualifying as "large enough"; too high and irregular-spacing lines stop qualifying
// Bubble borders (oval outline rings, spiky borders) appear as thin curved arcs
// in the OCR crop. After dilation they have a large bbox but very few filled
// pixels relative to that bbox — much lower fill-density than a text glyph.
// Blobs below this density fraction (pixelCount / bboxArea) are pre-filtered
// before the size-ratio / distance merge pass, so they can't be pulled in as
// "large blocks" even when their bbox area meets OCR_TEXT_MERGE_SIZE_RATIO.
const OCR_TEXT_MIN_BLOB_DENSITY       = 0.15; // needs tuning against real screenshots of various bubble border styles
const OCR_TEXT_MIN_CLUSTER_W_PX       = 10;   // px — reject a merged cluster narrower than this as noise, not text
const OCR_TEXT_MIN_CLUSTER_H_PX       = 8;    // px — reject a merged cluster shorter than this as noise, not text
const OCR_TEXT_MIN_CLUSTER_AREA_RATIO = 0.02; // merged cluster bbox area / full crop area — reject specks too small relative to the crop to plausibly be the dialogue
const OCR_TEXT_CLUSTER_PADDING_FRAC   = 0.15; // padding added around the merged cluster (fraction of its own w/h) so glyph descenders/ascenders/anti-aliasing aren't clipped right at the ink edge

/**
 * Otsu's method: finds the luminance threshold that best splits `luminances`
 * (one 0-255 value per pixel) into two classes — text vs. background —
 * minimizing intra-class variance (equivalently, maximizing between-class
 * variance). Replaces a single fixed tuned constant (the old
 * OCR_TEXT_DARK_THRESHOLD) with a value computed fresh from THIS crop's own
 * histogram, so contrast/lighting differences between crops don't need one
 * constant to fit all of them. Straightforward implementation — doesn't
 * special-case degenerate (near-uniform, no real bimodal split) histograms
 * beyond what the algorithm does naturally, consistent with the rest of this
 * pipeline's "coarse, tune via real screenshots" approach.
 */
function _otsuThreshold(luminances) {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < luminances.length; i++) {
    histogram[Math.min(255, Math.max(0, Math.round(luminances[i])))]++;
  }

  const total = luminances.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumBackground = 0, weightBackground = 0, maxBetweenVariance = -Infinity, threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const betweenVariance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (betweenVariance > maxBetweenVariance) { maxBetweenVariance = betweenVariance; threshold = t; }
  }
  return threshold;
}

/** Same separable square dilation as bundle.js's dilateMask — see OCR_TEXT_DILATE_PX above for why it's duplicated rather than imported. */
function _dilateMask(mask, w, h, radius) {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dx = -radius; dx <= radius && !on; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < w && mask[y * w + nx]) on = 1;
      }
      tmp[y * w + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < h && tmp[ny * w + x]) on = 1;
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Labels every 4-connected component of `mask` (a binary Uint8Array over a w x h grid). Returns [{minX,minY,maxX,maxY,pixelCount}, ...] — one entry per distinct dark-pixel blob (e.g. one word/line fragment before merging). */
function _labelConnectedComponents(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    const stack = [start];
    let minX = start % w, maxX = minX, minY = (start / w) | 0, maxY = minY, pixelCount = 0;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx / w) | 0;
      pixelCount++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack.push(idx - 1); }
      if (x < w - 1 && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack.push(idx + 1); }
      if (y > 0     && mask[idx - w] && !visited[idx - w]) { visited[idx - w] = 1; stack.push(idx - w); }
      if (y < h - 1 && mask[idx + w] && !visited[idx + w]) { visited[idx + w] = 1; stack.push(idx + w); }
    }
    components.push({ minX, minY, maxX, maxY, pixelCount });
  }
  return components;
}

/** Gap (px) between two component bboxes along whichever axis actually separates them — 0 if they overlap/touch. */
function _componentGap(a, b) {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
  return Math.max(dx, dy);
}

/**
 * Decides which raw text-block components belong in the final merged
 * dialogue bbox, and returns that single merged bbox (or null if `components`
 * is empty). Pure distance-based merging drops real text lines that sit an
 * irregular distance from the rest of the dialogue — e.g. a bubble that
 * narrows near its tail, widening the gap before its last line — because a
 * real, full-size text line sitting far away looks identical to a small,
 * genuinely-noise blob sitting far away.
 *
 * Fix: a block whose own bbox area is >= `sizeRatioThreshold` of the largest
 * block found in this crop is ALWAYS included, no matter how far it sits
 * from the rest (it's plausibly a real text line, not noise). Only blocks
 * below that ratio still go through the gap-distance check — a stray
 * punctuation mark or partial character close to the cluster likely belongs
 * to it; one far away is more likely noise. Distance-qualified inclusion is
 * iterated to a fixed point, since including one small block can bring
 * another, farther small block within range of the (now bigger) cluster.
 *
 * `decisions` (returned for [OcrCropRefine] logging/tuning) records every
 * candidate block's area ratio, gap-to-cluster, and why it was in/excluded.
 */
function _mergeNearbyComponents(components, mergeDistancePx, sizeRatioThreshold) {
  const blocks = components.map(c => ({
    ...c,
    area: (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1),
  }));
  const maxBlockArea = Math.max(...blocks.map(b => b.area));

  const included = [];
  const decisions = [];

  // Pass 1: large-enough blocks are in unconditionally (the single biggest
  // block always qualifies against itself, so `included` is never empty here).
  // Pre-filter: skip thin arc-shaped blobs (bubble border segments) whose fill
  // density (pixelCount / bboxArea) is too low to be a text glyph. These can
  // have a large bbox but very few actual dark pixels, unlike real characters.
  for (const b of blocks) {
    const density = b.pixelCount / b.area;
    if (density < OCR_TEXT_MIN_BLOB_DENSITY) {
      decisions.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, areaRatio: +(b.area / maxBlockArea).toFixed(3), gap: 0, density: +density.toFixed(3), includedBy: null, included: false });
      continue;
    }
    const areaRatio = b.area / maxBlockArea;
    if (areaRatio >= sizeRatioThreshold) {
      included.push(b);
      decisions.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, areaRatio: +areaRatio.toFixed(3), density: +density.toFixed(3), gap: 0, includedBy: 'size', included: true });
    }
  }

  // Pass 2: remaining (small) blocks — include only if within gap distance of
  // an already-included block, iterating since one merge can pull another
  // small block into range.
  const remaining = blocks.filter(b => !included.includes(b));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of remaining) {
      if (included.includes(b)) continue;
      const gap = Math.min(...included.map(o => _componentGap(b, o)));
      if (gap <= mergeDistancePx) {
        included.push(b);
        decisions.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, areaRatio: +(b.area / maxBlockArea).toFixed(3), density: +(b.pixelCount / b.area).toFixed(3), gap, includedBy: 'distance', included: true });
        changed = true;
      }
    }
  }

  // Whatever's left never qualified by either rule — noise.
  for (const b of remaining) {
    if (included.includes(b)) continue;
    const gap = Math.min(...included.map(o => _componentGap(b, o)));
    decisions.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, areaRatio: +(b.area / maxBlockArea).toFixed(3), density: +(b.pixelCount / b.area).toFixed(3), gap, includedBy: null, included: false });
  }

  if (!included.length) return { merged: null, decisions };

  const merged = included.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY),
    pixelCount: acc.pixelCount + b.pixelCount,
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, pixelCount: 0 });

  return { merged, decisions };
}

/**
 * Attempts a tighter, text-cluster-based re-crop of `dataUrl` (already the
 * percentage-inset crop from bundle.js's OCR_CROP_INSET_PCT step). Never
 * throws and never blocks OCR — on any failure or "nothing found" case, it
 * returns the ORIGINAL dataUrl unchanged with source: 'inset-fallback' (see
 * requirement #4 in the task this implements). source: 'text-cluster' means
 * the tighter crop was used instead.
 */
async function refineOcrCropToTextCluster(dataUrl) {
  if (!dataUrl) return { dataUrl, source: 'inset-fallback', reason: 'no-input' };

  try {
    const res    = await fetch(dataUrl);
    const blob   = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width, h = bitmap.height;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, w, h);

    const luminances = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      luminances[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const otsuThreshold = _otsuThreshold(luminances);
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < luminances.length; p++) {
      if (luminances[p] < otsuThreshold) mask[p] = 1;
    }

    const dilated    = _dilateMask(mask, w, h, OCR_TEXT_DILATE_PX);
    const components = _labelConnectedComponents(dilated, w, h);
    if (!components.length) {
      return { dataUrl, source: 'inset-fallback', reason: 'no-dark-pixels', otsuThreshold };
    }

    const { merged: best, decisions } = _mergeNearbyComponents(components, OCR_TEXT_MERGE_DISTANCE_PX, OCR_TEXT_MERGE_SIZE_RATIO);
    if (!best) {
      return { dataUrl, source: 'inset-fallback', reason: 'no-dark-pixels', decisions, otsuThreshold };
    }
    // Exactly one raw block contributing to the merge is a reasonable proxy
    // for "this is a single isolated line" (vs. several blocks merged
    // together, i.e. multi-line dialogue) — used to pick a tighter PSM for
    // Tesseract (see handleOcr -> tesseractRun). Not perfectly reliable (a
    // single line can still split into >1 raw block if dilation doesn't
    // bridge every character gap), just a best-effort signal.
    const isSingleLine = decisions.filter(d => d.included).length === 1;
    const bw = best.maxX - best.minX + 1, bh = best.maxY - best.minY + 1;
    const areaRatio = (bw * bh) / (w * h);

    if (bw < OCR_TEXT_MIN_CLUSTER_W_PX || bh < OCR_TEXT_MIN_CLUSTER_H_PX || areaRatio < OCR_TEXT_MIN_CLUSTER_AREA_RATIO) {
      return { dataUrl, source: 'inset-fallback', reason: 'cluster-too-small', bw, bh, areaRatio: +areaRatio.toFixed(3), decisions, otsuThreshold, isSingleLine };
    }

    const padX = Math.round(bw * OCR_TEXT_CLUSTER_PADDING_FRAC);
    const padY = Math.round(bh * OCR_TEXT_CLUSTER_PADDING_FRAC);
    const cropX = Math.max(0, best.minX - padX);
    const cropY = Math.max(0, best.minY - padY);
    const cropW = Math.min(w, best.maxX + 1 + padX) - cropX;
    const cropH = Math.min(h, best.maxY + 1 + padY) - cropY;

    const outCanvas = new OffscreenCanvas(cropW, cropH);
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const outBlob = await outCanvas.convertToBlob({ type: 'image/png' });
    const refinedDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to encode refined crop'));
      reader.readAsDataURL(outBlob);
    });

    return { dataUrl: refinedDataUrl, source: 'text-cluster', cropW, cropH, areaRatio: +areaRatio.toFixed(3), decisions, otsuThreshold, isSingleLine };
  } catch (e) {
    return { dataUrl, source: 'inset-fallback', reason: 'refine-error', error: e.message || String(e) };
  }
}

async function handleOcr({ dataUrl, imageUrl, bbox, refineCrop = true }) {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [PADDLE_URL_KEY]:    '',
  });
  const provider = stored[OCR_PROVIDER_KEY];

  // Resolve dataUrl — crop here if content script was blocked by canvas taint
  let finalDataUrl = dataUrl;
  if (!finalDataUrl && imageUrl) {
    finalDataUrl = await fetchAndCrop(imageUrl, bbox);
  }

  // Second, more precise crop pass — tighten to the actual text-pixel
  // cluster within the inset crop above. Falls back to the inset crop
  // unchanged if nothing valid is found (see refineOcrCropToTextCluster).
  // Skipped entirely for a manual region (refineCrop false) — the content
  // script already sent the exact, un-inset user-drawn bbox for those, and
  // this step assumes a flood-fill bubble shape's margin, which doesn't
  // apply here (see bundle.js's runOcr for the source: 'auto' | 'manual' gate).
  // isSingleLine (see refineOcrCropToTextCluster) tells tesseractRun whether
  // to use a tighter PSM — stays false for manual regions (no refinement
  // ever ran) and for any refinement fallback case (nothing to base it on),
  // matching PSM.SINGLE_BLOCK as the safe default per task scope.
  let isSingleLine = false;
  if (refineCrop) {
    const { dataUrl: _refinedDataUrl, ...refineDebug } = await refineOcrCropToTextCluster(finalDataUrl);
    console.log('[OcrCropRefine]', refineDebug);
    finalDataUrl = _refinedDataUrl;
    isSingleLine = refineDebug.isSingleLine === true;
  } else {
    console.log('[OcrCropRefine]', { source: 'manual-skip' });
  }

  let result;
  if (provider === 'paddleocr') {
    const endpoint = (stored[PADDLE_URL_KEY] || DEFAULT_PADDLE_URL).replace(/\/+$/, '');
    result = await paddleOcrRun(finalDataUrl, endpoint);
  } else if (provider === 'paddleocr-local') {
    result = await paddleLocalRun(finalDataUrl);
  } else {
    // Tesseract — primary (and default) offline OCR engine.
    const tessResult = await tesseractRun(finalDataUrl, isSingleLine);
    const tessText   = cleanKoreanOcrText(tessResult.text || '') || tessResult.text || '';
    result = { ...tessResult, text: tessText, provider: 'tesseract' };
  }

  // Single choke point for every OCR result regardless of provider/branch —
  // see recordOcrStat() for why this lives here instead of in bundle.js.
  // Awaited (not fire-and-forget) so the write finishes before this async
  // function itself resolves — an MV3 service worker can be torn down once
  // nothing is tracking it as busy, and an un-awaited storage write here
  // would race that teardown and could silently lose the update.
  if (result?.ok !== false) {
    await recordOcrStat(result.provider || provider, typeof result?.confidence === 'number' ? result.confidence : null);
  }
  return result;
}

// Strip non-Korean noise from OCR output while preserving valid Korean text
// and common punctuation. Applied post-OCR to remove garbage characters from
// bubble tails or adjacent panel content bleeding into the crop region.
function cleanKoreanOcrText(text) {
  const cleaned = text
    .replace(/[^가-힣ㄱ-ㅎㅏ-ㅣ\s.,!?…~‼！。、·『』「」\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

// ── Multi-image stitch OCR ───────────────────────────────────────────────────────

async function handleOcrStitch({ clips, refineCrop = true }) {
  // Fetch and crop each clip, normalize to same display scale, stitch vertically, OCR
  const items = await Promise.all(clips.map(async ({ imageUrl, bbox, dispW }) => {
    const res  = await _fetchImage(imageUrl);
    const blob = await res.blob();
    const bm   = await createImageBitmap(blob);
    const sx = (bbox.x / 100) * bm.width;
    const sy = (bbox.y / 100) * bm.height;
    const sw = Math.max(1, (bbox.w / 100) * bm.width);
    const sh = Math.max(1, (bbox.h / 100) * bm.height);
    // dispW: display-pixel width of clip (used for scale normalization)
    return { bm, sx, sy, sw, sh, dispW: dispW || sw };
  }));

  // All clips rendered at TARGET_W pixels wide so text from each panel is same scale
  const maxDispW = Math.max(...items.map(i => i.dispW));
  const TARGET_W = Math.max(600, Math.round(maxDispW * (maxDispW < 600 ? Math.min(3, 600 / maxDispW) : 1)));

  const rows = items.map(({ bm, sx, sy, sw, sh, dispW }) => {
    const scale = TARGET_W / dispW;
    const dispH = sh * (dispW / sw);        // display-pixel height of this clip
    return { bm, sx, sy, sw, sh, dw: TARGET_W, dh: Math.round(dispH * scale) };
  });

  const totalH = rows.reduce((s, r) => s + r.dh, 0);
  const canvas = new OffscreenCanvas(TARGET_W, totalH);
  const ctx    = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let dy = 0;
  for (const { bm, sx, sy, sw, sh, dw, dh } of rows) {
    ctx.drawImage(bm, sx, sy, sw, sh, 0, dy, dw, dh);
    bm.close();
    dy += dh;
  }

  const blob    = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to encode stitched image'));
    reader.readAsDataURL(blob);
  });

  return handleOcr({ dataUrl, imageUrl: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, refineCrop });
}

// ── OCR Detect: full-image block detection for auto-indicators ────────────────

// ── PaddleOCR (self-hosted HTTP server, see server/paddleocr/) ────────────────

// No cleanKoreanOcrText() here — that filter exists to scrub Tesseract garbage
// and would strip digits/Latin from otherwise-good output.
async function paddleOcrRun(dataUrl, endpoint) {
  let res;
  try {
    res = await fetch(`${endpoint}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
  } catch (_) {
    return { ok: false, error: `PaddleOCR server unreachable at ${endpoint} — is it running? (see server/paddleocr/README.md)` };
  }
  if (!res.ok) return { ok: false, error: `PaddleOCR server HTTP ${res.status}` };
  let json;
  try {
    json = await res.json();
  } catch (_) {
    return { ok: false, error: 'PaddleOCR server returned invalid JSON' };
  }
  if (!json.ok) return { ok: false, error: `PaddleOCR: ${json.error || 'unknown error'}` };
  const text = (json.text || '').replace(/\s+/g, ' ').trim();
  // Server reports confidence on the 0-100 scale (see bundle.js's confNorm).
  const confidence = typeof json.confidence === 'number' ? json.confidence : null;
  return { ok: true, text, confidence, provider: 'paddleocr' };
}

// ── Tesseract (offscreen document) ────────────────────────────────────────────

let offscreenReady = null;

function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen/ocr.html',
        reasons: ['WORKERS'],
        justification: 'Run Tesseract.js OCR (WASM web workers) on user-selected panel regions',
      });
    })().catch(err => { offscreenReady = null; throw err; });
  }
  return offscreenReady;
}

async function tesseractRun(dataUrl, isSingleLine = false) {
  if (!chrome.offscreen?.createDocument) {
    return { ok: false, error: 'Offscreen API unavailable — reload extension (Chrome 109+)' };
  }
  await ensureOffscreen();
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_RUN', payload: { dataUrl, isSingleLine } });
      if (res) return res;
      lastErr = new Error('OCR worker did not respond');
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr || new Error('OCR worker did not respond');
}

// ── PaddleOCR in-browser (offscreen document, see offscreen/paddle-runner.js) ─

async function paddleLocalRun(dataUrl) {
  if (!chrome.offscreen?.createDocument) {
    return { ok: false, error: 'Offscreen API unavailable — reload extension (Chrome 109+)' };
  }
  await ensureOffscreen();
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PADDLE_OCR_RUN', payload: { dataUrl } });
      if (res) return res;
      lastErr = new Error('PaddleOCR worker did not respond');
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr || new Error('PaddleOCR worker did not respond');
}

// ── PaddleOCR in-browser model download (Cache Storage API) ───────────────────
// The packaged extension does NOT ship the ~15 MB det+rec ONNX files (they're
// gitignored — see extension/models/README.md) because most users won't pick
// this engine, and a Chrome-Web-Store-installed extension can't have files
// written into its own package after install anyway. Instead, models are
// fetched at runtime (from a GitHub Release of this repo) into the Cache
// Storage API here in the service worker — a plain data fetch, which Web
// Store policy explicitly allows (unlike fetching executable code).
//
// Cache Storage is same-origin (chrome-extension://<id>) regardless of which
// extension context calls caches.open(), so offscreen/paddle-runner.js reads
// the exact same cache when it builds the ONNX sessions — no message-passing
// needed between this download step and actual OCR use.
const PADDLE_MODELS_RELEASE = 'https://github.com/naeminhye/webtoon-translator/releases/download/paddle-models-v1/';
const PADDLE_CACHE_NAME     = 'paddle-ocr-models-v1';
const PADDLE_MODEL_FILES = {
  det: { url: PADDLE_MODELS_RELEASE + 'paddle-det.onnx',        label: 'detector',   approxMB: 4.7 },
  rec: { url: PADDLE_MODELS_RELEASE + 'paddle-rec-korean.onnx', label: 'recognizer', approxMB: 10.6 },
};

function broadcastPaddleModelsEvent(payload) {
  chrome.runtime.sendMessage({ type: 'PADDLE_MODELS_EVENT', payload }, () => void chrome.runtime.lastError);
}

async function paddleModelsStatus() {
  const cache = await caches.open(PADDLE_CACHE_NAME);
  const status = { ok: true, downloading: _paddleDownloadInFlight };
  for (const [key, { url }] of Object.entries(PADDLE_MODEL_FILES)) {
    status[key] = (await cache.match(url)) ? 'cached' : 'missing';
  }
  return status;
}

let _paddleDownloadInFlight = false;

async function paddleModelsDownload() {
  if (_paddleDownloadInFlight) return { ok: false, error: 'A download is already in progress.' };
  _paddleDownloadInFlight = true;
  try {
    const cache = await caches.open(PADDLE_CACHE_NAME);
    for (const [key, { url, label }] of Object.entries(PADDLE_MODEL_FILES)) {
      if (await cache.match(url)) {
        broadcastPaddleModelsEvent({ stage: key, state: 'done', cached: true });
        continue;
      }
      broadcastPaddleModelsEvent({ stage: key, state: 'downloading' });
      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        throw new Error(`Could not reach the ${label} model download (${err.message || err}) — check your connection.`);
      }
      if (!res.ok) throw new Error(`${label} model download failed: HTTP ${res.status}`);
      await cache.put(url, res);
      broadcastPaddleModelsEvent({ stage: key, state: 'done' });
    }
    broadcastPaddleModelsEvent({ stage: 'all', state: 'done' });
    return { ok: true };
  } catch (err) {
    const error = err.message || String(err);
    broadcastPaddleModelsEvent({ stage: 'error', state: 'error', error });
    return { ok: false, error };
  } finally {
    _paddleDownloadInFlight = false;
  }
}

async function paddleModelsClear() {
  const cache = await caches.open(PADDLE_CACHE_NAME);
  for (const { url } of Object.values(PADDLE_MODEL_FILES)) await cache.delete(url);
  return { ok: true };
}

// ── Image fetch + crop (service-worker side, full cross-origin access) ────────

async function fetchAndCrop(imageUrl, bbox) {
  const res    = await _fetchImage(imageUrl);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const sx = (bbox.x / 100) * bitmap.width;
  const sy = (bbox.y / 100) * bitmap.height;
  const sw = Math.max(1, (bbox.w / 100) * bitmap.width);
  const sh = Math.max(1, (bbox.h / 100) * bitmap.height);
  const scale = sw < 400 ? Math.min(3, 400 / sw) : 1;

  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const cropBlob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to encode cropped image'));
    reader.readAsDataURL(cropBlob);
  });
}

/**
 * Fetches imageUrl (service-worker side, so no cross-origin canvas taint) and
 * crops it to `bbox` (% of natural image size) at 1:1 pixel scale — no OCR
 * upscaling, so the caller's pixel-space math (e.g. flood-fill detection)
 * still lines up with the returned image.
 */
async function fetchAndCropRaw(imageUrl, bbox) {
  const res    = await _fetchImage(imageUrl);
  const blob   = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.round((bbox.x / 100) * bitmap.width);
  const sy = Math.round((bbox.y / 100) * bitmap.height);
  const sw = Math.max(1, Math.round((bbox.w / 100) * bitmap.width));
  const sh = Math.max(1, Math.round((bbox.h / 100) * bitmap.height));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const cropBlob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to encode cropped image'));
    reader.readAsDataURL(cropBlob);
  });
}

async function handleCropImage({ imageUrl, bbox }) {
  const dataUrl = await fetchAndCropRaw(imageUrl, bbox);
  return { ok: true, dataUrl };
}

// ── extension on/off badge ────────────────────────────────────────────────────
// `wt:enabled` (default true) is the global switch toggled from the popup.
// Reflect it on the toolbar icon so the state is visible without opening the popup.

const ENABLED_KEY = 'wt:enabled';

async function updateBadge() {
  const stored  = await chrome.storage.local.get({ [ENABLED_KEY]: true });
  const enabled = stored[ENABLED_KEY];
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  if (!enabled) await chrome.action.setBadgeBackgroundColor({ color: '#94a3b8' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ENABLED_KEY in changes) updateBadge();
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
updateBadge();

// ── helpers ───────────────────────────────────────────────────────────────────

/** Stable unique key for an annotation — survives round-trips */
function annKey(a) {
  return `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}`;
}

function storageKey(site, titleId, chapterId) { return `wt:${site}:${titleId}:${chapterId}`; }

function getLocal(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key])));
}
