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

// ── OCR (offscreen document) ──────────────────────────────────────────────────
// Tesseract.js needs DOM/WASM workers, which a service worker can't host.
// We lazily create one offscreen document and forward crops to it.

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

async function handleOcr(payload) {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API unavailable — fully reload the extension (Chrome 109+ required)');
  }
  await ensureOffscreen();
  // runtime.sendMessage reaches extension pages (incl. offscreen), not content
  // scripts. Retry briefly: the offscreen document may still be executing its
  // scripts right after createDocument() resolves.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OCR_RUN', payload });
      if (res) return res;
      lastErr = new Error('OCR worker did not respond');
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr || new Error('OCR worker did not respond');
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
