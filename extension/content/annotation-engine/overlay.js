/**
 * content/annotation-engine/overlay.js
 *
 * Renders translation text bubbles as absolutely-positioned divs
 * over webtoon panel images.
 *
 * Design decisions:
 *   - Pure DOM (no Canvas) so bubbles are selectable text and accessible
 *   - BBox stored as %, converted to px at render time using
 *     image.getBoundingClientRect()
 *   - Bubbles use a semi-transparent white background to maintain readability
 *     over any image content
 *   - ResizeObserver re-positions all bubbles when image width changes
 *     (browser zoom, window resize, layout shift)
 */

export class OverlayRenderer {
  constructor() {
    /** @type {Map<HTMLImageElement, {wrapper: HTMLElement, bubbles: Map<string, HTMLElement>}>} */
    this.imageState = new Map();
    this._resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        this._repositionForWrapper(entry.target);
      }
    });
  }

  /**
   * Renders all annotations for a given image.
   * Clears any existing bubbles for that image first.
   *
   * @param {HTMLImageElement} img
   * @param {import('../types.js').Annotation[]} annotations
   */
  renderForImage(img, annotations) {
    const wrapper = this._ensureWrapper(img);
    const state = this.imageState.get(img);

    // Clear existing bubbles
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();

    for (const ann of annotations) {
      const bubble = this._createBubble(ann);
      this._positionBubble(bubble, ann.bbox, img);
      wrapper.appendChild(bubble);
      state.bubbles.set(this._annKey(ann), bubble);
    }
  }

  /**
   * Adds or updates a single annotation bubble.
   * @param {HTMLImageElement} img
   * @param {import('../types.js').Annotation} annotation
   */
  upsertBubble(img, annotation) {
    const wrapper = this._ensureWrapper(img);
    const state = this.imageState.get(img);
    const key = this._annKey(annotation);

    state.bubbles.get(key)?.remove();

    const bubble = this._createBubble(annotation);
    this._positionBubble(bubble, annotation.bbox, img);
    wrapper.appendChild(bubble);
    state.bubbles.set(key, bubble);
  }

  /**
   * Removes the overlay layer for an image entirely.
   * @param {HTMLImageElement} img
   */
  clearImage(img) {
    const state = this.imageState.get(img);
    if (!state) return;
    state.bubbles.forEach(el => el.remove());
    state.bubbles.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _ensureWrapper(img) {
    if (this.imageState.has(img)) {
      return this.imageState.get(img).wrapper;
    }

    let wrapper = img.parentElement;
    if (!wrapper.classList.contains('wt-img-wrapper')) {
      // selector.js may have already created a wrapper; if not, create one
      wrapper = document.createElement('div');
      wrapper.className = 'wt-img-wrapper';
      const computed = getComputedStyle(img);
      wrapper.style.cssText = `
        position: relative;
        display: ${computed.display === 'inline' ? 'inline-block' : 'block'};
        line-height: 0;
        margin: 0;
        padding: 0;
      `;
      img.parentElement.insertBefore(wrapper, img);
      wrapper.appendChild(img);
    }

    this.imageState.set(img, { wrapper, bubbles: new Map() });
    this._resizeObserver.observe(wrapper);
    return wrapper;
  }

  _createBubble(annotation) {
    const bubble = document.createElement('div');
    bubble.className = 'wt-translation-bubble';
    bubble.dataset.annKey = this._annKey(annotation);
    bubble.textContent = annotation.translatedText;
    return bubble;
  }

  _positionBubble(bubble, bbox, img) {
    // bbox is in % of image dimensions
    // img may not be at 1:1 scale, so use its rendered dimensions
    const iw = img.offsetWidth || img.naturalWidth;
    const ih = img.offsetHeight || img.naturalHeight;

    bubble.style.left   = `${(bbox.x / 100) * iw}px`;
    bubble.style.top    = `${(bbox.y / 100) * ih}px`;
    bubble.style.width  = `${(bbox.w / 100) * iw}px`;
    bubble.style.minHeight = `${(bbox.h / 100) * ih}px`;
  }

  _repositionForWrapper(wrapper) {
    const img = wrapper.querySelector('img');
    if (!img) return;
    const state = this.imageState.get(img);
    if (!state) return;

    // Re-read annotations from existing bubbles and reposition
    state.bubbles.forEach((bubble) => {
      // bbox is stored as data attributes to avoid re-fetching from storage
      const x = parseFloat(bubble.dataset.bboxX);
      const y = parseFloat(bubble.dataset.bboxY);
      const w = parseFloat(bubble.dataset.bboxW);
      const h = parseFloat(bubble.dataset.bboxH);
      if (!isNaN(x)) {
        this._positionBubble(bubble, { x, y, w, h }, img);
      }
    });
  }

  _annKey(ann) {
    return `${ann.imageHash}:${ann.bbox.x.toFixed(1)}:${ann.bbox.y.toFixed(1)}`;
  }
}
