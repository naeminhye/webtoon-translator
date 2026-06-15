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
  CLEAR_CHAPTER:     'CLEAR_CHAPTER',
  OCR_REGION:        'OCR_REGION',
  OCR_STITCH:        'OCR_STITCH',
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

  // Naver CDN (pstatic.net) blocks credentialed CORS fetches (ACAO: *), so a
  // byte-level hash was never reachable — every image fell into the url:
  // fallback anyway. Go straight there: same key format (compatible with
  // existing saved annotations), no console CORS spam, no wasted fetches.
  // Naver image URLs are stable per chapter so this stays a reliable identity.
  if (img.src.includes('pstatic.net')) {
    const urlHash = img.src.split('?')[0].split('/').slice(-2).join('/');
    img.__wtHash  = `url:${urlHash}`;
    return img.__wtHash;
  }

  // Ridi (and any other viewer) uses blob: URLs that are revoked after the
  // image loads — fetch() fails with ERR_FILE_NOT_FOUND. The decoded bitmap
  // is still in the <img> element, so draw a tiny sample to a canvas instead.
  if (img.src.startsWith('blob:')) {
    try {
      const SAMPLE = 16;
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE; canvas.height = SAMPLE;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      const data    = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      const hex     = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      img.__wtHash = `sha256:${hex}`;
    } catch {
      // Canvas tainted or image not decoded — use data-index (stable per chapter)
      const idx = img.dataset.index ?? img.src.split('/').pop();
      img.__wtHash = `blob-idx:${idx}`;
    }
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
  constructor({ onSelect, getImages }) {
    this._onSelect  = onSelect;
    this._getImages = getImages || null; // live image list — survives lazy-load/remount
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

  /** Image a bubble was rendered for — fixed bubbles live in body, not in a wrapper */
  getBubbleImage(annKey) {
    return this._bubbles.get(annKey)?.img || null;
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

    // Forward wheel events so the page can still scroll while the overlay is active.
    // Ridi uses simplebar — its custom scroll container doesn't respond to re-dispatched
    // WheelEvents (isTrusted:false), so we scroll it directly. Other sites fall back to
    // the re-dispatch trick. Guard against non-trusted events to avoid infinite recursion.
    this._el.addEventListener('wheel', (e) => {
      if (!e.isTrusted) return;
      const simplebarWrapper = document.querySelector('.simplebar-content-wrapper');
      if (simplebarWrapper) {
        simplebarWrapper.scrollTop  += e.deltaY;
        simplebarWrapper.scrollLeft += e.deltaX;
        return;
      }
      this._el.style.pointerEvents = 'none';
      const target = document.elementFromPoint(e.clientX, e.clientY);
      this._el.style.pointerEvents = 'auto';
      if (target) {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY,
        }));
      }
    }, { passive: true });

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

      const selL = Math.min(startX, endX), selT = Math.min(startY, endY);
      const selR = selL + pw, selB = selT + ph;
      const cx   = selL + pw / 2, cy = selT + ph / 2;
      const imgs = this._liveImages();

      // Detect all images that overlap with the drawn selection rect
      const overlapping = imgs
        .filter(i => {
          const r = i.getBoundingClientRect();
          return r.width > 100 && r.height > 100 &&
            selL < r.right && selR > r.left && selT < r.bottom && selB > r.top;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      if (overlapping.length === 0) {
        // Fallback: any image at center
        const fb = this._anyImageAtPoint(cx, cy);
        if (!fb) { showToast('✗ No panel image found under selection. Scroll so the panel is fully loaded, then try again.', '#ef4444'); return; }
        overlapping.push(fb);
      }

      if (overlapping.length > 1) {
        // Multi-image selection: compute per-image bbox clips
        const clips = overlapping.map(i => {
          const r = i.getBoundingClientRect();
          const clipL = Math.max(selL, r.left), clipT = Math.max(selT, r.top);
          const clipR = Math.min(selR, r.right), clipB = Math.min(selB, r.bottom);
          return {
            img: i,
            bbox: {
              x: ((clipL - r.left) / r.width)  * 100,
              y: ((clipT - r.top)  / r.height) * 100,
              w: ((clipR - clipL)  / r.width)  * 100,
              h: ((clipB - clipT)  / r.height) * 100,
            },
          };
        });
        const primary = overlapping[0];
        let primaryIdx = imgs.indexOf(primary);
        if (primaryIdx === -1) { imgs.push(primary); primaryIdx = imgs.length - 1; }
        this._onSelect({ bbox: clips[0].bbox, imageEl: primary, imageIndex: primaryIdx, clips });
        return;
      }

      const img  = overlapping[0];
      const rect = img.getBoundingClientRect();
      const bbox = {
        x: Math.max(0, (selL - rect.left) / rect.width  * 100),
        y: Math.max(0, (selT - rect.top)  / rect.height * 100),
        w: Math.min(100, pw / rect.width  * 100),
        h: Math.min(100, ph / rect.height * 100),
      };
      bbox.w = Math.min(100 - bbox.x, bbox.w);
      bbox.h = Math.min(100 - bbox.y, bbox.h);

      let imageIndex = imgs.indexOf(img);
      if (imageIndex === -1) { imgs.push(img); imageIndex = imgs.length - 1; }
      this._onSelect({ bbox, imageEl: img, imageIndex });
    });
  }

  _liveImages() {
    // Prefer the live list (source of truth in bootForPage) — fall back to the
    // enable()-time snapshot only when no getter was provided.
    return this._getImages ? this._getImages() : this._images;
  }

  /** Filter-free fallback: any reasonably sized <img> whose rect contains the point */
  _anyImageAtPoint(vx, vy) {
    for (const img of document.images) {
      if (!img.src || img.src.startsWith('data:')) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 150 || r.height < 100) continue;
      if (vx >= r.left && vx <= r.right && vy >= r.top && vy <= r.bottom) return img;
    }
    return null;
  }

  _imageAtViewportPoint(vx, vy, imgs = this._images) {
    for (const img of imgs) {
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
      b.style.fontSize   = `${s.fontSize || 20}px`;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
      b.style.background = s.noBg   ? 'transparent' : (s.bg || 'rgba(255,255,255,0.95)');
      if (s.stroke && s.strokeColor) {
        b.style.textShadow = strokeTextShadow(s.strokeColor, s.strokeWidth || 1);
      } else {
        b.style.textShadow = 'none';
      }
      if (s.fontFamily) b.style.fontFamily = `'${s.fontFamily}', system-ui, sans-serif`;
      if (s.textAlign) {
        b.style.textAlign      = s.textAlign;
        b.style.justifyContent = s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center';
      }
      if (s.rotate) b.style.transform = `rotate(${s.rotate}deg)`;
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
      const overlayRect = overlay.getBoundingClientRect();
      const ex = e.clientX - overlayRect.left, ey = e.clientY - overlayRect.top;
      const px = Math.min(startX, ex), py = Math.min(startY, ey);
      const pw = Math.abs(ex - startX), ph = Math.abs(ey - startY);
      selectionEl.remove();
      this._currentDrag = null;
      if (pw < 10 || ph < 10) return;
      // Use IMAGE dimensions (not overlay) for %-coordinates.
      // The overlay is 80px taller than the image for cross-panel drag affordance;
      // dividing by overlayRect.height would shift/compress all Y values.
      const imgRect = img.getBoundingClientRect();
      this.onSelect({
        bbox: { x: (px / imgRect.width)  * 100,
                y: (py / imgRect.height) * 100,
                w: (pw / imgRect.width)  * 100,
                h: (ph / imgRect.height) * 100 },
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
    // blob: images (Ridi etc.) — reparenting a React-managed node triggers a re-render
    // that tries to reload the already-revoked blob URL, breaking the image.
    if (img.src?.startsWith('blob:')) return parent;
    // Capture rendered dimensions BEFORE moving the image — after reparenting
    // the CSS-constrained size is lost and only naturalWidth remains.
    const displayW = img.offsetWidth;
    const wrapper = document.createElement('div');
    wrapper.className = 'wt-img-wrapper';
    img.parentElement.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    img.style.display = 'block';
    const setW = () => {
      const w = displayW || img.naturalWidth || img.offsetWidth;
      // Don't set explicit height — let the image determine it.
      // Setting height:naturalHeight causes gaps when the viewer scales images down.
      if (w > 0) {
        wrapper.style.cssText = `position:relative;display:block;width:${w}px;line-height:0;margin:0 auto;padding:0;`;
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
      const displayW = img.offsetWidth;
      wrapper = document.createElement('div');
      wrapper.className = 'wt-img-wrapper';
      img.parentElement.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      img.style.display = 'block';
      const setW = () => {
        const w = displayW || img.naturalWidth || img.offsetWidth;
        if (w > 0) {
          wrapper.style.cssText = `position:relative;display:block;width:${w}px;line-height:0;margin:0 auto;padding:0;`;
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
      b.style.fontSize   = `${s.fontSize || 20}px`;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
      b.style.background = s.noBg   ? 'transparent' : (s.bg || 'rgba(255,255,255,0.95)');
      if (s.stroke && s.strokeColor) {
        b.style.textShadow = strokeTextShadow(s.strokeColor, s.strokeWidth || 1);
      } else {
        b.style.textShadow = 'none';
      }
      if (s.fontFamily) {
        b.style.fontFamily = `'${s.fontFamily}', system-ui, sans-serif`;
        loadGoogleFont(s.fontFamily);
      }
      if (s.textAlign) {
        b.style.textAlign      = s.textAlign;
        b.style.justifyContent = s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center';
      }
      if (s.rotate) b.style.transform = `rotate(${s.rotate}deg)`;
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
      fontSize: 20, bold: false, italic: false,
      color: '#1a1a2e', bg: '#ffffff', noBg: false,
      stroke: false, strokeColor: '#ffffff', strokeWidth: 1,
      fontFamily: '', textAlign: 'center', rotate: 0,
      ...(InputDialog._lastStyle || {}),
    };
    this._build();
  }

  show(screenPos, prefill = {}) {
    // SPA sites (Kakao/Next.js) can wipe body children on re-render — re-attach
    if (!this._el.isConnected) document.body.appendChild(this._el);
    this._isEdit = !!prefill.translatedText;
    this._onPreview = prefill.onPreview || null;
    this._onCancel  = prefill.onCancel  || null;
    // Update title and show/hide delete button
    this._el.querySelector('.wt-dialog-title').textContent =
      this._isEdit ? 'Edit translation' : 'Add translation';
    this._el.querySelector('.wt-btn-delete').style.display =
      this._isEdit ? 'block' : 'none';

    return new Promise(resolve => {
      this._resolve = resolve;
      this._el.querySelector('.wt-input-original').value   = prefill.originalText   || '';
      this._el.querySelector('.wt-input-translated').value = prefill.translatedText || '';
      // Merge: defaults → last saved style → prefill.style (prefill wins)
      this._style = {
        fontSize: 20, bold: false, italic: false,
        color: '#1a1a2e', bg: '#ffffff', noBg: false,
        stroke: false, strokeColor: '#ffffff', strokeWidth: 1, fontFamily: '', textAlign: 'center', rotate: 0,
        ...(InputDialog._lastStyle || {}),
        ...(prefill.style || {}),
      };
      // Snapshot for Reset button
      this._initText  = prefill.translatedText || '';
      this._initStyle = { ...this._style };
      this._syncStyleUI();

      // Store bbox for resize
      this._currentBbox = prefill.bbox || null;
      this._currentImg  = prefill.img  || null;

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
    this._el.querySelector('.wt-ocr-status').style.display = 'none';
    clearTimeout(this._ocrStatusTimer);
    document.removeEventListener('keydown', this._escHandler);
  }

  // ── OCR prefill ──────────────────────────────────────────────────────────
  // Background OCR fills the "Original text" field while the dialog is open.
  // Never overwrites anything the user already typed.

  setOcrPending() {
    // Session token guards against a slow OCR result landing in a dialog
    // that was since reopened for a different bbox
    this._ocrSession = (this._ocrSession || 0) + 1;
    this._showOcrStatus('⏳ Starting OCR…', '#6366f1');
    return this._ocrSession;
  }

  setOcrText(text, session) {
    if (session !== this._ocrSession) return;
    const inp = this._el.querySelector('.wt-input-original');
    if (this._el.style.display !== 'none' && !inp.value && text) inp.value = text;
    if (text) this._showOcrStatus('✓ OCR done — edit if needed', '#16a34a', 4000);
    else      this._showOcrStatus('OCR found no text in this region', '#94a3b8', 4000);
  }

  setOcrError(message, session) {
    if (session !== undefined && session !== this._ocrSession) return;
    this._showOcrStatus(`✗ OCR failed: ${message || 'unknown error'}`, '#ef4444');
  }

  /** Engine-level progress (model download, recognition) — not session-bound */
  setOcrStatus({ status, progress, message }) {
    const pct = progress !== undefined ? ` ${Math.round(progress * 100)}%` : '';
    if (status === 'downloading-model') {
      this._showOcrStatus(`⏳ Loading Korean OCR model…${pct}`, '#6366f1');
    } else if (status === 'initializing') {
      this._showOcrStatus('⏳ Preparing OCR engine…', '#6366f1');
    } else if (status === 'recognizing') {
      this._showOcrStatus(`🔍 Scanning text…${pct}`, '#6366f1');
    } else if (status === 'error') {
      this._showOcrStatus(`✗ OCR engine failed to start: ${message || 'unknown error'}`, '#ef4444');
    }
    // 'ready' is not shown by itself — setOcrText handles the success message
  }

  _showOcrStatus(text, color, autoHideMs) {
    const el = this._el.querySelector('.wt-ocr-status');
    el.textContent    = text;
    el.style.color    = color;
    el.style.display  = 'block';
    clearTimeout(this._ocrStatusTimer);
    if (autoHideMs) {
      this._ocrStatusTimer = setTimeout(() => { el.style.display = 'none'; }, autoHideMs);
    }
  }

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-input-dialog';
    this._el.innerHTML = `
      <div class="wt-dialog-header">
        <span class="wt-dialog-title">Add translation</span>
        <button class="wt-btn-close" aria-label="Cancel">&#x2715;</button>
      </div>
      <div class="wt-original-label-row">
        <label class="wt-dialog-label">Original text (optional)</label>
        <button class="wt-btn-gtranslate" type="button" title="Translate with Google Translate">Translate ↗</button>
      </div>
      <input class="wt-input-original" type="text" placeholder="Source text..." />
      <div class="wt-ocr-status" style="display:none"></div>
      <label class="wt-dialog-label">Translation</label>
      <textarea class="wt-input-translated" rows="3" placeholder="Enter translation..."></textarea>
      <div class="wt-style-bar">
        <input class="wt-style-fontsize" type="number" min="8" max="48" value="20" title="Font size (px)" />
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
        <div class="wt-style-divider"></div>
        <button class="wt-style-btn wt-style-align" data-align="left"   title="Align left"><svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="1" width="13" height="2"/><rect x="0" y="5" width="9"  height="2"/><rect x="0" y="9" width="11" height="2"/></svg></button>
        <button class="wt-style-btn wt-style-align" data-align="center" title="Align center"><svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="1" width="13" height="2"/><rect x="2" y="5" width="9"  height="2"/><rect x="1" y="9" width="11" height="2"/></svg></button>
        <button class="wt-style-btn wt-style-align" data-align="right"  title="Align right"><svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="0" y="1" width="13" height="2"/><rect x="4" y="5" width="9"  height="2"/><rect x="2" y="9" width="11" height="2"/></svg></button>
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
      <div class="wt-rotate-row">
        <label class="wt-dialog-label" style="margin:0;flex-shrink:0">Rotate</label>
        <input class="wt-style-rotate" type="range" min="-180" max="180" value="0" step="1" />
        <span class="wt-rotate-val">0°</span>
      </div>
      <div class="wt-dialog-actions">
        <button class="wt-btn-delete" style="display:none">Delete</button>
        <button class="wt-btn-reset" style="display:none" title="Reset to state before opening">Reset</button>
        <button class="wt-btn-cancel">Cancel</button>
        <button class="wt-btn-save">Save</button>
      </div>`;

    this._makeDraggable(this._el.querySelector('.wt-dialog-header'));

    // Stop keyboard events from bubbling to the site — prevents Ridi/Kakao viewer
    // shortcuts (arrow-key navigation, etc.) from firing while user is typing.
    this._el.addEventListener('keydown', e => e.stopPropagation());

    this._el.querySelector('.wt-btn-close').addEventListener('click',  () => this._cancel());
    this._el.querySelector('.wt-btn-cancel').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-btn-save').addEventListener('click',   () => this._save());
    this._el.querySelector('.wt-btn-delete').addEventListener('click', () => this._delete());
    this._el.querySelector('.wt-btn-reset').addEventListener('click',  () => this._reset());
    this._el.querySelector('.wt-input-translated').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._save(); }
    });
    this._el.querySelector('.wt-input-original').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._el.querySelector('.wt-input-translated').focus(); }
    });
    // Enter in any number/style input also saves
    this._el.querySelectorAll('.wt-style-fontsize, .wt-style-stroke-width').forEach(inp => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._save(); } });
    });

    // Style bar
    this._el.querySelector('.wt-style-fontsize').addEventListener('input', (e) => {
      this._style.fontSize = parseInt(e.target.value) || 13;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-bold').addEventListener('click', () => {
      this._style.bold = !this._style.bold;
      this._el.querySelector('.wt-style-bold').classList.toggle('active', this._style.bold);
      this._firePreview();
    });
    this._el.querySelector('.wt-style-italic').addEventListener('click', () => {
      this._style.italic = !this._style.italic;
      this._el.querySelector('.wt-style-italic').classList.toggle('active', this._style.italic);
      this._firePreview();
    });
    this._el.querySelector('.wt-style-color').addEventListener('input', (e) => {
      this._style.color = e.target.value;
      this._el.querySelector('#wt-dot-color').style.background = e.target.value;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-bg').addEventListener('input', (e) => {
      this._style.bg = e.target.value;
      this._el.querySelector('#wt-dot-bg').style.background = e.target.value;
      this._el.querySelector('.wt-style-nobg').checked = false;
      this._style.noBg = false;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-nobg').addEventListener('change', (e) => {
      this._style.noBg = e.target.checked;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-stroke-on').addEventListener('change', (e) => {
      this._style.stroke = e.target.checked;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-stroke-color').addEventListener('input', (e) => {
      this._style.strokeColor = e.target.value;
      this._el.querySelector('#wt-dot-stroke').style.background = e.target.value;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-stroke-width').addEventListener('input', (e) => {
      this._style.strokeWidth = parseInt(e.target.value) || 1;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-font').addEventListener('change', (e) => {
      this._style.fontFamily = e.target.value;
      if (e.target.value) loadGoogleFont(e.target.value);
      this._firePreview();
    });
    this._el.querySelectorAll('.wt-style-align').forEach(btn => {
      btn.addEventListener('click', () => {
        this._style.textAlign = btn.dataset.align;
        this._el.querySelectorAll('.wt-style-align').forEach(b => b.classList.toggle('active', b === btn));
        this._firePreview();
      });
    });
    this._el.querySelector('.wt-style-rotate').addEventListener('input', (e) => {
      this._style.rotate = parseInt(e.target.value) || 0;
      this._el.querySelector('.wt-rotate-val').textContent = `${this._style.rotate}°`;
      this._firePreview();
    });
    this._el.querySelector('.wt-style-rotate').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._save(); }
    });
    this._el.querySelector('.wt-input-translated').addEventListener('input', () => {
      this._firePreview();
    });

    const translateBtn = this._el.querySelector('.wt-btn-gtranslate');

    // Show/hide translate button based on provider setting
    chrome.storage.local.get({ 'wt:translate-provider': 'google' }, (s) => {
      translateBtn.style.display = s['wt:translate-provider'] === 'none' ? 'none' : '';
    });

    translateBtn.addEventListener('click', async () => {
      const originalInput   = this._el.querySelector('.wt-input-original');
      const translatedInput = this._el.querySelector('.wt-input-translated');
      const text = originalInput.value.trim();
      if (!text) { originalInput.focus(); return; }
      translateBtn.disabled = true;
      translateBtn.textContent = '…';
      try {
        const translated = await autoTranslate(text);
        if (translated) {
          translatedInput.value = translated;
          translatedInput.focus();
        } else {
          this._showOcrStatus('Translation is disabled in Settings', '#94a3b8', 3000);
        }
      } catch (err) {
        this._showOcrStatus(`✗ Translation failed: ${err.message}`, '#ef4444', 5000);
      } finally {
        translateBtn.disabled = false;
        translateBtn.textContent = 'Translate ↗';
      }
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
    const align = this._style.textAlign || 'center';
    this._el.querySelectorAll('.wt-style-align').forEach(b => b.classList.toggle('active', b.dataset.align === align));
    const rotate = this._style.rotate || 0;
    this._el.querySelector('.wt-style-rotate').value = rotate;
    this._el.querySelector('.wt-rotate-val').textContent = `${rotate}°`;
    this._el.querySelector('.wt-btn-reset').style.display = this._onPreview ? 'block' : 'none';
    this._firePreview();
  }

  _firePreview() {
    if (!this._onPreview) return;
    const text = this._el.querySelector('.wt-input-translated').value;
    this._onPreview(text, { ...this._style });
  }

  _reset() {
    this._el.querySelector('.wt-input-translated').value = this._initText;
    this._style = { ...this._initStyle };
    this._syncStyleUI();
    this._firePreview();
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
    return this._currentBbox || null;
  }

  _save() {
    const originalText   = this._el.querySelector('.wt-input-original').value.trim();
    const translatedText = this._el.querySelector('.wt-input-translated').value.trim();
    if (!translatedText) { this._el.querySelector('.wt-input-translated').focus(); return; }
    const resizedBbox = this._isEdit ? this._getBboxFromResize() : null;
    InputDialog._lastStyle = { ...this._style };
    this.hide();
    this._onPreview = null;
    this._onCancel  = null;
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
    this._onCancel?.();
    this._onPreview = null;
    this._onCancel  = null;
    this._resolve?.(null);
    this._resolve = null;
  }
}

