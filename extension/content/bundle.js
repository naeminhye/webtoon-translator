// ============================================================
// Webtoon Translate — content script bundle (no ES modules)
// All source files inlined. Edit the originals, then re-bundle.
// ============================================================

(function () {
'use strict';

// ── constants (types.js) ────────────────────────────────────────────────────

const SITES = { NAVER: 'naver', RIDI: 'ridi', KAKAO: 'kakao' };
const MODES = { READ: 'read', ANNOTATE: 'annotate' };
const MSG = {
  SAVE_TRANSLATIONS: 'SAVE_TRANSLATIONS',
  LOAD_TRANSLATIONS: 'LOAD_TRANSLATIONS',
  EXPORT_CHAPTER:    'EXPORT_CHAPTER',
  IMPORT_FILE:       'IMPORT_FILE',
};

// ── hasher.js ───────────────────────────────────────────────────────────────

const CHUNK_SIZE = 64 * 1024;

async function hashImage(img) {
  if (img.__wtHash) return img.__wtHash;
  try {
    const response = await fetch(img.src, { credentials: 'include' });
    const buffer   = await response.arrayBuffer();
    const chunk    = buffer.slice(0, CHUNK_SIZE);
    const hashBuf  = await crypto.subtle.digest('SHA-256', chunk);
    const hex      = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    img.__wtHash = `sha256:${hex}`;
  } catch (err) {
    console.warn('[WebtoonTranslate] hash fallback for', img.src, err);
    const urlHash = img.src.split('?')[0].split('/').slice(-2).join('/');
    img.__wtHash = `url:${urlHash}`;
  }
  return img.__wtHash;
}

// ── selector.js ─────────────────────────────────────────────────────────────

class BBoxSelector {
  constructor({ onSelect }) {
    this.onSelect    = onSelect;
    this.overlays    = new Map();
    this.active      = false;
    this._currentDrag = null;
  }

  enable(images) {
    this.active = true;
    images.forEach((img, index) => this._attachOverlay(img, index));
  }

  disable() {
    this.active = false;
    for (const [, overlay] of this.overlays) {
      overlay._cleanup && overlay._cleanup();
      overlay.remove();
    }
    this.overlays.clear();
  }

  attachImage(img, index) {
    if (this.active) this._attachOverlay(img, index);
  }

  _attachOverlay(img, imageIndex) {
    if (this.overlays.has(img)) return;

    const wrapper = this._ensureWrapper(img);
    const overlay = document.createElement('div');
    overlay.className = 'wt-selector-overlay';
    overlay.dataset.imageIndex = imageIndex;
    wrapper.appendChild(overlay);
    this.overlays.set(img, overlay);

    let startX, startY, selectionEl;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      // If the click landed on an existing bubble, let it through for editing
      if (e.target.closest('.wt-translation-bubble')) return;
      e.preventDefault();
      const rect = overlay.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      selectionEl = document.createElement('div');
      selectionEl.className = 'wt-selection-rect';
      overlay.appendChild(selectionEl);
      this._currentDrag = { overlay, selectionEl, startX, startY };
    };

    const onMouseMove = (e) => {
      if (!this._currentDrag || this._currentDrag.overlay !== overlay) return;
      const rect = overlay.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      selectionEl.style.left   = `${Math.min(startX, cx)}px`;
      selectionEl.style.top    = `${Math.min(startY, cy)}px`;
      selectionEl.style.width  = `${Math.abs(cx - startX)}px`;
      selectionEl.style.height = `${Math.abs(cy - startY)}px`;
    };

    const onMouseUp = (e) => {
      if (!this._currentDrag || this._currentDrag.overlay !== overlay) return;
      const rect = overlay.getBoundingClientRect();
      const ex = e.clientX - rect.left;
      const ey = e.clientY - rect.top;
      const px = Math.min(startX, ex), py = Math.min(startY, ey);
      const pw = Math.abs(ex - startX), ph = Math.abs(ey - startY);
      selectionEl.remove();
      this._currentDrag = null;
      if (pw < 10 || ph < 10) return;
      const bbox = {
        x: (px / rect.width)  * 100,
        y: (py / rect.height) * 100,
        w: (pw / rect.width)  * 100,
        h: (ph / rect.height) * 100,
      };
      this.onSelect({ bbox, imageEl: img, imageIndex });
    };

    overlay.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    overlay._cleanup = () => {
      overlay.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    };
  }

  _ensureWrapper(img) {
    const parent = img.parentElement;
    if (parent && parent.classList.contains('wt-img-wrapper')) return parent;
    const wrapper = document.createElement('div');
    wrapper.className = 'wt-img-wrapper';
    // CRITICAL: wrapper must be inline-block or fit-content width
    // so it hugs the image, not full-width of the container.
    // This ensures absolute-positioned children (overlays, bubbles)
    // are positioned relative to the image edge, not the page edge.
    img.parentElement.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    img.style.display = 'block';
    // Size wrapper to image — must happen after img is in DOM
    const setWrapperSize = () => {
      const w = img.offsetWidth || img.naturalWidth;
      if (w > 0) {
        wrapper.style.cssText = `position:relative;display:block;width:${w}px;line-height:0;margin:0 auto;padding:0;`;
      } else {
        // Image not laid out yet — wait for load
        img.addEventListener('load', () => {
          const w2 = img.offsetWidth || img.naturalWidth;
          wrapper.style.cssText = `position:relative;display:block;width:${w2}px;line-height:0;margin:0 auto;padding:0;`;
        }, { once: true });
      }
    };
    setWrapperSize();
    return wrapper;
  }
}

// ── overlay.js ──────────────────────────────────────────────────────────────

class OverlayRenderer {
  constructor() {
    this.imageState = new Map();
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) this._repositionForWrapper(entry.target);
    });
  }

  renderForImage(img, annotations) {
    const wrapper = this._ensureWrapper(img);
    const state   = this.imageState.get(img);
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();
    for (const ann of annotations) {
      const bubble = this._createBubble(ann);
      this._positionBubble(bubble, ann.bbox, img);
      wrapper.appendChild(bubble);
      state.bubbles.set(this._annKey(ann), bubble);
    }
  }

  upsertBubble(img, annotation) {
    const wrapper = this._ensureWrapper(img);
    const state   = this.imageState.get(img);
    const key     = this._annKey(annotation);
    state.bubbles.get(key)?.remove();
    const bubble = this._createBubble(annotation);
    wrapper.appendChild(bubble);
    state.bubbles.set(key, bubble);

    // Position immediately, then re-position after layout settles
    // (image may not have rendered dimensions yet on first call)
    this._positionBubble(bubble, annotation.bbox, img);
    if (img.complete && img.naturalWidth > 0) {
      requestAnimationFrame(() => this._positionBubble(bubble, annotation.bbox, img));
    } else {
      img.addEventListener('load', () => {
        requestAnimationFrame(() => this._positionBubble(bubble, annotation.bbox, img));
      }, { once: true });
    }
  }

  clearImage(img) {
    const state = this.imageState.get(img);
    if (!state) return;
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();
  }

  _ensureWrapper(img) {
    if (this.imageState.has(img)) return this.imageState.get(img).wrapper;
    let wrapper = img.parentElement;
    if (!wrapper || !wrapper.classList.contains('wt-img-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'wt-img-wrapper';
      // inline-block so wrapper width = image width, not container width
      img.parentElement.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      img.style.display = 'block';
      const w = img.offsetWidth || img.naturalWidth;
      if (w > 0) {
        wrapper.style.cssText = `position:relative;display:block;width:${w}px;line-height:0;margin:0 auto;padding:0;`;
      } else {
        wrapper.style.cssText = `position:relative;display:block;line-height:0;margin:0;padding:0;`;
        img.addEventListener('load', () => {
          const w2 = img.offsetWidth || img.naturalWidth;
          if (w2 > 0) wrapper.style.width = `${w2}px`;
        }, { once: true });
      }
    }
    this.imageState.set(img, { wrapper, bubbles: new Map() });
    this._resizeObserver.observe(wrapper);
    return wrapper;
  }

  _createBubble(ann) {
    const b = document.createElement('div');
    b.className = 'wt-translation-bubble';
    b.dataset.annKey = this._annKey(ann);
    b.dataset.bboxX  = ann.bbox.x;
    b.dataset.bboxY  = ann.bbox.y;
    b.dataset.bboxW  = ann.bbox.w;
    b.dataset.bboxH  = ann.bbox.h;
    b.style.boxShadow = 'none'; // always off per item 1
    if (ann.style) {
      const s = ann.style;
      b.style.fontSize   = `${s.fontSize || 13}px`;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
      b.style.background = s.noBg   ? 'transparent' : (s.bg || 'rgba(255,255,255,0.95)');
      // Stroke via text-shadow (4-direction outline trick)
      if (s.stroke && s.strokeColor) {
        const sc = s.strokeColor;
        const sw = s.strokeWidth || 1;
        b.style.textShadow = `${sw}px 0 ${sc}, -${sw}px 0 ${sc}, 0 ${sw}px ${sc}, 0 -${sw}px ${sc}`;
      } else {
        b.style.textShadow = 'none';
      }
    }
    // Use a span so text wraps inside the bbox, not overflows
    const span = document.createElement('span');
    span.textContent = ann.translatedText;
    b.appendChild(span);
    return b;
  }

  _positionBubble(bubble, bbox, img) {
    // getBoundingClientRect gives the true rendered size regardless of
    // CSS transforms, zoom, or wrapper quirks
    const rect = img.getBoundingClientRect();
    const iw = rect.width  || img.offsetWidth  || img.naturalWidth  || 375;
    const ih = rect.height || img.offsetHeight || img.naturalHeight || 500;
    bubble.style.left      = `${(bbox.x / 100) * iw}px`;
    bubble.style.top       = `${(bbox.y / 100) * ih}px`;
    bubble.style.width     = `${(bbox.w / 100) * iw}px`;
    bubble.style.minHeight = `${(bbox.h / 100) * ih}px`;
    bubble.style.maxWidth  = `${iw - (bbox.x / 100) * iw}px`;
  }

  _repositionForWrapper(wrapper) {
    const img   = wrapper.querySelector('img');
    const state = img && this.imageState.get(img);
    if (!state) return;
    requestAnimationFrame(() => {
      // Re-sync wrapper width to image width on resize
      const w = img.offsetWidth || img.naturalWidth;
      if (w > 0) wrapper.style.width = `${w}px`;
      state.bubbles.forEach(bubble => {
        const x = parseFloat(bubble.dataset.bboxX);
        const y = parseFloat(bubble.dataset.bboxY);
        const bw = parseFloat(bubble.dataset.bboxW);
        const h = parseFloat(bubble.dataset.bboxH);
        if (!isNaN(x)) this._positionBubble(bubble, { x, y, w: bw, h }, img);
      });
    });
  }

  _annKey(ann) {
    return `${ann.imageHash}:${ann.bbox.x.toFixed(1)}:${ann.bbox.y.toFixed(1)}`;
  }
}

