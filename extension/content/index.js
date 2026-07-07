/**
 * content/index.js
 * Entry point injected into all supported pages.
 *
 * Responsibilities:
 *   1. Detect which site adapter to use
 *   2. Fetch saved annotations for this chapter
 *   3. Render overlays on existing images
 *   4. Listen for new images (infinite scroll)
 *   5. Listen for mode changes from the popup
 */

import { NaverAdapter } from './adapters/naver.js';
import { RidiAdapter } from './adapters/ridi.js';
import { KakaoAdapter } from './adapters/kakao.js';
import { BomtoonAdapter } from './adapters/bomtoon.js';
import { BBoxSelector } from './annotation-engine/selector.js';
import { OverlayRenderer } from './annotation-engine/overlay.js';
import { InputDialog } from './annotation-engine/input-dialog.js';
import { hashImage } from './annotation-engine/hasher.js';
import { MODES, MSG } from './types.js';

const ADAPTERS = [new NaverAdapter(), new RidiAdapter(), new KakaoAdapter(), new BomtoonAdapter()];

// ── Boot ─────────────────────────────────────────────────────────────────────

const adapter = ADAPTERS.find(a => a.detect());
if (!adapter) {
  console.log('[WebtoonTranslate] No adapter matched this page');
} else {
  boot(adapter);
}

async function boot(adapter) {
  const meta = adapter.getChapterMeta();
  console.log('[WebtoonTranslate] Active:', meta);

  const renderer = new OverlayRenderer();
  const selector = new BBoxSelector({ onSelect: handleBBoxSelect });
  const dialog = new InputDialog();

  let currentMode = MODES.READ;
  let images = [];

  // Load and render existing translations
  async function loadAndRender() {
    const { annotations } = await sendToBackground({
      type: MSG.LOAD_TRANSLATIONS,
      payload: meta,
    });

    // Group annotations by imageHash for efficient lookup
    const byHash = new Map();
    for (const ann of annotations) {
      if (!byHash.has(ann.imageHash)) byHash.set(ann.imageHash, []);
      byHash.get(ann.imageHash).push(ann);
    }

    // Render on currently loaded images
    for (const img of images) {
      const hash = await hashImage(img);
      const anns = byHash.get(hash) || [];
      if (anns.length > 0) renderer.renderForImage(img, anns);
    }
  }

  // Handle images already on page
  images = adapter.getImages();
  await loadAndRender();

  // Watch for new images (infinite scroll / lazy load)
  const stopWatching = adapter.watchNewImages(async (newImages) => {
    const added = newImages.filter(img => !images.includes(img));
    if (added.length === 0) return;
    images = [...images, ...added];

    if (currentMode === MODES.ANNOTATE) {
      added.forEach((img, i) => selector.attachImage(img, images.indexOf(img)));
    }

    await loadAndRender();
  });

  // ── BBox selection handler ────────────────────────────────────────────────

  async function handleBBoxSelect({ bbox, imageEl, imageIndex }) {
    const screenPos = {
      x: imageEl.getBoundingClientRect().left + (bbox.x / 100) * imageEl.offsetWidth,
      y: imageEl.getBoundingClientRect().top + (bbox.y / 100) * imageEl.offsetHeight + window.scrollY,
    };

    const result = await dialog.show(screenPos);
    if (!result) return;

    const imageHash = await hashImage(imageEl);
    const annotation = {
      imageHash,
      imageIndex,
      bbox,
      originalText: result.originalText,
      translatedText: result.translatedText,
      language: 'vi', // TODO: pull from settings
      createdAt: new Date().toISOString(),
    };

    // Save to local storage
    await sendToBackground({
      type: MSG.SAVE_TRANSLATIONS,
      payload: { ...meta, annotations: [annotation] },
    });

    // Immediately render the new bubble
    renderer.upsertBubble(imageEl, annotation);
  }

  // ── Mode switching (from popup) ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SET_MODE') {
      currentMode = message.mode;

      if (currentMode === MODES.ANNOTATE) {
        selector.enable(images);
      } else {
        selector.disable();
      }
    }

    if (message.type === 'TRIGGER_EXPORT') {
      triggerExport(meta);
    }

    if (message.type === 'TRIGGER_IMPORT') {
      triggerImport();
    }
  });

  // ── Export / Import ───────────────────────────────────────────────────────

  async function triggerExport({ site, titleId }) {
    const { exportData } = await sendToBackground({
      type: MSG.EXPORT_CHAPTER,
      payload: { site, titleId },
    });

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webtoon-translate_${site}_${titleId}_vi.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const { ok, imported, error } = await sendToBackground({
        type: MSG.IMPORT_FILE,
        payload: { jsonString: text },
      });

      if (ok) {
        alert(`[WebtoonTranslate] Imported ${imported} translations. Reload to see them.`);
      } else {
        alert(`[WebtoonTranslate] Import failed: ${error}`);
      }
    });
    input.click();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sendToBackground(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
}
