(function () {
'use strict';

// ── constants ────────────────────────────────────────────────────────────────

// Dev-only build flag — gates the Translation List side panel (original +
// translated text inspector), used while testing the difficulty classifier
// and story-context features. `npm run build` (scripts/build.js) rewrites
// this to `false` for production output and strips the __DEV_TOOLS_BLOCK__
// sections below entirely; `npm run dev` ships this file as-is (flag stays
// true). Must stay in sync with the same-named flag in popup/popup.js.
const __DEV_TOOLS__ = true;

const SITES = { NAVER: 'naver', RIDI: 'ridi', KAKAO: 'kakao' };
const MSG    = {
  SAVE_TRANSLATIONS: 'SAVE_TRANSLATIONS',
  LOAD_TRANSLATIONS: 'LOAD_TRANSLATIONS',
  DELETE_ANNOTATION: 'DELETE_ANNOTATION',
  CLEAR_CHAPTER:     'CLEAR_CHAPTER',
  OCR_REGION:        'OCR_REGION',
  OCR_STITCH:        'OCR_STITCH',
  GET_STORAGE_USAGE: 'GET_STORAGE_USAGE',
  CROP_IMAGE:        'CROP_IMAGE',
  DETECT_BUBBLES:    'DETECT_BUBBLES',
};

// Background opacity for the translation caption box — a fully-opaque overlay
// hides the original art entirely (no way to compare against source text or
// catch a bad OCR/translation). Needs visual tuning against real panels: light
// backgrounds vs. dark/stylized-text panels (e.g. colored SFX) may want
// different values; hold-to-peek is the primary fix for the latter case.
const OVERLAY_BG_OPACITY = 0.88;

/** '#rrggbb' (or '#rgb') -> 'rgba(r, g, b, alpha)'. Non-hex input passes through unchanged. */
function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return hex;
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Auto-fit text sizing ─────────────────────────────────────────────────────
// The overlay box comes from the ORIGINAL text's OCR bbox, but Vietnamese
// translations usually run longer in character count than the Korean source
// for the same meaning — using a fixed font size overflows the box. This
// finds the largest font size that lets the (already-translated) text wrap
// to fit the box, with a readability floor, and a box-height-expansion
// fallback (capped) for text that still doesn't fit at the floor. Sizing
// only — does not touch font-family/weight/style, which stay whatever the
// bubble's own `style` says (out of scope here, see the task that added
// auto color-matching for that).
//
// Overlay text is rendered as real DOM/CSS (a <span class="wt-bubble-text">
// with an inline font-size), not drawn on a canvas — see OverlayRenderer/
// FixedOverlayLayer._createBubble. Measurement still uses canvas
// measureText() (the standard technique for this even when the final
// render is DOM) so the wrap/fit math has a real width to work from before
// the span exists in the document.

const AUTO_FIT_MAX_FONT_SIZE   = 20;   // search seed — the app's prior fixed default; NOT a hard ceiling, see fitTextToBox's dynamicMax
const AUTO_FIT_ABSOLUTE_MAX_FONT_SIZE = 48; // sane ceiling so a short line in a huge bubble can't blow up to an absurd size; needs visual tuning
const AUTO_FIT_MIN_FONT_SIZE   = 13;   // absolute floor — readability wins over fitting; needs visual tuning against real panels
const AUTO_FIT_LINE_HEIGHT     = 1.45; // matches .wt-bubble-text's CSS line-height — kept for reference/docs only; measurement below reads it from real CSS, doesn't assume it
const AUTO_FIT_MAX_EXPAND_RATIO         = 2.5; // height fallback never grows the box past this multiple of its original bbox height
const AUTO_FIT_MAX_EXPAND_VIEWPORT_FRAC = 0.5; // ...or this fraction of the viewport height, whichever is smaller
// The OCR bbox is the RECTANGLE circumscribing an (often oval/round) bubble —
// an oval only touches its bounding rect at each edge's midpoint, not at the
// corners, so fitting text to the raw bbox pushes the visible caption box out
// toward those corners, past the bubble's real edge. These margins are a
// pragmatic width/height shrink applied before fitting, not real ellipse
// geometry — both need visual tuning against a range of real bubble shapes.
const AUTO_FIT_WIDTH_MARGIN  = 0.82;
const AUTO_FIT_HEIGHT_MARGIN = 0.92;

// Fitting is measured with a hidden, off-screen element carrying the EXACT
// same class (.wt-bubble-text) and CSS (padding, line-height, word-break,
// white-space, box-sizing) the real bubble text renders with — not canvas
// measureText(). A canvas approximation can silently diverge from the real
// render (an unavailable font in the stack falling back differently, CSS
// letter/word-spacing canvas doesn't know about, etc.), which showed up as
// translated text visibly overflowing its box even though the fit search
// "passed" — using the actual browser layout engine for both the search and
// the final render eliminates that class of mismatch by construction.
let _autoFitMeasureEl = null;
function _getAutoFitMeasureEl() {
  if (!_autoFitMeasureEl) {
    // .wt-bubble-text itself declares no font-family/line-height — it
    // inherits both from its real parent, .wt-translation-bubble. Nesting
    // the measurement element the same way (instead of a bare .wt-bubble-text
    // with no ancestor) is required for accurate measurement — a bare one
    // would silently fall back to the page's own default font/line-height,
    // which is exactly the kind of measurement-vs-render mismatch this
    // whole DOM-based approach exists to eliminate.
    const wrap = document.createElement('div');
    wrap.className = 'wt-translation-bubble';
    wrap.style.cssText = 'position:fixed; left:-99999px; top:0; visibility:hidden; display:block; width:auto; height:auto; animation:none;';
    _autoFitMeasureEl = document.createElement('span');
    _autoFitMeasureEl.className = 'wt-bubble-text';
    _autoFitMeasureEl.style.height   = 'auto';
    _autoFitMeasureEl.style.maxWidth = 'none'; // override .wt-bubble-text's max-width:100% — no real bbox-sized parent here
    wrap.appendChild(_autoFitMeasureEl);
    document.body.appendChild(wrap);
  }
  return _autoFitMeasureEl;
}

/** Real wrapped outer height (border-box, padding included) of `text` at `fontSizePx` constrained to `boxWidthPx`. */
function measureBubbleTextHeight(text, boxWidthPx, fontSizePx, { fontFamily, bold, italic } = {}) {
  const el = _getAutoFitMeasureEl();
  el.style.width      = `${boxWidthPx}px`;
  el.style.fontSize   = `${fontSizePx}px`;
  el.style.fontWeight = bold   ? 'bold'   : 'normal';
  el.style.fontStyle  = italic ? 'italic' : 'normal';
  el.style.fontFamily = fontFamily ? `'${fontFamily}', system-ui, sans-serif` : '';
  el.textContent = text;
  return el.scrollHeight;
}

/**
 * Binary-searches the largest font size for which `text`, wrapped to
 * boxWidthPx (real DOM layout, not an approximation), fits within
 * boxHeightPx. The search's upper bound scales with the box's own height
 * (see dynamicMax below) instead of being hard-capped at
 * AUTO_FIT_MAX_FONT_SIZE — a large bubble with short text should be able to
 * render well past the app's old fixed default. AUTO_FIT_MAX_FONT_SIZE is
 * used only as a search-efficiency seed. Returns { fontSize, totalTextHeight,
 * overflow } — overflow is true when even AUTO_FIT_MIN_FONT_SIZE doesn't fit
 * (caller applies the height-expansion / clip fallback).
 */
function fitTextToBox(text, boxWidthPx, boxHeightPx, styleOpts = {}) {
  const measureAt = (fontSizePx) => {
    const totalTextHeight = measureBubbleTextHeight(text, boxWidthPx, fontSizePx, styleOpts);
    return { fontSize: fontSizePx, totalTextHeight, fits: totalTextHeight <= boxHeightPx };
  };

  const atFloor = measureAt(AUTO_FIT_MIN_FONT_SIZE);
  if (!atFloor.fits) return { ...atFloor, overflow: true };

  // boxHeightPx / line-height is the biggest a single line could be and still
  // fit vertically — a cheap proxy for "how large could this box's text
  // plausibly get", clamped so it never shrinks below the old fixed default
  // (small/normal boxes behave exactly as before) and never exceeds the
  // absolute sanity ceiling (huge boxes don't blow up unreasonably).
  const dynamicMax = Math.min(
    AUTO_FIT_ABSOLUTE_MAX_FONT_SIZE,
    Math.max(AUTO_FIT_MAX_FONT_SIZE, Math.floor(boxHeightPx / AUTO_FIT_LINE_HEIGHT))
  );

  const seedSize = Math.min(AUTO_FIT_MAX_FONT_SIZE, dynamicMax);
  const atSeed = seedSize === AUTO_FIT_MIN_FONT_SIZE ? atFloor : measureAt(seedSize);

  let lo, hi, best;
  if (atSeed.fits) {
    lo = atSeed.fontSize; hi = dynamicMax; best = atSeed;
  } else {
    lo = AUTO_FIT_MIN_FONT_SIZE; hi = atSeed.fontSize - 1; best = atFloor;
  }

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const r = measureAt(mid);
    if (r.fits) { lo = mid; best = r; } else { hi = mid - 1; }
  }
  return { ...best, overflow: false };
}

/**
 * fitTextToBox() plus a box-height-expansion fallback of LAST RESORT: grows
 * the box's height (never its width — webtoons read vertically, so vertical
 * growth is less disruptive) only when the text doesn't fit even at
 * AUTO_FIT_MIN_FONT_SIZE within the ORIGINAL box (primary.overflow) — i.e.
 * the bbox is genuinely too small for the translation, not merely "could
 * look more comfortable at a bigger size". A grown box is a plain taller
 * rectangle, not the bubble's real (often oval) outline, so it visibly
 * spills past the drawn speech bubble — worth it when there's truly no
 * smaller font left to try, not worth risking otherwise. Whenever the text
 * fits within the original box at ANY size down to the floor, that's used
 * as-is, even if cramped — a legible, in-bounds caption beats a bigger font
 * that overflows the bubble. If even the capped expanded height isn't
 * enough, returns clipped: true so the caller can render a "show more"
 * affordance instead of silently cutting text.
 */
function fitAndExpand(text, boxWidthPx, boxHeightPx, styleOpts) {
  const primary = fitTextToBox(text, boxWidthPx, boxHeightPx, styleOpts);
  if (!primary.overflow) {
    return { fontSize: primary.fontSize, boxHeightPx, clipped: false };
  }

  const maxExpandedH = Math.min(
    boxHeightPx * AUTO_FIT_MAX_EXPAND_RATIO,
    window.innerHeight * AUTO_FIT_MAX_EXPAND_VIEWPORT_FRAC
  );
  if (maxExpandedH <= boxHeightPx) {
    return { fontSize: AUTO_FIT_MIN_FONT_SIZE, boxHeightPx, clipped: true };
  }

  const expanded = fitTextToBox(text, boxWidthPx, maxExpandedH, styleOpts);
  if (!expanded.overflow) {
    // Grow only as much as this font size actually needs, not the full cap.
    // totalTextHeight is already the full border-box height (real DOM
    // measurement, padding included) — no manual padding add-back needed.
    const neededH = Math.max(boxHeightPx, expanded.totalTextHeight);
    return { fontSize: expanded.fontSize, boxHeightPx: Math.min(neededH, maxExpandedH), clipped: false };
  }
  return { fontSize: AUTO_FIT_MIN_FONT_SIZE, boxHeightPx: maxExpandedH, clipped: true };
}

/**
 * Runs fitAndExpand() for a bubble's translated text against its pixel box
 * size, applies the resulting font-size to the outer bubble `b`, and — when
 * even the capped height-expansion fallback isn't enough — clips the inner
 * text span and adds a small toggle button so the full translation is still
 * reachable (secondary fallback from the auto-fit spec; no special
 * animation, just visibility on demand). Returns the (possibly expanded) box
 * height in px for the caller's _positionBubble to use as its height.
 *
 * `applyMargin` (default true) shrinks boxWidthPx/boxHeightPx by
 * AUTO_FIT_WIDTH_MARGIN/AUTO_FIT_HEIGHT_MARGIN first, since the raw box is
 * the OCR bbox's circumscribing rectangle, not the bubble's actual — often
 * oval — outline. Pass false when the box isn't an oval-bubble overlay at
 * all (side-by-side mode's caption renders as a plain rectangle in open page
 * margin, not on top of any bubble shape, so that margin has no meaning
 * there and would just needlessly shrink the box).
 */
function applyAutoFit(b, span, ann, boxWidthPx, boxHeightPx, applyMargin = true) {
  const s = ann.style || {};
  const fit = fitAndExpand(
    ann.translatedText || '',
    applyMargin ? boxWidthPx  * AUTO_FIT_WIDTH_MARGIN  : boxWidthPx,
    applyMargin ? boxHeightPx * AUTO_FIT_HEIGHT_MARGIN : boxHeightPx,
    { fontFamily: s.fontFamily, bold: s.bold, italic: s.italic }
  );
  b.style.fontSize = `${fit.fontSize}px`;

  b.querySelector('.wt-bubble-expand-toggle')?.remove();
  b.classList.remove('wt-bubble-clipped', 'wt-bubble-expanded');
  span.style.maxHeight = '';
  span.style.overflow  = '';

  if (fit.clipped) {
    // span has box-sizing:border-box, so max-height applies to the same
    // border-box (padding-included) height fit.boxHeightPx already is —
    // no manual padding subtraction needed.
    const capPx = fit.boxHeightPx;
    b.classList.add('wt-bubble-clipped');
    span.style.maxHeight = `${capPx}px`;
    span.style.overflow  = 'hidden';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wt-bubble-expand-toggle';
    toggle.title = 'View full translation';
    toggle.textContent = '⋯';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = b.classList.toggle('wt-bubble-expanded');
      span.style.maxHeight = expanded ? '' : `${capPx}px`;
      span.style.overflow  = expanded ? '' : 'hidden';
    });
    b.appendChild(toggle);
  }

  return fit.boxHeightPx;
}

// ── Auto color-matching (best-effort) ─────────────────────────────────────────
// Detects a dominant background color + a contrasting text color from the
// original bbox region, so the translation overlay blends in instead of
// looking like a foreign UI element. Works well for solid-bg + solid-text
// dialogue bubbles; deliberately does NOT try to handle gradient text, stroke-
// outlined text in a different color than fill, or busy/textured art — the
// confidence checks below are tuned to bail out (falling back to the default
// style) rather than guess wrong in those cases.

const COLOR_QUANTIZE_STEP    = 24;   // round each RGB channel to the nearest N — buckets away JPEG noise; tune against real panels
const COLOR_MIN_BUCKET_SHARE = 0.03; // ignore color buckets under this fraction of sampled pixels (noise)
const COLOR_CONFIDENCE_GAP   = 0.18; // top bg bucket must beat the runner-up by at least this fraction of its own count, else "too close to call"
const COLOR_MIN_TEXT_CONTRAST = 80;  // min Euclidean RGB distance a candidate text color needs vs. the detected background
// bbox is a RECTANGLE bounding the (often oval/irregular) bubble shape, so its
// corners can fall outside the bubble entirely, sampling whatever busy art
// sits behind it there. Shrinking the sampled rect inward keeps the sample
// concentrated on the bubble's interior instead — needs tuning against real
// panels (rounder bubbles need a bigger inset than near-rectangular ones).
const COLOR_SAMPLE_INSET_FRAC = 0.15;

/**
 * Samples the bbox region of `img` and returns { bg, color } hex strings, or
 * null if detection isn't confident enough (caller should fall back to the
 * default style). Never throws.
 */
async function detectBubbleColors(img, bbox) {
  const nw = img.naturalWidth  || img.width  || img.offsetWidth  || 1;
  const nh = img.naturalHeight || img.height || img.offsetHeight || 1;
  const fullX = (bbox.x / 100) * nw, fullY = (bbox.y / 100) * nh;
  const fullW = (bbox.w / 100) * nw, fullH = (bbox.h / 100) * nh;
  // Shrink the sample rect inward — see COLOR_SAMPLE_INSET_FRAC.
  const insetW = fullW * COLOR_SAMPLE_INSET_FRAC, insetH = fullH * COLOR_SAMPLE_INSET_FRAC;
  const sx = Math.max(0, fullX + insetW);
  const sy = Math.max(0, fullY + insetH);
  const sw = Math.max(1, Math.min(fullW - insetW * 2, nw - sx));
  const sh = Math.max(1, Math.min(fullH - insetH * 2, nh - sy));
  // Coarse sample — this is a rough color estimate, not a pixel-perfect one.
  const cw = Math.min(sw, 160), ch = Math.min(sh, 160);

  let data;
  try {
    data = _readColorSamplePixels(img, sx, sy, sw, sh, cw, ch);
  } catch (e) {
    // Cross-origin image without CORS headers taints the canvas — same issue
    // BubbleAutoDetector hits, same fix: fetch+crop via the background worker
    // (no taint there) and sample from the returned same-origin data: image.
    try {
      const bboxPct = { x: (sx / nw) * 100, y: (sy / nh) * 100, w: (sw / nw) * 100, h: (sh / nh) * 100 };
      const res = await sendToBackground({ type: MSG.CROP_IMAGE, payload: { imageUrl: img.src, bbox: bboxPct } });
      if (!res?.ok || !res.dataUrl) throw new Error(res?.error || 'background crop failed');
      const cropImg = await loadImage(res.dataUrl);
      data = _readColorSamplePixels(cropImg, 0, 0, cw, ch, cw, ch);
    } catch (e2) {
      console.log('[WebtoonTranslate] ColorMatch fail: canvas-tainted', e2.message);
      return null;
    }
  }

  const result = _analyzeColorHistogram(data);
  console.log(result ? '[WebtoonTranslate] ColorMatch pass' : '[WebtoonTranslate] ColorMatch fail: low-confidence', result || '');
  return result;
}

function _readColorSamplePixels(img, sx, sy, sw, sh, cw, ch) {
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch).data; // throws SecurityError if tainted
}

/** Quantized-color histogram -> { bg, color } hex, or null if not confident enough. */
function _analyzeColorHistogram(data) {
  // Bucket by rounded RGB, but keep the un-quantized sums so each bucket's
  // reported color is the true average of its members (not the rounded key).
  const buckets = new Map();
  let totalPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = `${Math.round(r / COLOR_QUANTIZE_STEP)},${Math.round(g / COLOR_QUANTIZE_STEP)},${Math.round(b / COLOR_QUANTIZE_STEP)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { r: 0, g: 0, b: 0, count: 0 }; buckets.set(key, bucket); }
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.count++;
    totalPixels++;
  }
  if (!totalPixels) return null;

  const sorted = [...buckets.values()]
    .map(b => ({ r: Math.round(b.r / b.count), g: Math.round(b.g / b.count), b: Math.round(b.b / b.count), count: b.count }))
    .filter(b => b.count / totalPixels >= COLOR_MIN_BUCKET_SHARE)
    .sort((a, b) => b.count - a.count);
  if (!sorted.length) return null;

  const bg = sorted[0];
  if (sorted.length > 1) {
    const gap = (bg.count - sorted[1].count) / bg.count;
    if (gap < COLOR_CONFIDENCE_GAP) return null; // ambiguous majority — likely textured/busy background
  }

  // Text color candidate: the most-contrasting remaining bucket against bg.
  let textCandidate = null, bestDist = 0;
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i];
    const dist = Math.hypot(c.r - bg.r, c.g - bg.g, c.b - bg.b);
    if (dist > bestDist) { bestDist = dist; textCandidate = c; }
  }
  if (!textCandidate || bestDist < COLOR_MIN_TEXT_CONTRAST) return null; // no confidently-contrasting text color

  const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return {
    bg:    `#${toHex(bg.r)}${toHex(bg.g)}${toHex(bg.b)}`,
    color: `#${toHex(textCandidate.r)}${toHex(textCandidate.g)}${toHex(textCandidate.b)}`,
  };
}