// ── input-dialog.js ─────────────────────────────────────────────────────────

class InputDialog {
  constructor() {
    this._el      = null;
    this._resolve = null;
    this._style   = { fontSize: 13, bold: false, italic: false, color: '#1a1a2e', bg: '#ffffff', noBg: false, stroke: false, strokeColor: '#ffffff', strokeWidth: 1 };
    this._build();
  }

  show(screenPos, prefill = {}) {
    return new Promise(resolve => {
      this._resolve = resolve;
      this._el.querySelector('.wt-input-original').value   = prefill.originalText   || '';
      this._el.querySelector('.wt-input-translated').value = prefill.translatedText || '';
      if (prefill.style) { Object.assign(this._style, prefill.style); this._syncStyleUI(); }

      const { innerWidth, innerHeight } = window;
      const w = this._el.offsetWidth  || 300;
      const h = this._el.offsetHeight || 280;
      let top  = screenPos.y + 10;
      let left = screenPos.x;
      if (left + w > scrollX + innerWidth  - 20) left = scrollX + innerWidth  - w - 20;
      if (top  + h > scrollY + innerHeight - 20) top  = screenPos.y - h - 20;
      if (left < scrollX + 10) left = scrollX + 10;
      if (top  < scrollY + 10) top  = scrollY + 10;
      this._el.style.top     = `${top}px`;
      this._el.style.left    = `${left}px`;
      this._el.style.display = 'block';

      this._escHandler = (e) => { if (e.key === 'Escape') this._cancel(); };
      document.addEventListener('keydown', this._escHandler);
      setTimeout(() => this._el.querySelector('.wt-input-translated').focus(), 50);
    });
  }

