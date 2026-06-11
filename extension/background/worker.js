/**
 * background/worker.js — Phase 1: chrome.storage.local
 * Migration note: replace handleSave/handleLoad/handleDelete with
 * Supabase REST calls in Phase 2. Auth token refresh lives here.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_TRANSLATIONS':   handleSave(message.payload).then(sendResponse);   return true;
    case 'LOAD_TRANSLATIONS':   handleLoad(message.payload).then(sendResponse);   return true;
    case 'DELETE_ANNOTATION':   handleDelete(message.payload).then(sendResponse); return true;
    case 'EXPORT_CHAPTER':      handleExport(message.payload).then(sendResponse); return true;
    case 'IMPORT_FILE':         handleImport(message.payload).then(sendResponse); return true;
    case 'CLEAR_CHAPTER':       handleClear(message.payload).then(sendResponse);  return true;
    case 'OCR_REGION':
      handleOcr(message.payload)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'OCR_STATUS':
      // Relay engine progress from the offscreen document to content scripts
      // (runtime.sendMessage never reaches content scripts directly)
      chrome.tabs.query({
        url: [
          'https://comic.naver.com/*', 'https://m.comic.naver.com/*',
          'https://page.kakao.com/*', 'https://www.ridi.com/*',
        ],
      }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id != null) {
            chrome.tabs.sendMessage(tab.id, message, () => void chrome.runtime.lastError);
          }
        }
      });
      return false;
  }
});

async function handleSave({ site, titleId, chapterId, annotations }) {
  const key      = storageKey(site, titleId, chapterId);
  const existing = await getLocal(key) || { site, titleId, chapterId, annotations: [] };

  for (const incoming of annotations) {
    // Match by imageHash + exact bbox X (rounded to 1dp) — stable identifier
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

  // Dedupe on read — last write wins by createdAt
  const seen = new Map();
  for (const ann of raw) {
    const k = annKey(ann);
    const existing = seen.get(k);
    if (!existing || new Date(ann.createdAt) >= new Date(existing.createdAt)) seen.set(k, ann);
  }
  const deduped = [...seen.values()];

  // If we found duplicates, write back the clean version
  if (deduped.length < raw.length && data) {
    data.annotations = deduped;
    await chrome.storage.local.set({ [key]: data });
  }

  return { annotations: deduped };
}

async function handleDelete({ site, titleId, chapterId, annKey: keyToDelete }) {
  const key  = storageKey(site, titleId, chapterId);
  const data = await getLocal(key);
  if (!data) return { ok: true };

  const before = data.annotations.length;
  data.annotations = data.annotations.filter(a => annKey(a) !== keyToDelete);

  await chrome.storage.local.set({ [key]: data });
  return { ok: true, removed: before - data.annotations.length };
}

async function handleExport({ site, titleId }) {
  const allKeys = await getAllKeysForTitle(site, titleId);
  const chapters = {};
  for (const key of allKeys) {
    const data = await getLocal(key);
    if (data) chapters[data.chapterId] = data.annotations;
  }
  return {
    exportData: {
      version: 1, site, titleId, language: 'vi',
      exportedAt: new Date().toISOString(), chapters,
    },
  };
}

async function handleClear({ site, titleId, chapterId }) {
  await chrome.storage.local.remove(storageKey(site, titleId, chapterId));
  return { ok: true };
}

async function handleImport({ jsonString }) {
  let parsed;
  try { parsed = JSON.parse(jsonString); }
  catch { return { ok: false, error: 'Invalid JSON' }; }

  if (parsed.version !== 1) return { ok: false, error: `Unsupported version: ${parsed.version}` };

  const { site, titleId, chapters } = parsed;
  let count = 0;
  for (const [chapterId, annotations] of Object.entries(chapters)) {
    // handleSave upserts by annKey — no duplicates even if imported twice
    await handleSave({ site, titleId, chapterId, annotations });
    count += annotations.length;
  }
  return { ok: true, imported: count };
}

// ── OCR ───────────────────────────────────────────────────────────────────────
// Two providers: 'tesseract' (offline, offscreen doc) and 'ocrspace' (online API).
// If the content script couldn't crop (tainted canvas), imageUrl + bbox are sent
// instead of dataUrl; the service worker fetches + crops here using OffscreenCanvas.

const OCR_PROVIDER_KEY  = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR = 'wt:ocrspace-key';

// Developer-supplied OCR.space key — bundled so end users never need to paste one.
// Leave blank ('') to require users to enter their own key in the popup.
const DEV_OCR_SPACE_KEY = '';

// Tesseract results below this confidence threshold trigger an OCR.space fallback
// when a key is available (complex backgrounds, small/stylised text).
const TESSERACT_CONFIDENCE_THRESHOLD = 50;

async function handleOcr({ dataUrl, imageUrl, bbox }) {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [OCR_SPACE_KEY_STR]: '',
  });
  const provider = stored[OCR_PROVIDER_KEY];
  const ocrKey   = stored[OCR_SPACE_KEY_STR] || DEV_OCR_SPACE_KEY;

  // Resolve dataUrl — crop here if content script was blocked by canvas taint
  let finalDataUrl = dataUrl;
  if (!finalDataUrl && imageUrl) {
    finalDataUrl = await fetchAndCrop(imageUrl, bbox);
  }

  if (provider === 'ocrspace') {
    if (!ocrKey) {
      return { ok: false, error: 'OCR.space API key not set — open the extension popup to add it.' };
    }
    return ocrSpaceRun(finalDataUrl, ocrKey);
  }

  // Tesseract — attempt first, then auto-fallback to OCR.space when the
  // result is empty or low-confidence (complex bg, small/stylised text).
  const tessResult = await tesseractRun(finalDataUrl);
  if (tessResult.ok && tessResult.text && (tessResult.confidence ?? 100) >= TESSERACT_CONFIDENCE_THRESHOLD) {
    return tessResult;
  }

  if (ocrKey) {
    // Silent fallback — add a marker so the UI can hint which engine was used
    const spaceResult = await ocrSpaceRun(finalDataUrl, ocrKey);
    if (spaceResult.ok && spaceResult.text) return { ...spaceResult, fallback: true };
  }

  // Return the original Tesseract result (even if empty/low-confidence) when
  // no OCR.space key is available or OCR.space also failed.
  return tessResult;
}

// ── OCR.space ─────────────────────────────────────────────────────────────────

async function ocrSpaceRun(dataUrl, apiKey) {
  const body = new URLSearchParams({
    apikey: apiKey,
    base64Image: dataUrl,
    language: 'kor',
    OCREngine: '2',
    isTable: 'false',
    detectOrientation: 'false',
    scale: 'true',
  });
  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body });
  if (!res.ok) return { ok: false, error: `OCR.space HTTP ${res.status}` };
  const json = await res.json();
  if (json.IsErroredOnProcessing) {
    const msg = Array.isArray(json.ErrorMessage)
      ? json.ErrorMessage.join(' ')
      : (json.ErrorMessage || 'unknown error');
    return { ok: false, error: `OCR.space: ${msg}` };
  }
  const text = (json.ParsedResults || [])
    .map(r => (r.ParsedText || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { ok: true, text };
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

async function tesseractRun(dataUrl) {
  if (!chrome.offscreen?.createDocument) {
    return { ok: false, error: 'Offscreen API unavailable — reload extension (Chrome 109+)' };
  }
  await ensureOffscreen();
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_RUN', payload: { dataUrl } });
      if (res) return res;
      lastErr = new Error('OCR worker did not respond');
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr || new Error('OCR worker did not respond');
}

// ── Image fetch + crop (service-worker side, full cross-origin access) ────────

async function fetchAndCrop(imageUrl, bbox) {
  const res    = await fetch(imageUrl, { credentials: 'omit' });
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

async function getAllKeysForTitle(site, titleId) {
  const prefix = `wt:${site}:${titleId}:`;
  return new Promise(resolve =>
    chrome.storage.local.get(null, all => resolve(Object.keys(all).filter(k => k.startsWith(prefix))))
  );
}