// ── hasher ───────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 64 * 1024;

async function hashImage(img) {
  if (img.__wtHash) return img.__wtHash;
  // Non-img elements (e.g., Bomtoon canvas containers) carry .src set by the adapter
  const src = img.src || img.dataset.src || '';
  if (!src.startsWith('http') && !src.startsWith('blob:') && src) {
    img.__wtHash = `bomtoon:${src}`;
    return img.__wtHash;
  }

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
  if (img.src.includes('pstatic.net') || img.src.includes('balcony.studio') || img.src.includes('bomtoon')) {
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
  constructor({ onSelect, onClick, getImages, onReload }) {
    this._onSelect  = onSelect;
    this._onClick   = onClick;   // ({ img, clickX, clickY, imgRect, imageIndex }) — fired on click (no drag), same contract as BBoxSelector
    this._getImages = getImages || null; // live image list — survives lazy-load/remount
    this._onReload  = onReload;  // (annotation, img, buttonEl) — re-translate this region, see bootForPage's retranslateAnnotation
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
    const bubble = this._createBubble(annotation, img);
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
      this._el.classList.add('wt-dragging'); // pointer -> crosshair while an actual drag is happening
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
      this._el.classList.remove('wt-dragging');

      const endX = e.clientX, endY = e.clientY;
      const pw = Math.abs(endX - startX), ph = Math.abs(endY - startY);

      // Minimal pointer movement -> treat as a click and try auto-detect first;
      // manual drag-to-select (below) remains the fallback for anything larger.
      // Mirrors BBoxSelector's click-to-detect (same threshold constant) so
      // Ridi/Kakao — the two sites that use this fixed-position overlay
      // instead of BBoxSelector — get the same click-to-detect interaction.
      if (Math.hypot(endX - startX, endY - startY) < BBOX_SELECTOR_CLICK_THRESHOLD_PX) {
        const img = this._imageAtViewportPoint(endX, endY, this._liveImages()) || this._anyImageAtPoint(endX, endY);
        if (!img) return;
        const imgRect = img.getBoundingClientRect();
        const clickX = endX - imgRect.left, clickY = endY - imgRect.top;
        if (clickX < 0 || clickY < 0 || clickX > imgRect.width || clickY > imgRect.height) return;
        const imgs = this._liveImages();
        let imageIndex = imgs.indexOf(img);
        if (imageIndex === -1) imageIndex = 0;
        this._onClick?.({ img, clickX, clickY, imgRect, imageIndex });
        return;
      }

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
    // autoFitHeightPx (set once at _createBubble time) may exceed the raw
    // bbox-derived height when the translated text needed the box-expansion
    // fallback — see fitAndExpand(). Doesn't get recomputed on reposition/
    // resize, so it can go slightly stale after a responsive resize, same
    // limitation the font-size styling already had before auto-fit.
    const storedH = parseFloat(bubble.dataset.autoFitHeightPx);
    const h = !isNaN(storedH) ? storedH : (bbox.h / 100) * ih;

    if (_overlayMode === 'side-by-side') {
      // Rendered entirely outside the panel, in the page's own margin to its
      // right, at the same vertical position as the original bubble — not
      // overlaid on the art at all. Needs actual blank page space there to
      // be visible; on a full-bleed viewer with no side margin this can
      // render off-screen or over neighboring page content.
      bubble.style.left      = `${r.right + window.scrollX + SIDE_BY_SIDE_GAP_PX}px`;
      bubble.style.top       = `${r.top   + window.scrollY + (bbox.y / 100) * ih}px`;
      bubble.style.width     = `${SIDE_BY_SIDE_WIDTH_PX}px`;
      bubble.style.minHeight = '';
    } else {
      const left    = r.left + window.scrollX + (bbox.x / 100) * iw;
      const topOrig = r.top  + window.scrollY + (bbox.y / 100) * ih;
      bubble.style.left      = `${left}px`;
      bubble.style.width     = `${(bbox.w / 100) * iw}px`;
      bubble.style.top       = `${topOrig}px`;
      bubble.style.minHeight = `${h}px`;
    }
  }

  _createBubble(ann, img) {
    const b = document.createElement('div');
    b.className      = 'wt-translation-bubble wt-fixed-bubble';
    b.dataset.annKey = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
    b.dataset.bboxX  = ann.bbox.x; b.dataset.bboxY = ann.bbox.y;
    b.dataset.bboxW  = ann.bbox.w; b.dataset.bboxH = ann.bbox.h;
    b.style.position  = 'absolute';
    if (ann.style) {
      const s = ann.style;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
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
    // The colored/background "chrome" lives on the inner span, sized to fit the
    // translated text — not on the outer bubble (which stays sized to the full
    // selected bbox as an invisible hit-area) — so the caption reads like a
    // tight subtitle box instead of a rectangle covering the whole speech bubble.
    const span = document.createElement('span');
    span.className = 'wt-bubble-text';
    span.textContent = ann.translatedText;
    const s = ann.style || {};
    span.style.background = s.noBg ? 'transparent' : hexToRgba(s.bg || '#ffffff', OVERLAY_BG_OPACITY);
    b.appendChild(span);
    b.appendChild(createBubbleReloadButton(this._onReload, ann, img));

    const r  = img.getBoundingClientRect();
    const iw = r.width  || img.naturalWidth;
    const ih = r.height || img.naturalHeight;
    // side-by-side mode: a fixed-width caption in the page's own margin, not
    // an overlay on the (often oval) bubble shape — no oval-corner margin.
    const boxWidthPx = _overlayMode === 'side-by-side' ? SIDE_BY_SIDE_WIDTH_PX : (ann.bbox.w / 100) * iw;
    const boxHeightPx = applyAutoFit(b, span, ann, boxWidthPx, (ann.bbox.h / 100) * ih, _overlayMode !== 'side-by-side');
    b.dataset.autoFitHeightPx = boxHeightPx;

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

// ── BubbleAutoDetector (Strategy 1: standard white/light speech bubbles) ──────
// Click-to-detect via local flood fill. Only handles plain white/light-gray
// bubbles — anything else (text clusters, colored/red text) is out of scope
// for this MVP and simply fails validity, letting the caller fall back to
// manual drag-to-select.

const AUTO_DETECT_CROP_RADIUS    = 250; // px around click, in natural-image pixels — starting radius
const AUTO_DETECT_MAX_RADIUS     = 700; // px — cap for the expand-and-retry loop when the fill hits the crop edge
const AUTO_DETECT_MAX_ATTEMPTS   = 3;   // expand-and-retry attempts before giving up
const AUTO_DETECT_TOLERANCE      = 25;  // flood-fill color-distance tolerance — needs tuning against real screenshots
const AUTO_DETECT_PADDING        = 8;   // px padding added to the final bbox
const AUTO_DETECT_MIN_W          = 20;  // px — reject narrower regions
const AUTO_DETECT_MIN_H          = 15;  // px — reject shorter regions
const AUTO_DETECT_MAX_AREA_RATIO = 0.85; // bbox area / crop area — reject if it likely leaked into background
// AUTO_DETECT_MAX_AREA_RATIO alone misses a specific leak: when a bubble's
// fill color nearly matches the surrounding page/panel background, the
// color-tolerance flood fill treats them as one continuous blob and keeps
// growing the crop (expand-and-retry loop) until it finds SOME other-colored
// boundary, however far that is — often well past the actual bubble, across
// blank panel space, even into the next panel. That result is DENSE (passes
// AUTO_DETECT_MIN_FILL_DENSITY, since it's a solid fill, not a sparse leaked
// fragment) and can end up well under AUTO_DETECT_MAX_AREA_RATIO once the
// crop itself has grown large enough to contain it — so neither existing
// check catches it. This is an absolute cap instead, anchored to the
// STARTING search radius (not however large the crop has since grown): a
// real single bubble is rarely bigger than a small multiple of the radius
// the algorithm considered reasonable to search around the click in the
// first place. Reuses the 'leaked-into-background' reason (not a new one) so
// the existing edge-barrier retry below — which stops at the bubble's drawn
// outline instead of relying on color distance — automatically engages for
// this case too. Needs tuning against real large-bubble screenshots to make
// sure legitimately huge bubbles don't get rejected.
//
// Real-world case that motivated requiring BOTH dimensions (not just one) to
// exceed this: a wide rectangular narration box (636x382, common for
// caption-style dialogue that spans most of a panel's width) was rejected
// because its width alone crossed the cap, even though its height was
// entirely ordinary. A background-color leak balloons in BOTH directions
// (it's the fill spreading outward, not a legitimately wide-but-short box),
// so requiring both dimensions to be oversized still catches that case
// (verified against the original ~900x1050 leaked-region report) while no
// longer flagging a box that's just wide OR just tall.
const AUTO_DETECT_MAX_REGION_DIM_PX = AUTO_DETECT_CROP_RADIUS * 2.5;
const AUTO_DETECT_MAX_ASPECT     = 5;
const AUTO_DETECT_MIN_ASPECT     = 0.2;
// filledPixels / own-bbox-area — a solid oval/rounded-rect bubble is
// ~0.7-0.9; an irregular leaked fragment (e.g. part of a connector fused
// with unrelated art) is much sparser within its own bbox. But a legitimate
// bubble shape that isn't a single convex oval — e.g. two lobes joined by a
// smooth (not sharply pinched) curve, which findWaistSplit's narrower
// bottleneck check doesn't treat as a real waist to split on — has more
// empty bbox area (two corner-voids instead of one, plus the concave join
// itself) and comes out lower than a plain oval's. Real-world case that
// motivated lowering this from 0.55: a two-lobed bubble (381x439,
// filledPixels 85497) measured ~0.511 density and was legitimately a single
// detectable bubble, not a leaked fragment. Needs tuning against more real
// screenshots of both non-oval bubble shapes and genuinely sparse leaks.
const AUTO_DETECT_MIN_FILL_DENSITY = 0.45;

class BubbleAutoDetector {
  /**
   * Attempts to detect a speech-bubble region around a click point using a
   * local flood fill. `clickX`/`clickY` and `imgRect` are in the same CSS-px
   * space as img.getBoundingClientRect(). `images`/`imageIndex` (optional) let
   * the crop pull in pixels from the previous/next panel image — webtoon
   * panels stack vertically, so a bubble can visually span two separate <img>
   * elements; without this, flood fill could never "see" past the edge of
   * whichever single image was clicked.
   *
   * If the filled region touches the edge of the crop (a strong sign it got
   * clipped — e.g. the click landed off-center in a large bubble), the crop
   * is re-centered on the click with a bigger radius and retried, up to
   * AUTO_DETECT_MAX_ATTEMPTS times.
   *
   * Returns { bboxes, debug }: `bboxes` is an array of 1+ %-of-natural-image
   * boxes relative to `img` (usually 1; 2 when a waist-split separated two
   * touching bubbles) matching BBoxSelector's onSelect contract for each — y
   * may be negative or y+h may exceed 100 when a bubble spans into a
   * neighboring panel; ocrRegionStitched already knows how to grab that
   * overflow. `bboxes` is empty if detection failed (caller should fall back
   * to manual drag).
   */
  async detect(img, clickX, clickY, imgRect, images, imageIndex) {
    const nw = img.naturalWidth  || img.width  || imgRect.width;
    const nh = img.naturalHeight || img.height || imgRect.height;
    const scaleX = nw / imgRect.width, scaleY = nh / imgRect.height;
    const cx = clickX * scaleX, cy = clickY * scaleY; // click point in current image's natural px

    let radius = AUTO_DETECT_CROP_RADIUS;
    let debug = { click: { x: clickX, y: clickY }, clickNatural: { x: Math.round(cx), y: Math.round(cy) } };

    for (let attempt = 0; attempt < AUTO_DETECT_MAX_ATTEMPTS; attempt++) {
      const syRaw = cy - radius, eyRaw = cy + radius;
      const sx = Math.max(0, Math.round(cx - radius));
      const ex = Math.min(nw, Math.round(cx + radius));
      const cw = ex - sx;

      debug = { ...debug, attempt, radius, tolerance: AUTO_DETECT_TOLERANCE };

      if (cw < 2) return this._fail(debug, 'crop-too-small');

      const segments = this._buildVerticalSegments(img, images, imageIndex, Math.round(syRaw), Math.round(eyRaw), nh);
      const ch = segments.totalHeight;
      if (ch < 2) return this._fail(debug, 'crop-too-small');
      debug.crop = { sx, sy: segments.canvasTopFrameY, w: cw, h: ch, segments: segments.list.length };

      let imageData;
      try {
        imageData = await this._composeSegments(segments.list, sx, cw, ch);
      } catch (e) {
        return this._fail(debug, 'canvas-tainted');
      }
      if (!imageData) return this._fail(debug, 'canvas-tainted');

      smoothSegmentSeams(imageData, segments.list);
      boxBlur3x3(imageData);

      const localX = Math.round(cx - sx);
      const localY = Math.round(cy - segments.canvasTopFrameY);
      const region = floodFillBBox(imageData, localX, localY, AUTO_DETECT_TOLERANCE);
      if (!region) return this._fail(debug, 'seed-out-of-bounds');

      const rw = region.maxX - region.minX + 1, rh = region.maxY - region.minY + 1;
      const touchesEdge = region.minX === 0 || region.minY === 0 || region.maxX === cw - 1 || region.maxY === ch - 1;
      debug.region = { x: region.minX, y: region.minY, w: rw, h: rh, filledPixels: region.filledPixels, aspect: +(rw / rh).toFixed(2), touchesEdge };

      if (touchesEdge && radius < AUTO_DETECT_MAX_RADIUS) {
        // Likely clipped by the crop (off-center click, or a bubble bigger than
        // the current radius) — grow the crop around the same click point and retry.
        radius = Math.min(AUTO_DETECT_MAX_RADIUS, Math.round(radius * 1.8));
        continue;
      }

      // Two touching/overlapping bubbles flood-fill as one blob. Check for a
      // "waist" — a narrow join between two otherwise-separate masses — and
      // split into independent regions when found, each validated on its
      // own. This also catches a different failure: flood fill leaking out
      // of the bubble entirely through a thin bridge of similar-tolerance
      // color into unrelated nearby art (e.g. a highlight on a character's
      // clothing), which the retry-and-grow loop above can widen into a
      // large, garbage-filled bbox. That leaked appendage is typically an
      // odd, non-bubble shape, so it fails validity on its own — in that
      // case keep only the valid half(s) instead of falling back to the
      // full (still-contaminated) merged region. Only fall back to the
      // merged region if NEITHER half is independently valid.
      let { bboxes, firstFailReason } = this._extractBboxes(region, cw, ch, sx, segments, nw, nh, debug);

      // Last-resort retry for bubbles with a literal gap in their border
      // (dashed/dotted outlines), which a color-only fill leaks straight
      // through regardless of tolerance tuning — see computeEdgeBarrierMask's
      // doc. Only attempted when the plain fill actually leaked into the
      // background (not other failure reasons, and never when the plain fill
      // already succeeded), so solid-border bubbles — the vast majority — are
      // completely unaffected by this and take zero extra work.
      if (!bboxes.length && firstFailReason === 'leaked-into-background') {
        const barrier    = computeEdgeBarrierMask(imageData);
        const edgeRegion = floodFillBBox(imageData, localX, localY, AUTO_DETECT_TOLERANCE, barrier);
        if (edgeRegion) {
          const retry = this._extractBboxes(edgeRegion, cw, ch, sx, segments, nw, nh, debug);
          if (retry.bboxes.length) {
            bboxes = retry.bboxes;
            debug.edgeBarrierRetry = true;
          }
        }
      }

      if (!bboxes.length) return this._fail(debug, firstFailReason || 'too-small');

      debug.bboxes = bboxes;
      debug.pass = true;
      console.log('[WebtoonTranslate] AutoDetect pass', debug);
      return { bboxes, debug };
    }

    return this._fail(debug, 'exceeded-max-attempts');
  }

  /** Waist-split + per-region validity check + bbox conversion — shared by the plain flood fill and the edge-barrier dashed-border retry. */
  _extractBboxes(region, cw, ch, sx, segments, nw, nh, debug) {
    let regions = [region];
    const split = findWaistSplit(region.mask, cw, ch, region);
    if (split) {
      const validHalves = split.filter(r => this._isValidRegion(r, cw, ch).valid);
      if (validHalves.length > 0) {
        regions = validHalves;
        debug.split = validHalves.length === split.length ? 'both' : 'partial';
      }
    }

    const bboxes = [];
    let firstFailReason = null;
    for (const r of regions) {
      const v = this._isValidRegion(r, cw, ch);
      if (!v.valid) { firstFailReason = firstFailReason || v.reason; continue; }
      const bbox = this._regionToBbox(r, sx, segments.canvasTopFrameY, nw, nh);
      // Difficulty-classifier signal, computed here while the mask is still in
      // scope (it isn't kept around once detect() returns). Reuses the
      // merged region's mask even for a waist-split half, since halves share
      // the same underlying canvas/mask — just a tighter minX/minY/maxX/maxY.
      // Callers must strip this before persisting `bbox` as an annotation —
      // it's debug/routing metadata, not part of the BBox shape.
      bbox.skewAngle = minAreaRectAngle(extractRegionContour(region.mask, cw, r));
      // Marks this bbox as flood-fill-detected (vs. a hand-drawn/hand-resized
      // one) — gates the OCR-crop inset + text-cluster refinement, which only
      // make sense for a flood-fill shape's bounding box. See runOcr.
      bbox.source = 'auto';
      bboxes.push(bbox);
    }
    return { bboxes, firstFailReason };
  }

  /** Size/area/aspect validity check shared by the merged region and each waist-split half. */
  _isValidRegion(region, cw, ch) {
    const rw = region.maxX - region.minX + 1, rh = region.maxY - region.minY + 1;
    if (rw < AUTO_DETECT_MIN_W || rh < AUTO_DETECT_MIN_H) return { valid: false, reason: 'too-small' };
    const areaRatio = (rw * rh) / (cw * ch);
    if (areaRatio > AUTO_DETECT_MAX_AREA_RATIO) return { valid: false, reason: 'leaked-into-background' };
    if (rw > AUTO_DETECT_MAX_REGION_DIM_PX && rh > AUTO_DETECT_MAX_REGION_DIM_PX) return { valid: false, reason: 'leaked-into-background' };
    const aspect = rw / rh;
    if (aspect > AUTO_DETECT_MAX_ASPECT || aspect < AUTO_DETECT_MIN_ASPECT) return { valid: false, reason: 'bad-aspect-ratio' };
    const density = region.filledPixels / (rw * rh);
    if (density < AUTO_DETECT_MIN_FILL_DENSITY) return { valid: false, reason: 'low-fill-density' };
    return { valid: true };
  }

  /** Crop-local region -> bbox relative to the CURRENT image's natural size, padded. x stays clamped to this image's width; y is intentionally left unclamped — see detect()'s doc. */
  _regionToBbox(region, sx, canvasTopFrameY, nw, nh) {
    const px0 = Math.max(0,  sx + region.minX - AUTO_DETECT_PADDING);
    const py0 = canvasTopFrameY + region.minY - AUTO_DETECT_PADDING;
    const px1 = Math.min(nw, sx + region.maxX + 1 + AUTO_DETECT_PADDING);
    const py1 = canvasTopFrameY + region.maxY + 1 + AUTO_DETECT_PADDING;
    return {
      x: (px0 / nw) * 100,
      y: (py0 / nh) * 100,
      w: ((px1 - px0) / nw) * 100,
      h: ((py1 - py0) / nh) * 100,
    };
  }

  _fail(debug, reason) {
    debug.pass = false;
    debug.reason = reason;
    console.log('[WebtoonTranslate] AutoDetect fail', debug);
    return { bboxes: [], debug };
  }

  /**
   * Splits the vertical span [syRaw, eyRaw) — in the CURRENT image's own
   * natural-px coordinate space, may extend past [0, nh) — into up to 3
   * segments: a slice of the previous image (if syRaw<0 and one exists), the
   * current image's own portion, and a slice of the next image (if
   * eyRaw>nh and one exists). Each segment records its source element,
   * source-y range, and where it lands in the composed canvas (destY).
   * `canvasTopFrameY` is the current-image-space y that ends up at destY=0
   * (equal to syRaw unless a neighbor didn't have enough height to cover the
   * full requested overflow, in which case it's clamped inward).
   */
  _buildVerticalSegments(img, images, imageIndex, syRaw, eyRaw, nh) {
    const list = [];
    let canvasTopFrameY = syRaw;

    if (syRaw < 0) {
      const prevImg = (images && imageIndex > 0) ? images[imageIndex - 1] : null;
      const pnh = prevImg ? (prevImg.naturalHeight || prevImg.height || 0) : 0;
      const want = prevImg ? Math.min(-syRaw, pnh) : 0;
      canvasTopFrameY = -want;
      if (want > 0) list.push({ source: prevImg, sy: pnh - want, sh: want, destY: 0 });
    }

    const curSegStart = Math.max(0, syRaw);
    const curSegEnd   = Math.min(nh, eyRaw);
    const curH = curSegEnd - curSegStart;
    if (curH > 0) list.push({ source: img, sy: curSegStart, sh: curH, destY: curSegStart - canvasTopFrameY });

    if (eyRaw > nh) {
      const nextImg = (images && imageIndex < images.length - 1) ? images[imageIndex + 1] : null;
      if (nextImg) {
        const nnh = nextImg.naturalHeight || nextImg.height || 0;
        const want = Math.min(eyRaw - nh, nnh);
        if (want > 0) list.push({ source: nextImg, sy: 0, sh: want, destY: nh - canvasTopFrameY });
      }
    }

    const totalHeight = list.reduce((max, s) => Math.max(max, s.destY + s.sh), 0);
    return { list, totalHeight, canvasTopFrameY };
  }

  /**
   * Draws 1-3 vertical segments (possibly from different <img> elements) into
   * one canvas and reads back the composed pixels. Falls back to fetching
   * each segment via the background worker (same taint-avoidance as the
   * single-image case) if any source is a cross-origin image without CORS
   * headers — getImageData taints the WHOLE canvas if even one drawn source
   * was tainted, so the fallback re-draws every segment from a background-
   * fetched (same-origin data:) image rather than trying to patch just one.
   */
  async _composeSegments(segments, sx, cw, ch) {
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const seg of segments) {
      ctx.drawImage(seg.source, sx, seg.sy, cw, seg.sh, 0, seg.destY, cw, seg.sh);
    }
    try {
      return ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      const canvas2 = document.createElement('canvas');
      canvas2.width = cw; canvas2.height = ch;
      const ctx2 = canvas2.getContext('2d', { willReadFrequently: true });
      for (const seg of segments) {
        const snw = seg.source.naturalWidth || seg.source.width || cw;
        const snh = seg.source.naturalHeight || seg.source.height || seg.sh;
        const bbox = { x: (sx / snw) * 100, y: (seg.sy / snh) * 100, w: (cw / snw) * 100, h: (seg.sh / snh) * 100 };
        const res = await sendToBackground({ type: MSG.CROP_IMAGE, payload: { imageUrl: seg.source.src, bbox } });
        if (!res?.ok || !res.dataUrl) throw new Error(res?.error || 'background crop failed');
        const segImg = await loadImage(res.dataUrl);
        ctx2.drawImage(segImg, 0, 0, cw, seg.sh, 0, seg.destY, cw, seg.sh);
      }
      return ctx2.getImageData(0, 0, cw, ch);
    }
  }
}

/** Loads a data: URL into an <img>, resolving once it's decoded. */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load cropped image'));
    img.src = dataUrl;
  });
}