  hide() {
    this._el.style.display = 'none';
    document.removeEventListener('keydown', this._escHandler);
  }

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-input-dialog';
    this._el.innerHTML = `
      <div class="wt-dialog-header">
        <span class="wt-dialog-title">Add translation</span>
        <button class="wt-btn-close" aria-label="Cancel">&#x2715;</button>
      </div>
      <label class="wt-dialog-label">Original text (optional)</label>
      <input class="wt-input-original" type="text" placeholder="Source text..." />
      <label class="wt-dialog-label">Translation</label>
      <textarea class="wt-input-translated" rows="3" placeholder="Enter translation..."></textarea>
      <div class="wt-style-bar">
        <input class="wt-style-fontsize" type="number" min="8" max="48" value="13" title="Font size (px)" />
        <span class="wt-style-px">px</span>
        <button class="wt-style-btn wt-style-bold" title="Bold">B</button>
        <button class="wt-style-btn wt-style-italic" title="Italic">I</button>
        <label class="wt-swatch-wrap" title="Text color">
          <span class="wt-swatch" id="wt-dot-color" style="background:#1a1a2e"></span>
          <input class="wt-style-color" type="color" value="#1a1a2e" />
        </label>
        <label class="wt-swatch-wrap" title="Background color">
          <span class="wt-swatch" id="wt-dot-bg" style="background:#ffffff;border:1px solid #ccc"></span>
          <input class="wt-style-bg" type="color" value="#ffffff" />
        </label>
        <label class="wt-nobg-wrap" title="No background">
          <input class="wt-style-nobg" type="checkbox" />
          <span>No BG</span>
        </label>
        <div class="wt-style-divider"></div>
        <label class="wt-nobg-wrap" title="Text stroke">
          <input class="wt-style-stroke-on" type="checkbox" />
          <span>Stroke</span>
        </label>
        <label class="wt-swatch-wrap" title="Stroke color">
          <span class="wt-swatch" id="wt-dot-stroke" style="background:#ffffff;border:1px solid #ccc"></span>
          <input class="wt-style-stroke-color" type="color" value="#ffffff" />
        </label>
        <input class="wt-style-stroke-width" type="number" min="1" max="6" value="1" title="Stroke width (px)" style="width:36px" />
      </div>
      <div class="wt-dialog-actions">
        <button class="wt-btn-cancel">Cancel</button>
        <button class="wt-btn-save">Save</button>
      </div>`;