// ── QuickTranslateDialog ──────────────────────────────────────────────────────
// Minimal floating dialog for Read-mode quick OCR+translate.
// No style options — result is saved with sensible defaults.

class QuickTranslateDialog {
  constructor() {
    this._el       = null;
    this._resolve  = null;
    this._origText = '';
    this._build();
  }

  show(screenPos, prefill = {}) {
    if (!this._el.isConnected) document.body.appendChild(this._el);
    this._el.querySelector('.wt-quick-translated').value = prefill.translatedText || '';
    this._origText = prefill.originalText || '';
    const origEl = this._el.querySelector('.wt-quick-original');
    origEl.textContent = this._origText;
    origEl.style.display = this._origText ? 'block' : 'none';
    this._setStatus('');
    const isEdit = Boolean(prefill.translatedText);
    this._el.querySelector('.wt-quick-title').innerHTML = isEdit
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Edit Translation`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg> Quick Translate`;

    return new Promise(resolve => {
      this._resolve = resolve;
      const { innerWidth, innerHeight } = window;
      const w = 280, h = 200;
      let top  = screenPos.y + 10, left = screenPos.x;
      if (left + w > scrollX + innerWidth  - 20) left = scrollX + innerWidth  - w - 20;
      if (top  + h > scrollY + innerHeight - 20) top  = screenPos.y - h - 20;
      if (left < scrollX + 10) left = scrollX + 10;
      if (top  < scrollY + 10) top  = scrollY + 10;
      this._el.style.top  = `${top}px`;
      this._el.style.left = `${left}px`;
      this._el.style.display = 'block';
      this._escHandler = (e) => { if (e.key === 'Escape') this._cancel(); };
      document.addEventListener('keydown', this._escHandler);
    });
  }