// A bubble spanning two stacked panel <img> elements gets its click-to-detect
// crop composited from BOTH source images (_buildVerticalSegments +
// _composeSegments). Real-world case: on Kakao, flood-fill stopped at the
// exact seam between the two composited images — touchesEdge:false (i.e. it
// believed it had found the bubble's true boundary, not that it ran out of
// search radius) — even though the crop had plenty of room left to keep
// growing into the neighboring image, and the bubble's own drawn outline is
// continuous across that seam. Two separately-served image files depicting
// "the same" continuous artwork can differ slightly in color/brightness
// (different compression, whatever encoding each was served with) — a real
// discontinuity the color-tolerance flood fill reads as a wall, even though
// boxBlur3x3's radius-1 smoothing (aimed at JPEG ringing, not a real
// brightness step between two files) isn't strong enough to bridge it.
// Coarse mitigation: blur a wider band centered on each segment seam more
// aggressively than the rest of the crop, specifically to smooth over that
// discontinuity before flood-fill sees it. Only ever runs for a multi-segment
// composite (segments.length > 1, i.e. an actual cross-panel click) — a
// same-single-image detection (the overwhelming majority of clicks) is
// completely unaffected. Needs tuning against more real cross-panel
// screenshots — too small and it won't bridge the seam; too large and it
// could blur away real text/bubble edges that happen to sit close to it.
const SEAM_BLUR_RADIUS_PX = 5;

/** Vertical-only box blur (blurs across the horizontal seam, not along it) over rows [centerY-radius, centerY+radius). See SEAM_BLUR_RADIUS_PX above. */
function _blurSeamBand(imageData, centerY, radius) {
  const { data, width: w, height: h } = imageData;
  const yStart = Math.max(0, centerY - radius);
  const yEnd   = Math.min(h - 1, centerY + radius - 1);
  if (yStart > yEnd) return;
  const src = new Uint8ClampedArray(data);
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = 0; x < w; x++) {
      let rSum = 0, gSum = 0, bSum = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const i = (ny * w + x) * 4;
        rSum += src[i]; gSum += src[i + 1]; bSum += src[i + 2];
        n++;
      }
      const i = (y * w + x) * 4;
      data[i] = rSum / n; data[i + 1] = gSum / n; data[i + 2] = bSum / n;
    }
  }
}

/** Smooths every segment-join seam in a composited multi-image crop — see SEAM_BLUR_RADIUS_PX above. No-op for a single-segment (same-image) crop. */
function smoothSegmentSeams(imageData, segmentList) {
  if (segmentList.length < 2) return;
  // Every segment after the first one starts at a real seam (destY).
  for (let i = 1; i < segmentList.length; i++) {
    _blurSeamBand(imageData, segmentList[i].destY, SEAM_BLUR_RADIUS_PX);
  }
}

/** In-place 3x3 box blur (radius 1) — smooths JPEG ringing artifacts around bubble edges. */
function boxBlur3x3(imageData) {
  const { data, width: w, height: h } = imageData;
  const src = new Uint8ClampedArray(data); // blur from a snapshot, not partially-blurred values
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rSum = 0, gSum = 0, bSum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const i = (ny * w + nx) * 4;
          rSum += src[i]; gSum += src[i + 1]; bSum += src[i + 2];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      data[i] = rSum / n; data[i + 1] = gSum / n; data[i + 2] = bSum / n;
    }
  }
}

/** Iterative 4-connected flood fill by color distance to the seed pixel. `barrierMask` (optional, from computeEdgeBarrierMask), when given, blocks traversal into any marked pixel regardless of color tolerance — used as a last-resort retry for bubbles whose border has literal gaps (dashed/dotted outlines) that a color-only fill leaks straight through. Returns the bbox + pixel count + the fill mask, or null if the seed is out of bounds. */
function floodFillBBox(imageData, startX, startY, tolerance, barrierMask) {
  const { data, width: w, height: h } = imageData;
  if (startX < 0 || startY < 0 || startX >= w || startY >= h) return null;

  const seedI = (startY * w + startX) * 4;
  const sr = data[seedI], sg = data[seedI + 1], sb = data[seedI + 2];
  const tolSq = tolerance * tolerance;

  const visited = new Uint8Array(w * h);
  const stack = [startY * w + startX];
  visited[startY * w + startX] = 1;

  let minX = startX, maxX = startX, minY = startY, maxY = startY, filledPixels = 0;

  const tryVisit = (nIdx) => {
    if (visited[nIdx]) return;
    if (barrierMask && barrierMask[nIdx]) return;
    const i = nIdx * 4;
    const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
    if (dr * dr + dg * dg + db * db <= tolSq) {
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  };

  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w, y = (idx / w) | 0;
    filledPixels++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;

    if (x > 0)     tryVisit(idx - 1);
    if (x < w - 1) tryVisit(idx + 1);
    if (y > 0)     tryVisit(idx - w);
    if (y < h - 1) tryVisit(idx + w);
  }

  return { minX, minY, maxX, maxY, filledPixels, mask: visited };
}

// ── Edge barrier (dashed/dotted bubble border fallback) ────────────────────────
// A color-tolerance flood fill treats a dashed border as a series of walls with
// literal gaps between them — the fill leaks straight through those gaps into
// whatever's outside the bubble. This computes a simple gradient-magnitude edge
// map (cheap central-difference approximation, not a full Sobel convolution)
// and dilates it by a few px, so nearby dash segments' edges merge into a
// mostly-continuous barrier that bridges small gaps. Deliberately NOT wired
// into the main detection path — see AUTO_DETECT_EDGE_* below and detect()'s
// last-resort retry — a real border (dashed or solid) is a strong edge either
// way, so this mainly matters for closing dash gaps, not for solid borders
// (which the plain color-tolerance fill already handles).

const AUTO_DETECT_EDGE_THRESHOLD   = 40; // luminance gradient magnitude above this counts as an edge; needs tuning against real dashed-bubble screenshots
const AUTO_DETECT_EDGE_DILATE_PX   = 2;  // how far to grow each edge pixel — must be >= half the typical gap between dashes to bridge them

/** Grayscale gradient magnitude (central differences) thresholded into a binary edge mask. */
function computeEdgeMask(imageData, threshold) {
  const { data, width: w, height: h } = imageData;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const edges = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const gx = lum[p + (x < w - 1 ? 1 : 0)] - lum[p - (x > 0 ? 1 : 0)];
      const gy = lum[p + (y < h - 1 ? w : 0)] - lum[p - (y > 0 ? w : 0)];
      if (Math.sqrt(gx * gx + gy * gy) > threshold) edges[p] = 1;
    }
  }
  return edges;
}

/** Separable square dilation (grows every set pixel by `radius` in both axes) — O(w*h*radius), not O(w*h*radius²). */
function dilateMask(mask, w, h, radius) {
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

/** computeEdgeMask + dilateMask in one call, for detect()'s dashed-border retry. */
function computeEdgeBarrierMask(imageData) {
  const edges = computeEdgeMask(imageData, AUTO_DETECT_EDGE_THRESHOLD);
  return dilateMask(edges, imageData.width, imageData.height, AUTO_DETECT_EDGE_DILATE_PX);
}

// ── Waist-split (separates two bubbles merged by flood fill at a touching point) ─
// A pair of touching/overlapping speech bubbles flood-fills as one connected
// blob. The signature of that join is a "waist": a row or column where the
// blob's width/height narrows sharply relative to the bubble mass on both
// sides of it — unlike a single bubble's natural taper toward its own edges,
// which only ever narrows on ONE side (going to zero at the boundary).

const WAIST_SPLIT_RATIO      = 0.35; // narrowest-run width vs. the weaker side's local max — below this, treat as two joined bubbles. Needs tuning against real touching-bubble screenshots.
const WAIST_EDGE_MARGIN_FRAC = 0.15; // ignore narrowing within this fraction of the scan axis's own extent from either end (that's just normal bubble taper, not a junction)
const WAIST_MIN_REGION_DIM   = 20;   // px — each split half must still span at least this far along the scan axis to be considered a real second bubble, not noise
const WAIST_MIN_RUN_PX       = 6;    // the narrow point must persist for at least this many consecutive rows/cols — a real connector is physically several px wide; a single anomalous row/col (JPEG noise, a translucent bubble briefly failing color tolerance) isn't
const WAIST_SMOOTH_WINDOW    = 5;    // moving-average window applied to the profile before scanning, for the same noise-vs-real-connector reason

/**
 * If `region` (within a `w`x`h` `mask`) looks like two bubbles joined at a
 * narrow waist, returns the two split sub-regions (each with its own bbox +
 * filledPixels, same shape as floodFillBBox's return). Otherwise returns null.
 * Checks both a vertical waist (bubbles stacked, narrows along rows) and a
 * horizontal waist (bubbles side-by-side, narrows along columns), preferring
 * whichever axis shows the stronger (lower ratio) narrowing.
 */
function findWaistSplit(mask, w, h, region) {
  const { minX, minY, maxX, maxY } = region;

  // Profile is each row/column's SPAN (leftmost to rightmost filled pixel),
  // not a raw filled-pixel count — text glyphs inside a bubble punch holes in
  // the background match and would make text-dense rows look artificially
  // narrow under a count, even though the background still reaches both
  // edges on those rows. Span only shrinks when the shape itself narrows.
  const rowProfile = [];
  for (let y = minY; y <= maxY; y++) {
    let lo = -1, hi = -1;
    const base = y * w;
    for (let x = minX; x <= maxX; x++) if (mask[base + x]) { if (lo === -1) lo = x; hi = x; }
    rowProfile.push(lo === -1 ? 0 : hi - lo + 1);
  }
  const rowWaist = _scanForWaist(rowProfile, WAIST_SPLIT_RATIO, WAIST_EDGE_MARGIN_FRAC, WAIST_MIN_RUN_PX);

  const colProfile = [];
  for (let x = minX; x <= maxX; x++) {
    let lo = -1, hi = -1;
    for (let y = minY; y <= maxY; y++) if (mask[y * w + x]) { if (lo === -1) lo = y; hi = y; }
    colProfile.push(lo === -1 ? 0 : hi - lo + 1);
  }
  const colWaist = _scanForWaist(colProfile, WAIST_SPLIT_RATIO, WAIST_EDGE_MARGIN_FRAC, WAIST_MIN_RUN_PX);

  let axis = null;
  if (rowWaist && (!colWaist || rowWaist.ratio <= colWaist.ratio)) axis = { type: 'row', ...rowWaist };
  else if (colWaist) axis = { type: 'col', ...colWaist };
  if (!axis) return null;

  let regionA, regionB;
  if (axis.type === 'row') {
    const splitY = minY + axis.index;
    regionA = _maskSubRegion(mask, w, minX, minY, maxX, splitY - 1);
    regionB = _maskSubRegion(mask, w, minX, splitY + 1, maxX, maxY);
    if (!regionA || !regionB) return null;
    if (regionA.maxY - regionA.minY + 1 < WAIST_MIN_REGION_DIM) return null;
    if (regionB.maxY - regionB.minY + 1 < WAIST_MIN_REGION_DIM) return null;
  } else {
    const splitX = minX + axis.index;
    regionA = _maskSubRegion(mask, w, minX, minY, splitX - 1, maxY);
    regionB = _maskSubRegion(mask, w, splitX + 1, minY, maxX, maxY);
    if (!regionA || !regionB) return null;
    if (regionA.maxX - regionA.minX + 1 < WAIST_MIN_REGION_DIM) return null;
    if (regionB.maxX - regionB.minX + 1 < WAIST_MIN_REGION_DIM) return null;
  }
  return [regionA, regionB];
}

/**
 * Scans a 1-D width/height profile for a "waist": a run of at least
 * `minRunPx` consecutive indices (away from both ends, by `edgeMarginFrac`)
 * whose (smoothed) value stays under `ratioThreshold` of the smaller of the
 * local max before the run and the local max after it. Returns the run with
 * the lowest minimum ratio, or null if none qualifies.
 *
 * The profile is smoothed first and the narrowing must hold over a run, not
 * just a single point — single-row/col dips (JPEG noise, a translucent
 * bubble briefly failing color tolerance where busy art shows through) are
 * common and must NOT be mistaken for a real bubble-to-bubble connector,
 * which is physically several pixels wide/tall at minimum.
 */
function _scanForWaist(profile, ratioThreshold, edgeMarginFrac, minRunPx) {
  const n = profile.length;
  if (n < 5) return null;
  const margin = Math.max(1, Math.round(n * edgeMarginFrac));
  if (margin * 2 >= n) return null;

  const smoothed = _smoothProfile(profile, WAIST_SMOOTH_WINDOW);

  const prefixMax = new Array(n);
  for (let i = 0, pm = 0; i < n; i++) { pm = Math.max(pm, smoothed[i]); prefixMax[i] = pm; }
  const suffixMax = new Array(n);
  for (let i = n - 1, sm = 0; i >= 0; i--) { sm = Math.max(sm, smoothed[i]); suffixMax[i] = sm; }

  const ratioAt = (k) => {
    const before = prefixMax[k - 1] || 0;
    const after  = suffixMax[k + 1] || 0;
    if (!before || !after) return Infinity;
    return smoothed[k] / Math.min(before, after);
  };

  let bestRun = null; // { start, end, minRatio }
  let runStart = -1, runMin = Infinity;
  for (let k = margin; k <= n - margin; k++) {
    const ratio = k < n - margin ? ratioAt(k) : Infinity;
    if (ratio < ratioThreshold) {
      if (runStart === -1) { runStart = k; runMin = ratio; }
      else runMin = Math.min(runMin, ratio);
    } else if (runStart !== -1) {
      if (k - runStart >= minRunPx && (!bestRun || runMin < bestRun.minRatio)) {
        bestRun = { start: runStart, end: k - 1, minRatio: runMin };
      }
      runStart = -1;
    }
  }
  if (!bestRun) return null;
  return { index: Math.round((bestRun.start + bestRun.end) / 2), ratio: bestRun.minRatio };
}

/** Simple centered moving-average smoothing. */
function _smoothProfile(profile, window) {
  const n = profile.length;
  const half = Math.floor(window / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { sum += profile[j]; count++; }
    out[i] = sum / count;
  }
  return out;
}

/** bbox + filledPixels of the mask pixels within a clip rect — NOT a connected-component search, just a rectangular restriction of the original connected blob. */
function _maskSubRegion(mask, w, x0, y0, x1, y1) {
  if (x1 < x0 || y1 < y0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, filledPixels = 0;
  for (let y = y0; y <= y1; y++) {
    const base = y * w;
    for (let x = x0; x <= x1; x++) {
      if (mask[base + x]) {
        filledPixels++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!filledPixels) return null;
  return { minX, minY, maxX, maxY, filledPixels };
}

// ── Difficulty Classifier (heuristic router: OCR text -> translation tier) ───
// Not every line needs an LLM to translate well. This sits between region
// detection/OCR and translation, and routes each region into one of four
// tiers, each meant for a different (separately-implemented) pipeline:
//   easy/medium -> machine translation only (medium == easy for now, no MTPE
//                  tier yet), hard -> LLM translation, vision -> Vision LLM
//                  on the cropped image (OCR skipped entirely for this tier).
// v1 is deliberately "dumb": string matching + confidence thresholds, no real
// Korean NLP/grammar analysis. A wrong tier just sends a line through a
// slightly more/less expensive pipeline than ideal — not catastrophic — so
// every threshold below is a named, tunable constant meant to be adjusted
// after reviewing a batch of real screenshots against the [DifficultyClassifier]
// console logs this module emits.

const DIFFICULTY_SKEW_ANGLE_THRESHOLD_DEG  = 15;   // minAreaRect rotation (0-90, abs) beyond this -> too skewed to OCR reliably; needs tuning against real angled/phone-screen panel screenshots
const DIFFICULTY_LOW_CONFIDENCE_THRESHOLD  = 0.6;  // OCR confidence (0-1) below this -> unreliable text, fall back to vision
const DIFFICULTY_SHORT_TEXT_MAX_CHARS      = 5;    // char count at/under this counts as "very short" (e.g. a single SFX or interjection)
const DIFFICULTY_HIGH_CONFIDENCE_THRESHOLD = 0.85; // OCR confidence (0-1) required, alongside short text, to call a line 'easy'

const DIFFICULTY_TIERS = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', VISION: 'vision' };

// Sentence-ending honorific markers — a strong signal of formal/polite speech
// register, which machine translation tends to flatten. Extend as needed.
const DIFFICULTY_HONORIFIC_MARKERS = ['습니다', '입니다', '세요', '였습니다', '겠습니다'];

// Stylized punctuation clusters common in webtoon dialogue (trailing off,
// emphasis, tone) that machine translation tends to mishandle. Extend as needed.
const DIFFICULTY_STYLIZED_PUNCTUATION_MARKERS = ['…', '~', '‼', '？！'];

/**
 * Derives boundary ("contour") points from a flood-fill region's fill mask —
 * any filled pixel with at least one empty (or out-of-bounds) 4-neighbor.
 * `mask`/`w` are floodFillBBox's returned `mask` and the canvas width it was
 * computed against (also valid for a waist-split half, since those reuse the
 * same mask/canvas, just a tighter minX/minY/maxX/maxY). Order doesn't matter
 * — minAreaRectAngle's convex-hull step sorts points itself — so this is a
 * boundary POINT SET, not an ordered polygon trace.
 *
 * floodFillBBox itself only returns a fill mask + axis-aligned bbox, not a
 * contour; this is the missing piece needed to compute a true minimum-area
 * (rotated) bounding rectangle instead of the axis-aligned one.
 */
function extractRegionContour(mask, w, region) {
  const { minX, minY, maxX, maxY } = region;
  const points = [];
  for (let y = minY; y <= maxY; y++) {
    const base = y * w;
    for (let x = minX; x <= maxX; x++) {
      const idx = base + x;
      if (!mask[idx]) continue;
      const isBoundary =
        x === minX || x === maxX || y === minY || y === maxY ||
        !mask[idx - 1] || !mask[idx + 1] || !mask[idx - w] || !mask[idx + w];
      if (isBoundary) points.push({ x, y });
    }
  }
  return points;
}

/** Andrew's monotone-chain convex hull. Returns hull points in CCW order (length may be < 3 for degenerate/collinear input). */
function _convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area bounding rectangle via rotating calipers: for each convex-hull
 * edge, treats that edge's direction as one rectangle axis and measures the
 * axis-aligned extent of every hull point in that rotated frame, keeping
 * whichever edge yields the smallest-area rectangle. Returns that rectangle's
 * rotation relative to horizontal, normalized to 0-90 degrees (absolute value)
 * — a rectangle's rotation is ambiguous mod 90° (which side is "width" vs.
 * "height"), and only how far off-horizontal it is matters here, not direction.
 */
function minAreaRectAngle(contourPoints) {
  if (!contourPoints || contourPoints.length < 3) return 0;
  const hull = _convexHull(contourPoints);
  if (hull.length < 3) return 0;

  let minArea = Infinity, bestAngleRad = 0;
  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i], p2 = hull[(i + 1) % hull.length];
    const edgeAngleRad = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const cos = Math.cos(-edgeAngleRad), sin = Math.sin(-edgeAngleRad);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < minArea) { minArea = area; bestAngleRad = edgeAngleRad; }
  }

  // Fold into [0, 90) with true modulo (NOT abs-then-%, which mishandles
  // negative angles and — since a rectangle's two perpendicular edge
  // directions are 90° apart and both tie for minimal area — would make the
  // reported angle flip unpredictably between theta and 90-theta depending on
  // which tied edge the loop above happened to keep).
  const angleDeg = bestAngleRad * 180 / Math.PI;
  return ((angleDeg % 90) + 90) % 90;
}