    this._makeDraggable(this._el.querySelector('.wt-dialog-header'));

    this._el.querySelector('.wt-btn-close').addEventListener('click',  () => this._cancel());
    this._el.querySelector('.wt-btn-cancel').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-btn-save').addEventListener('click',   () => this._save());
    this._el.querySelector('.wt-input-translated').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._save();
    });

    this._el.querySelector('.wt-style-fontsize').addEventListener('input', (e) => {
      this._style.fontSize = parseInt(e.target.value) || 13;
    });
    this._el.querySelector('.wt-style-bold').addEventListener('click', () => {
      this._style.bold = !this._style.bold;
      this._el.querySelector('.wt-style-bold').classList.toggle('active', this._style.bold);
    });
    this._el.querySelector('.wt-style-italic').addEventListener('click', () => {
      this._style.italic = !this._style.italic;
      this._el.querySelector('.wt-style-italic').classList.toggle('active', this._style.italic);
    });
    this._el.querySelector('.wt-style-color').addEventListener('input', (e) => {
      this._style.color = e.target.value;
      this._el.querySelector('#wt-dot-color').style.background = e.target.value;
    });
    this._el.querySelector('.wt-style-bg').addEventListener('input', (e) => {
      this._style.bg = e.target.value;
      this._el.querySelector('#wt-dot-bg').style.background = e.target.value;
      this._el.querySelector('.wt-style-nobg').checked = false;
      this._style.noBg = false;
    });
    this._el.querySelector('.wt-style-nobg').addEventListener('change', (e) => {
      this._style.noBg = e.target.checked;
    });
    this._el.querySelector('.wt-style-stroke-on').addEventListener('change', (e) => {
      this._style.stroke = e.target.checked;
    });
    this._el.querySelector('.wt-style-stroke-color').addEventListener('input', (e) => {
      this._style.strokeColor = e.target.value;
      this._el.querySelector('#wt-dot-stroke').style.background = e.target.value;
    });
    this._el.querySelector('.wt-style-stroke-width').addEventListener('input', (e) => {
      this._style.strokeWidth = parseInt(e.target.value) || 1;
    });

    document.body.appendChild(this._el);
  }

  _syncStyleUI() {
    this._el.querySelector('.wt-style-fontsize').value = this._style.fontSize;
    this._el.querySelector('.wt-style-bold').classList.toggle('active', this._style.bold);
    this._el.querySelector('.wt-style-italic').classList.toggle('active', this._style.italic);
    this._el.querySelector('.wt-style-color').value = this._style.color;
    this._el.querySelector('#wt-dot-color').style.background = this._style.color;
    this._el.querySelector('.wt-style-nobg').checked = this._style.noBg;
    if (!this._style.noBg) {
      this._el.querySelector('.wt-style-bg').value = this._style.bg;
      this._el.querySelector('#wt-dot-bg').style.background = this._style.bg;
    }
    this._el.querySelector('.wt-style-stroke-on').checked = !!this._style.stroke;
    this._el.querySelector('.wt-style-stroke-color').value = this._style.strokeColor || '#ffffff';
    this._el.querySelector('#wt-dot-stroke').style.background = this._style.strokeColor || '#ffffff';
    this._el.querySelector('.wt-style-stroke-width').value = this._style.strokeWidth || 1;
  }

  _makeDraggable(handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wt-btn-close')) return;
      dragging = true;
      // getBoundingClientRect gives viewport-relative position,
      // consistent with e.clientX/Y — no offsetParent confusion
      const rect = this._el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Convert viewport coords back to page-absolute for position:absolute
      this._el.style.left = `${e.clientX - ox + window.scrollX}px`;
      this._el.style.top  = `${e.clientY - oy + window.scrollY}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  _save() {
    const originalText   = this._el.querySelector('.wt-input-original').value.trim();
    const translatedText = this._el.querySelector('.wt-input-translated').value.trim();
    if (!translatedText) { this._el.querySelector('.wt-input-translated').focus(); return; }
    this.hide();
    this._resolve?.({ originalText, translatedText, style: { ...this._style } });
    this._resolve = null;
  }

  _cancel() {
    this.hide();
    this._resolve?.(null);
    this._resolve = null;
  }
}

// ── adapters ────────────────────────────────────────────────────────────────

class NaverAdapter {
  detect() {
    // Supports both comic.naver.com and m.comic.naver.com
    return location.hostname.endsWith('comic.naver.com') &&
           location.pathname.startsWith('/webtoon/detail');
  }

  getChapterMeta() {
    const p = new URLSearchParams(location.search);
    return {
      site:      SITES.NAVER,
      titleId:   p.get('titleId') || 'unknown',
      chapterId: p.get('no')      || 'unknown',
    };
  }

  getImages() {
    const isPanelImage = (img) => {
      const src = img.src || '';
      if (src.includes('/thumbnail/')) return false;
      if (src.includes('/title/'))     return false;
      if (src.includes('/banner/'))    return false;
      if (src.includes('bg_transparency')) return false;
      const w = img.naturalWidth || img.offsetWidth || img.width;
      return w >= 300;
    };

    const seen = new Set();
    const imgs = [];
    const containerSelectors = [
      '.wt_viewer', '#comic_view_area', '.viewer_lst',
      '.viewer_img', '.toon_img', '.swiper-wrapper',
    ];

    let foundContainer = false;
    for (const sel of containerSelectors) {
      const container = document.querySelector(sel);
      if (!container) continue;
      container.querySelectorAll('img').forEach(img => {
        if (!seen.has(img) && isPanelImage(img)) {
          seen.add(img); imgs.push(img); foundContainer = true;
        }
      });
    }

    if (!foundContainer) {
      document.querySelectorAll('img').forEach(img => {
        if (!seen.has(img) && isPanelImage(img)) { seen.add(img); imgs.push(img); }
      });
    }

    return imgs;
  }

  watchNewImages(callback) {
    const target = document.querySelector('.wt_viewer')       ||
                   document.querySelector('#comic_view_area') ||
                   document.querySelector('.toon_img')        ||
                   document.body;
    const observer = new MutationObserver(() => {
      const imgs = this.getImages();
      if (imgs.length > 0) callback(imgs);
    });
    observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
}

class RidiAdapter {
  detect() {
    return location.hostname === 'www.ridi.com' && location.pathname.startsWith('/viewer/');
  }
  getChapterMeta() {
    const parts = location.pathname.split('/');
    return { site: SITES.RIDI, titleId: parts[2] || 'unknown', chapterId: parts[2] || 'unknown' };
  }
  getImages() { return []; }
  watchNewImages() { return () => {}; }
}

class KakaoAdapter {
  detect() {
    return location.hostname === 'page.kakao.com' && location.pathname.includes('/content/');
  }
  getChapterMeta() {
    const m = location.pathname.match(/\/content\/(\w+)\/viewer\/(\w+)/);
    return { site: SITES.KAKAO, titleId: m?.[1] || 'unknown', chapterId: m?.[2] || 'unknown' };
  }
  getImages() { return []; }
  watchNewImages() { return () => {}; }
}

// ── utility ─────────────────────────────────────────────────────────────────

function sendToBackground(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
}

// ── boot ────────────────────────────────────────────────────────────────────

const ADAPTERS = [new NaverAdapter(), new RidiAdapter(), new KakaoAdapter()];
const adapter  = ADAPTERS.find(a => a.detect());

if (!adapter) {
  console.log('[WebtoonTranslate] No adapter matched:', location.hostname, location.pathname);
} else {
  boot(adapter);
}

async function boot(adapter) {
  const meta = adapter.getChapterMeta();
  console.log('[WebtoonTranslate] Active:', meta);

  const renderer = new OverlayRenderer();
  const selector = new BBoxSelector({ onSelect: handleBBoxSelect });
  const dialog   = new InputDialog();

  let currentMode     = MODES.READ;
  let images          = [];
  let annotationCount = 0;

  async function loadAndRender() {
    const { annotations } = await sendToBackground({
      type: MSG.LOAD_TRANSLATIONS, payload: meta,
    });
    annotationCount = annotations.length;

    const byHash = new Map();
    for (const ann of annotations) {
      if (!byHash.has(ann.imageHash)) byHash.set(ann.imageHash, []);
      byHash.get(ann.imageHash).push(ann);
    }
    for (const img of images) {
      const hash = await hashImage(img);
      const anns = byHash.get(hash) || [];
      if (anns.length > 0) renderer.renderForImage(img, anns);
    }
  }

  // Initial image load — retry a few times for slow pages
  let attempts = 0;
  const tryGetImages = () => {
    images = adapter.getImages();
    if (images.length === 0 && attempts++ < 10) {
      setTimeout(tryGetImages, 500);
    } else {
      loadAndRender();
    }
  };
  tryGetImages();

  adapter.watchNewImages(async (newImages) => {
    const added = newImages.filter(img => !images.includes(img));
    if (!added.length) return;
    images = [...images, ...added];
    if (currentMode === MODES.ANNOTATE) {
      added.forEach(img => selector.attachImage(img, images.indexOf(img)));
    }
    await loadAndRender();
  });

  // ── bbox handler ────────────────────────────────────────────────────────

  async function handleBBoxSelect({ bbox, imageEl, imageIndex }) {
    const rect = imageEl.getBoundingClientRect();
    // rect is viewport-relative; add scroll to get page-absolute coords
    const screenPos = {
      x: rect.left + window.scrollX + (bbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (bbox.y / 100) * rect.height,
    };
    const result = await dialog.show(screenPos);
    if (!result) return;

    const imageHash  = await hashImage(imageEl);
    const annotation = {
      imageHash, imageIndex, bbox,
      originalText:   result.originalText,
      translatedText: result.translatedText,
      style:          result.style,
      language:       'vi',
      createdAt:      new Date().toISOString(),
    };

    await sendToBackground({
      type: MSG.SAVE_TRANSLATIONS,
      payload: { ...meta, annotations: [annotation] },
    });
    annotationCount++;
    renderer.upsertBubble(imageEl, annotation);
  }

  // Click existing bubble to edit — annotate mode only
  document.addEventListener('click', async (e) => {
    if (currentMode !== MODES.ANNOTATE) return;
    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) return;
    e.stopPropagation();

    // Find which image this bubble belongs to
    const wrapper = bubble.closest('.wt-img-wrapper');
    if (!wrapper) return;
    const img = wrapper.querySelector('img');
    if (!img) return;
    const imgIndex = images.indexOf(img);

    const existingBbox = {
      x: parseFloat(bubble.dataset.bboxX),
      y: parseFloat(bubble.dataset.bboxY),
      w: parseFloat(bubble.dataset.bboxW),
      h: parseFloat(bubble.dataset.bboxH),
    };

    // Get stored annotation to prefill dialog
    const { annotations: stored } = await sendToBackground({
      type: MSG.LOAD_TRANSLATIONS, payload: meta,
    });
    const imgHash = await hashImage(img);
    const existing = stored.find(a =>
      a.imageHash === imgHash &&
      Math.abs(a.bbox.x - existingBbox.x) < 2
    );

    const rect = img.getBoundingClientRect();
    const screenPos = {
      x: rect.left + window.scrollX + (existingBbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (existingBbox.y / 100) * rect.height,
    };

    const result = await dialog.show(screenPos, {
      originalText:   existing?.originalText   || '',
      translatedText: existing?.translatedText || bubble.textContent,
      style:          existing?.style          || {},
    });
    if (!result) return;

    const annotation = {
      imageHash: imgHash,
      imageIndex: imgIndex,
      bbox: existingBbox,
      originalText:   result.originalText,
      translatedText: result.translatedText,
      style:          result.style,
      language:       'vi',
      createdAt:      existing?.createdAt || new Date().toISOString(),
    };
    await sendToBackground({
      type: MSG.SAVE_TRANSLATIONS,
      payload: { ...meta, annotations: [annotation] },
    });
    renderer.upsertBubble(img, annotation);
  });

  // ── message listener ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_META') {
      sendResponse({ ...meta, annotationCount, currentMode });
      return true;
    }
    if (message.type === 'SET_MODE') {
      currentMode = message.mode;
      if (currentMode === MODES.ANNOTATE) {
        selector.enable(images);
        document.body.classList.add('wt-annotate-mode');
      } else {
        selector.disable();
        document.body.classList.remove('wt-annotate-mode');
      }
    }
    if (message.type === 'TRIGGER_EXPORT') triggerExport(meta);
    if (message.type === 'TRIGGER_IMPORT') triggerImport();
  });

  // ── export / import ─────────────────────────────────────────────────────

  async function triggerExport({ site, titleId }) {
    const { exportData } = await sendToBackground({
      type: MSG.EXPORT_CHAPTER, payload: { site, titleId },
    });
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `webtoon-translate_${site}_${titleId}_vi.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const { ok, imported, error } = await sendToBackground({
        type: MSG.IMPORT_FILE, payload: { jsonString: text },
      });
      if (ok) {
        // Re-render immediately without page reload
        await loadAndRender();
        const msg = imported === 1
          ? `Imported 1 translation.`
          : `Imported ${imported} translations.`;
        // Brief toast instead of blocking alert
        const toast = document.createElement('div');
        toast.textContent = `✓ ${msg}`;
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;background:#22c55e;color:#fff;padding:10px 18px;border-radius:8px;font-family:system-ui;font-size:14px;font-weight:500;pointer-events:none;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      } else {
        alert(`[WebtoonTranslate] Import failed: ${error}`);
      }
    });
    input.click();
  }
}

})(); // end IIFE