  setStatus(text, color = '#6366f1') { this._setStatus(text, color); }

  setOriginalText(text) {
    this._origText = text;
    const el = this._el.querySelector('.wt-quick-original');
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }

  setTranslated(text) {
    this._el.querySelector('.wt-quick-translated').value = text;
    this._setStatus('');
    setTimeout(() => this._el.querySelector('.wt-quick-translated').focus(), 50);
  }

  getOriginalText() { return this._origText; }

  hide() {
    this._el.style.display = 'none';
    document.removeEventListener('keydown', this._escHandler);
  }

  _setStatus(text, color = '#6366f1') {
    const el = this._el.querySelector('.wt-quick-status');
    el.textContent = text;
    el.style.color  = color;
    el.style.display = text ? 'block' : 'none';
  }

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-quick-dialog';
    this._el.innerHTML = `
      <div class="wt-quick-header">
        <span class="wt-quick-title">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>
          Quick Translate
        </span>
        <button class="wt-quick-close" aria-label="Cancel">&#x2715;</button>
      </div>
      <div class="wt-quick-status" style="display:none"></div>
      <div class="wt-quick-original" style="display:none"></div>
      <textarea class="wt-quick-translated" rows="3" placeholder="Translation will appear here…"></textarea>
      <div class="wt-quick-actions">
        <button class="wt-quick-cancel">Cancel</button>
        <button class="wt-quick-save">Save</button>
      </div>`;