/** Post-OCR tier rules (skew already checked, OCR already ran) — see classifyDifficulty for the full flow and rule order/rationale. */
function _classifyPostOcr(text, confidence, skewAngle) {
  const base = { skewAngle, ocrConfidence: confidence, text };

  // confidence is null when the OCR provider didn't report one (e.g.
  // OCR.space) — `null < DIFFICULTY_LOW_CONFIDENCE_THRESHOLD` would otherwise
  // evaluate true (null coerces to 0 for `<`), wrongly routing a genuinely
  // correct OCR read (unknown confidence, not low confidence) to 'vision'.
  // Unknown confidence just skips this check and falls through to the
  // text-only rules below.
  if (confidence != null && confidence < DIFFICULTY_LOW_CONFIDENCE_THRESHOLD) {
    return { ...base, tier: DIFFICULTY_TIERS.VISION, reason: 'low-ocr-confidence' };
  }

  // Computed once — reused by the 'easy' check's negative condition below and
  // the 'hard' check, so a honorific line never accidentally qualifies as easy.
  const hasHonorific = DIFFICULTY_HONORIFIC_MARKERS.some(m => text.includes(m));

  if (text.length <= DIFFICULTY_SHORT_TEXT_MAX_CHARS &&
      confidence > DIFFICULTY_HIGH_CONFIDENCE_THRESHOLD &&
      !hasHonorific) {
    return { ...base, tier: DIFFICULTY_TIERS.EASY, reason: 'short-high-confidence' };
  }

  if (hasHonorific) {
    return { ...base, tier: DIFFICULTY_TIERS.HARD, reason: 'honorific-detected' };
  }

  const hasStylizedPunctuation = DIFFICULTY_STYLIZED_PUNCTUATION_MARKERS.some(m => text.includes(m));
  if (hasStylizedPunctuation) {
    return { ...base, tier: DIFFICULTY_TIERS.HARD, reason: 'stylized-punctuation' };
  }

  return { ...base, tier: DIFFICULTY_TIERS.MEDIUM, reason: 'default' };
}

function _logDifficultyClassification(result) {
  console.log('[DifficultyClassifier]', {
    text: result.text,
    confidence: result.ocrConfidence,
    tier: result.tier,
    reason: result.reason,
    skewAngle: result.skewAngle,
  });
}

/**
 * Single entry point for difficulty classification. Owns the decision of
 * whether OCR runs at all:
 *   1. Computes skew angle from `regionContour` (boundary points from the
 *      region's flood-fill mask — see extractRegionContour — NOT the
 *      axis-aligned bbox) via minAreaRectAngle. If it exceeds
 *      DIFFICULTY_SKEW_ANGLE_THRESHOLD_DEG, returns tier 'vision' immediately
 *      WITHOUT calling `ocrRunner` — Tesseract is skipped entirely for
 *      high-skew regions (e.g. angled phone-screen panels).
 *   2. Otherwise calls `ocrRunner()` (may be async; expected to resolve to
 *      `{ text, confidence }` with confidence in 0-1) and applies the
 *      post-OCR rules — see _classifyPostOcr.
 * Every result (early-exit or not) is logged via _logDifficultyClassification
 * for later tuning.
 *
 * @param {{x:number,y:number}[]} regionContour - boundary points, e.g. from extractRegionContour(region.mask, canvasWidth, region)
 * @param {() => ({text:string,confidence:number}|Promise<{text:string,confidence:number}>)} ocrRunner
 * @returns {Promise<{tier:string, reason:string, skewAngle:number, ocrConfidence:number|null, text:string|null}>}
 */
async function classifyDifficulty(regionContour, ocrRunner) {
  const skewAngle = minAreaRectAngle(regionContour);

  if (skewAngle > DIFFICULTY_SKEW_ANGLE_THRESHOLD_DEG) {
    const result = { tier: DIFFICULTY_TIERS.VISION, reason: 'high-skew-angle', skewAngle, ocrConfidence: null, text: null };
    _logDifficultyClassification(result);
    return result;
  }

  const { text, confidence } = await ocrRunner();
  const result = _classifyPostOcr(text, confidence, skewAngle);
  _logDifficultyClassification(result);
  return result;
}

/**
 * Shadow-mode variant used by the live detect -> OCR flow (see JobManager's
 * runOcr wiring), where OCR has ALREADY run for real translation purposes —
 * unlike classifyDifficulty, this never decides whether to call OCR, and
 * takes an already-computed `skewAngle` rather than raw contour points: the
 * flood-fill mask/contour only exists transiently inside
 * BubbleAutoDetector._extractBboxes (where the angle gets computed and
 * attached to the bbox), long before this runs — by the time OCR finishes,
 * the mask itself is out of scope. Exists purely to produce
 * [DifficultyClassifier] logs for tuning; never affects what OCR or
 * translation actually does. `skewAngle` is null for manually drag-selected
 * regions (no flood-fill contour was ever computed for those).
 */
function logDifficultyClassificationShadow(skewAngle, text, confidence) {
  const angle = skewAngle ?? 0;
  const result = angle > DIFFICULTY_SKEW_ANGLE_THRESHOLD_DEG
    ? { tier: DIFFICULTY_TIERS.VISION, reason: 'high-skew-angle', skewAngle: angle, ocrConfidence: confidence, text }
    : _classifyPostOcr(text, confidence, angle);
  _logDifficultyClassification(result);
  return result;
}

// ── DetectionPreview ─────────────────────────────────────────────────────────
// Adjustable bounding-box preview shown after a successful auto-detect, so the
// user can correct the region before it's sent into the OCR pipeline. Also
// reused by startBubbleResize to adjust an EXISTING annotation's box.

// A bubble can visually span two stacked panel images (webtoons scroll
// vertically) — both the initial manual drag-select (BBoxSelector/
// FixedOverlayLayer's multi-image overlap check) and auto-detect
// (BubbleAutoDetector's y<0 / y+h>100 convention, consumed by
// ocrRegionStitched's cross-panel grab) already support this. The move/resize
// handles below used to hard-clamp the box to the CURRENT single image's own
// [top, top+height] bounds, with no way to drag it into a neighboring
// panel — so a box created spanning two panels could never be resized to
// still cover both. This allowance lets the box's top/bottom extend past the
// image's own edge by up to this fraction of the image's height, matching
// ocrRegionStitched's own cross-panel grab cap (grabH capped at 60% of image
// height) — no point letting the UI reach further than OCR would actually
// fetch from the neighboring panel. Horizontal (left/right) stays clamped to
// the current image's own width — panels stack vertically, not side-by-side.
const CROSS_PANEL_DRAG_ALLOWANCE_FRAC = 0.6;

class DetectionPreview {
  constructor() {
    this._el = null;
    this._cleanup = null;
  }

  /**
   * Shows an adjustable box over `img` for `bboxPct`. Resolves with the
   * (possibly adjusted) bbox % on confirm, or null on cancel/dismiss.
   *
   * By default the box is appended to `wrapper` (position:absolute, px
   * relative to the wrapper's own top-left — the wrapper is sized to the
   * image, so 0,0 IS the image's top-left). Pass `{ fixed: true }` and
   * `wrapper` can be null: the box is appended to document.body instead
   * (position:fixed, px relative to the *viewport*) — needed for Ridi/Kakao,
   * whose bubbles/overlays already work in viewport coordinates via
   * FixedOverlayLayer rather than a `.wt-img-wrapper` (which those sites
   * never get — see BBoxSelector._ensureWrapper). The move/resize handles'
   * own delta math (based on raw e.clientX/Y deltas) needs no changes either
   * way; only the img-relative <-> viewport-relative offset conversions in
   * applyPx/readPct and the handles' clamping bounds differ.
   */
  show(img, wrapper, bboxPct, { fixed = false } = {}) {
    this.dismiss();
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = `wt-detect-preview${fixed ? ' wt-detect-preview-fixed' : ''}`;
      (fixed ? document.body : wrapper).appendChild(box);

      const dims = () => ({
        iw: img.offsetWidth || img.naturalWidth,
        ih: img.offsetHeight || img.naturalHeight,
      });
      // Origin of the image in the box's own coordinate space: (0,0) when the
      // box lives inside the image's own wrapper; the image's live viewport
      // rect when the box is position:fixed instead.
      const origin = () => fixed ? img.getBoundingClientRect() : { left: 0, top: 0 };
      const applyPx = (bbox) => {
        const { iw, ih } = dims();
        const o = origin();
        box.style.left   = `${o.left + (bbox.x / 100) * iw}px`;
        box.style.top    = `${o.top  + (bbox.y / 100) * ih}px`;
        box.style.width  = `${(bbox.w / 100) * iw}px`;
        box.style.height = `${(bbox.h / 100) * ih}px`;
      };
      const readPct = () => {
        const { iw, ih } = dims();
        const o = origin();
        return {
          x: ((parseFloat(box.style.left) - o.left) / iw) * 100,
          y: ((parseFloat(box.style.top)  - o.top)  / ih) * 100,
          w: (parseFloat(box.style.width)  / iw) * 100,
          h: (parseFloat(box.style.height) / ih) * 100,
        };
      };
      applyPx(bboxPct);

      const cleanups = [];

      // fixed mode positions the box in VIEWPORT coordinates (position:fixed),
      // snapshotting origin() = img.getBoundingClientRect() only once, at
      // whatever scroll position was current when show() was called. The box
      // itself never moves on scroll (that's what position:fixed does), but
      // the underlying image is normal in-flow content and DOES scroll — so
      // without re-syncing, the box visually detaches from the panel
      // underneath it the moment the page scrolls.
      //
      // NOT done via readPct()+applyPx(): readPct() divides by origin() at
      // the moment it's called, which — by the time a scroll/resize listener
      // fires — is already the NEW (post-scroll) rect, so it would silently
      // bake the scroll delta into the "restored" percentage instead of
      // preserving the box's true position relative to the image. Instead,
      // track the image's rect/dims explicitly and apply the raw geometric
      // delta directly to the box's own pixel styles: shifts left/top by how
      // much the image's origin moved (handles scroll) and scales
      // left/top/width/height by how much the image's own size changed
      // (handles a responsive-layout window resize), without ever
      // round-tripping through a percentage.
      if (fixed) {
        let lastOrigin = origin();
        let lastDims   = dims();
        const resync = () => {
          const newOrigin = origin();
          const newDims   = dims();
          const scaleX = newDims.iw / lastDims.iw;
          const scaleY = newDims.ih / lastDims.ih;
          const relLeft = parseFloat(box.style.left) - lastOrigin.left;
          const relTop  = parseFloat(box.style.top)  - lastOrigin.top;
          box.style.left   = `${newOrigin.left + relLeft * scaleX}px`;
          box.style.top    = `${newOrigin.top  + relTop  * scaleY}px`;
          box.style.width  = `${parseFloat(box.style.width)  * scaleX}px`;
          box.style.height = `${parseFloat(box.style.height) * scaleY}px`;
          lastOrigin = newOrigin;
          lastDims   = newDims;
        };
        window.addEventListener('scroll', resync, { passive: true, capture: true });
        window.addEventListener('resize', resync, { passive: true });
        cleanups.push(() => {
          window.removeEventListener('scroll', resync, { capture: true });
          window.removeEventListener('resize', resync);
        });
      }

      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(pos => {
        const h = document.createElement('div');
        h.className = `wt-resize-handle wt-rh-${pos}`;
        box.appendChild(h);
        cleanups.push(this._makeResizeHandle(h, pos, box, img, origin));
      });
      cleanups.push(this._makeMoveHandle(box, img, origin));

      const toolbar = document.createElement('div');
      toolbar.className = 'wt-detect-toolbar';
      toolbar.innerHTML = `
        <button type="button" class="wt-detect-confirm" title="Use this region">&#10003;</button>
        <button type="button" class="wt-detect-cancel" title="Draw manually instead">&#10005;</button>
      `;
      box.appendChild(toolbar);

      const finish = (result) => {
        cleanups.forEach(fn => fn());
        document.removeEventListener('keydown', onKey);
        box.remove();
        if (this._el === box) this._el = null;
        resolve(result);
      };

      toolbar.querySelector('.wt-detect-confirm').addEventListener('mousedown', e => e.stopPropagation());
      toolbar.querySelector('.wt-detect-cancel').addEventListener('mousedown', e => e.stopPropagation());
      toolbar.querySelector('.wt-detect-confirm').addEventListener('click', () => finish(readPct()));
      toolbar.querySelector('.wt-detect-cancel').addEventListener('click', () => finish(null));

      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter') finish(readPct());
      };
      document.addEventListener('keydown', onKey);

      this._el = box;
      this._cleanup = () => finish(null);
    });
  }

  /** Dismisses any open preview without resolving to a bbox (treated as cancel). */
  dismiss() {
    this._cleanup?.();
  }

  _makeMoveHandle(box, img, origin) {
    let dragging = false, startX, startY, origLeft, origTop;
    const onDown = (e) => {
      if (e.target !== box || e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origLeft = parseFloat(box.style.left) || 0;
      origTop  = parseFloat(box.style.top)  || 0;
      e.preventDefault(); e.stopPropagation();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const iw = img.offsetWidth || img.naturalWidth;
      const ih = img.offsetHeight || img.naturalHeight;
      const o = origin();
      const vAllowance = ih * CROSS_PANEL_DRAG_ALLOWANCE_FRAC;
      const w = parseFloat(box.style.width), h = parseFloat(box.style.height);
      const l = Math.max(o.left, Math.min(o.left + iw - w, origLeft + (e.clientX - startX)));
      const t = Math.max(o.top - vAllowance,  Math.min(o.top + ih - h + vAllowance, origTop  + (e.clientY - startY)));
      box.style.left = `${l}px`;
      box.style.top  = `${t}px`;
    };
    const onUp = () => { dragging = false; };
    box.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      box.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }

  _makeResizeHandle(handle, pos, box, img, origin) {
    let dragging = false, startX, startY, origLeft, origTop, origW, origH;
    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origLeft = parseFloat(box.style.left)   || 0;
      origTop  = parseFloat(box.style.top)    || 0;
      origW    = parseFloat(box.style.width)  || AUTO_DETECT_MIN_W;
      origH    = parseFloat(box.style.height) || AUTO_DETECT_MIN_H;
      e.preventDefault(); e.stopPropagation();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const iw = img.offsetWidth || img.naturalWidth;
      const ih = img.offsetHeight || img.naturalHeight;
      const o = origin();
      let l = origLeft, t = origTop, w = origW, h = origH;

      if (pos.includes('e')) w = Math.max(AUTO_DETECT_MIN_W, origW + dx);
      if (pos.includes('s')) h = Math.max(AUTO_DETECT_MIN_H, origH + dy);
      if (pos.includes('w')) { w = Math.max(AUTO_DETECT_MIN_W, origW - dx); l = Math.min(origLeft + origW - AUTO_DETECT_MIN_W, origLeft + dx); }
      if (pos.includes('n')) { h = Math.max(AUTO_DETECT_MIN_H, origH - dy); t = Math.min(origTop  + origH - AUTO_DETECT_MIN_H, origTop  + dy); }

      const vAllowance = ih * CROSS_PANEL_DRAG_ALLOWANCE_FRAC;
      l = Math.max(o.left, Math.min(o.left + iw - w, l));
      t = Math.max(o.top - vAllowance,  Math.min(o.top + ih - h + vAllowance, t));

      box.style.left   = `${l}px`;
      box.style.top    = `${t}px`;
      box.style.width  = `${w}px`;
      box.style.height = `${h}px`;
    };
    const onUp = () => { dragging = false; };
    handle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      handle.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }
}

