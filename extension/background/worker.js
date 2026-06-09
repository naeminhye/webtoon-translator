/**
 * background/worker.js
 * Service worker for Webtoon Translate extension.
 *
 * Phase 1: All storage is local (chrome.storage.local).
 * Phase 2 migration note: Replace saveTranslations/loadTranslations with
 *   Supabase REST calls. Auth token management lives here (not in content scripts)
 *   because service workers are the only persistent context for token refresh.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_TRANSLATIONS':
      handleSave(message.payload).then(sendResponse);
      return true; // keep channel open for async

    case 'LOAD_TRANSLATIONS':
      handleLoad(message.payload).then(sendResponse);
      return true;

    case 'EXPORT_CHAPTER':
      handleExport(message.payload).then(sendResponse);
      return true;

    case 'IMPORT_FILE':
      handleImport(message.payload).then(sendResponse);
      return true;
  }
});

/**
 * Storage key format: `wt:${site}:${titleId}:${chapterId}`
 * Value: TranslationChapter (see types.js)
 */
async function handleSave({ site, titleId, chapterId, annotations }) {
  const key = storageKey(site, titleId, chapterId);
  const existing = await getLocal(key) || { site, titleId, chapterId, annotations: [] };

  // Upsert by imageHash + bbox proximity
  for (const incoming of annotations) {
    const idx = existing.annotations.findIndex(
      a => a.imageHash === incoming.imageHash && bboxesMatch(a.bbox, incoming.bbox)
    );
    if (idx >= 0) {
      existing.annotations[idx] = incoming;
    } else {
      existing.annotations.push(incoming);
    }
  }

  await chrome.storage.local.set({ [key]: existing });
  return { ok: true };
}

async function handleLoad({ site, titleId, chapterId }) {
  const key = storageKey(site, titleId, chapterId);
  const data = await getLocal(key);
  return { annotations: data?.annotations || [] };
}

async function handleExport({ site, titleId }) {
  // Collect all chapters for this title
  const allKeys = await getAllKeysForTitle(site, titleId);
  const chapters = {};

  for (const key of allKeys) {
    const data = await getLocal(key);
    if (data) chapters[data.chapterId] = data.annotations;
  }

  const exportData = {
    version: 1,
    site,
    titleId,
    language: 'vi', // TODO: pull from settings
    exportedAt: new Date().toISOString(),
    chapters,
  };

  return { exportData };
}

async function handleImport({ jsonString }) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  if (parsed.version !== 1) {
    return { ok: false, error: `Unsupported version: ${parsed.version}` };
  }

  const { site, titleId, chapters } = parsed;
  let count = 0;

  for (const [chapterId, annotations] of Object.entries(chapters)) {
    await handleSave({ site, titleId, chapterId, annotations });
    count += annotations.length;
  }

  return { ok: true, imported: count };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function storageKey(site, titleId, chapterId) {
  return `wt:${site}:${titleId}:${chapterId}`;
}

function getLocal(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result[key]));
  });
}

async function getAllKeysForTitle(site, titleId) {
  const prefix = `wt:${site}:${titleId}:`;
  return new Promise(resolve => {
    chrome.storage.local.get(null, all => {
      resolve(Object.keys(all).filter(k => k.startsWith(prefix)));
    });
  });
}

/**
 * Two bboxes match if their centers are within 2% of each other.
 * Avoids exact float comparison issues.
 */
function bboxesMatch(a, b) {
  const cx1 = a.x + a.w / 2, cy1 = a.y + a.h / 2;
  const cx2 = b.x + b.w / 2, cy2 = b.y + b.h / 2;
  return Math.abs(cx1 - cx2) < 2 && Math.abs(cy1 - cy2) < 2;
}