    this._makeDraggable(this._el.querySelector('.wt-quick-header'));
    this._el.addEventListener('keydown', e => e.stopPropagation());
    this._el.querySelector('.wt-quick-close').addEventListener('click',  () => this._cancel());
    this._el.querySelector('.wt-quick-cancel').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-quick-save').addEventListener('click',   () => this._save());
    this._el.querySelector('.wt-quick-translated').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._save();
    });
    document.body.appendChild(this._el);
  }

  _makeDraggable(handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wt-quick-close')) return;
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

  _save() {
    const translatedText = this._el.querySelector('.wt-quick-translated').value.trim();
    if (!translatedText) { this._el.querySelector('.wt-quick-translated').focus(); return; }
    this.hide();
    this._resolve?.({ translatedText });
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
    this._justDragged = false;
  }

  /** Returns true (and clears) if a drag/resize just ended — used to suppress the post-drag click. */
  consumeDrag() {
    const v = this._justDragged;
    this._justDragged = false;
    return v;
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
      this._justDragged = true;
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
      this._justDragged = true;
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
  constructor({ onJump, onImport, onExport, onDelete, onEdit }) {
    this._onJump   = onJump;
    this._onImport = onImport;
    this._onExport = onExport;
    this._onDelete = onDelete;
    this._onEdit   = onEdit;
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
      // Sort within each panel: top-to-bottom (bbox.y), then left-to-right (bbox.x)
      anns.sort((a, b) => a.bbox.y !== b.bbox.y ? a.bbox.y - b.bbox.y : a.bbox.x - b.bbox.x);
      const section = document.createElement('div');
      section.className = 'wt-sp-section';
      section.innerHTML = `<div class="wt-sp-section-label">Panel ${imgIdx + 1}</div>`;

      for (const ann of anns) {
        const row = document.createElement('div');
        row.className = 'wt-sp-row';
        const key = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
        row.dataset.annKey = key;

        row.innerHTML = `
          <div class="wt-sp-row-actions">
            <button class="wt-sp-row-edit" title="Edit translation">✏</button>
            <button class="wt-sp-row-del"  title="Delete translation">Delete</button>
          </div>
          <div class="wt-sp-row-text">${ann.translatedText}</div>
          ${ann.originalText ? `<div class="wt-sp-row-orig">${ann.originalText}</div>` : ''}
          <div class="wt-sp-row-edit-wrap hidden">
            <textarea class="wt-sp-row-textarea" rows="3">${ann.translatedText}</textarea>
            <div class="wt-sp-row-edit-btns">
              <button class="wt-sp-row-save">Save</button>
              <button class="wt-sp-row-cancel">Cancel</button>
            </div>
          </div>`;

        const textEl   = row.querySelector('.wt-sp-row-text');
        const editWrap = row.querySelector('.wt-sp-row-edit-wrap');
        const textarea = row.querySelector('.wt-sp-row-textarea');

        const openEditMode = () => {
          textEl.classList.add('hidden');
          editWrap.classList.remove('hidden');
          textarea.focus();
          textarea.select();
        };

        row.querySelector('.wt-sp-row-edit').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditMode();
        });

        row.querySelector('.wt-sp-row-cancel').addEventListener('click', (e) => {
          e.stopPropagation();
          textarea.value = ann.translatedText;
          editWrap.classList.add('hidden');
          textEl.classList.remove('hidden');
        });

        row.querySelector('.wt-sp-row-save').addEventListener('click', (e) => {
          e.stopPropagation();
          const next = { ...ann, translatedText: textarea.value };
          textEl.textContent = textarea.value;
          editWrap.classList.add('hidden');
          textEl.classList.remove('hidden');
          this._onEdit?.(next);
        });

        textarea.addEventListener('keydown', (e) => {
          e.stopPropagation(); // prevent site-level key handlers from firing
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            row.querySelector('.wt-sp-row-save').click();
          } else if (e.key === 'Escape') {
            row.querySelector('.wt-sp-row-cancel').click();
          }
        });

        row.querySelector('.wt-sp-row-del').addEventListener('click', (e) => {
          e.stopPropagation();
          this._onDelete?.(ann);
        });

        row.addEventListener('click', (e) => {
          if (e.target.closest('.wt-sp-row-actions, .wt-sp-row-edit-wrap')) return;
          const img    = this._images[imgIdx];
          const bubble = document.querySelector(`[data-ann-key="${key}"]`);
          if (bubble && !bubble.classList.contains('wt-fixed-bubble')) {
            bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else if (img) {
            const r = img.getBoundingClientRect();
            const targetY = r.top + ((ann.bbox.y + ann.bbox.h / 2) / 100) * r.height;
            scrollAncestorBy(img, targetY - window.innerHeight / 2);
          } else if (bubble) {
            bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            openEditMode();
            return;
          }
          this._onJump?.(ann, img);
          openEditMode();
        });
        section.appendChild(row);
      }
      list.appendChild(section);
    }
  }
}

const PANEL_W = 280;