// ── Job pipeline (concurrent region translation) ──────────────────────────────
// Each selected region becomes an independent job (queued → ocr → translating →
// done | error) instead of blocking on a modal dialog. Only MAX_CONCURRENT_JOBS
// jobs run at once across the whole pipeline; OCR itself is additionally
// serialized (Tesseract.js is CPU-bound) even when multiple jobs are active,
// while each job's translate step (network-bound) can overlap with others'.

const MAX_CONCURRENT_JOBS = 3;   // total active jobs (OCR+translate combined) — tune against real usage/API limits
const OVERLAP_THRESHOLD   = 0.55; // intersection / min(areaA, areaB) — needs tuning against real screenshots

// Minimum crop size Tesseract's WASM build will accept, measured in the IMAGE'S
// OWN natural pixels (not CSS/display pixels of the on-screen <img>). Webtoon
// panels are often served at a very different resolution than they're displayed
// at, so a "10px" drag on the visible page can still crop down to just 1-2
// natural pixels and crash OCR with "Image too small to scale!!". _cropCanvas/
// fetchAndCrop upscale small crops up to 3x, so this floor is set well above
// Tesseract's own ~3px minimum to leave margin after that upscale.
const MIN_OCR_NATURAL_PX = 10;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/** bbox (%-of-image) -> {w, h} in the image's own natural pixels. */
function bboxNaturalSize(bbox, imageEl) {
  const nw = imageEl.naturalWidth  || imageEl.width  || imageEl.getBoundingClientRect().width  || 1;
  const nh = imageEl.naturalHeight || imageEl.height || imageEl.getBoundingClientRect().height || 1;
  return { w: (bbox.w / 100) * nw, h: (bbox.h / 100) * nh };
}

/** Overlap ratio of two %-of-image bboxes: intersection area / smaller box's area. */
function bboxOverlapRatio(a, b) {
  const ix0 = Math.max(a.x, b.x), iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.w, b.x + b.w), iy1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const interArea = iw * ih;
  if (interArea <= 0) return 0;
  const areaA = a.w * a.h, areaB = b.w * b.h;
  return interArea / Math.min(areaA, areaB);
}

class JobManager {
  /**
   * @param runOcr          async (job) => originalText
   * @param runTranslate    async (job) => translatedText
   * @param onStatusChange  (job) => void — render/update the transient status overlay
   * @param onDone          async (job) => void — persist + render the final bubble
   * @param findOverlap     (bbox, imageIndex, excludeAnnKey) => ratio (0-1) against existing jobs/annotations
   * @param confirmOverlap  async (screenPos) => boolean — "still create a new job here?"
   * @param onTooSmall      (job) => void — bbox is below the OCR-viable natural-pixel floor
   * @param onQueueChange   () => void — active/queued counts changed (for a live badge, etc.)
   */
  constructor({ runOcr, runTranslate, onStatusChange, onDone, findOverlap, confirmOverlap, onTooSmall, onQueueChange }) {
    this._runOcr         = runOcr;
    this._runTranslate    = runTranslate;
    this._onStatusChange  = onStatusChange;
    this._onDone          = onDone;
    this._findOverlap     = findOverlap;
    this._confirmOverlap  = confirmOverlap;
    this._onTooSmall      = onTooSmall;
    this._onQueueChange   = onQueueChange;

    this.jobs           = new Map(); // id -> job
    this._queue          = [];        // pending job ids (FIFO)
    this._active          = new Set(); // active job ids (occupy a concurrency slot)
    this._ocrChainTail   = Promise.resolve(); // serializes OCR across jobs
  }

  async create({ bbox, imageEl, imageIndex, clips, screenPos, existingAnnKey = null, skewAngle = null, source = 'manual' }) {
    const { w: natW, h: natH } = bboxNaturalSize(bbox, imageEl);
    if (natW < MIN_OCR_NATURAL_PX || natH < MIN_OCR_NATURAL_PX) {
      this._onTooSmall?.({ bbox, imageEl, imageIndex, natW, natH });
      return null;
    }
    const overlapRatio = this._findOverlap(bbox, imageIndex, existingAnnKey);
    if (overlapRatio >= OVERLAP_THRESHOLD) {
      const proceed = await this._confirmOverlap(screenPos);
      if (!proceed) return null;
    }
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      bbox, imageEl, imageIndex, clips, existingAnnKey,
      skewAngle, // difficulty-classifier signal from auto-detect; null for manual drag-select (no flood-fill contour to measure) — see runOcr's shadow-mode classification call
      source, // 'auto' (flood-fill detected) | 'manual' (drag-select or hand-resize, default) — gates the OCR-crop inset/text-cluster refinement in runOcr, which only make sense for a flood-fill shape's bbox
      status: 'queued', // queued -> ocr -> translating -> done | error
      originalText: '', translatedText: '', errorMessage: '',
      cancelled: false, createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this._onStatusChange(job);
    this._queue.push(job.id);
    this._pump();
    this._onQueueChange?.();
    return job;
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    this._queue = this._queue.filter(id => id !== jobId);
    this.jobs.delete(jobId);
    this._onStatusChange({ ...job, status: 'removed' });
    this._pump();
    this._onQueueChange?.();
  }

  retry(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'queued';
    job.errorMessage = '';
    job.cancelled = false;
    this._onStatusChange(job);
    this._queue.push(job.id);
    this._pump();
    this._onQueueChange?.();
  }

  activeCount()  { return this._active.size; }
  queuedCount()  { return this._queue.length; }

  _pump() {
    while (this._active.size < MAX_CONCURRENT_JOBS && this._queue.length) {
      const id  = this._queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.cancelled) continue;
      this._process(job);
    }
  }

  async _process(job) {
    this._active.add(job.id);
    this._onQueueChange?.();
    try {
      job.status = 'ocr';
      this._onStatusChange(job);
      const ocrText = await this._runExclusiveOcr(() => this._runOcr(job));
      if (job.cancelled) return;
      job.originalText = ocrText || '';
      if (!ocrText) {
        job.status = 'error';
        job.errorMessage = 'No text found in this region';
        this._onStatusChange(job);
        return;
      }
      console.log('[WebtoonTranslate] OCR text:', ocrText);
      job.status = 'translating';
      this._onStatusChange(job);
      const translated = await this._runTranslate(job);
      if (job.cancelled) return;
      job.translatedText = translated || ocrText;
      job.status = 'done';
      await this._onDone(job);
      this.jobs.delete(job.id); // done jobs become regular annotations, no longer tracked as jobs
    } catch (err) {
      if (job.cancelled) return;
      job.status = 'error';
      job.errorMessage = err?.message || String(err);
      this._onStatusChange(job);
    } finally {
      this._active.delete(job.id);
      this._pump();
      // Fires after the job truly stops occupying a slot — onDone (above) runs
      // while it's still counted active, so a badge relying only on that
      // callback would stay stuck one job over-count after this job finishes.
      this._onQueueChange?.();
    }
  }

  // Chains OCR calls so only one Tesseract recognition runs at a time, even
  // though up to MAX_CONCURRENT_JOBS jobs may be "active" simultaneously —
  // their translate steps (network-bound) can still overlap freely.
  _runExclusiveOcr(fn) {
    const run = this._ocrChainTail.then(fn, fn);
    this._ocrChainTail = run.then(() => {}, () => {});
    return run;
  }
}

/** Transient status pill (queued/ocr/translating/error) shown at a job's bbox. */
class JobOverlayRenderer {
  constructor({ isKakao, onCancel, onRetry }) {
    this._isKakao  = isKakao;
    this._onCancel = onCancel;
    this._onRetry  = onRetry;
    this._els      = new Map(); // jobId -> el
  }

  render(job) {
    if (job.status === 'removed') { this.remove(job.id); return; }
    let el = this._els.get(job.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.jobId = job.id;
      if (this._isKakao) document.body.appendChild(el);
      else this._wrapperFor(job.imageEl).appendChild(el);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.dataset.status === 'error') this._onRetry(job.id);
      });
      this._els.set(job.id, el);
    }
    el.className = `wt-job-overlay wt-job-${job.status}${this._isKakao ? ' wt-job-fixed' : ''}`;
    el.dataset.status = job.status;

    const labels = { queued: 'Pending…', ocr: 'Scanning text…', translating: 'Translating…' };
    const label = job.status === 'error' ? (job.errorMessage || 'Error') : (labels[job.status] || '');
    const cancellable = job.status !== 'error';
    el.innerHTML = `
      <span class="wt-job-spinner"></span>
      <span class="wt-job-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <button type="button" class="${cancellable ? 'wt-job-cancel' : 'wt-job-dismiss'}" title="${cancellable ? 'Cancel' : 'Dismiss'}">&#10005;</button>
    `;
    el.querySelector('.wt-job-cancel, .wt-job-dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      this._onCancel(job.id);
    });
    this._position(el, job);
  }

  remove(jobId) {
    this._els.get(jobId)?.remove();
    this._els.delete(jobId);
  }

  repositionAll() {
    for (const [jobId, el] of this._els) {
      const job = el._job;
      if (job) this._position(el, job);
    }
  }

  _wrapperFor(img) {
    return img.parentElement;
  }

  _position(el, job) {
    el._job = job;
    const { bbox, imageEl: img } = job;
    if (this._isKakao) {
      const r  = img.getBoundingClientRect();
      const iw = r.width  || img.naturalWidth  || 375;
      const ih = r.height || img.naturalHeight || 500;
      el.style.left = `${r.left + window.scrollX + (bbox.x / 100) * iw}px`;
      el.style.top  = `${r.top  + window.scrollY + (bbox.y / 100) * ih}px`;
      el.style.maxWidth = `${(bbox.w / 100) * iw}px`;
    } else {
      const iw = img.naturalWidth  || img.getBoundingClientRect().width  || img.offsetWidth  || 375;
      const ih = img.naturalHeight || img.getBoundingClientRect().height || img.offsetHeight || 500;
      el.style.left = `${(bbox.x / 100) * iw}px`;
      el.style.top  = `${(bbox.y / 100) * ih}px`;
      el.style.maxWidth = `${(bbox.w / 100) * iw}px`;
    }
  }
}

/** Small floating Yes/No popup — used to confirm creating a job over a likely-duplicate region. */
class ConfirmPopup {
  constructor() { this._el = null; }

  show(screenPos, message) {
    this.dismiss();
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'wt-confirm-popup';
      box.style.left = `${screenPos.x}px`;
      box.style.top  = `${screenPos.y}px`;
      box.innerHTML = `
        <div class="wt-confirm-msg">${escapeHtml(message)}</div>
        <div class="wt-confirm-actions">
          <button type="button" class="wt-confirm-no">Cancel</button>
          <button type="button" class="wt-confirm-yes">Create anyway</button>
        </div>`;
      document.body.appendChild(box);
      const finish = (v) => {
        document.removeEventListener('keydown', onKey);
        box.remove();
        if (this._el === box) this._el = null;
        resolve(v);
      };
      box.querySelector('.wt-confirm-yes').addEventListener('click', () => finish(true));
      box.querySelector('.wt-confirm-no').addEventListener('click', () => finish(false));
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      document.addEventListener('keydown', onKey);
      this._el = box;
    });
  }

  dismiss() { this._el?.remove(); this._el = null; }
}

/**
 * Popover for previewing/testing the LLM prompt for a single region. Opened
 * only by an explicit click on a region's "Test LLM" button (see
 * .wt-bt-llm-test in the bubble toolbar) — never auto-opened, since regions
 * are OCR'd/translated concurrently (MAX_CONCURRENT_JOBS at once) and an
 * auto-popping modal per region would fight that flow.
 *
 * This is a preview/inspection tool only: "Send to LLM" calls the user's BYOK
 * provider and displays the raw reply here, but never writes it back into the
 * region's saved translation — the region keeps showing its normal
 * Google/DeepL-translated result regardless of what happens in this popover.
 */
class LlmTestPopover {
  constructor() { this._el = null; }

  dismiss() {
    this._el?.remove();
    this._el = null;
    if (this._onOutside) document.removeEventListener('mousedown', this._onOutside);
    this._onOutside = null;
  }

  /**
   * onApply(replyText) — optional async callback that writes the LLM's reply
   * into the region's displayed translation (see applyTranslatedText in
   * bootForPage). Omitted/no-op leaves this purely a read-only preview, same
   * as before this button existed.
   */
  show(screenPos, prompt, onApply) {
    this.dismiss();
    const box = document.createElement('div');
    box.className = 'wt-llm-popover';
    box.style.left = `${screenPos.x}px`;
    box.style.top  = `${screenPos.y}px`;
    box.innerHTML = `
      <div class="wt-llm-popover-header">
        <span class="wt-llm-popover-title">LLM Prompt Preview</span>
        <button type="button" class="wt-llm-popover-close" title="Close">&#10005;</button>
      </div>
      <textarea class="wt-llm-popover-prompt" readonly spellcheck="false">${escapeHtml(prompt)}</textarea>
      <button type="button" class="wt-llm-popover-send">Send to LLM</button>
      <div class="wt-llm-popover-result hidden"></div>
      <button type="button" class="wt-llm-popover-apply hidden">Apply to region</button>
    `;
    document.body.appendChild(box);
    this._el = box;
    let lastReply = null;

    box.querySelector('.wt-llm-popover-close').addEventListener('click', () => this.dismiss());

    const applyBtn = box.querySelector('.wt-llm-popover-apply');

    box.querySelector('.wt-llm-popover-send').addEventListener('click', async (e) => {
      e.stopPropagation();
      lastReply = null;
      applyBtn.classList.add('hidden');
      const resultEl = box.querySelector('.wt-llm-popover-result');
      resultEl.classList.remove('hidden', 'wt-llm-popover-error');
      resultEl.classList.add('wt-llm-popover-loading');
      resultEl.textContent = 'Sending…';
      try {
        const reply = await callByokLlm(prompt);
        resultEl.classList.remove('wt-llm-popover-loading');
        resultEl.textContent = reply;
        lastReply = reply;
        if (onApply && reply) applyBtn.classList.remove('hidden');
      } catch (err) {
        resultEl.classList.remove('wt-llm-popover-loading');
        resultEl.classList.add('wt-llm-popover-error');
        resultEl.textContent = `Error: ${err?.message || err}`;
      }
    });

    // Applies the raw LLM reply as-is to the region's saved translation —
    // still never mutates anything until the user explicitly clicks this;
    // the region keeps its prior (e.g. Google-translated) text until then.
    applyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!onApply || !lastReply) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      try {
        await onApply(lastReply);
        this.dismiss();
      } catch (err) {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply to region';
        showToast(`✗ Apply failed: ${err?.message || err}`, '#ef4444');
      }
    });

    this._onOutside = (e) => { if (!box.contains(e.target)) this.dismiss(); };
    setTimeout(() => document.addEventListener('mousedown', this._onOutside), 0);
  }
}

// ── BBoxSelector ─────────────────────────────────────────────────────────────

const BBOX_SELECTOR_CLICK_THRESHOLD_PX = 5; // pointer movement below this is treated as a click, not a drag

class BBoxSelector {
  constructor({ onSelect, onClick, onDragStart }) {
    this.onSelect      = onSelect;
    this.onClick       = onClick;      // ({ img, overlay, clickX, clickY, imgRect, imageIndex }) — fired on click (no drag)
    this.onDragStart   = onDragStart;  // () => void — fired when a manual drag starts
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
      this.onDragStart?.();
      overlay.classList.add('wt-dragging'); // pointer -> crosshair while an actual drag is happening
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
      overlay.classList.remove('wt-dragging');
      this._currentDrag = null;

      // Minimal pointer movement -> treat as a click and try auto-detect first;
      // manual drag-to-select (below) remains the fallback for anything larger.
      if (Math.hypot(ex - startX, ey - startY) < BBOX_SELECTOR_CLICK_THRESHOLD_PX) {
        const imgRect = img.getBoundingClientRect();
        const clickX = e.clientX - imgRect.left, clickY = e.clientY - imgRect.top;
        if (clickX >= 0 && clickY >= 0 && clickX <= imgRect.width && clickY <= imgRect.height) {
          this.onClick?.({ img, overlay, clickX, clickY, imgRect, imageIndex });
        }
        return;
      }

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

/**
 * Small "re-translate" button appended to every finished bubble (regardless
 * of which translation API produced it — Google, DeepL, or an applied LLM
 * test result), shown on hover via CSS (see .wt-bubble-reload in
 * overlay.css). Shared by OverlayRenderer and FixedOverlayLayer's
 * _createBubble so the two near-identical bubble-DOM builders don't each
 * carry their own copy of this wiring.
 */
function createBubbleReloadButton(onReload, ann, img) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wt-bubble-reload';
  btn.title = 'Re-translate this region';
  btn.innerHTML = BUBBLE_RELOAD_ICON;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also open the click-to-open edit/resize/delete toolbar
    if (btn.disabled) return;
    onReload?.(ann, img, btn);
  });
  return btn;
}

// ── OverlayRenderer ───────────────────────────────────────────────────────────

