(function () {
'use strict';

// ── constants ────────────────────────────────────────────────────────────────

const SITES = { NAVER: 'naver', RIDI: 'ridi', KAKAO: 'kakao' };
const MODES  = { READ: 'read', ANNOTATE: 'annotate' };
const MSG    = {
  SAVE_TRANSLATIONS: 'SAVE_TRANSLATIONS',
  LOAD_TRANSLATIONS: 'LOAD_TRANSLATIONS',
  DELETE_ANNOTATION: 'DELETE_ANNOTATION',
  EXPORT_CHAPTER:    'EXPORT_CHAPTER',
  IMPORT_FILE:       'IMPORT_FILE',
  GET_STORAGE_USAGE: 'GET_STORAGE_USAGE',
};

// ── hasher ───────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 64 * 1024;

async function hashImage(img) {
  if (img.__wtHash) return img.__wtHash;

  // Kakao CDN uses signed URLs with short-lived tokens — the `kid` param
  // is stable per image, so extract it as the hash instead of fetching bytes.
  // This avoids CORS errors from page-edge.kakao.com.
  if (img.src.includes('page-edge.kakao.com') || img.src.includes('kakaocdn.net')) {
    // Use `filename` param (stable) or `kid` — both survive URL re-signing
    const u = new URL(img.src);
    const stable = u.searchParams.get('filename') || u.searchParams.get('kid') || img.src.split('/').pop();
    img.__wtHash = `kakao:${stable}`;
    return img.__wtHash;
  }

  try {
    const response  = await fetch(img.src, { credentials: 'include' });
    const buffer    = await response.arrayBuffer();
    const chunk     = buffer.slice(0, CHUNK_SIZE);
    const hashBuf   = await crypto.subtle.digest('SHA-256', chunk);
    const hex       = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    img.__wtHash = `sha256:${hex}`;
  } catch {
    // Fallback: stable portion of URL without CDN tokens
    const urlHash = img.src.split('?')[0].split('/').slice(-2).join('/');
    img.__wtHash  = `url:${urlHash}`;
  }
  return img.__wtHash;
}

// ── FixedOverlayLayer (Kakao) ─────────────────────────────────────────────────
// Kakao uses padding-top aspect-ratio layout — injecting a wrapper breaks their CSS.
// Instead, we use a single position:fixed div over the viewport.
// All drag coords are converted back to % of the target image.

class FixedOverlayLayer {
  constructor({ onSelect }) {
    this._onSelect  = onSelect;
    this._el        = null;
    this._images    = [];
    this._active    = false;
    this._bubbles   = new Map(); // annKey -> {el, img}
    this._drag      = null;
    this._selRect   = null;
    this._build();
  }

  enable(images) {
    this._images = images;
    this._active = true;
    this._el.style.display = 'block';
    this._updateBubbleVisibility();
  }

  disable() {
    this._active = false;
    this._el.style.display = 'none';
  }

  /** Render a translated bubble at the given bbox (% of img) */
  upsertBubble(img, annotation) {
    const key = `${annotation.imageHash}::${annotation.bbox.x.toFixed(1)}::${annotation.bbox.y.toFixed(1)}`;
    this._bubbles.get(key)?.el.remove();
    const bubble = this._createBubble(annotation);
    document.body.appendChild(bubble);
    this._bubbles.set(key, { el: bubble, img, annotation });
    this._positionBubble(bubble, annotation.bbox, img);
    return bubble;
  }

  removeBubble(annKey) {
    this._bubbles.get(annKey)?.el.remove();
    this._bubbles.delete(annKey);
  }

  clearAll() {
    this._bubbles.forEach(({ el }) => el.remove());
    this._bubbles.clear();
  }

  repositionAll() {
    this._bubbles.forEach(({ el, img, annotation }) => {
      this._positionBubble(el, annotation.bbox, img);
    });
  }

  setVisible(visible) {
    this._bubbles.forEach(({ el }) => {
      el.style.visibility = visible ? '' : 'hidden';
    });
  }

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-fixed-overlay';
    this._el.style.display = 'none';
    document.body.appendChild(this._el);

    let startX, startY;

    this._el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.wt-translation-bubble')) return;
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      this._selRect = document.createElement('div');
      this._selRect.className = 'wt-fixed-sel-rect';
      document.body.appendChild(this._selRect);
      this._drag = { startX, startY };
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._drag) return;
      const x = Math.min(this._drag.startX, e.clientX);
      const y = Math.min(this._drag.startY, e.clientY);
      const w = Math.abs(e.clientX - this._drag.startX);
      const h = Math.abs(e.clientY - this._drag.startY);
      this._selRect.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `border:2px solid rgba(99,102,241,0.9);background:rgba(99,102,241,0.12);pointer-events:none;z-index:99999;box-sizing:border-box;`;
    });

    document.addEventListener('mouseup', (e) => {
      if (!this._drag) return;
      const { startX, startY } = this._drag;
      this._drag = null;
      this._selRect?.remove(); this._selRect = null;

      const endX = e.clientX, endY = e.clientY;
      const pw = Math.abs(endX - startX), ph = Math.abs(endY - startY);
      if (pw < 10 || ph < 10) return;

      // Find which image this drag is over (center of selection)
      const cx = (Math.min(startX, endX) + pw / 2);
      const cy = (Math.min(startY, endY) + ph / 2);
      const img = this._imageAtViewportPoint(cx, cy);
      if (!img) return;

      const rect = img.getBoundingClientRect();
      const bbox = {
        x: ((Math.min(startX, endX) - rect.left) / rect.width)  * 100,
        y: ((Math.min(startY, endY) - rect.top)  / rect.height) * 100,
        w: (pw / rect.width)  * 100,
        h: (ph / rect.height) * 100,
      };
      // Clamp
      bbox.x = Math.max(0, bbox.x); bbox.y = Math.max(0, bbox.y);
      bbox.w = Math.min(100 - bbox.x, bbox.w);
      bbox.h = Math.min(100 - bbox.y, bbox.h);

      const imageIndex = this._images.indexOf(img);
      this._onSelect({ bbox, imageEl: img, imageIndex });
    });
  }

  _imageAtViewportPoint(vx, vy) {
    for (const img of this._images) {
      const r = img.getBoundingClientRect();
      if (vx >= r.left && vx <= r.right && vy >= r.top && vy <= r.bottom) return img;
    }
    return null;
  }

  _positionBubble(bubble, bbox, img) {
    const r = img.getBoundingClientRect();
    const iw = r.width  || img.naturalWidth;
    const ih = r.height || img.naturalHeight;
    const left = r.left + window.scrollX + (bbox.x / 100) * iw;
    const top  = r.top  + window.scrollY + (bbox.y / 100) * ih;
    bubble.style.left      = `${left}px`;
    bubble.style.top       = `${top}px`;
    bubble.style.width     = `${(bbox.w / 100) * iw}px`;
    bubble.style.minHeight = `${(bbox.h / 100) * ih}px`;
  }

  _createBubble(ann) {
    const b = document.createElement('div');
    b.className      = 'wt-translation-bubble wt-fixed-bubble';
    b.dataset.annKey = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
    b.dataset.bboxX  = ann.bbox.x; b.dataset.bboxY = ann.bbox.y;
    b.dataset.bboxW  = ann.bbox.w; b.dataset.bboxH = ann.bbox.h;
    b.style.position  = 'absolute';
    b.style.boxShadow = 'none';
    if (ann.style) {
      const s = ann.style;
      b.style.fontSize   = `${s.fontSize || 13}px`;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
      b.style.background = s.noBg   ? 'transparent' : (s.bg || 'rgba(255,255,255,0.95)');
      if (s.stroke && s.strokeColor) {
        const sc = s.strokeColor, sw = s.strokeWidth || 1;
        b.style.textShadow = `${sw}px 0 ${sc},-${sw}px 0 ${sc},0 ${sw}px ${sc},0 -${sw}px ${sc}`;
      }
      if (s.fontFamily) b.style.fontFamily = `'${s.fontFamily}', system-ui, sans-serif`;
    }
    const span = document.createElement('span');
    span.textContent = ann.translatedText;
    b.appendChild(span);
    return b;
  }

  _updateBubbleVisibility() {
    this._bubbles.forEach(({ el }) => {
      el.style.visibility = this._active ? '' : '';
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Kakao (and some other sites) set pointer-events:none on img + parent containers.
 * Walk up the DOM from the img and force pointer-events:auto on any blocked ancestors
 * so our overlay receives mouse events.
 */
function fixPointerEvents(img) {
  img.style.pointerEvents = 'none'; // img itself stays none — overlay handles events
  let el = img.parentElement;
  for (let i = 0; i < 5 && el && el !== document.body; i++) {
    if (getComputedStyle(el).pointerEvents === 'none') {
      el.style.pointerEvents = 'auto';
    }
    el = el.parentElement;
  }
}

// ── BBoxSelector ─────────────────────────────────────────────────────────────

class BBoxSelector {
  constructor({ onSelect }) {
    this.onSelect     = onSelect;
    this.overlays     = new Map();
    this.active       = false;
    this._currentDrag = null;
  }

  enable(images) {
    this.active = true;
    images.forEach((img, i) => this._attachOverlay(img, i));
  }

  disable() {
    this.active = false;
    for (const [, overlay] of this.overlays) {
      overlay._cleanup?.();
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
      if (e.target.closest('.wt-translation-bubble')) return; // let bubble clicks through
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
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      selectionEl.style.left   = `${Math.min(startX, cx)}px`;
      selectionEl.style.top    = `${Math.min(startY, cy)}px`;
      selectionEl.style.width  = `${Math.abs(cx - startX)}px`;
      selectionEl.style.height = `${Math.abs(cy - startY)}px`;
    };

    const onMouseUp = (e) => {
      if (!this._currentDrag || this._currentDrag.overlay !== overlay) return;
      const rect = overlay.getBoundingClientRect();
      const ex = e.clientX - rect.left, ey = e.clientY - rect.top;
      const px = Math.min(startX, ex), py = Math.min(startY, ey);
      const pw = Math.abs(ex - startX), ph = Math.abs(ey - startY);
      selectionEl.remove();
      this._currentDrag = null;
      if (pw < 10 || ph < 10) return;
      this.onSelect({
        bbox: { x: (px/rect.width)*100, y: (py/rect.height)*100,
                w: (pw/rect.width)*100, h: (ph/rect.height)*100 },
        imageEl: img, imageIndex,
      });
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
    if (parent?.classList.contains('wt-img-wrapper')) return parent;
    // Kakao: padding-top aspect-ratio layout breaks if we inject a wrapper.
    // Mark with a class but don't reparent — overlay will use position:fixed instead.
    if (img.src?.includes('page-edge.kakao.com') || img.src?.includes('kakaocdn.net')) {
      img.dataset.wtKakao = '1';
      return parent; // return parent as-is, don't wrap
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'wt-img-wrapper';
    img.parentElement.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    img.style.display = 'block';
    const setW = () => {
      const w = img.naturalWidth || img.offsetWidth;
      const h = img.naturalHeight || img.offsetHeight;
      if (w > 0) {
        wrapper.style.cssText = `position:relative;display:block;width:${w}px;${
          h > 0 ? `height:${h}px;` : ''
        }line-height:0;margin:0 auto;padding:0;`;
      }
    };
    if (img.complete && img.naturalWidth > 0) setW();
    else img.addEventListener('load', setW, { once: true });
    return wrapper;
  }
}

// ── OverlayRenderer ───────────────────────────────────────────────────────────

class OverlayRenderer {
  constructor() {
    this.imageState      = new Map();
    this._resizeObserver = new ResizeObserver(entries => {
      for (const e of entries) this._repositionForWrapper(e.target);
    });
  }

  renderForImage(img, annotations) {
    const wrapper = this._ensureWrapper(img);
    const state   = this.imageState.get(img);
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();
    for (const ann of annotations) {
      const bubble = this._createBubble(ann);
      wrapper.appendChild(bubble);
      state.bubbles.set(this._annKey(ann), bubble);
      this._positionBubble(bubble, ann.bbox, img);
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
    this._positionBubble(bubble, annotation.bbox, img);
    if (!img.complete || img.naturalWidth === 0) {
      img.addEventListener('load', () => {
        requestAnimationFrame(() => this._positionBubble(bubble, annotation.bbox, img));
      }, { once: true });
    }
  }

  removeBubble(img, annKey) {
    const state = this.imageState.get(img);
    if (!state) return;
    state.bubbles.get(annKey)?.remove();
    state.bubbles.delete(annKey);
  }

  clearImage(img) {
    const state = this.imageState.get(img);
    if (!state) return;
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();
  }

  clearAll() {
    for (const [img] of this.imageState) this.clearImage(img);
  }

  _ensureWrapper(img) {
    if (this.imageState.has(img)) return this.imageState.get(img).wrapper;
    let wrapper = img.parentElement;
    if (!wrapper?.classList.contains('wt-img-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'wt-img-wrapper';
      img.parentElement.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      img.style.display = 'block';
      const setW = () => {
        const w = img.naturalWidth || img.offsetWidth;
        const h = img.naturalHeight || img.offsetHeight;
        if (w > 0) {
          wrapper.style.cssText = `position:relative;display:block;width:${w}px;${
            h > 0 ? `height:${h}px;` : ''
          }line-height:0;margin:0 auto;padding:0;`;
        }
      };
      if (img.complete && img.naturalWidth > 0) setW();
      else img.addEventListener('load', setW, { once: true });
    }
    this.imageState.set(img, { wrapper, bubbles: new Map() });
    this._resizeObserver.observe(wrapper);
    return wrapper;
  }

  _createBubble(ann) {
    const b = document.createElement('div');
    b.className       = 'wt-translation-bubble';
    b.dataset.annKey  = this._annKey(ann);
    b.dataset.bboxX   = ann.bbox.x;
    b.dataset.bboxY   = ann.bbox.y;
    b.dataset.bboxW   = ann.bbox.w;
    b.dataset.bboxH   = ann.bbox.h;
    b.style.boxShadow = 'none';
    if (ann.style) {
      const s = ann.style;
      b.style.fontSize   = `${s.fontSize || 13}px`;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
      b.style.background = s.noBg   ? 'transparent' : (s.bg || 'rgba(255,255,255,0.95)');
      if (s.stroke && s.strokeColor) {
        const sc = s.strokeColor, sw = s.strokeWidth || 1;
        b.style.textShadow = `${sw}px 0 ${sc},-${sw}px 0 ${sc},0 ${sw}px ${sc},0 -${sw}px ${sc}`;
      } else {
        b.style.textShadow = 'none';
      }
      if (s.fontFamily) {
        b.style.fontFamily = `'${s.fontFamily}', system-ui, sans-serif`;
        loadGoogleFont(s.fontFamily);
      }
    }
    const span = document.createElement('span');
    span.textContent = ann.translatedText;
    b.appendChild(span);
    return b;
  }

  _positionBubble(bubble, bbox, img) {
    const rect = img.getBoundingClientRect();
    // Kakao uses padding-top ratio so rect.height may be 0 — fallback to naturalHeight
    const iw = img.naturalWidth  || rect.width  || img.offsetWidth  || 375;
    const ih = img.naturalHeight || rect.height || img.offsetHeight || 500;
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
      const w = img.offsetWidth || img.naturalWidth;
      if (w > 0) wrapper.style.width = `${w}px`;
      state.bubbles.forEach(bubble => {
        const x = parseFloat(bubble.dataset.bboxX), y = parseFloat(bubble.dataset.bboxY);
        const bw = parseFloat(bubble.dataset.bboxW), h = parseFloat(bubble.dataset.bboxH);
        if (!isNaN(x)) this._positionBubble(bubble, { x, y, w: bw, h }, img);
      });
    });
  }

  _annKey(ann) {
    // Use :: separator so sha256: prefix in imageHash doesn't cause split confusion
    return `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
  }
}

// ── InputDialog ───────────────────────────────────────────────────────────────

class InputDialog {
  constructor({ onDelete } = {}) {
    this._el       = null;
    this._resolve  = null;
    this._onDelete = onDelete;
    this._isEdit   = false;
    this._style    = {
      fontSize: 13, bold: false, italic: false,
      color: '#1a1a2e', bg: '#ffffff', noBg: false,
      stroke: false, strokeColor: '#ffffff', strokeWidth: 1,
      fontFamily: '',
    };
    this._build();
  }

  show(screenPos, prefill = {}) {
    this._isEdit = !!prefill.translatedText;
    // Update title and show/hide delete button
    this._el.querySelector('.wt-dialog-title').textContent =
      this._isEdit ? 'Edit translation' : 'Add translation';
    this._el.querySelector('.wt-btn-delete').style.display =
      this._isEdit ? 'block' : 'none';

    return new Promise(resolve => {
      this._resolve = resolve;
      this._el.querySelector('.wt-input-original').value   = prefill.originalText   || '';
      this._el.querySelector('.wt-input-translated').value = prefill.translatedText || '';
      if (prefill.style) {
        // Reset to defaults first so stale values from previous edit don't bleed through
        this._style = {
          fontSize: 13, bold: false, italic: false,
          color: '#1a1a2e', bg: '#ffffff', noBg: false,
          stroke: false, strokeColor: '#ffffff', strokeWidth: 1, fontFamily: '',
          ...prefill.style
        };
        this._syncStyleUI();
      }

      // Store bbox for resize
      this._currentBbox = prefill.bbox || null;
      this._currentImg  = prefill.img  || null;
      if (this._isEdit && prefill.bbox && prefill.img) {
        this._el.querySelector('.wt-resize-row').style.display = 'flex';
        this._el.querySelector('.wt-resize-x').value  = prefill.bbox.x.toFixed(1);
        this._el.querySelector('.wt-resize-y').value  = prefill.bbox.y.toFixed(1);
        this._el.querySelector('.wt-resize-w').value  = prefill.bbox.w.toFixed(1);
        this._el.querySelector('.wt-resize-h').value  = prefill.bbox.h.toFixed(1);
      } else {
        this._el.querySelector('.wt-resize-row').style.display = 'none';
      }

      const { innerWidth, innerHeight } = window;
      const w = this._el.offsetWidth || 300, h = this._el.offsetHeight || 320;
      let top  = screenPos.y + 10, left = screenPos.x;
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
        <button class="wt-style-btn wt-style-bold"   title="Bold">B</button>
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
          <input class="wt-style-nobg" type="checkbox" /><span>No BG</span>
        </label>
        <div class="wt-style-divider"></div>
        <label class="wt-nobg-wrap" title="Stroke">
          <input class="wt-style-stroke-on" type="checkbox" /><span>Stroke</span>
        </label>
        <label class="wt-swatch-wrap" title="Stroke color">
          <span class="wt-swatch" id="wt-dot-stroke" style="background:#ffffff;border:1px solid #ccc"></span>
          <input class="wt-style-stroke-color" type="color" value="#ffffff" />
        </label>
        <input class="wt-style-stroke-width" type="number" min="1" max="6" value="1" title="Stroke px" style="width:36px" />
      </div>
      <div class="wt-font-row">
        <label class="wt-dialog-label" style="margin:0;flex-shrink:0">Font</label>
        <select class="wt-style-font">
          <option value="">System default</option>
          <optgroup label="Vietnamese-friendly">
            <option value="Fuzzy Bubbles">Fuzzy Bubbles</option>
            <option value="Pangolin">Pangolin</option>
            <option value="Mansalva">Mansalva</option>
            <option value="Patrick Hand SC">Patrick Hand SC</option>
            <option value="Baloo 2">Baloo 2</option>
            <option value="Be Vietnam Pro">Be Vietnam Pro</option>
            <option value="Nunito">Nunito</option>
            <option value="Quicksand">Quicksand</option>
            <option value="Signika">Signika</option>
            <option value="Kanit">Kanit</option>
          </optgroup>
          <optgroup label="Comic / Display">
            <option value="Bangers">Bangers</option>
            <option value="Comic Neue">Comic Neue</option>
            <option value="Permanent Marker">Permanent Marker</option>
            <option value="Anton">Anton</option>
            <option value="Lilita One">Lilita One</option>
            <option value="Boogaloo">Boogaloo</option>
          </optgroup>
          <optgroup label="Clean / Readable">
            <option value="Noto Sans">Noto Sans</option>
            <option value="Roboto">Roboto</option>
            <option value="Montserrat">Montserrat</option>
            <option value="Oswald">Oswald</option>
            <option value="Noto Serif">Noto Serif</option>
          </optgroup>
        </select>
      </div>
      <div class="wt-resize-row" style="display:none">
        <span class="wt-dialog-label" style="margin:0;flex-shrink:0">Resize</span>
        <label class="wt-resize-label">X<input class="wt-resize-x wt-resize-input" type="number" step="0.1"/></label>
        <label class="wt-resize-label">Y<input class="wt-resize-y wt-resize-input" type="number" step="0.1"/></label>
        <label class="wt-resize-label">W<input class="wt-resize-w wt-resize-input" type="number" step="0.1"/></label>
        <label class="wt-resize-label">H<input class="wt-resize-h wt-resize-input" type="number" step="0.1"/></label>
      </div>
      <div class="wt-dialog-actions">
        <button class="wt-btn-delete" style="display:none">Delete</button>
        <button class="wt-btn-cancel">Cancel</button>
        <button class="wt-btn-save">Save</button>
      </div>`;

    this._makeDraggable(this._el.querySelector('.wt-dialog-header'));

    this._el.querySelector('.wt-btn-close').addEventListener('click',  () => this._cancel());
    this._el.querySelector('.wt-btn-cancel').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-btn-save').addEventListener('click',   () => this._save());
    this._el.querySelector('.wt-btn-delete').addEventListener('click', () => this._delete());
    this._el.querySelector('.wt-input-translated').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._save();
    });

    // Style bar
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
    this._el.querySelector('.wt-style-font').addEventListener('change', (e) => {
      this._style.fontFamily = e.target.value;
      if (e.target.value) loadGoogleFont(e.target.value);
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
    this._el.querySelector('.wt-style-bg').value = this._style.bg;
    this._el.querySelector('#wt-dot-bg').style.background = this._style.noBg ? '#ffffff' : this._style.bg;
    this._el.querySelector('.wt-style-stroke-on').checked = !!this._style.stroke;
    this._el.querySelector('.wt-style-stroke-color').value = this._style.strokeColor || '#ffffff';
    this._el.querySelector('#wt-dot-stroke').style.background = this._style.strokeColor || '#ffffff';
    this._el.querySelector('.wt-style-stroke-width').value = this._style.strokeWidth || 1;
    this._el.querySelector('.wt-style-font').value = this._style.fontFamily || '';
  }

  _makeDraggable(handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wt-btn-close')) return;
      dragging = true;
      const rect = this._el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this._el.style.left = `${e.clientX - ox + window.scrollX}px`;
      this._el.style.top  = `${e.clientY - oy + window.scrollY}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  _getBboxFromResize() {
    const x = parseFloat(this._el.querySelector('.wt-resize-x').value);
    const y = parseFloat(this._el.querySelector('.wt-resize-y').value);
    const w = parseFloat(this._el.querySelector('.wt-resize-w').value);
    const h = parseFloat(this._el.querySelector('.wt-resize-h').value);
    if ([x,y,w,h].some(isNaN)) return null;
    // Clamp to [0,100]
    return {
      x: Math.max(0, Math.min(99, x)),
      y: Math.max(0, Math.min(99, y)),
      w: Math.max(1, Math.min(100 - x, w)),
      h: Math.max(1, Math.min(100 - y, h)),
    };
  }

  _save() {
    const originalText   = this._el.querySelector('.wt-input-original').value.trim();
    const translatedText = this._el.querySelector('.wt-input-translated').value.trim();
    if (!translatedText) { this._el.querySelector('.wt-input-translated').focus(); return; }
    const resizedBbox = this._isEdit ? this._getBboxFromResize() : null;
    this.hide();
    this._resolve?.({ originalText, translatedText, style: { ...this._style }, resizedBbox });
    this._resolve = null;
  }

  _delete() {
    this.hide();
    this._onDelete?.();
    this._resolve?.(null);
    this._resolve = null;
  }

  _cancel() {
    this.hide();
    this._resolve?.(null);
    this._resolve = null;
  }
}

// ── BubbleEditor ─────────────────────────────────────────────────────────────
// Attaches drag-to-move and 8-handle resize to a bubble in annotate mode.
// Calls onBboxChange(newBbox) in real-time so the annotation can be saved on mouseup.

class BubbleEditor {
  constructor({ onBboxChange }) {
    this._onBboxChange = onBboxChange;
    this._active = null; // { bubble, img, handles }
  }

  attach(bubble, img) {
    if (this._active?.bubble === bubble) return;
    this.detach();

    const handles = [];
    // 8 resize handles: corners + mid-edges
    const positions = ['nw','n','ne','e','se','s','sw','w'];
    for (const pos of positions) {
      const h = document.createElement('div');
      h.className = `wt-resize-handle wt-rh-${pos}`;
      h.dataset.pos = pos;
      bubble.appendChild(h);
      handles.push(h);
      this._makeResizeHandle(h, bubble, img);
    }

    // Move cursor on bubble body (not on handles)
    bubble.style.cursor = 'move';
    this._makeMoveHandle(bubble, img, handles);

    this._active = { bubble, img, handles };
    bubble.classList.add('wt-bubble-editing');
  }

  detach() {
    if (!this._active) return;
    const { bubble, handles } = this._active;
    handles.forEach(h => h.remove());
    bubble.style.cursor = '';
    bubble.classList.remove('wt-bubble-editing');
    this._active = null;
  }

  _getBboxPct(bubble, img) {
    const iw = img.offsetWidth || img.naturalWidth || 375;
    const ih = img.offsetHeight || img.naturalHeight || 500;
    return {
      x: (parseFloat(bubble.style.left)      / iw) * 100,
      y: (parseFloat(bubble.style.top)       / ih) * 100,
      w: (parseFloat(bubble.style.width)     / iw) * 100,
      h: (parseFloat(bubble.style.minHeight) / ih) * 100,
    };
  }

  _applyBboxPx(bubble, img, bbox) {
    const iw = img.offsetWidth || img.naturalWidth || 375;
    const ih = img.offsetHeight || img.naturalHeight || 500;
    const x = (bbox.x / 100) * iw, y = (bbox.y / 100) * ih;
    const w = (bbox.w / 100) * iw, h = (bbox.h / 100) * ih;
    bubble.style.left      = `${x}px`;
    bubble.style.top       = `${y}px`;
    bubble.style.width     = `${w}px`;
    bubble.style.minHeight = `${h}px`;
    // Update dataset
    bubble.dataset.bboxX = bbox.x;
    bubble.dataset.bboxY = bbox.y;
    bubble.dataset.bboxW = bbox.w;
    bubble.dataset.bboxH = bbox.h;
  }

  _makeMoveHandle(bubble, img, handles) {
    let dragging = false, startX, startY, origLeft, origTop;

    const onDown = (e) => {
      if (e.target.classList.contains('wt-resize-handle')) return;
      if (e.button !== 0) return;
      dragging = true;
      startX   = e.clientX;
      startY   = e.clientY;
      origLeft = parseFloat(bubble.style.left)  || 0;
      origTop  = parseFloat(bubble.style.top)   || 0;
      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const iw = img.offsetWidth || img.naturalWidth || 375;
      const ih = img.offsetHeight || img.naturalHeight || 500;
      const newLeft = Math.max(0, Math.min(iw - parseFloat(bubble.style.width), origLeft + (e.clientX - startX)));
      const newTop  = Math.max(0, Math.min(ih - parseFloat(bubble.style.minHeight), origTop  + (e.clientY - startY)));
      bubble.style.left = `${newLeft}px`;
      bubble.style.top  = `${newTop}px`;
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this._onBboxChange?.(bubble, img, this._getBboxPct(bubble, img));
    };

    bubble.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Store cleanup
    bubble._moveCleanup = () => {
      bubble.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }

  _makeResizeHandle(handle, bubble, img) {
    const pos = handle.dataset.pos;
    let dragging = false;
    let startX, startY, origLeft, origTop, origW, origH;

    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX   = e.clientX; startY = e.clientY;
      origLeft = parseFloat(bubble.style.left)      || 0;
      origTop  = parseFloat(bubble.style.top)       || 0;
      origW    = parseFloat(bubble.style.width)     || 50;
      origH    = parseFloat(bubble.style.minHeight) || 20;
      e.preventDefault(); e.stopPropagation();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const iw = img.offsetWidth || img.naturalWidth || 375;
      const ih = img.offsetHeight || img.naturalHeight || 500;
      let l = origLeft, t = origTop, w = origW, h = origH;

      if (pos.includes('e')) w = Math.max(20, origW + dx);
      if (pos.includes('s')) h = Math.max(12, origH + dy);
      if (pos.includes('w')) { w = Math.max(20, origW - dx); l = Math.min(origLeft + origW - 20, origLeft + dx); }
      if (pos.includes('n')) { h = Math.max(12, origH - dy); t = Math.min(origTop  + origH - 12, origTop  + dy); }

      l = Math.max(0, Math.min(iw - w, l));
      t = Math.max(0, Math.min(ih - h, t));

      bubble.style.left      = `${l}px`;
      bubble.style.top       = `${t}px`;
      bubble.style.width     = `${w}px`;
      bubble.style.minHeight = `${h}px`;
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this._onBboxChange?.(bubble, img, this._getBboxPct(bubble, img));
    };

    handle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
}

// ── SidePanel ────────────────────────────────────────────────────────────────
// Persistent side panel (like Claude's extension), shown/hidden via toggle.
// Contains: annotation list, import/export, live updates on add/delete.

class SidePanel {
  constructor({ onJump, onImport, onExport }) {
    this._onJump   = onJump;
    this._onImport = onImport;
    this._onExport = onExport;
    this._visible  = false;
    this._images   = [];
    this._el       = null;
    this._build();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  show() {
    this._el.style.transform = 'translateX(0)';
    this._el.style.opacity   = '1';
    this._visible = true;
    document.body.style.marginRight = `${PANEL_W}px`;
    document.body.classList.add('wt-panel-open');
  }

  hide() {
    this._el.style.transform = `translateX(${PANEL_W}px)`;
    this._el.style.opacity   = '0';
    this._visible = false;
    document.body.style.marginRight = '';
    document.body.classList.remove('wt-panel-open');
  }

  toggle() {
    this._visible ? this.hide() : this.show();
  }

  isVisible() { return this._visible; }

  setImages(images) { this._images = images; }

  /** Full re-render of annotation list */
  update(annotations) {
    this._renderList(annotations);
    this._el.querySelector('.wt-sp-count').textContent =
      annotations.length === 1 ? '1 translation' : `${annotations.length} translations`;
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-side-panel';
    this._el.innerHTML = `
      <div class="wt-sp-header">
        <div class="wt-sp-title">
          <span class="wt-sp-logo">📖</span>
          <span>Webtoon Translate</span>
        </div>
        <button class="wt-sp-close" title="Close panel">&#x2715;</button>
      </div>
      <div class="wt-sp-meta">
        <span class="wt-sp-count">0 translations</span>
      </div>
      <div class="wt-sp-actions">
        <button class="wt-sp-btn wt-sp-import">⬆ Import JSON</button>
        <button class="wt-sp-btn wt-sp-export">⬇ Export JSON</button>
      </div>
      <div class="wt-sp-list"></div>`;

    this._el.querySelector('.wt-sp-close').addEventListener('click', () => this.hide());
    this._el.querySelector('.wt-sp-import').addEventListener('click', () => this._onImport?.());
    this._el.querySelector('.wt-sp-export').addEventListener('click', () => this._onExport?.());

    // Start hidden (off-screen right)
    this._el.style.transform = `translateX(${PANEL_W}px)`;
    this._el.style.opacity   = '0';

    document.body.appendChild(this._el);
  }

  _renderList(annotations) {
    const list = this._el.querySelector('.wt-sp-list');
    list.innerHTML = '';

    if (!annotations.length) {
      list.innerHTML = '<div class="wt-sp-empty">No translations yet.<br>Switch to Translate mode and drag on any panel to add one.</div>';
      return;
    }

    // Group by imageIndex, sorted
    const grouped = new Map();
    for (const ann of annotations) {
      const k = ann.imageIndex ?? 0;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(ann);
    }

    for (const [imgIdx, anns] of [...grouped.entries()].sort((a,b) => a[0]-b[0])) {
      const section = document.createElement('div');
      section.className = 'wt-sp-section';
      section.innerHTML = `<div class="wt-sp-section-label">Panel ${imgIdx + 1}</div>`;

      for (const ann of anns) {
        const row = document.createElement('div');
        row.className = 'wt-sp-row';
        row.dataset.annKey = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
        row.innerHTML = `
          <div class="wt-sp-row-text">${ann.translatedText}</div>
          ${ann.originalText ? `<div class="wt-sp-row-orig">${ann.originalText}</div>` : ''}`;
        row.addEventListener('click', () => {
          const img = this._images[imgIdx];
          if (!img) return;
          // Scroll to the bubble itself if it exists, else scroll to img
          const annKey = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
          const bubble = document.querySelector(`[data-ann-key="${annKey}"]`);
          const target = bubble || img;
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          this._onJump?.(ann, img);
        });
        section.appendChild(row);
      }
      list.appendChild(section);
    }
  }
}

const PANEL_W = 280;

// ── StorageBar ────────────────────────────────────────────────────────────────

function showStorageWarning(usedBytes, quotaBytes) {
  const pct = Math.round((usedBytes / quotaBytes) * 100);
  if (pct < 70) return;
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#f59e0b;color:#1a1a2e;padding:10px 18px;border-radius:8px;font-family:system-ui;font-size:13px;font-weight:500;pointer-events:none;max-width:340px;text-align:center;';
  toast.textContent = `⚠️ Storage ${pct}% full (${(usedBytes/1024/1024).toFixed(1)}MB / ${(quotaBytes/1024/1024).toFixed(0)}MB). Consider exporting old chapters.`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// ── Adapters ──────────────────────────────────────────────────────────────────

class NaverAdapter {
  detect() {
    return location.hostname.endsWith('comic.naver.com') &&
           location.pathname.startsWith('/webtoon/detail');
  }
  getChapterMeta() {
    // Naver doesn't have og:url — parse from location.search directly
    // Both comic.naver.com and m.comic.naver.com use ?titleId=X&no=Y
    const p = new URLSearchParams(location.search);
    const titleId   = p.get('titleId') || 'unknown';
    const chapterId = p.get('no')      || 'unknown';
    return { site: SITES.NAVER, titleId, chapterId };
  }
  getImages() {
    const isPanelImage = (img) => {
      const src = img.src || '';
      if (src.includes('/thumbnail/') || src.includes('/title/') ||
          src.includes('/banner/')    || src.includes('bg_transparency')) return false;
      return (img.naturalWidth || img.offsetWidth || img.width) >= 300;
    };
    const seen = new Set(), imgs = [];
    for (const sel of ['.wt_viewer','#comic_view_area','.viewer_lst','.viewer_img','.toon_img','.swiper-wrapper']) {
      const c = document.querySelector(sel);
      if (!c) continue;
      c.querySelectorAll('img').forEach(img => {
        if (!seen.has(img) && isPanelImage(img)) { seen.add(img); imgs.push(img); }
      });
    }
    if (!imgs.length) {
      document.querySelectorAll('img').forEach(img => {
        if (!seen.has(img) && isPanelImage(img)) { seen.add(img); imgs.push(img); }
      });
    }
    return imgs;
  }
  watchNewImages(callback) {
    const target = document.querySelector('.wt_viewer') || document.querySelector('#comic_view_area') ||
                   document.querySelector('.toon_img')  || document.body;
    const obs = new MutationObserver(() => { const i = this.getImages(); if (i.length) callback(i); });
    obs.observe(target, { childList: true, subtree: true });
    return () => obs.disconnect();
  }
}

class RidiAdapter {
  detect() { return location.hostname === 'www.ridi.com' && location.pathname.startsWith('/viewer/'); }
  getChapterMeta() { const p = location.pathname.split('/'); return { site: SITES.RIDI, titleId: p[2]||'unknown', chapterId: p[2]||'unknown' }; }
  getImages() { return []; }
  watchNewImages() { return () => {}; }
}

class KakaoAdapter {
  get usesFixedOverlay() { return true; }

  detect() {
    return location.hostname === 'page.kakao.com' && location.pathname.includes('/content/');
  }

  getChapterMeta() {
    // 1. Most reliable: og:url meta tag always has the canonical URL
    //    e.g. https://page.kakao.com/content/69229506/viewer/69312723
    const ogUrl = document.querySelector('meta[property="og:url"]')?.content || location.href;
    const m = ogUrl.match(/\/content\/(\d+)\/viewer\/(\d+)/);
    if (m) return { site: SITES.KAKAO, titleId: m[1], chapterId: m[2] };

    // 2. Fallback: parse from window.location directly
    const m2 = location.pathname.match(/\/content\/(\d+)\/viewer\/(\d+)/);
    if (m2) return { site: SITES.KAKAO, titleId: m2[1], chapterId: m2[2] };

    return { site: SITES.KAKAO, titleId: 'unknown', chapterId: 'unknown' };
  }

  getImages() {
    const seen = new Set(), imgs = [];

    const isPanelImage = (img) => {
      const src = img.src || '';
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
      if (!src.includes('page-edge.kakao.com') && !src.includes('kakaocdn.net')) return false;
      if (src.includes('thumbnail') || src.includes('cover') || src.includes('profile')) return false;
      // Kakao uses padding-top aspect ratio — offsetHeight may be 0.
      // Use naturalWidth as the reliable size check.
      return img.naturalWidth >= 200;
    };

    document.querySelectorAll('.image-container img').forEach(img => {
      if (!seen.has(img) && isPanelImage(img)) { seen.add(img); imgs.push(img); }
    });

    if (imgs.length === 0) {
      document.querySelectorAll('img').forEach(img => {
        if (!seen.has(img) && isPanelImage(img)) { seen.add(img); imgs.push(img); }
      });
    }

    imgs.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return imgs;
  }

  watchNewImages(callback) {
    const obs = new MutationObserver(() => {
      const imgs = this.getImages();
      if (imgs.length > 0) callback(imgs);
    });
    // Watch both body and #__next for Next.js hydration
    const target = document.getElementById('__next') || document.body;
    obs.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src'] });
    return () => obs.disconnect();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

// Loaded font cache to avoid duplicate injections
const _loadedFonts = new Set();
function loadGoogleFont(family) {
  if (!family || _loadedFonts.has(family)) return;
  _loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  // subset=vietnamese ensures diacritics (ắ, ề, ộ...) load correctly
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&subset=vietnamese&display=swap`;
  document.head.appendChild(link);
}

function sendToBackground(message, retries = 3) {
  return new Promise((resolve, reject) => {
    // Extension context may be invalidated if extension was reloaded
    // while the content script was running. Fail gracefully.
    if (!chrome.runtime?.id) {
      reject(new Error('Extension context invalidated — reload the page.'));
      return;
    }
    const attempt = (remaining) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('context invalidated')) {
              reject(new Error('Extension reloaded — please reload this tab.'));
              return;
            }
            if (remaining > 0) {
              setTimeout(() => attempt(remaining - 1), 200);
            } else {
              reject(new Error(msg));
            }
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    };
    attempt(retries);
  });
}

// ── Translation visibility toggle ────────────────────────────────────────────
let _translationsVisible = true;

const EYE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function buildToggleButton() {
  const btn = document.createElement('button');
  btn.id = 'wt-toggle-btn';
  btn.title = 'Hide translations (T)';
  btn.setAttribute('aria-label', 'Toggle translations');
  btn.innerHTML = EYE_ICON;
  btn.addEventListener('click', () => toggleTranslations());
  document.body.appendChild(btn);
  return btn;
}

function toggleTranslations(force) {
  _translationsVisible = force !== undefined ? force : !_translationsVisible;
  const bubbles = document.querySelectorAll('.wt-translation-bubble');
  bubbles.forEach(b => { b.style.visibility = _translationsVisible ? '' : 'hidden'; });
  // fixedLayer bubbles are also .wt-translation-bubble so covered above
  const btn = document.getElementById('wt-toggle-btn');
  if (btn) {
    btn.innerHTML = _translationsVisible ? EYE_ICON : EYE_OFF_ICON;
    btn.title = _translationsVisible ? 'Hide translations (T)' : 'Show translations (T)';
    btn.classList.toggle('wt-toggle-off', !_translationsVisible);
  }
}

function showToast(text, color = '#22c55e') {
  const t = document.createElement('div');
  t.textContent = text;
  t.style.cssText = `position:fixed;bottom:84px;right:24px;z-index:99999;background:${color};color:#fff;padding:10px 18px;border-radius:8px;font-family:system-ui;font-size:14px;font-weight:500;pointer-events:none;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const ADAPTERS = [new NaverAdapter(), new RidiAdapter(), new KakaoAdapter()];

function findAdapter() { return ADAPTERS.find(a => a.detect()); }

let bootCleanup = null;
let _wtEnabled  = true;

function bootForPage() {
  bootCleanup?.();
  bootCleanup = null;
  if (!_wtEnabled) return;

  const adapter = findAdapter();
  if (!adapter) { console.log('[WebtoonTranslate] No adapter:', location.href); return; }

  const meta = adapter.getChapterMeta();
  console.log('[WebtoonTranslate] Active:', meta);

  const renderer    = new OverlayRenderer();
  const isKakao     = adapter.usesFixedOverlay === true;
  const fixedLayer  = isKakao ? new FixedOverlayLayer({ onSelect: handleBBoxSelect }) : null;

  const panel    = new SidePanel({
    onJump: (ann, img) => {
      const key = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
      // Search document-wide since wrapper may be nested differently per site
      const b = document.querySelector(`[data-ann-key="${key}"]`);
      if (b) {
        b.classList.add('wt-bubble-highlight');
        setTimeout(() => b.classList.remove('wt-bubble-highlight'), 1500);
      }
    },
    onImport: () => triggerImport(),
    onExport: () => triggerExport(meta),
  });
  const bubbleEditor = new BubbleEditor({
    onBboxChange: async (bubble, img, newBbox) => {
      // Persist the moved/resized bbox immediately on mouseup
      const imgHash = await hashImage(img);
      const imgIndex = images.indexOf(img);
      const annKey  = bubble.dataset.annKey;
      const { annotations: stored } = await sendToBackground({ type: MSG.LOAD_TRANSLATIONS, payload: meta });
      const existing = stored?.find(a => `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === annKey);
      if (!existing) return;
      const updated = { ...existing, imageIndex: imgIndex, bbox: newBbox };
      await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [updated] } });
      // Update dataset so dialog re-edit picks up new bbox
      bubble.dataset.bboxX = newBbox.x;
      bubble.dataset.bboxY = newBbox.y;
      bubble.dataset.bboxW = newBbox.w;
      bubble.dataset.bboxH = newBbox.h;
      allAnnotations = allAnnotations.map(a =>
        `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === annKey ? updated : a
      );
    },
  });
  let allAnnotations = [];

  const dialog = new InputDialog({
    onDelete: () => { /* handled inline below via _pendingDelete */ },
  });

  let currentMode     = MODES.READ;
  let images          = [];
  let annotationCount = 0;

  // Build floating toggle button (Read mode only)
  const toggleBtn = buildToggleButton();

  // Keyboard shortcut: T to toggle
  const keyHandler = (e) => {
    if (e.key === 't' || e.key === 'T') {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      toggleTranslations();
    }
  };
  document.addEventListener('keydown', keyHandler);
  let _pendingDeleteFn = null;

  // ── load & render ──────────────────────────────────────────────────────

  async function loadAndRender() {
    const { annotations } = await sendToBackground({ type: MSG.LOAD_TRANSLATIONS, payload: meta });
    const raw = annotations || [];

    // Dedupe by annKey (imageHash::bboxX::bboxY) — keep most recent
    const seen = new Map();
    for (const ann of raw) {
      const key = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
      const existing = seen.get(key);
      if (!existing || new Date(ann.createdAt) >= new Date(existing.createdAt)) seen.set(key, ann);
    }

    // Always sync allAnnotations to deduplicated storage state
    allAnnotations  = [...seen.values()];
    annotationCount = allAnnotations.length;

    const byHash = new Map();
    for (const ann of allAnnotations) {
      if (!byHash.has(ann.imageHash)) byHash.set(ann.imageHash, []);
      byHash.get(ann.imageHash).push(ann);
    }
    for (const img of images) {
      const hash = await hashImage(img);
      const anns = byHash.get(hash) || [];
      if (isKakao) {
        for (const ann of anns) fixedLayer.upsertBubble(img, ann);
      } else {
        renderer.renderForImage(img, anns);
      }
    }
    // Keep side panel in sync
    panel.setImages(images);
    panel.update(allAnnotations);
  }

  // ── progress indicator ──────────────────────────────────────────────────

  function updateProgressBar() {
    let bar = document.getElementById('wt-progress-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'wt-progress-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;height:3px;background:rgba(99,102,241,0.15);pointer-events:none;';
      const fill = document.createElement('div');
      fill.id = 'wt-progress-fill';
      fill.style.cssText = 'height:100%;background:#6366f1;transition:width 0.3s;width:0%;';
      bar.appendChild(fill);
      document.body.appendChild(bar);
    }
    const imgsWithTranslation = new Set(allAnnotations.map(a => a.imageIndex ?? 0));
    const pct = images.length > 0 ? Math.round((imgsWithTranslation.size / images.length) * 100) : 0;
    document.getElementById('wt-progress-fill').style.width = `${pct}%`;
    bar.title = `${imgsWithTranslation.size} of ${images.length} panels translated (${pct}%)`;
  }

  // ── image loading ──────────────────────────────────────────────────────

  let attempts = 0;
  const tryGetImages = () => {
    images = adapter.getImages();
    if (images.length === 0 && attempts++ < 20) {
      // For Kakao: images are lazy-loaded. After a few failed attempts,
      // trigger a tiny scroll to wake up the IntersectionObserver.
      if (attempts === 5 && location.hostname === 'page.kakao.com') {
        window.scrollBy(0, 1);
        setTimeout(() => window.scrollBy(0, -1), 100);
      }
      setTimeout(tryGetImages, 600);
    } else {
      loadAndRender().then(updateProgressBar);
      checkStorageQuota();
    }
  };
  tryGetImages();

  const stopWatching = adapter.watchNewImages(async (newImages) => {
    const added = newImages.filter(img => !images.includes(img));
    if (!added.length) return;
    images = [...images, ...added];
    if (currentMode === MODES.ANNOTATE) {
      if (isKakao) fixedLayer.enable(images);
      else added.forEach(img => selector.attachImage(img, images.indexOf(img)));
    }
    await loadAndRender();
    updateProgressBar();
  });

  // ── bbox select handler ────────────────────────────────────────────────

  const selector = new BBoxSelector({ onSelect: handleBBoxSelect });

  async function handleBBoxSelect({ bbox, imageEl, imageIndex }) {
    const rect = imageEl.getBoundingClientRect();
    const screenPos = {
      x: rect.left + window.scrollX + (bbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (bbox.y / 100) * rect.height,
    };
    const result = await dialog.show(screenPos);
    if (!result) return;

    const imageHash  = await hashImage(imageEl);
    const annotation = {
      imageHash, imageIndex, bbox: result.resizedBbox || bbox,
      originalText: result.originalText, translatedText: result.translatedText,
      style: result.style, language: 'vi', createdAt: new Date().toISOString(),
    };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });
    // Upsert into allAnnotations by annKey — never duplicate
    const newKey = `${annotation.imageHash}::${annotation.bbox.x.toFixed(1)}::${annotation.bbox.y.toFixed(1)}`;
    const existsIdx = allAnnotations.findIndex(a =>
      `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === newKey
    );
    if (existsIdx >= 0) allAnnotations[existsIdx] = annotation;
    else { allAnnotations.push(annotation); annotationCount++; }
    if (isKakao) fixedLayer.upsertBubble(imageEl, annotation);
    else renderer.upsertBubble(imageEl, annotation);
    panel.update(allAnnotations);
    updateProgressBar();
  }

  // ── click bubble to edit ───────────────────────────────────────────────

  document.addEventListener('click', async (e) => {
    if (currentMode !== MODES.ANNOTATE) return;
    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) return;
    e.stopPropagation();

    const wrapper = bubble.closest('.wt-img-wrapper');
    const img     = wrapper?.querySelector('img');
    if (img) bubbleEditor.attach(bubble, img);
    if (!img) return;
    const imgIndex = images.indexOf(img);

    // Always read bbox from dataset — stays current after drag/resize
    const existingBbox = {
      x: parseFloat(bubble.dataset.bboxX), y: parseFloat(bubble.dataset.bboxY),
      w: parseFloat(bubble.dataset.bboxW), h: parseFloat(bubble.dataset.bboxH),
    };

    const annKeyToDelete = bubble.dataset.annKey; // format: imageHash::bboxX::bboxY

    // Look up annotation from in-memory allAnnotations first (always up-to-date),
    // fall back to storage only if not found (e.g. imported annotation).
    const imgHash = await hashImage(img);
    let existing = allAnnotations.find(a =>
      `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === annKeyToDelete
    );
    if (!existing) {
      // Fallback: fetch from storage and match by annKey
      const { annotations: stored } = await sendToBackground({ type: MSG.LOAD_TRANSLATIONS, payload: meta });
      existing = stored?.find(a =>
        `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === annKeyToDelete
      );
    }

    const rect = img.getBoundingClientRect();
    const bubbleLeft  = rect.left + window.scrollX + (existingBbox.x / 100) * rect.width;
    const bubbleTop   = rect.top  + window.scrollY + (existingBbox.y / 100) * rect.height;
    const bubbleRight = rect.left + window.scrollX + ((existingBbox.x + existingBbox.w) / 100) * rect.width;
    const dialogW     = 300;
    const spaceRight  = window.scrollX + window.innerWidth - bubbleRight - 24;
    const screenPos   = {
      x: spaceRight >= dialogW ? bubbleRight + 12 : bubbleLeft - dialogW - 12,
      y: bubbleTop,
    };

    // Hide selector overlay on this image while dialog is open so color picker sees true colors
    const selectorOverlay = wrapper?.querySelector('.wt-selector-overlay');
    if (selectorOverlay) selectorOverlay.style.visibility = 'hidden';

    dialog._onDelete = async () => {
      await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey: annKeyToDelete } });
      if (isKakao) fixedLayer.removeBubble(annKeyToDelete);
      else renderer.removeBubble(img, annKeyToDelete);
      allAnnotations = allAnnotations.filter(a =>
        `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` !== annKeyToDelete
      );
      annotationCount--;
      panel.update(allAnnotations);
      updateProgressBar();
    };

    const result = await dialog.show(screenPos, {
      originalText:   existing?.originalText   || '',
      translatedText: existing?.translatedText || bubble.querySelector('span')?.textContent || '',
      style:          existing?.style          || {},
      bbox:           existingBbox,
      img,
    });
    // Restore overlay regardless of save/cancel
    if (selectorOverlay) selectorOverlay.style.visibility = '';
    if (!result) return;

    const finalBbox = result.resizedBbox || existingBbox;
    const annotation = {
      imageHash: imgHash, imageIndex: imgIndex, bbox: finalBbox,
      originalText: result.originalText, translatedText: result.translatedText,
      style: result.style, language: 'vi',
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });

    if (result.resizedBbox) {
      if (isKakao) fixedLayer.removeBubble(annKeyToDelete);
      else renderer.removeBubble(img, annKeyToDelete);
    }
    if (isKakao) fixedLayer.upsertBubble(img, annotation);
    else renderer.upsertBubble(img, annotation);

    // Update allAnnotations by annKey (exact match, no bbox proximity)
    allAnnotations = allAnnotations.filter(a =>
      `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` !== annKeyToDelete
    );
    allAnnotations.push(annotation);
    panel.update(allAnnotations);
  });

  // Reposition fixed bubbles on scroll (Kakao uses position:absolute relative to page)
  if (isKakao) {
    window.addEventListener('scroll', () => fixedLayer?.repositionAll(), { passive: true });
    window.addEventListener('resize', () => fixedLayer?.repositionAll(), { passive: true });
  }

  // ── chapter navigation (SPA) ───────────────────────────────────────────
  // Naver is a SPA — URL changes via pushState without full page reload.
  // We watch for URL changes and re-boot when chapter changes.

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const newAdapter = findAdapter();
      if (newAdapter) {
        console.log('[WebtoonTranslate] SPA navigation detected, re-booting');
        renderer.clearAll();
        panel.hide();
        document.getElementById('wt-progress-bar')?.remove();
        // Small delay for Naver to render new chapter DOM
        setTimeout(() => bootForPage(), 800);
      }
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // ── storage quota check ────────────────────────────────────────────────

  async function checkStorageQuota() {
    if (!navigator.storage?.estimate) return;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      showStorageWarning(usage, quota);
    } catch {}
  }

  // ── message listener ───────────────────────────────────────────────────

  const onRuntimeMessage = (message, _sender, sendResponse) => {
    if (message.type === 'GET_META') {
      // Get human-readable title from meta tags
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content
        || document.querySelector('title')?.textContent
        || meta.titleId;
      sendResponse({ ...meta, title: ogTitle, annotationCount, currentMode,
        imageCount: images.length,
        translatedPanels: new Set(allAnnotations.map(a => a.imageIndex ?? 0)).size });
      return true;
    }
    if (message.type === 'SET_MODE') {
      currentMode = message.mode;
      if (currentMode === MODES.ANNOTATE) {
        if (isKakao) fixedLayer.enable(images);
        else selector.enable(images);
        document.body.classList.add('wt-annotate-mode');
        toggleBtn.style.display = 'none';
        toggleTranslations(true);
      } else {
        if (isKakao) fixedLayer.disable();
        else selector.disable();
        bubbleEditor.detach();
        document.body.classList.remove('wt-annotate-mode');
        toggleBtn.style.display = '';
      }
    }
    if (message.type === 'TOGGLE_PANEL') {
      panel.setImages(images);
      panel.update(allAnnotations);
      panel.toggle();
    }
    if (message.type === 'TRIGGER_EXPORT') triggerExport(meta);
    if (message.type === 'TRIGGER_IMPORT') triggerImport();
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // ── export / import ────────────────────────────────────────────────────

  async function triggerExport({ site, titleId }) {
    try {
      const response = await sendToBackground({ type: MSG.EXPORT_CHAPTER, payload: { site, titleId } });
      if (!response?.exportData) {
        showToast('✗ Export failed: no data returned. Try reloading the extension.', '#ef4444');
        return;
      }
      const blob = new Blob([JSON.stringify(response.exportData, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `webtoon-translate_${site}_${titleId}_vi.json`;
      a.click(); URL.revokeObjectURL(url);
      showToast('✓ Exported successfully.');
    } catch (err) {
      showToast(`✗ Export error: ${err.message}`, '#ef4444');
    }
  }

  function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const { ok, imported, error } = await sendToBackground({ type: MSG.IMPORT_FILE, payload: { jsonString: text } });
      if (ok) {
        await loadAndRender(); updateProgressBar();
        showToast(`✓ Imported ${imported} translation${imported !== 1 ? 's' : ''}.`);
      } else {
        showToast(`✗ Import failed: ${error}`, '#ef4444');
      }
    });
    input.click();
  }

  bootCleanup = () => {
    stopWatching();
    urlObserver.disconnect();
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    if (isKakao) { fixedLayer.disable(); fixedLayer.clearAll(); }
    else selector.disable();
    renderer.clearAll();
    bubbleEditor.detach();
    toggleBtn.remove();
    panel.hide();
    document.getElementById('wt-progress-bar')?.remove();
    document.body.classList.remove('wt-annotate-mode');
    document.body.style.marginRight = '';
    document.removeEventListener('keydown', keyHandler);
    _translationsVisible = true;
  };
}

// ── Global on/off switch ──────────────────────────────────────────────────────
// `wt:enabled` is a global flag in chrome.storage.local. When off, the content
// script tears down all injected UI and stays dormant until re-enabled.

function teardown() {
  bootCleanup?.();
  bootCleanup = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SET_ENABLED') return;
  _wtEnabled = !!message.enabled;
  if (_wtEnabled) {
    if (!bootCleanup) bootForPage();
  } else {
    teardown();
  }
});

chrome.storage.local.get({ 'wt:enabled': true }, (result) => {
  _wtEnabled = !!result['wt:enabled'];
  if (_wtEnabled) bootForPage();
});

})();