/** Scroll el's nearest scrollable ancestor (or the window) by delta px */
function scrollAncestorBy(el, delta) {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const s = getComputedStyle(p);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) {
      p.scrollBy({ top: delta, behavior: 'smooth' });
      return;
    }
    p = p.parentElement;
  }
  window.scrollBy({ top: delta, behavior: 'smooth' });
}

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
  get usesFixedOverlay() { return true; }

  detect() {
    return location.hostname === 'ridibooks.com' &&
           /\/books\/\w+\/view/.test(location.pathname);
  }

  getChapterMeta() {
    const bId = location.pathname.match(/\/books\/(\w+)\/view/)?.[1] || 'unknown';
    try {
      const raw = document.getElementById('app_init')?.textContent;
      if (raw) {
        const json = JSON.parse(raw);
        const book = json?.detail?.book;
        if (book) {
          return { site: SITES.RIDI,
                   titleId:   String(book.series_id || bId),
                   chapterId: String(book.b_id       || bId) };
        }
      }
    } catch (_) { /* fall through */ }
    return { site: SITES.RIDI, titleId: bId, chapterId: bId };
  }

  getImages() {
    return [...document.querySelectorAll('img[data-index]')].filter(
      img => img.src && img.src.startsWith('blob:')
    );
  }

  watchNewImages(callback) {
    const root = document.querySelector('.simplebar-content-wrapper') ||
                 document.querySelector('.simplebar-content') ||
                 document.body;
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const imgs = this.getImages();
        if (imgs.length) callback(imgs);
      }, 150);
    });
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['src'] });
    return () => observer.disconnect();
  }
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
      if (!src || src.startsWith('data:')) return false;
      // Viewer may serve panels as DRM-decrypted blob: URLs instead of CDN links
      const isBlob = src.startsWith('blob:');
      const isCdn  = src.includes('page-edge.kakao.com') || src.includes('kakaocdn.net');
      if (!isBlob && !isCdn) return false;
      if (isCdn && (src.includes('thumbnail') || src.includes('cover') || src.includes('profile'))) return false;
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

// ── OCR ───────────────────────────────────────────────────────────────────────

async function ocrRegion(img, bbox) {
  // Fast path: draw the already-loaded DOM image directly.
  // blob: URLs (Kakao) are same-origin → never tainted.
  // CDN images without crossOrigin attr may taint the canvas → SecurityError.
  // In that case pass imageUrl to the background service worker, which can
  // fetch cross-origin freely and do the crop there.
  let dataUrl = null;
  try {
    dataUrl = _cropCanvas(img, bbox);
  } catch (e) {
    if (!(e instanceof DOMException) || e.name !== 'SecurityError') throw e;
  }

  const res = await sendToBackground({
    type: MSG.OCR_REGION,
    payload: { dataUrl, imageUrl: dataUrl ? null : img.src, bbox },
  });
  if (!res?.ok) throw new Error(res?.error || 'OCR failed');
  return res.text;
}

async function ocrRegionStitched(img, bbox, images) {
  const idx        = images.indexOf(img);
  const bottomEdge = bbox.y + bbox.h;  // may exceed 100 when user drags past image bottom
  const topEdge    = bbox.y;           // may be < 0 when user drags past image top
  const imgDispW   = img.getBoundingClientRect().width;
  const dispW      = (bbox.w / 100) * imgDispW;

  // Primary clip — clamp to valid image coordinates
  const primaryH = Math.min(bbox.h, 100 - Math.max(0, bbox.y));
  const primaryY = Math.max(0, bbox.y);
  const clips = [{ img, x: bbox.x, y: primaryY, w: bbox.w, h: Math.max(1, primaryH), dispW }];

  // Bottom cross-panel: only when user explicitly dragged past image boundary (bottomEdge > 100)
  if (bottomEdge > 100 && idx >= 0 && idx < images.length - 1) {
    const nextImg = images[idx + 1];
    if (nextImg.src && !nextImg.src.startsWith('data:')) {
      const nextDispW = (bbox.w / 100) * (nextImg.getBoundingClientRect().width || imgDispW);
      const overflow  = bottomEdge - 100;
      const grabH     = Math.max(overflow + 10, 40);
      clips.push({ img: nextImg, x: bbox.x, y: 0, w: bbox.w, h: Math.min(grabH, 60), dispW: nextDispW });
    }
  }

  // Top cross-panel: only when user explicitly dragged above image top (topEdge < 0)
  if (topEdge < 0 && idx > 0) {
    const prevImg = images[idx - 1];
    if (prevImg.src && !prevImg.src.startsWith('data:')) {
      const prevDispW = (bbox.w / 100) * (prevImg.getBoundingClientRect().width || imgDispW);
      const overflow  = -topEdge;
      const grabH     = Math.max(overflow + 10, 40);
      clips.unshift({ img: prevImg, x: bbox.x, y: Math.max(0, 100 - grabH), w: bbox.w, h: Math.min(grabH, 60), dispW: prevDispW });
    }
  }

  if (clips.length === 1) return ocrRegion(img, bbox);

  // Try client-side stitching (same-origin/blob images)
  const dataUrl = stitchClips(clips);
  if (dataUrl) {
    const res = await sendToBackground({
      type: MSG.OCR_REGION,
      payload: { dataUrl, imageUrl: null, bbox: { x: 0, y: 0, w: 100, h: 100 } },
    });
    if (!res?.ok) throw new Error(res?.error || 'OCR failed');
    return res.text;
  }

  // Cross-origin: send to background for fetch+stitch
  const bgClips = clips.map(({ img: i, x, y, w, h, dispW: dw }) => ({ imageUrl: i.src, bbox: { x, y, w, h }, dispW: dw }));
  const res = await sendToBackground({ type: MSG.OCR_STITCH, payload: { clips: bgClips } });
  if (!res?.ok) throw new Error(res?.error || 'OCR stitch failed');
  return res.text;
}

async function ocrClips(clips) {
  // clips from FixedOverlayLayer: {img, bbox: {x,y,w,h}}
  // Convert to internal {img, x, y, w, h, dispW} format
  const items = clips.map(c => {
    const r = c.img.getBoundingClientRect();
    return {
      img:   c.img,
      x:     c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h,
      dispW: (c.bbox.w / 100) * r.width,
    };
  });

  // Try client-side stitch first
  const dataUrl = stitchClips(items);
  if (dataUrl) {
    const res = await sendToBackground({
      type: MSG.OCR_REGION,
      payload: { dataUrl, imageUrl: null, bbox: { x: 0, y: 0, w: 100, h: 100 } },
    });
    if (!res?.ok) throw new Error(res?.error || 'OCR failed');
    return res.text;
  }
  // Cross-origin: background fetch+stitch
  const bgClips = items.map(({ img, x, y, w, h, dispW }) => ({ imageUrl: img.src, bbox: { x, y, w, h }, dispW }));
  const res = await sendToBackground({ type: MSG.OCR_STITCH, payload: { clips: bgClips } });
  if (!res?.ok) throw new Error(res?.error || 'OCR stitch failed');
  return res.text;
}

// Stitch multiple image clips vertically into one canvas.
// All clips are normalized to the SAME output pixel width (based on display width)
// so text from different panels renders at the same scale.
function stitchClips(clips) {
  try {
    const items = clips.map(({ img, x, y, w, h, dispW }) => {
      const px = (x / 100) * img.naturalWidth;
      const py = (y / 100) * img.naturalHeight;
      const pw = Math.max(1, (w / 100) * img.naturalWidth);
      const ph = Math.max(1, (h / 100) * img.naturalHeight);
      // dispW is the display-pixel width; use it to normalize scale
      const dw = dispW || pw;
      return { img, px, py, pw, ph, dw };
    });

    // Normalize: all clips rendered at TARGET_W pixels wide
    // Use the maximum display width, upscale to at least 600px for OCR quality
    const maxDispW = Math.max(...items.map(r => r.dw));
    const TARGET_W = Math.max(600, maxDispW * (maxDispW < 600 ? Math.min(3, 600 / maxDispW) : 1));

    // Compute output height for each clip proportional to its natural aspect
    const rows = items.map(({ img, px, py, pw, ph, dw }) => {
      const scale = TARGET_W / dw; // display→output scale
      // Output height = display height of clip * same scale
      const dispH = ph * (dw / pw); // display-pixel height of clip
      return { img, px, py, pw, ph, dw: Math.round(TARGET_W), dh: Math.round(dispH * scale) };
    });

    const totalH = rows.reduce((s, r) => s + r.dh, 0);
    const canvas  = document.createElement('canvas');
    canvas.width  = Math.round(TARGET_W);
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    let dy = 0;
    for (const { img, px, py, pw, ph, dw, dh } of rows) {
      ctx.drawImage(img, px, py, pw, ph, 0, dy, dw, dh);
      dy += dh;
    }
    return canvas.toDataURL('image/png');
  } catch {
    return null; // tainted canvas (cross-origin) → caller sends to background
  }
}