class OverlayRenderer {
  constructor({ onReload } = {}) {
    this.imageState      = new Map();
    this._onReload       = onReload; // (annotation, img, buttonEl) — re-translate this region, see bootForPage's retranslateAnnotation
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
      const bubble = this._createBubble(ann, img);
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
    const bubble = this._createBubble(annotation, img);
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

  _createBubble(ann, img) {
    const b = document.createElement('div');
    b.className       = 'wt-translation-bubble';
    b.dataset.annKey  = this._annKey(ann);
    b.dataset.bboxX   = ann.bbox.x;
    b.dataset.bboxY   = ann.bbox.y;
    b.dataset.bboxW   = ann.bbox.w;
    b.dataset.bboxH   = ann.bbox.h;
    if (ann.style) {
      const s = ann.style;
      b.style.fontWeight = s.bold   ? 'bold'   : 'normal';
      b.style.fontStyle  = s.italic ? 'italic' : 'normal';
      b.style.color      = s.color  || '#1a1a2e';
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
    // See FixedOverlayLayer._createBubble for why background lives on the span.
    const span = document.createElement('span');
    span.className = 'wt-bubble-text';
    span.textContent = ann.translatedText;
    const s = ann.style || {};
    span.style.background = s.noBg ? 'transparent' : hexToRgba(s.bg || '#ffffff', OVERLAY_BG_OPACITY);
    b.appendChild(span);
    b.appendChild(createBubbleReloadButton(this._onReload, ann, img));

    const rect = img.getBoundingClientRect();
    const iw = img.naturalWidth  || rect.width  || img.offsetWidth  || 375;
    const ih = img.naturalHeight || rect.height || img.offsetHeight || 500;
    // side-by-side mode: a fixed-width caption in the page's own margin, not
    // an overlay on the (often oval) bubble shape — no oval-corner margin.
    const boxWidthPx = _overlayMode === 'side-by-side' ? SIDE_BY_SIDE_WIDTH_PX : (ann.bbox.w / 100) * iw;
    const boxHeightPx = applyAutoFit(b, span, ann, boxWidthPx, (ann.bbox.h / 100) * ih, _overlayMode !== 'side-by-side');
    b.dataset.autoFitHeightPx = boxHeightPx;

    return b;
  }

  _positionBubble(bubble, bbox, img) {
    const rect = img.getBoundingClientRect();
    // Kakao uses padding-top ratio so rect.height may be 0 — fallback to naturalHeight
    const iw = img.naturalWidth  || rect.width  || img.offsetWidth  || 375;
    const ih = img.naturalHeight || rect.height || img.offsetHeight || 500;
    // autoFitHeightPx (set once at _createBubble time) may exceed the raw
    // bbox-derived height — see fitAndExpand(). Not recomputed on reposition/
    // resize; same pre-existing limitation the font-size styling already had.
    const storedH = parseFloat(bubble.dataset.autoFitHeightPx);
    const h = !isNaN(storedH) ? storedH : (bbox.h / 100) * ih;

    if (_overlayMode === 'side-by-side') {
      // Rendered entirely outside the panel, in the wrapper's own overflow
      // margin to the right of it (the wrapper has no overflow:hidden, so
      // this paints in the page's blank space rather than being clipped),
      // at the same vertical position as the original bubble — not overlaid
      // on the art at all. Needs actual blank page space there to be
      // visible; on a full-bleed viewer with no side margin this can render
      // off-screen or over neighboring page content.
      bubble.style.left      = `${iw + SIDE_BY_SIDE_GAP_PX}px`;
      bubble.style.top       = `${(bbox.y / 100) * ih}px`;
      bubble.style.width     = `${SIDE_BY_SIDE_WIDTH_PX}px`;
      bubble.style.maxWidth  = '';
      bubble.style.minHeight = '';
    } else {
      const x = (bbox.x / 100) * iw;
      bubble.style.left      = `${x}px`;
      bubble.style.width     = `${(bbox.w / 100) * iw}px`;
      bubble.style.maxWidth  = `${iw - x}px`;
      bubble.style.top       = `${(bbox.y / 100) * ih}px`;
      bubble.style.minHeight = `${h}px`;
    }
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

// ── SidePanel ────────────────────────────────────────────────────────────────
// Persistent side panel listing every original/translated text pair on the
// page — a dev-only inspection tool (gated by __DEV_TOOLS__ below), kept
// around for testing the difficulty-classifier and story-context features.
// __DEV_TOOLS_BLOCK_START__

class SidePanel {
  constructor({ onJump }) {
    this._onJump   = onJump;
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
      <div class="wt-sp-list"></div>`;

    this._el.querySelector('.wt-sp-close').addEventListener('click', () => this.hide());

    // Start hidden (off-screen right)
    this._el.style.transform = `translateX(${PANEL_W}px)`;
    this._el.style.opacity   = '0';

    document.body.appendChild(this._el);
  }

  _renderList(annotations) {
    const list = this._el.querySelector('.wt-sp-list');
    list.innerHTML = '';

    if (!annotations.length) {
      list.innerHTML = '<div class="wt-sp-empty">No translations yet.<br>Click (or drag) on any speech bubble to add one.</div>';
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

        // Read-only list — no inline edit/delete here; use the overlay's own
        // bubble toolbar (click a bubble on the page) for that.
        row.innerHTML = `
          <div class="wt-sp-row-text">${ann.translatedText}</div>
          ${ann.originalText ? `<div class="wt-sp-row-orig">${ann.originalText}</div>` : ''}`;

        row.addEventListener('click', () => {
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
            return;
          }
          this._onJump?.(ann, img);
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
// __DEV_TOOLS_BLOCK_END__

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

// ── Story Context (lazy auto-fetch, for future LLM translation modes) ─────────
// Fetches synopsis/tags/author/age-rating from a title's info page (not the
// chapter page itself) so it can eventually be injected into an LLM
// translation prompt alongside chapter/character memory. Naver-only for now;
// scoped to a per-site adapter method (fetchStoryContext) so a future
// KakaoAdapter can add its own implementation without touching this file —
// getStoryContext() below is adapter-agnostic and no-ops for any adapter that
// doesn't implement fetchStoryContext.
//
// NOTE: there is currently no LLM prompt-building step anywhere in this
// codebase to wire the result into — translation today is plain string
// translation via Google/DeepL (see autoTranslate()). This only builds the
// fetch+cache foundation; a future Mode B/C implementation should call
// getStoryContext(adapter, meta.site, meta.titleId) (already memoized) when
// constructing its prompt.

const STORY_CONTEXT_KEY_PREFIX = 'wt:story-context:';
const _storyContextInFlight = new Map(); // "site:titleId" -> Promise, dedupes concurrent lazy-fetch triggers
// Bump this whenever fetchStoryContext's extraction logic changes in a way
// that could change the resulting data (new field, fixed selector, switched
// data source entirely, etc.) — a cached entry stamped with an older version
// is treated as a miss and re-fetched. Without this, "no expiry in v1" means
// a title cached under an old, since-fixed bug (e.g. empty tags from the
// broken HTML-scraping approach) would silently keep serving that stale,
// wrong data forever with no way to tell short of manually clearing storage.
const STORY_CONTEXT_SCHEMA_VERSION = 2;

/**
 * Lazily fetches + caches Story Context for a title, keyed by site+titleId.
 * Doesn't re-fetch a cache hit stamped with the current
 * STORY_CONTEXT_SCHEMA_VERSION (synopsis/tags/author rarely change after a
 * title publishes) — but a hit from an older schema version is treated as a
 * miss and re-fetched, so a fix to the extraction logic actually takes
 * effect instead of being masked by stale cached data indefinitely.
 * Concurrent calls for the same title (e.g. several jobs starting near-
 * simultaneously) share one in-flight fetch. Resolves to null (never
 * rejects) if the adapter has no fetchStoryContext implementation, or if the
 * fetch/parse fails — logged as a console warning, never surfaced to the
 * user or allowed to block translation.
 */
async function getStoryContext(adapter, site, titleId) {
  if (typeof adapter.fetchStoryContext !== 'function') return null;
  const key = `${STORY_CONTEXT_KEY_PREFIX}${site}:${titleId}`;

  const stored = await chrome.storage.local.get(key);
  if (stored[key] && stored[key].schemaVersion === STORY_CONTEXT_SCHEMA_VERSION) {
    // Cache-hit path never used to log anything, which reads as "nothing
    // happened" on every run after the first — log every time so it's
    // always visible, not just on a fresh fetch.
    console.log(`[WebtoonTranslate] StoryContext(${site}) cache hit:`, stored[key]);
    return stored[key];
  }
  if (stored[key]) {
    console.log(`[WebtoonTranslate] StoryContext(${site}) cache stale (schema v${stored[key].schemaVersion ?? 'none'} -> v${STORY_CONTEXT_SCHEMA_VERSION}), re-fetching`);
  }

  if (_storyContextInFlight.has(key)) return _storyContextInFlight.get(key);

  const promise = (async () => {
    try {
      const ctx = await adapter.fetchStoryContext(titleId);
      if (ctx) {
        ctx.schemaVersion = STORY_CONTEXT_SCHEMA_VERSION;
        await chrome.storage.local.set({ [key]: ctx });
      }
      return ctx || null;
    } catch (err) {
      console.warn('[WebtoonTranslate] StoryContext fetch failed for', site, titleId, err);
      return null;
    } finally {
      _storyContextInFlight.delete(key);
    }
  })();
  _storyContextInFlight.set(key, promise);
  return promise;
}

// Converts a stored target-language code (e.g. 'vi', 'zh-CN' — same codes
// used by the Target Language <select> in settings.html) into an English
// display name for the LLM instruction, via the built-in Intl API rather
// than a second hardcoded code->name list that could drift out of sync with
// that dropdown's options.
function targetLanguageDisplayName(langCode) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode) || langCode;
  } catch {
    return langCode;
  }
}

// ── LLM prompt formatting (manual "Test LLM" preview only, see LlmTestPopover) ──
// Plain string formatting (title + tags + synopsis + OCR text) — no template
// engine and no LLM-based compression, consistent with the earlier decision to
// keep Story Context assembly simple. Character memory / chapter summary
// aren't built yet, so they're intentionally omitted here rather than stubbed
// with placeholder text; nothing built from this function is wired into the
// automatic translation pipeline (see autoTranslate()) — it only feeds the
// manual per-region preview/test popover. Only one call site exists (the
// "Test LLM" button handler below), so adding the targetLang param here can't
// unexpectedly change behavior anywhere else.
function formatLlmPrompt(storyContext, ocrText, targetLang) {
  const lines = [];
  if (storyContext?.title)          lines.push(`Title: ${storyContext.title}`);
  if (storyContext?.tags?.length)   lines.push(`Tags: ${storyContext.tags.join(', ')}`);
  if (storyContext?.synopsis)       lines.push(`Synopsis: ${storyContext.synopsis}`);
  lines.push('');
  lines.push(
    `Translate the following Korean webtoon dialogue/narration into ${targetLanguageDisplayName(targetLang)}. ` +
    'Output ONLY the translated text itself — no alternatives, no explanation, no markdown formatting. ' +
    'Choose the single most natural and contextually appropriate translation.'
  );
  lines.push(ocrText);
  return lines.join('\n');
}

// ── Adapters ──────────────────────────────────────────────────────────────────

class NaverAdapter {
  detect() {
    return location.hostname.endsWith('comic.naver.com') &&
           (location.pathname.startsWith('/webtoon/detail') ||
            location.pathname.startsWith('/challenge/detail') ||
            location.pathname.startsWith('/bestChallenge/detail'));
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

  /**
   * Fetches Story Context from Naver's own title-info JSON API (not the list
   * page's HTML at all — found via the network tab: the list page itself
   * calls this same endpoint client-side to render its title header). Same-
   * origin, returns clean structured JSON, so no HTML/selector parsing, no
   * hidden-iframe rendering, no client-side-rendering timing concerns — all
   * of which the two previous approaches (fetch()+DOMParser, then a
   * rendered-iframe fallback once the tag data turned out to be client-
   * rendered) needed to work around. `tab`/`week` isn't required — titleId
   * alone is enough.
   *
   * Every field is still independently best-effort per REQUIREMENTS #5 — a
   * field missing from the response logs a console.warn and is left
   * undefined rather than throwing or blocking the others.
   */
  async fetchStoryContext(titleId) {
    const url = `https://comic.naver.com/api/article/list/info?titleId=${encodeURIComponent(titleId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const json = await res.json();

    const ctx = { site: SITES.NAVER, titleId, fetchedAt: new Date().toISOString() };

    ctx.title = json.titleName || undefined;
    if (!ctx.title) console.warn('[WebtoonTranslate] StoryContext(naver): titleName missing from API response');

    ctx.synopsis = json.synopsis || undefined;
    if (!ctx.synopsis) console.warn('[WebtoonTranslate] StoryContext(naver): synopsis missing from API response');

    ctx.tags = Array.isArray(json.curationTagList)
      ? json.curationTagList.map(t => t.tagName).filter(Boolean)
      : [];
    if (!ctx.tags.length) console.warn('[WebtoonTranslate] StoryContext(naver): curationTagList missing/empty in API response');

    ctx.author = Array.isArray(json.communityArtists)
      ? json.communityArtists.map(a => a.name).filter(Boolean).join(', ') || undefined
      : undefined;
    if (!ctx.author) console.warn('[WebtoonTranslate] StoryContext(naver): communityArtists missing/empty in API response');

    ctx.ageRating = json.age?.description || undefined;
    if (!ctx.ageRating) console.warn('[WebtoonTranslate] StoryContext(naver): age.description missing from API response');

    console.log('[WebtoonTranslate] StoryContext(naver) fetched:', ctx);
    return ctx;
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
// A flood-fill bubble's bbox is the RECTANGLE circumscribing an often
// round/oval/irregular shape — for round bubbles that rectangle extends well
// beyond the actual text into empty background and (sometimes) the bubble's
// outline stroke. Tesseract misreads that margin's curves/edge-artifacts as
// stray characters, garbling the real text. This never shows up for
// rectangular bubbles, whose bbox already hugs the text tightly.
//
// Fix: shrink the bbox toward its own center by a fixed percentage on each
// side before it's used to crop the OCR input image — a separate, OCR-only
// crop step. This must NOT touch the bbox used for anything else (overlay
// render bounds, waist-splitting, validity checks, the persisted
// annotation) — those still need the full bubble extent. Deliberately not
// the same constant as AUTO_FIT_WIDTH_MARGIN/AUTO_FIT_HEIGHT_MARGIN (the
// oval-overflow fix for rendering TRANSLATED text back into the bubble) —
// that's a different concern (output rendering vs. OCR input cropping).
//
// Coarse by design: a uniform inset assumes margin is roughly evenly
// distributed around the text, which won't hold for bubbles where the text
// sits hard against the boundary on one side. This is no longer the only
// pass — worker.js's refineOcrCropToTextCluster runs a second, precise
// dark-pixel-cluster pass on top of this crop — so this first pass only
// needs to knock off the worst of the outline/margin, not get close to the
// text. Real-world testing found the original 17.5%/side default clipping
// trailing characters of off-center text (e.g. text sitting at ~91% of the
// bbox width got its last couple characters cut by an 82.5% right edge),
// which the second pass can't recover once the pixels are gone — reduced
// accordingly. Still needs tuning against more real screenshots.
const OCR_CROP_INSET_PCT = 0.08; // % of width/height trimmed from EACH side (e.g. 0.08 = 8%/side, ~16% off each dimension total)

// A box that dips only marginally past an image's true edge (e.g. a
// hand-resized box that overshoots by a fraction of a percent into the
// selector overlay's 80px drag-tolerance zone) doesn't necessarily mean the
// dialogue actually continues into the next panel — but the grab-amount
// formula below (grabH) has a generous ~40%-of-image-height floor regardless
// of how small the overflow is, so triggering on ANY overflow, however
// trivial, can staple a large chunk of unrelated next-panel content onto an
// otherwise perfectly legible crop and confuse Tesseract into misreading the
// whole thing (found via real-world testing: a resized box that barely
// crossed the boundary came back with garbage digits instead of its two
// perfectly legible lines of dialogue). Only overflow past this threshold is
// treated as "genuinely needs the next panel" — needs tuning against real
// cross-panel screenshots (both marginal-dip and real multi-panel cases).
const OCR_CROSS_PANEL_OVERFLOW_THRESHOLD_PCT = 3;

/** Shrinks a %-of-image bbox toward its own center for the OCR crop only — see the OCR section note above. */
function _insetBboxForOcr(bbox) {
  const insetX = bbox.w * OCR_CROP_INSET_PCT;
  const insetY = bbox.h * OCR_CROP_INSET_PCT;
  return {
    x: bbox.x + insetX,
    y: bbox.y + insetY,
    w: Math.max(0, bbox.w - 2 * insetX),
    h: Math.max(0, bbox.h - 2 * insetY),
  };
}

/** Same as _insetBboxForOcr but only shrinks the horizontal (x/w) extent, leaving y/h untouched — see ocrRegionStitched for why a cross-panel-spanning bbox needs this instead. */
function _insetBboxXOnlyForOcr(bbox) {
  const insetX = bbox.w * OCR_CROP_INSET_PCT;
  return { x: bbox.x + insetX, y: bbox.y, w: Math.max(0, bbox.w - 2 * insetX), h: bbox.h };
}

/**
 * `applyOcrRefinement` gates the percentage-inset + (worker-side)
 * text-cluster refinement — both exist to correct for a flood-fill bubble's
 * bbox extending past its actual text into margin/outline. A manually
 * drag-selected (or hand-resized) bbox never went through flood-fill — the
 * user already selected exactly the text they want — so applying either
 * step there could needlessly shrink/distort an intentionally-sized region.
 * Defaults to true (auto-detect's existing behavior); callers pass false for
 * manual regions — see runOcr, which decides this from job.source.
 */
async function ocrRegion(img, bbox, applyOcrRefinement = true) {
  const cropBbox = applyOcrRefinement ? _insetBboxForOcr(bbox) : bbox;
  // Fast path: draw the already-loaded DOM image directly.
  // blob: URLs (Kakao) are same-origin → never tainted.
  // CDN images without crossOrigin attr may taint the canvas → SecurityError.
  // In that case pass imageUrl to the background service worker, which can
  // fetch cross-origin freely and do the crop there.
  let dataUrl = null;
  try {
    dataUrl = _cropCanvas(img, cropBbox);
  } catch (e) {
    if (!(e instanceof DOMException) || e.name !== 'SecurityError') throw e;
  }

  const res = await sendToBackground({
    type: MSG.OCR_REGION,
    payload: { dataUrl, imageUrl: dataUrl ? null : img.src, bbox: cropBbox, refineCrop: applyOcrRefinement },
  });
  if (!res?.ok) throw new Error(res?.error || 'OCR failed');
  return { text: res.text, confidence: res.confidence };
}

async function ocrRegionStitched(img, rawBbox, images, applyOcrRefinement = true) {
  // A bubble that visually spans two stacked panel images needs its
  // cross-panel overflow amount (below) computed from the TRUE selection
  // extent — shrinking y/h first (as the plain 2-axis inset does) can pull a
  // borderline overflow back under the 100%/0% trigger entirely, silently
  // dropping the neighboring panel's portion of the text from the crop
  // (found via real-world testing: a bubble spanning two panels came back
  // with zero OCR'd text). So a cross-panel-spanning bbox only gets the
  // horizontal inset here; the worker-side text-cluster refinement trims
  // vertical margin AFTER stitching, once both panels' pixels are already
  // combined into one coordinate space. A single-panel bbox (the common
  // case) is unaffected and still gets the full 2-axis inset. Manual
  // regions (applyOcrRefinement false) skip all of this — rawBbox as-is.
  const crossesPanel = rawBbox.y < 0 || (rawBbox.y + rawBbox.h) > 100;
  const bbox = !applyOcrRefinement
    ? rawBbox
    : (crossesPanel ? _insetBboxXOnlyForOcr(rawBbox) : _insetBboxForOcr(rawBbox));
  const idx        = images.indexOf(img);
  const bottomEdge = bbox.y + bbox.h;  // may exceed 100 when user drags past image bottom
  const topEdge    = bbox.y;           // may be < 0 when user drags past image top
  const imgDispW   = img.getBoundingClientRect().width;
  const dispW      = (bbox.w / 100) * imgDispW;

  // Primary clip — clamp to valid image coordinates
  const primaryH = Math.min(bbox.h, 100 - Math.max(0, bbox.y));
  const primaryY = Math.max(0, bbox.y);
  const clips = [{ img, x: bbox.x, y: primaryY, w: bbox.w, h: Math.max(1, primaryH), dispW }];

  // Bottom cross-panel: only when the overflow past the image boundary is
  // meaningful (see OCR_CROSS_PANEL_OVERFLOW_THRESHOLD_PCT above), not a
  // marginal dip that doesn't actually need next-panel content.
  if (bottomEdge > 100 + OCR_CROSS_PANEL_OVERFLOW_THRESHOLD_PCT && idx >= 0 && idx < images.length - 1) {
    const nextImg = images[idx + 1];
    if (nextImg.src && !nextImg.src.startsWith('data:')) {
      const nextDispW = (bbox.w / 100) * (nextImg.getBoundingClientRect().width || imgDispW);
      const overflow  = bottomEdge - 100;
      const grabH     = Math.max(overflow + 10, 40);
      clips.push({ img: nextImg, x: bbox.x, y: 0, w: bbox.w, h: Math.min(grabH, 60), dispW: nextDispW });
    }
  }

  // Top cross-panel: only when the overflow past the image top is
  // meaningful (see OCR_CROSS_PANEL_OVERFLOW_THRESHOLD_PCT above).
  if (topEdge < -OCR_CROSS_PANEL_OVERFLOW_THRESHOLD_PCT && idx > 0) {
    const prevImg = images[idx - 1];
    if (prevImg.src && !prevImg.src.startsWith('data:')) {
      const prevDispW = (bbox.w / 100) * (prevImg.getBoundingClientRect().width || imgDispW);
      const overflow  = -topEdge;
      const grabH     = Math.max(overflow + 10, 40);
      clips.unshift({ img: prevImg, x: bbox.x, y: Math.max(0, 100 - grabH), w: bbox.w, h: Math.min(grabH, 60), dispW: prevDispW });
    }
  }

  // rawBbox, not bbox — ocrRegion applies its own inset; insetting twice would over-crop.
  if (clips.length === 1) return ocrRegion(img, rawBbox, applyOcrRefinement);

  // Try client-side stitching (same-origin/blob images)
  const dataUrl = stitchClips(clips);
  if (dataUrl) {
    const res = await sendToBackground({
      type: MSG.OCR_REGION,
      payload: { dataUrl, imageUrl: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, refineCrop: applyOcrRefinement },
    });
    if (!res?.ok) throw new Error(res?.error || 'OCR failed');
    return { text: res.text, confidence: res.confidence };
  }

  // Cross-origin: send to background for fetch+stitch
  const bgClips = clips.map(({ img: i, x, y, w, h, dispW: dw }) => ({ imageUrl: i.src, bbox: { x, y, w, h }, dispW: dw }));
  const res = await sendToBackground({ type: MSG.OCR_STITCH, payload: { clips: bgClips, refineCrop: applyOcrRefinement } });
  if (!res?.ok) throw new Error(res?.error || 'OCR stitch failed');
  return { text: res.text, confidence: res.confidence };
}

async function ocrClips(clips, applyOcrRefinement = true) {
  // clips from FixedOverlayLayer: {img, bbox: {x,y,w,h}}
  // Convert to internal {img, x, y, w, h, dispW} format, insetting each
  // clip's bbox for the OCR crop (see the OCR section note above) unless
  // this is a manual region (applyOcrRefinement false) — see runOcr.
  const items = clips.map(c => {
    const r = c.img.getBoundingClientRect();
    const cropBbox = applyOcrRefinement ? _insetBboxForOcr(c.bbox) : c.bbox;
    return {
      img:   c.img,
      x:     cropBbox.x, y: cropBbox.y, w: cropBbox.w, h: cropBbox.h,
      dispW: (cropBbox.w / 100) * r.width,
    };
  });

  // Try client-side stitch first
  const dataUrl = stitchClips(items);
  if (dataUrl) {
    const res = await sendToBackground({
      type: MSG.OCR_REGION,
      payload: { dataUrl, imageUrl: null, bbox: { x: 0, y: 0, w: 100, h: 100 }, refineCrop: applyOcrRefinement },
    });
    if (!res?.ok) throw new Error(res?.error || 'OCR failed');
    return { text: res.text, confidence: res.confidence };
  }
  // Cross-origin: background fetch+stitch
  const bgClips = items.map(({ img, x, y, w, h, dispW }) => ({ imageUrl: img.src, bbox: { x, y, w, h }, dispW }));
  const res = await sendToBackground({ type: MSG.OCR_STITCH, payload: { clips: bgClips, refineCrop: applyOcrRefinement } });
  if (!res?.ok) throw new Error(res?.error || 'OCR stitch failed');
  return { text: res.text, confidence: res.confidence };
}

// Stitch multiple image clips vertically into one canvas.
// All clips are normalized to the SAME output pixel width (based on display width)
// so text from different panels renders at the same scale.
function stitchClips(clips) {
  try {
    const items = clips.map(({ img, x, y, w, h, dispW }) => {
      const nw = img.naturalWidth  || img.width  || img.offsetWidth;
      const nh = img.naturalHeight || img.height || img.offsetHeight;
      const px = (x / 100) * nw;
      const py = (y / 100) * nh;
      const pw = Math.max(1, (w / 100) * nw);
      const ph = Math.max(1, (h / 100) * nh);
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

  // Google Translate (unofficial free endpoint) — also the fallback for
  // 'byok', which isn't wired into this automatic pipeline yet (see
  // callByokLlm/LlmTestPopover for the manual per-region preview instead).
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data[0].map(s => s[0]).join('');
}

/**
 * Calls the user's BYOK LLM with a prompt built by formatLlmPrompt(), for the
 * manual "Test LLM" preview button only (see LlmTestPopover) — never called
 * from the automatic translation pipeline (autoTranslate above).
 *
 * Provider/model are stored as two separate settings values (not a combined
 * "provider/model" string — the Settings UI now uses a constrained Provider
 * dropdown + free-text Model field, see settings.html/js). The dropdown's
 * options and the actual request shape both come from the shared adapter
 * registry (extension/shared/llm-adapters.js, loaded as a content script
 * before this file — see manifest.json), so they can't drift apart.
 */
async function callByokLlm(prompt) {
  const s = await chrome.storage.local.get({
    'wt:byok-key':      '',
    'wt:byok-provider': '',
    'wt:byok-model':    '',
  });
  const apiKey     = s['wt:byok-key'];
  const providerId = s['wt:byok-provider'];
  const model      = s['wt:byok-model'];
  if (!apiKey) throw new Error('No BYOK API key set — add one in Settings');
  if (!providerId) throw new Error('No provider selected — pick one in Settings');
  if (!model) throw new Error('No model set — add one in Settings');

  const adapter = getLlmAdapter(providerId);
  if (!adapter) throw new Error(`Unknown provider "${providerId}" — pick one from the Settings dropdown`);
  return adapter.callApi(apiKey, model, prompt);
}

function _cropCanvas(img, bbox) {
  const nw = img.naturalWidth  || img.width  || img.offsetWidth;
  const nh = img.naturalHeight || img.height || img.offsetHeight;
  const sx = (bbox.x / 100) * nw;
  const sy = (bbox.y / 100) * nh;
  const sw = Math.max(1, (bbox.w / 100) * nw);
  const sh = Math.max(1, (bbox.h / 100) * nh);
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

// ── Translation visibility toggle ────────────────────────────────────────────
let _translationsVisible = true;

const EYE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const SCAN_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>`;

// Bubble action toolbar icons — same Feather-style outline language as SCAN_ICON/EYE_ICON above.
const BT_EDIT_ICON   = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const BT_RESIZE_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const BT_DELETE_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
// Manual per-region "Test LLM" prompt-preview button (see LlmTestPopover) —
// only shown when BYOK is the selected Translation API and a key is set.
const BT_LLM_ICON    = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v3a4 4 0 0 0-2 3.46V19a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-6.54A4 4 0 0 0 16 9V6a4 4 0 0 0-4-4z"/><path d="M9 12h.01M15 12h.01"/></svg>`;
// Small per-bubble "re-translate" button, shown on hover over any finished
// bubble (Google/DeepL or LLM alike) — see .wt-bubble-reload in overlay.css
// and the onReload callback wired into OverlayRenderer/FixedOverlayLayer.
const BUBBLE_RELOAD_ICON = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

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
  get usesFixedOverlay() { return true; }

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

  // Extract image URLs from __NEXT_DATA__ so we can identify panels by URL.
  _getImageUrls() {
    try {
      const data = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
      const images = data?.props?.pageProps?.episodeData?.result?.images || [];
      return images.map(i => i.imagePath || i.url || '').filter(Boolean);
    } catch { return []; }
  }

  getImages() {
    // Bomtoon renders panels as <canvas> elements (scrambled WebP tiles).
    // Return the canvas elements directly so drawImage() works for OCR/cropping.
    // We attach a .src property (JS-only) from __NEXT_DATA__ URLs for hashing.
    const urls = this._getImageUrls();

    const canvases = [...document.querySelectorAll('canvas')]
      .filter(c => (c.width || 0) >= 200 && (c.height || 0) >= 200);

    // Annotate each canvas with a stable .src for hashImage
    canvases.forEach((el, i) => {
      if (!el.src) el.src = urls[i] || `bomtoon-panel-${i}`;
    });

    return canvases;
  }

  watchNewImages(callback) {
    const root = document.body;
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const imgs = this.getImages();
        if (imgs.length) callback(imgs);
      }, 300);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const ADAPTERS = [new NaverAdapter(), new RidiAdapter(), new KakaoAdapter(), new BomtoonAdapter()];

function findAdapter() { return ADAPTERS.find(a => a.detect()); }

let bootCleanup = null;
let _wtEnabled  = true;

// Persisted display-mode setting (extension/popup/settings.html): 'overlay'
// (translation drawn on top of the original region, the default) or
// 'side-by-side' (drawn entirely outside the panel, in the page's own margin
// to the right of it, at the same vertical position as the original bubble —
// not overlaid on the art at all). Read live by _positionBubble in both
// renderer classes, so a change takes effect for newly (re)positioned
// bubbles without needing to re-instantiate anything.
const OVERLAY_MODE_KEY = 'wt:overlay-mode';
let _overlayMode = 'overlay';
const SIDE_BY_SIDE_GAP_PX   = 12; // gap between the panel's right edge and the side-by-side caption
const SIDE_BY_SIDE_WIDTH_PX = 260; // fixed caption width in side-by-side mode — independent of the original bbox's width, since the box no longer overlays it

function bootForPage() {
  bootCleanup?.();
  bootCleanup = null;
  if (!_wtEnabled) return;

  const adapter = findAdapter();
  if (!adapter) { console.log('[WebtoonTranslate] No adapter:', location.href); return; }

  const meta = adapter.getChapterMeta();
  console.log('[WebtoonTranslate] Active:', meta);

  const renderer    = new OverlayRenderer({ onReload: retranslateAnnotation });
  const isKakao     = adapter.usesFixedOverlay === true;
  const fixedLayer  = isKakao
    ? new FixedOverlayLayer({ onSelect: createJobFromSelection, onClick: handleAutoDetectClick, getImages: () => images, onReload: retranslateAnnotation })
    : null;

  const panel    = __DEV_TOOLS__ ? new SidePanel({
    onJump: (ann, img) => {
      const key = `${ann.imageHash}::${ann.bbox.x.toFixed(1)}::${ann.bbox.y.toFixed(1)}`;
      // Search document-wide since wrapper may be nested differently per site
      const b = document.querySelector(`[data-ann-key="${key}"]`);
      if (b) {
        b.classList.add('wt-bubble-highlight');
        setTimeout(() => b.classList.remove('wt-bubble-highlight'), 1500);
      }
    },
    // No onEdit/onDelete — the list is read-only; use the overlay's own
    // bubble toolbar (click a bubble on the page) to edit or delete.
  }) : null;
  let allAnnotations = [];

  let readScanEnabled = false;
  let images          = [];
  let annotationCount = 0;
  let disposed        = false;

  // ONNX bbox cache: img.src → Promise<{ok,bboxes}|null>
  // Only populated when ONNX session is confirmed ready (onnxAvailable === true).
  // Stays null until we get a 'model-ready' status, so failed sessions never
  // flood the offscreen document and break Tesseract OCR.
  const onnxBboxCache = new Map();
  let onnxAvailable   = null; // null=unknown, true=ready, false=failed

  function warmOnnxCache(img) {
    if (onnxAvailable !== true) return; // don't attempt if session is unknown or failed
    if (!img.src || onnxBboxCache.has(img.src)) return;
    const p = sendToBackground({ type: MSG.DETECT_BUBBLES, payload: { imageUrl: img.src } })
      .catch(() => null);
    onnxBboxCache.set(img.src, p);
  }

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
      maybeShowScanHint();
    } else {
      if (isKakao) fixedLayer.disable();
      else selector.disable();
    }
  }
  scanBtn.addEventListener('click', () => setReadScan(!readScanEnabled));

  // ── ONNX "Scan All" button ────────────────────────────────────────────────
  // Runs the ONNX bubble-detector model over every loaded panel image and

  // One-time hint (persisted across sessions) explaining click-to-auto-detect,
  // since the overlay cursor alone doesn't make that obvious. Kakao only
  // supports drag-select (no auto-detect), so its crosshair cursor already
  // matches the interaction and needs no extra explanation.
  const SCAN_HINT_KEY = 'wt:seen-scan-hint';
  function maybeShowScanHint() {
    if (isKakao) return;
    chrome.storage.local.get({ [SCAN_HINT_KEY]: false }).then((stored) => {
      if (stored[SCAN_HINT_KEY]) return;
      showToast('💡 Click to auto-detect a bubble, or drag to select a region manually', '#6366f1', 4500);
      chrome.storage.local.set({ [SCAN_HINT_KEY]: true });
    });
  }

  // Keyboard shortcut: T to toggle
  const keyHandler = (e) => {
    if (e.key === 't' || e.key === 'T') {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      toggleTranslations();
    }
  };
  document.addEventListener('keydown', keyHandler);

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
    panel?.setImages(images);
    panel?.update(allAnnotations);
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
      setTimeout(() => images.forEach(warmOnnxCache), 500);
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
    setTimeout(() => added.forEach(warmOnnxCache), 500);
    if (readScanEnabled) {
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

  // ── job pipeline: bbox select → independent concurrent job ─────────────

  const autoDetector      = new BubbleAutoDetector();
  const detectPreview     = new DetectionPreview(); // reused for post-hoc bbox adjustment (resize action)
  const confirmPopup      = new ConfirmPopup();
  const llmTestPopover    = new LlmTestPopover();
  const jobOverlayRenderer = new JobOverlayRenderer({
    isKakao,
    onCancel: (jobId) => jobManager.cancel(jobId),
    onRetry:  (jobId) => jobManager.retry(jobId),
  });

  const DEFAULT_STYLE = { fontSize: 20, bold: false, italic: false, color: '#1a1a2e', bg: '#ffffff', noBg: false, stroke: false, strokeColor: '#ffffff', strokeWidth: 1, fontFamily: '' };

  function annKeyOf(a) {
    return `${a.imageHash}::${a.bbox.x.toFixed(1)}::${a.bbox.y.toFixed(1)}`;
  }

  function _upsertAnnotation(annotation) {
    const newKey = annKeyOf(annotation);
    const existsIdx = allAnnotations.findIndex(a => annKeyOf(a) === newKey);
    if (existsIdx >= 0) allAnnotations[existsIdx] = annotation;
    else { allAnnotations.push(annotation); annotationCount++; }
  }

  async function deleteAnnotation(annKey, img) {
    await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey } });
    if (isKakao) fixedLayer.removeBubble(annKey);
    else renderer.removeBubble(img, annKey);
    allAnnotations = allAnnotations.filter(a => annKeyOf(a) !== annKey);
    annotationCount--;
    panel?.update(allAnnotations);
    updateProgressBar();
  }

  // Overwrites a saved annotation's translatedText (same save+re-render shape
  // startInlineEdit's finish(save) uses) and re-renders its bubble. Shared by
  // the per-bubble reload button (retranslateAnnotation, below) and the LLM
  // Test popover's "Apply to region" button.
  async function applyTranslatedText(annKey, img, newText) {
    const existing = allAnnotations.find(a => annKeyOf(a) === annKey);
    if (!existing) return;
    const updated = { ...existing, translatedText: newText };
    await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [updated] } });
    _upsertAnnotation(updated);
    if (isKakao) fixedLayer.upsertBubble(img, updated);
    else renderer.upsertBubble(img, updated);
    panel?.update(allAnnotations);
  }

  // Re-runs translation for an already-saved region using whatever Translation
  // API is currently configured (autoTranslate — Google/DeepL, same as the
  // automatic pipeline; BYOK isn't wired into autoTranslate, see its own
  // comment) — this is the hover "reload" button shown on every bubble, not
  // specific to LLM-produced translations.
  async function retranslateAnnotation(ann, img, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.classList.add('wt-bubble-reload-spinning'); }
    try {
      const newText = await autoTranslate(ann.originalText);
      if (newText) await applyTranslatedText(annKeyOf(ann), img, newText);
    } catch (err) {
      showToast(`Re-translate failed: ${err?.message || err}`, '#ef4444');
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('wt-bubble-reload-spinning'); }
    }
  }

  // Overlap vs. pending/processing jobs and already-saved annotations on the same
  // panel. excludeAnnKey lets a resize-triggered re-run ignore the annotation it's
  // itself replacing (its new bbox naturally overlaps its own old bbox).
  function findOverlapForBbox(bbox, imageIndex, excludeAnnKey) {
    let max = 0;
    for (const job of jobManager.jobs.values()) {
      if (job.imageIndex !== imageIndex || job.status === 'error') continue;
      if (excludeAnnKey && job.existingAnnKey === excludeAnnKey) continue;
      max = Math.max(max, bboxOverlapRatio(bbox, job.bbox));
    }
    for (const a of allAnnotations) {
      if ((a.imageIndex ?? 0) !== imageIndex) continue;
      if (excludeAnnKey && annKeyOf(a) === excludeAnnKey) continue;
      max = Math.max(max, bboxOverlapRatio(bbox, a.bbox));
    }
    return max;
  }

  function updateJobBadge() {
    let badge = document.getElementById('wt-job-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'wt-job-badge';
      badge.innerHTML = '<span class="wt-job-badge-dot"></span><span class="wt-job-badge-text"></span>';
      document.body.appendChild(badge);
    }
    const active = jobManager.activeCount(), queued = jobManager.queuedCount();
    badge.classList.toggle('wt-job-badge-visible', active + queued > 0);
    badge.querySelector('.wt-job-badge-text').textContent =
      queued > 0 ? `${active} translating · ${queued} pending` : `${active} translating`;
  }

  let _storyContextRequestedThisPageLoad = false; // only fetch/log once per page load, not on every OCR request