async function autoTranslate(text) {
  const s = await chrome.storage.local.get({
    'wt:translate-provider': 'google',
    'wt:translate-lang':     'vi',
    'wt:deepl-key':          '',
  });
  const provider   = s['wt:translate-provider'];
  const targetLang = s['wt:translate-lang'];
  if (provider === 'none') return null;

  if (provider === 'deepl') {
    const apiKey = s['wt:deepl-key'];
    if (!apiKey) throw new Error('DeepL API key not set — add it in Settings');
    const base = apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: targetLang.toUpperCase().replace('-', '_') }),
    });
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
    const data = await res.json();
    return data.translations[0].text;
  }

  // Google Translate (unofficial free endpoint)
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data[0].map(s => s[0]).join('');
}

function _cropCanvas(img, bbox) {
  const sx = (bbox.x / 100) * img.naturalWidth;
  const sy = (bbox.y / 100) * img.naturalHeight;
  const sw = Math.max(1, (bbox.w / 100) * img.naturalWidth);
  const sh = Math.max(1, (bbox.h / 100) * img.naturalHeight);
  const scale = sw < 400 ? Math.min(3, 400 / sw) : 1;
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png'); // throws SecurityError if canvas is tainted
}

function strokeTextShadow(color, width) {
  const shadows = [];
  const steps = Math.max(12, width * 6);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const x = +(width * Math.cos(a)).toFixed(2);
    const y = +(width * Math.sin(a)).toFixed(2);
    shadows.push(`${x}px ${y}px 0 ${color}`);
  }
  return shadows.join(',');
}

function detectBboxColors(imageEl, bbox) {
  try {
    const sx = (bbox.x / 100) * imageEl.naturalWidth;
    const sy = (bbox.y / 100) * imageEl.naturalHeight;
    const sw = Math.max(1, (bbox.w / 100) * imageEl.naturalWidth);
    const sh = Math.max(1, (bbox.h / 100) * imageEl.naturalHeight);
    const cw = Math.min(sw, 120), ch = Math.min(sh, 120);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(imageEl, sx, sy, sw, sh, 0, 0, cw, ch);
    const data = canvas.getContext('2d').getImageData(0, 0, cw, ch).data;

    let dark = { r: 0, g: 0, b: 0, n: 0 };
    let light = { r: 0, g: 0, b: 0, n: 0 };
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i+1], b = data[i+2];
      const lum = 0.2126 * r/255 + 0.7152 * g/255 + 0.0722 * b/255;
      if (lum < 0.45) { dark.r += r; dark.g += g; dark.b += b; dark.n++; }
      else             { light.r += r; light.g += g; light.b += b; light.n++; }
    }
    const avg = (c, n) => n ? '#' + [c.r, c.g, c.b].map(v => Math.round(v/n).toString(16).padStart(2,'0')).join('') : null;
    const darkHex  = avg(dark,  dark.n);
    const lightHex = avg(light, light.n);
    if (!darkHex && !lightHex) return null;
    // Decide which is text and which is bg: majority → bg, minority → text
    const textColor = dark.n <= light.n ? (darkHex || '#1a1a2e') : (lightHex || '#ffffff');
    const bgColor   = dark.n <= light.n ? (lightHex || '#ffffff') : (darkHex  || '#1a1a2e');
    return { textColor, bgColor };
  } catch (e) {
    return null; // canvas tainted (cross-origin image)
  }
}

// ── Translation visibility toggle ────────────────────────────────────────────
let _translationsVisible = true;

const EYE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SCAN_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>`;

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

function showToast(text, color = '#22c55e', duration = 3000) {
  const t = document.createElement('div');
  t.textContent = text;
  t.style.cssText = `position:fixed;bottom:84px;right:24px;z-index:99999;background:${color};color:#fff;padding:10px 18px;border-radius:8px;font-family:system-ui;font-size:14px;font-weight:500;pointer-events:none;`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── BomtoonAdapter ────────────────────────────────────────────────────────────
// https://www.bomtoon.com/viewer/{titleId}/{chapterId}

class BomtoonAdapter {
  detect() {
    return location.hostname === 'www.bomtoon.com' &&
           location.pathname.startsWith('/viewer/');
  }

  getChapterMeta() {
    const parts = location.pathname.split('/').filter(Boolean);
    // /viewer/{titleId}/{chapterId}
    const titleId   = parts[1] || 'unknown';
    const chapterId = parts[2] || 'unknown';
    return { site: 'bomtoon', titleId, chapterId };
  }

  getImages() {
    // Bomtoon renders panel images vertically; pick large images inside the viewer
    const MIN_W = 200;
    const viewer = document.querySelector('.viewer_wrap')
                || document.querySelector('.view_content')
                || document.querySelector('[class*="viewer"]')
                || document.querySelector('[class*="view"]')
                || document.body;
    return [...viewer.querySelectorAll('img')].filter(img => {
      const w = img.naturalWidth || img.offsetWidth || img.width;
      if (w < MIN_W) return false;
      const src = img.src || '';
      if (!src || src.startsWith('data:') || src.includes('logo') || src.includes('icon')) return false;
      return true;
    });
  }

  watchNewImages(callback) {
    const root = document.querySelector('.viewer_wrap')
              || document.querySelector('.view_content')
              || document.querySelector('[class*="viewer"]')
              || document.body;
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const imgs = this.getImages();
        if (imgs.length) callback(imgs);
      }, 150);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    return () => observer.disconnect();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const ADAPTERS = [new NaverAdapter(), new RidiAdapter(), new KakaoAdapter(), new BomtoonAdapter()];

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
  const fixedLayer  = isKakao
    ? new FixedOverlayLayer({ onSelect: handleBBoxSelect, getImages: () => images })
    : null;

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
    onEdit: async (ann) => {
      await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [ann] } });
      // Update in-memory list so a re-render reflects the change
      const idx = allAnnotations.findIndex(a =>
        `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` ===
        `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`
      );
      if (idx >= 0) allAnnotations[idx] = ann;
      // Refresh the bubble on the page
      const img = images[ann.imageIndex ?? 0];
      if (img) {
        if (isKakao) { fixedLayer.removeBubble(`${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`); fixedLayer.upsertBubble(img, ann); }
        else { renderer.upsertBubble(img, ann); }
      }
    },
    onDelete: async (ann) => {
      const annKey = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
      await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey } });
      if (isKakao) fixedLayer.removeBubble(annKey);
      else {
        const img = images[ann.imageIndex ?? 0];
        if (img) renderer.removeBubble(img, annKey);
        else document.querySelector(`[data-ann-key="${annKey}"]`)?.remove();
      }
      allAnnotations  = allAnnotations.filter(a =>
        `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` !== annKey
      );
      annotationCount = allAnnotations.length;
      panel.update(allAnnotations);
      updateProgressBar();
    },
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
      // annKey is derived from bbox x/y — moving the bubble changes the key,
      // so drop the record stored under the old key or it duplicates on reload
      const newKey = `${updated.imageHash}::${updated.bbox.x.toFixed(1)}::${updated.bbox.y.toFixed(1)}`;
      if (newKey !== annKey) {
        await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey } });
        bubble.dataset.annKey = newKey;
        // Keep renderer state map in sync so removeBubble/upsertBubble work on the new key
        const rendState = renderer.imageState.get(img);
        if (rendState) {
          rendState.bubbles.delete(annKey);
          rendState.bubbles.set(newKey, bubble);
        }
      }
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

  const dialog      = new InputDialog({ onDelete: () => {} });
  const quickDialog = new QuickTranslateDialog();

  let currentMode     = MODES.READ;
  let readScanEnabled = false;
  let images          = [];
  let annotationCount = 0;
  let disposed        = false;

  // Build floating toggle button (Read mode only)
  const toggleBtn = buildToggleButton();

  // Build floating scan button (Read mode only)
  const scanBtn = document.createElement('button');
  scanBtn.id = 'wt-scan-btn';
  scanBtn.title = 'Quick OCR translate';
  scanBtn.setAttribute('aria-label', 'Toggle quick OCR translate');
  scanBtn.innerHTML = SCAN_ICON;
  document.body.appendChild(scanBtn);

  function setReadScan(on) {
    readScanEnabled = on;
    scanBtn.classList.toggle('wt-scan-active', on);
    scanBtn.title = on ? 'Stop scanning' : 'Quick OCR translate';
    if (on) {
      if (isKakao) fixedLayer.enable(images);
      else selector.enable(images);
    } else {
      if (isKakao) fixedLayer.disable();
      else selector.disable();
    }
  }
  scanBtn.addEventListener('click', () => setReadScan(!readScanEnabled));

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
    if (disposed) return;
    if (!chrome.runtime?.id) return; // extension reloaded — silently stop
    const { annotations } = await sendToBackground({ type: MSG.LOAD_TRANSLATIONS, payload: meta });
    if (disposed) return;
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
    // Re-derive imageIndex from the sorted images array so panel numbers in the
    // sidebar always reflect true visual scroll order, even for old annotations.
    const hashToIndex = new Map();
    for (let i = 0; i < images.length; i++) {
      const h = await hashImage(images[i]);
      hashToIndex.set(h, i);
      const anns = byHash.get(h) || [];
      for (const ann of anns) ann.imageIndex = i; // patch in-memory; storage updated lazily
      if (isKakao) {
        for (const ann of anns) fixedLayer.upsertBubble(images[i], ann);
      } else {
        renderer.renderForImage(images[i], anns);
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
    if (disposed) return;
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
    // Merge then sort by DOM position so imageIndex matches visual scroll order
    // even when lazy-loaded images arrive out of sequence.
    images = [...images, ...added].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    if (currentMode === MODES.ANNOTATE) {
      if (isKakao) fixedLayer.enable(images);
      else added.forEach(img => selector.attachImage(img, images.indexOf(img)));
    }
    try {
      await loadAndRender();
    } catch (e) {
      if (!chrome.runtime?.id) { stopWatching(); return; }
      throw e;
    }
    updateProgressBar();
  });

  // ── bbox select handler ────────────────────────────────────────────────

  const selector = new BBoxSelector({ onSelect: handleBBoxSelect });

  async function handleBBoxSelect({ bbox, imageEl, imageIndex, clips }) {
    if (currentMode === MODES.READ) {
      await handleReadBBoxSelect({ bbox, imageEl, imageIndex, clips });
    } else {
      await handleAnnotateBBoxSelect({ bbox, imageEl, imageIndex, clips });
    }
  }

  // Read mode: OCR → auto-translate → minimal dialog (no styling)
  async function handleReadBBoxSelect({ bbox, imageEl, imageIndex, clips }) {
    const rect = imageEl.getBoundingClientRect();
    const screenPos = {
      x: rect.left + window.scrollX + (bbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (bbox.y / 100) * rect.height,
    };
    const resultPromise = quickDialog.show(screenPos);

    quickDialog.setStatus('⏳ Scanning text…', '#6366f1');
    let ocrText = '';
    try {
      ocrText = clips ? await ocrClips(clips) : await ocrRegionStitched(imageEl, bbox, images);
      if (ocrText) {
        quickDialog.setOriginalText(ocrText);
        quickDialog.setStatus('⏳ Translating…', '#6366f1');
        try {
          const translated = await autoTranslate(ocrText);
          if (translated) {
            quickDialog.setTranslated(translated);
          } else {
            // Provider is "none" — just pre-fill with OCR text
            quickDialog.setTranslated(ocrText);
            quickDialog.setStatus('Translation disabled — edit if needed', '#94a3b8');
          }
        } catch (err) {
          quickDialog.setTranslated(ocrText);
          quickDialog.setStatus(`⚠ Translation failed: ${err.message}`, '#f59e0b');
        }
      } else {
        quickDialog.setStatus('No text found in this region', '#94a3b8');
      }
    } catch (err) {
      quickDialog.setStatus(`✗ OCR failed: ${err.message}`, '#ef4444');
    }

    const result = await resultPromise;
    if (!result) return;

    const imageHash  = await hashImage(imageEl);
    const annotation = {
      imageHash, imageIndex, bbox,
      originalText:   quickDialog.getOriginalText(),
      translatedText: result.translatedText,
      style: { fontSize: 20, bold: false, italic: false, color: '#1a1a2e', bg: '#ffffff', noBg: false, stroke: false, strokeColor: '#ffffff', strokeWidth: 1, fontFamily: '' },
      language: 'vi', createdAt: new Date().toISOString(),
    };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });
    _upsertAnnotation(annotation);
    if (isKakao) fixedLayer.upsertBubble(imageEl, annotation);
    else renderer.upsertBubble(imageEl, annotation);
    updateProgressBar();
  }

  // Annotate mode: full dialog with style options
  async function handleAnnotateBBoxSelect({ bbox, imageEl, imageIndex, clips }) {
    const rect = imageEl.getBoundingClientRect();
    const screenPos = {
      x: rect.left + window.scrollX + (bbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (bbox.y / 100) * rect.height,
    };
    const colors    = detectBboxColors(imageEl, bbox);
    const colorStyle = colors ? { color: colors.textColor, bg: colors.bgColor, noBg: false } : {};
    // Hash early so preview callback can use it immediately
    const imageHash = await hashImage(imageEl);
    let tmpAnnKey = null;
    const resultPromise = dialog.show(screenPos, {
      style: colorStyle,
      onPreview: (text, style) => {
        const tmpAnn = { imageHash, imageIndex, bbox, originalText: '', translatedText: text || ' ', style, language: 'vi', createdAt: new Date().toISOString() };
        tmpAnnKey = `${imageHash}::${bbox.x.toFixed(1)}::${bbox.y.toFixed(1)}`;
        if (isKakao) fixedLayer.upsertBubble(imageEl, tmpAnn);
        else renderer.upsertBubble(imageEl, tmpAnn);
      },
      onCancel: () => {
        if (tmpAnnKey) {
          if (isKakao) fixedLayer.removeBubble(tmpAnnKey);
          else renderer.removeBubble(imageEl, tmpAnnKey);
        }
      },
    });
    const ocrSession = dialog.setOcrPending();
    clips ? ocrClips(clips) : ocrRegionStitched(imageEl, bbox, images)
      .then(text => dialog.setOcrText(text, ocrSession))
      .catch(err => dialog.setOcrError(err.message, ocrSession));
    const result = await resultPromise;
    if (!result) return;

    const annotation = {
      imageHash, imageIndex, bbox: result.resizedBbox || bbox,
      originalText: result.originalText, translatedText: result.translatedText,
      style: result.style, language: 'vi', createdAt: new Date().toISOString(),
    };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });
    _upsertAnnotation(annotation);
    if (isKakao) fixedLayer.upsertBubble(imageEl, annotation);
    else renderer.upsertBubble(imageEl, annotation);
    panel.update(allAnnotations);
    updateProgressBar();
  }

  function _upsertAnnotation(annotation) {
    const newKey = `${annotation.imageHash}::${annotation.bbox.x.toFixed(1)}::${annotation.bbox.y.toFixed(1)}`;
    const existsIdx = allAnnotations.findIndex(a =>
      `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === newKey
    );
    if (existsIdx >= 0) allAnnotations[existsIdx] = annotation;
    else { allAnnotations.push(annotation); annotationCount++; }
  }

  // ── click bubble to edit ───────────────────────────────────────────────

  document.addEventListener('click', async (e) => {
    if (currentMode !== MODES.ANNOTATE) return;
    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) return;
    // If the user just finished a drag/resize, suppress the click-to-edit dialog
    if (bubbleEditor.consumeDrag()) return;
    e.stopPropagation();

    const wrapper = bubble.closest('.wt-img-wrapper');
    let img = wrapper?.querySelector('img');
    // Kakao fixed bubbles live in body — resolve their image via the layer's map
    if (!img && isKakao) img = fixedLayer.getBubbleImage(bubble.dataset.annKey);
    if (!img) return;
    if (!isKakao) bubbleEditor.attach(bubble, img); // drag/resize editor is Naver-only
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

    const originalAnnotation = existing ? { ...existing } : null;
    const result = await dialog.show(screenPos, {
      originalText:   existing?.originalText   || '',
      translatedText: existing?.translatedText || bubble.querySelector('span')?.textContent || '',
      style:          existing?.style          || {},
      bbox:           existingBbox,
      img,
      onPreview: (text, style) => {
        const previewAnn = { ...(existing || {}), imageHash: imgHash, imageIndex: imgIndex, bbox: existingBbox, originalText: existing?.originalText || '', translatedText: text || ' ', style, language: 'vi', createdAt: existing?.createdAt || new Date().toISOString() };
        if (isKakao) fixedLayer.upsertBubble(img, previewAnn);
        else renderer.upsertBubble(img, previewAnn);
      },
      onCancel: () => {
        // Restore original bubble
        if (originalAnnotation) {
          if (isKakao) fixedLayer.upsertBubble(img, originalAnnotation);
          else renderer.upsertBubble(img, originalAnnotation);
        }
      },
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

    // annKey is derived from imageHash + bbox x/y — if the edit changed either,
    // the save above created a NEW record; remove the old one or it duplicates
    const savedKey = `${annotation.imageHash}::${annotation.bbox.x.toFixed(1)}::${annotation.bbox.y.toFixed(1)}`;
    if (savedKey !== annKeyToDelete) {
      await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey: annKeyToDelete } });
      if (isKakao) fixedLayer.removeBubble(annKeyToDelete);
      else renderer.removeBubble(img, annKeyToDelete);
    } else if (result.resizedBbox) {
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

  // ── double-click bubble to edit in Read mode ───────────────────────────

  document.addEventListener('dblclick', async (e) => {
    if (currentMode !== MODES.READ) return;
    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) return;
    e.stopPropagation();
    e.preventDefault();

    const annKeyToEdit = bubble.dataset.annKey;
    const wrapper = bubble.closest('.wt-img-wrapper');
    let img = wrapper?.querySelector('img');
    if (!img && isKakao) img = fixedLayer.getBubbleImage(annKeyToEdit);
    if (!img) return;
    const imgIndex = images.indexOf(img);

    const existingBbox = {
      x: parseFloat(bubble.dataset.bboxX), y: parseFloat(bubble.dataset.bboxY),
      w: parseFloat(bubble.dataset.bboxW), h: parseFloat(bubble.dataset.bboxH),
    };
    const existing = allAnnotations.find(a =>
      `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}` === annKeyToEdit
    );

    const rect = img.getBoundingClientRect();
    const bubbleRight = rect.left + window.scrollX + ((existingBbox.x + existingBbox.w) / 100) * rect.width;
    const bubbleLeft  = rect.left + window.scrollX + (existingBbox.x / 100) * rect.width;
    const bubbleTop   = rect.top  + window.scrollY + (existingBbox.y / 100) * rect.height;
    const spaceRight  = window.scrollX + window.innerWidth - bubbleRight - 24;
    const screenPos   = {
      x: spaceRight >= 280 ? bubbleRight + 8 : bubbleLeft - 288,
      y: bubbleTop,
    };

    const result = await quickDialog.show(screenPos, {
      originalText:   existing?.originalText   || '',
      translatedText: existing?.translatedText || bubble.querySelector('span')?.textContent || '',
    });
    if (!result) return;

    const imgHash  = await hashImage(img);
    const annotation = {
      ...(existing || {}),
      imageHash: imgHash, imageIndex: imgIndex, bbox: existingBbox,
      originalText:   existing?.originalText || '',
      translatedText: result.translatedText,
      style:          existing?.style || { fontSize: 20, bold: false, italic: false, color: '#1a1a2e', bg: '#ffffff', noBg: false, stroke: false, strokeColor: '#ffffff', strokeWidth: 1, fontFamily: '' },
      language:       existing?.language || 'vi',
      createdAt:      existing?.createdAt || new Date().toISOString(),
    };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });
    _upsertAnnotation(annotation);
    if (isKakao) fixedLayer.upsertBubble(img, annotation);
    else renderer.upsertBubble(img, annotation);
  });

  // Reposition fixed bubbles on scroll (Kakao uses position:absolute relative to page)
  if (isKakao) {
    // capture:true also catches scrolls from inner scroll containers (scroll doesn't bubble)
    document.addEventListener('scroll', () => fixedLayer?.repositionAll(), { passive: true, capture: true });
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
        // Turn off read scan before entering annotate mode
        setReadScan(false);
        scanBtn.style.display = 'none';
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
        scanBtn.style.display = '';
        panel.hide();
      }
    }
    // Translation list + Export are translator tools — ignored in Read mode.
    // Import/Clear work in any mode so readers can use their own local files.
    if (message.type === 'TOGGLE_PANEL' && currentMode === MODES.ANNOTATE) {
      panel.setImages(images);
      panel.update(allAnnotations);
      panel.toggle();
    }
    if (message.type === 'TRIGGER_EXPORT' && currentMode === MODES.ANNOTATE) triggerExport(meta);
    if (message.type === 'TRIGGER_IMPORT') triggerImport();
    if (message.type === 'TRIGGER_CLEAR')  triggerClear();
    if (message.type === 'OCR_STATUS')     dialog.setOcrStatus(message.payload);
    if (message.type === 'SYNC_STATUS') {
      if (message.status === 'saved')    showToast('☁ Synced', '#6366f1', 2000);
      else if (message.status === 'imported') showToast(`☁ Synced ${message.error || ''} translations`, '#6366f1', 3000);
      else if (message.status === 'deleted') { /* silent */ }
      else if (message.status === 'error')   showToast(`⚠ Sync failed: ${message.error || 'unknown error'}`, '#f59e0b', 5000);
    }
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

  async function triggerClear() {
    const count = allAnnotations.length;
    if (!count) { showToast('Nothing to clear for this chapter.', '#f59e0b'); return; }
    if (!window.confirm(`Delete all ${count} translation${count !== 1 ? 's' : ''} stored for this chapter on this device? This cannot be undone.`)) return;
    try {
      await sendToBackground({ type: MSG.CLEAR_CHAPTER, payload: meta });
      if (isKakao) fixedLayer.clearAll();
      else renderer.clearAll();
      allAnnotations  = [];
      annotationCount = 0;
      panel.update(allAnnotations);
      updateProgressBar();
      showToast('✓ Cleared all translations for this chapter.');
    } catch (err) {
      showToast(`✗ Clear failed: ${err.message}`, '#ef4444');
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
    disposed = true;
    stopWatching();
    urlObserver.disconnect();
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    if (isKakao) { fixedLayer.disable(); fixedLayer.clearAll(); }
    else selector.disable();
    renderer.clearAll();
    bubbleEditor.detach();
    toggleBtn.remove();
    scanBtn.remove();
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