  const jobManager = new JobManager({
    runOcr:        async (job) => {
      // Lazy trigger point: first OCR/translation request for this title,
      // once per page load (repeat scans on the same page don't re-trigger
      // it — cached reads are silent past the first one now, by request).
      // Fire-and-forget — nothing consumes the result yet (no LLM prompt step
      // exists in this codebase), but it fetches + caches it now so a future
      // Mode B/C implementation can read it back instantly. No-ops for any
      // adapter without fetchStoryContext (i.e. every non-Naver site today).
      if (!_storyContextRequestedThisPageLoad) {
        _storyContextRequestedThisPageLoad = true;
        getStoryContext(adapter, meta.site, meta.titleId);
      }
      // Only a flood-fill-detected region needs the OCR-crop inset/text-
      // cluster refinement (both correct for a bubble shape's bbox extending
      // past its text) — a manual drag-select or hand-resized bbox is
      // already exactly what the user wants, so it's sent to OCR unmodified.
      const applyOcrRefinement = job.source === 'auto';
      const { text, confidence } = job.clips
        ? await ocrClips(job.clips, applyOcrRefinement)
        : await ocrRegionStitched(job.imageEl, job.bbox, images, applyOcrRefinement);
      // Shadow-mode difficulty classification: logs [DifficultyClassifier] for
      // every real region so thresholds can be tuned against actual
      // screenshots, WITHOUT changing what OCR/translation actually does yet
      // (no pipeline routing exists — see extension/content/bundle.js's
      // Difficulty Classifier section). Tesseract/OCR.space confidence is
      // 0-100 (or absent for OCR.space); the classifier's thresholds are 0-1.
      logDifficultyClassificationShadow(
        job.skewAngle,
        text,
        typeof confidence === 'number' ? confidence / 100 : null
      );
      return text;
    },
    runTranslate:  (job) => autoTranslate(job.originalText),
    findOverlap:   findOverlapForBbox,
    confirmOverlap: (screenPos) => confirmPopup.show(screenPos, 'This region looks like it overlaps an existing translation. Create a new one here anyway?'),
    onTooSmall: () => showToast('Selected region is too small to recognize text — drag/select a larger area', '#f59e0b'),
    onQueueChange: updateJobBadge,
    onStatusChange: (job) => jobOverlayRenderer.render(job),
    onDone: async (job) => {
      const imageHash = await hashImage(job.imageEl);
      const existing  = job.existingAnnKey ? allAnnotations.find(a => annKeyOf(a) === job.existingAnnKey) : null;
      // Auto color-match only for brand-new translations — resize-triggered
      // re-runs keep whatever style the annotation already has.
      const matched = !existing ? await detectBubbleColors(job.imageEl, job.bbox) : null;
      const style = existing?.style || (matched ? { ...DEFAULT_STYLE, bg: matched.bg, color: matched.color } : DEFAULT_STYLE);
      const annotation = {
        imageHash, imageIndex: job.imageIndex, bbox: job.bbox,
        originalText: job.originalText, translatedText: job.translatedText,
        style,
        language: existing?.language || 'vi',
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [annotation] } });
      const newKey = annKeyOf(annotation);
      if (job.existingAnnKey && job.existingAnnKey !== newKey) {
        await sendToBackground({ type: MSG.DELETE_ANNOTATION, payload: { ...meta, annKey: job.existingAnnKey } });
        if (isKakao) fixedLayer.removeBubble(job.existingAnnKey);
        else renderer.removeBubble(job.imageEl, job.existingAnnKey);
        allAnnotations = allAnnotations.filter(a => annKeyOf(a) !== job.existingAnnKey);
      }
      _upsertAnnotation(annotation);
      if (isKakao) fixedLayer.upsertBubble(job.imageEl, annotation);
      else renderer.upsertBubble(job.imageEl, annotation);
      jobOverlayRenderer.remove(job.id);
      panel?.update(allAnnotations);
      updateProgressBar();
    },
  });

  async function createJobFromSelection({ bbox, imageEl, imageIndex, clips, existingAnnKey }) {
    // skewAngle/source (auto-detect only — see BubbleAutoDetector._extractBboxes)
    // are routing metadata (difficulty classifier + OCR-crop refinement gate),
    // not part of the BBox shape saved with an annotation — strip them here,
    // the one choke point auto-detect, manual drag-select, AND hand-resize
    // (startBubbleResize) job creation all funnel through. A bbox with no
    // `source` (manual drag-select or a hand-resized box — neither ever went
    // through flood-fill) defaults to 'manual'.
    const { skewAngle, source = 'manual', ...cleanBbox } = bbox;
    const rect = imageEl.getBoundingClientRect();
    const screenPos = {
      x: rect.left + window.scrollX + (cleanBbox.x / 100) * rect.width,
      y: rect.top  + window.scrollY + (cleanBbox.y / 100) * rect.height,
    };
    return jobManager.create({ bbox: cleanBbox, imageEl, imageIndex, clips, screenPos, existingAnnKey, skewAngle, source });
  }

  // Shared click-to-detect handler — used by both BBoxSelector (normal sites)
  // and FixedOverlayLayer (Ridi/Kakao's fixed-position overlay), so a click
  // (vs. a drag) auto-detects the bubble under the cursor on every site
  // instead of only the ones using BBoxSelector.
  async function handleAutoDetectClick({ img, clickX, clickY, imgRect, imageIndex }) {
    // Check ONNX cache: if the model already detected bubbles for this image,
    // find whichever bbox contains the click point and use it directly.
    const cached = onnxBboxCache.get(img.src);
    if (cached) {
      const result = await cached;
      if (result?.ok && result.bboxes?.length) {
        const cx = (clickX / imgRect.width)  * 100;
        const cy = (clickY / imgRect.height) * 100;
        const hit = result.bboxes.find(b =>
          cx >= b.x && cx <= b.x + b.w &&
          cy >= b.y && cy <= b.y + b.h
        );
        if (hit) {
          await createJobFromSelection({ bbox: { ...hit, source: 'onnx' }, imageEl: img, imageIndex });
          return;
        }
      }
    } else {
      warmOnnxCache(img); // not yet requested — start now for next click
    }

    // Fallback: flood-fill detector (works offline, no model required)
    const { bboxes } = await autoDetector.detect(img, clickX, clickY, imgRect, images, imageIndex);
    if (!bboxes.length) return; // validity check failed — fall back to manual drag-to-select
    // A waist-split click can yield two touching bubbles at once — each is
    // translated as its own independent job.
    for (const bbox of bboxes) {
      await createJobFromSelection({ bbox, imageEl: img, imageIndex });
    }
  }

  const selector = new BBoxSelector({
    onSelect: createJobFromSelection,
    onDragStart: () => { detectPreview.dismiss(); dismissBubbleToolbar(); },
    onClick: handleAutoDetectClick,
  });

  // ── click bubble to edit / resize / delete ──────────────────────────────
  // Single click toggles a small inline toolbar — no modal dialog. Edit swaps
  // the bubble's text for an inline textarea; resize shows an adjustable box
  // (reusing DetectionPreview) and auto re-runs OCR+translate on confirm;
  // delete removes the annotation immediately.

  let _activeToolbar = null; // { bubble, el }

  function dismissBubbleToolbar() {
    _activeToolbar?.el.remove();
    _activeToolbar = null;
  }

  function startInlineEdit(bubble, img, annKey) {
    dismissBubbleToolbar();
    const span = bubble.querySelector('span');
    const currentText = span?.textContent || '';
    const textarea = document.createElement('textarea');
    textarea.className = 'wt-bubble-edit-textarea';
    textarea.value = currentText;
    textarea.style.left     = bubble.style.left;
    textarea.style.top      = bubble.style.top;
    textarea.style.width    = bubble.style.width;
    textarea.style.height   = bubble.style.minHeight || bubble.style.height || '32px';
    // Match the size text actually renders at in the normal overlay — the
    // bubble already carries this as an inline style — instead of a small,
    // debug-looking fixed size.
    textarea.style.fontSize = bubble.style.fontSize || '20px';
    const parent = bubble.parentElement;
    parent.appendChild(textarea);
    bubble.style.visibility = 'hidden';
    textarea.focus();
    textarea.select();

    // Reuses the same checkmark/✕ confirm-reject pattern as DetectionPreview's
    // toolbar, so Save/Cancel are always visible — not just reachable via keys.
    const toolbar = document.createElement('div');
    toolbar.className = 'wt-detect-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="wt-detect-confirm" title="Save (Enter)">&#10003;</button>
      <button type="button" class="wt-detect-cancel" title="Cancel (Esc)">&#10005;</button>
    `;
    toolbar.style.left = textarea.style.left;
    toolbar.style.top  = `${parseFloat(textarea.style.top) - 34}px`;
    parent.appendChild(toolbar);

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      textarea.removeEventListener('blur', onBlur);
      textarea.remove();
      toolbar.remove();
      bubble.style.visibility = '';
      if (!save) return;
      const newText = textarea.value.trim();
      if (!newText || newText === currentText) return;
      const existing = allAnnotations.find(a => annKeyOf(a) === annKey);
      if (!existing) return;
      const updated = { ...existing, translatedText: newText };
      await sendToBackground({ type: MSG.SAVE_TRANSLATIONS, payload: { ...meta, annotations: [updated] } });
      _upsertAnnotation(updated);
      if (isKakao) fixedLayer.upsertBubble(img, updated);
      else renderer.upsertBubble(img, updated);
      panel?.update(allAnnotations);
    };
    const onBlur = () => finish(true);
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') finish(false);
    });
    textarea.addEventListener('blur', onBlur);

    // preventDefault (not just stopPropagation) on mousedown stops the browser
    // from blurring the textarea before the click lands — otherwise clicking
    // Cancel would blur-trigger a save first, then the click's own finish(false)
    // would be a no-op against an already-closed edit view.
    toolbar.querySelector('.wt-detect-confirm').addEventListener('mousedown', e => e.preventDefault());
    toolbar.querySelector('.wt-detect-cancel').addEventListener('mousedown', e => e.preventDefault());
    toolbar.querySelector('.wt-detect-confirm').addEventListener('click', () => finish(true));
    toolbar.querySelector('.wt-detect-cancel').addEventListener('click', () => finish(false));
  }

  async function startBubbleResize(bubble, img, annKey, imgIndex) {
    dismissBubbleToolbar();
    const currentBbox = {
      x: parseFloat(bubble.dataset.bboxX), y: parseFloat(bubble.dataset.bboxY),
      w: parseFloat(bubble.dataset.bboxW), h: parseFloat(bubble.dataset.bboxH),
    };
    // Ridi/Kakao bubbles live in document.body (FixedOverlayLayer), not inside
    // a .wt-img-wrapper — DetectionPreview's `fixed` mode positions the box
    // relative to the viewport instead in that case (see its show() doc comment).
    const wrapper = bubble.closest('.wt-img-wrapper');
    bubble.style.visibility = 'hidden';
    const newBbox = await detectPreview.show(img, wrapper, currentBbox, { fixed: !wrapper });
    bubble.style.visibility = '';
    if (!newBbox) return; // cancelled — bbox unchanged
    // Re-run OCR + translate with the adjusted bbox; onDone updates this same
    // annotation in place once it finishes, without blocking other jobs.
    await createJobFromSelection({ bbox: newBbox, imageEl: img, imageIndex: imgIndex, existingAnnKey: annKey });
  }

  // ── hold-to-peek ─────────────────────────────────────────────────────────
  // Holding a bubble down fades it out so the original art underneath is
  // visible — a quick-glance comparison, not the click-to-edit toolbar. A
  // genuine tap (released before the hold delay) still opens the toolbar as
  // before; a real hold suppresses the click that would otherwise follow
  // pointerup so peeking doesn't also pop the toolbar open.
  const HOLD_TO_PEEK_DELAY_MS = 120; // below the ~150ms "must feel instant" budget
  let _peek = null; // { bubble, timer, active }
  let _suppressNextBubbleClick = false;

  function endPeek() {
    if (!_peek) return;
    clearTimeout(_peek.timer);
    if (_peek.active) {
      _peek.bubble.classList.remove('wt-peeking');
      _suppressNextBubbleClick = true;
    }
    _peek = null;
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.wt-bubble-toolbar, .wt-bubble-edit-textarea, .wt-detect-preview, .wt-resize-handle')) return;
    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) return;
    endPeek();
    const timer = setTimeout(() => {
      bubble.classList.add('wt-peeking');
      if (_peek) _peek.active = true;
    }, HOLD_TO_PEEK_DELAY_MS);
    _peek = { bubble, timer, active: false };
  });
  document.addEventListener('pointerup', endPeek);
  document.addEventListener('pointercancel', endPeek);

  document.addEventListener('click', (e) => {
    if (_suppressNextBubbleClick) { _suppressNextBubbleClick = false; return; }
    if (e.target.closest('.wt-bubble-toolbar, .wt-bubble-edit-textarea, .wt-detect-preview')) return;

    const bubble = e.target.closest('.wt-translation-bubble');
    if (!bubble) { dismissBubbleToolbar(); return; }
    e.stopPropagation();
    if (_activeToolbar?.bubble === bubble) return;
    dismissBubbleToolbar();

    const annKey = bubble.dataset.annKey;
    const wrapper = bubble.closest('.wt-img-wrapper');
    let img = wrapper?.querySelector('img');
    if (!img && isKakao) img = fixedLayer.getBubbleImage(annKey);
    if (!img) return;
    const imgIndex = images.indexOf(img);

    // Appended to the bubble's parent (not the bubble itself) since bubbles have
    // overflow:hidden — a child positioned above the bubble's own box would be clipped.
    const toolbar = document.createElement('div');
    toolbar.className = 'wt-bubble-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="wt-bt-edit" title="Edit text">${BT_EDIT_ICON}</button>
      <button type="button" class="wt-bt-resize" title="Adjust box">${BT_RESIZE_ICON}</button>
      <button type="button" class="wt-bt-delete" title="Delete">${BT_DELETE_ICON}</button>
    `;
    // `bubble` is an invisible hit-area sized to the FULL selected bbox — the
    // visible caption is the inner .wt-bubble-text span, which auto-fit sizes
    // to its own content and centers within that bbox (see .wt-translation-
    // bubble's comment), so it's often much smaller/lower than the bbox's own
    // top-left. Anchor to the span's real rendered position instead of
    // bubble.style.left/top so the toolbar sits right above the visible text,
    // not off at the top of a much taller bbox.
    //
    // Computed as a viewport-space DELTA (span rect minus bubble rect) added
    // on top of bubble.style.left/top, rather than converting the span's
    // rect to a page-absolute value directly — OverlayRenderer positions
    // bubbles in page-absolute px (adds scrollX/scrollY) but
    // FixedOverlayLayer (Kakao/Ridi) positions them wrapper-relative (no
    // scroll offset); this code is shared by both, and a plain rect
    // difference is correct either way since it never assumes which
    // convention is in play.
    const span = bubble.querySelector('.wt-bubble-text');
    let anchorLeft = parseFloat(bubble.style.left);
    let anchorTop  = parseFloat(bubble.style.top);
    if (span) {
      const bubbleRect = bubble.getBoundingClientRect();
      const spanRect   = span.getBoundingClientRect();
      anchorLeft += spanRect.left - bubbleRect.left;
      anchorTop  += spanRect.top  - bubbleRect.top;
    }
    toolbar.style.left = `${anchorLeft}px`;
    toolbar.style.top  = `${anchorTop - 32}px`;
    bubble.parentElement.appendChild(toolbar);
    _activeToolbar = { bubble, el: toolbar };

    toolbar.querySelector('.wt-bt-edit').addEventListener('click', (ev) => {
      ev.stopPropagation();
      startInlineEdit(bubble, img, annKey);
    });
    toolbar.querySelector('.wt-bt-resize')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      startBubbleResize(bubble, img, annKey, imgIndex);
    });
    toolbar.querySelector('.wt-bt-delete').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      dismissBubbleToolbar();
      await deleteAnnotation(annKey, img);
    });

    // "Test LLM" is added after the rest of the toolbar so edit/resize/delete
    // stay instantly usable — this check is async (reads settings) and only
    // applies when BYOK is the selected Translation API with a key saved.
    // Never wired into automatic translation; see LlmTestPopover/callByokLlm.
    (async () => {
      const s = await chrome.storage.local.get({ 'wt:translate-provider': 'google', 'wt:byok-key': '' });
      if (s['wt:translate-provider'] !== 'byok' || !s['wt:byok-key']) return;
      if (_activeToolbar?.el !== toolbar) return; // toolbar dismissed/replaced while we awaited
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wt-bt-llm-test';
      btn.title = 'Test LLM prompt';
      btn.innerHTML = BT_LLM_ICON;
      toolbar.appendChild(btn);
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ann = allAnnotations.find(a => annKeyOf(a) === annKey);
        const ocrText = ann?.originalText || '';
        const btnRect = btn.getBoundingClientRect();
        const storyContext = await getStoryContext(adapter, meta.site, meta.titleId);
        // Same 'wt:translate-lang' value the Target Language dropdown in
        // settings.html writes — reused here rather than a second setting.
        const { 'wt:translate-lang': targetLang } = await chrome.storage.local.get({ 'wt:translate-lang': 'vi' });
        const prompt = formatLlmPrompt(storyContext, ocrText, targetLang);
        llmTestPopover.show(
          { x: btnRect.left + window.scrollX, y: btnRect.bottom + window.scrollY + 6 },
          prompt,
          (replyText) => applyTranslatedText(annKey, img, replyText)
        );
      });
    })();
  });

  // Reposition fixed bubbles/job overlays on scroll (Kakao uses position:absolute relative to page)
  if (isKakao) {
    // capture:true also catches scrolls from inner scroll containers (scroll doesn't bubble)
    document.addEventListener('scroll', () => { fixedLayer?.repositionAll(); jobOverlayRenderer.repositionAll(); }, { passive: true, capture: true });
    window.addEventListener('resize', () => { fixedLayer?.repositionAll(); jobOverlayRenderer.repositionAll(); }, { passive: true });
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
        panel?.hide();
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
      sendResponse({ ...meta, title: ogTitle, annotationCount,
        imageCount: images.length,
        translatedPanels: new Set(allAnnotations.map(a => a.imageIndex ?? 0)).size });
      return true;
    }
    if (message.type === 'TOGGLE_PANEL' && __DEV_TOOLS__) {
      panel?.setImages(images);
      panel?.update(allAnnotations);
      panel?.toggle();
    }
    if (message.type === 'TRIGGER_CLEAR')  triggerClear();
    if (message.type === 'ONNX_STATUS') {
      const { status, message: msg } = message.payload || {};
      if (status === 'loading-model') {
        showToast('Loading ONNX bubble detector model…', '#6366f1', 2500);
      } else if (status === 'model-ready') {
        onnxAvailable = true;
        // Now that the session is ready, warm the cache for all loaded images.
        setTimeout(() => images.forEach(warmOnnxCache), 100);
      } else if (status === 'error') {
        onnxAvailable = false;
        showToast(`✗ ONNX error: ${msg || 'unknown'}`, '#ef4444', 5000);
      }
    }
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // ── clear ─────────────────────────────────────────────────────────────

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
      panel?.update(allAnnotations);
      updateProgressBar();
      showToast('✓ Cleared all translations for this chapter.');
    } catch (err) {
      showToast(`✗ Clear failed: ${err.message}`, '#ef4444');
    }
  }

  bootCleanup = () => {
    disposed = true;
    stopWatching();
    urlObserver.disconnect();
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    if (isKakao) { fixedLayer.disable(); fixedLayer.clearAll(); }
    else selector.disable();
    renderer.clearAll();
    for (const jobId of [...jobManager.jobs.keys()]) jobManager.cancel(jobId);
    dismissBubbleToolbar();
    detectPreview.dismiss();
    confirmPopup.dismiss();
    llmTestPopover.dismiss();
    toggleBtn.remove();
    scanBtn.remove();
    panel?.hide();
    document.getElementById('wt-progress-bar')?.remove();
    document.getElementById('wt-job-badge')?.remove();
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

chrome.storage.local.get({ 'wt:enabled': true, [OVERLAY_MODE_KEY]: 'overlay' }, (result) => {
  _wtEnabled = !!result['wt:enabled'];
  _overlayMode = result[OVERLAY_MODE_KEY] === 'side-by-side' ? 'side-by-side' : 'overlay';
  if (_wtEnabled) bootForPage();
});

// Live-apply if the setting changes while this tab stays open (e.g. changed
// in the settings page in another tab) — affects newly (re)positioned
// bubbles, not ones already on screen until they're next touched.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && OVERLAY_MODE_KEY in changes) {
    _overlayMode = changes[OVERLAY_MODE_KEY].newValue === 'side-by-side' ? 'side-by-side' : 'overlay';
  }
});

})();
