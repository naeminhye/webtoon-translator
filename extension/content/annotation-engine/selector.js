/**
 * content/annotation-engine/selector.js
 *
 * Handles drag-to-select bounding boxes on webtoon panel images.
 *
 * Design:
 *   - Creates a transparent overlay <div> on top of each image
 *   - User clicks + drags to define a rectangle
 *   - Emits an { bbox, imageEl, imageIndex } event when drag ends
 *   - BBox values are percentages of image dimensions (not pixel coords)
 *     so they stay correct when the page is resized
 */

export class BBoxSelector {
  /**
   * @param {Object} options
   * @param {(result: {bbox: BBox, imageEl: HTMLImageElement, imageIndex: number}) => void} options.onSelect
   */
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.overlays = new Map(); // img -> overlay div
    this.active = false;
    this._currentDrag = null;
  }

  /**
   * Activates annotation mode.
   * Attaches overlay divs to all provided images.
   * @param {HTMLImageElement[]} images
   */
  enable(images) {
    this.active = true;
    images.forEach((img, index) => this._attachOverlay(img, index));
  }

  /**
   * Deactivates annotation mode, removes all overlays.
   */
  disable() {
    this.active = false;
    for (const [img, overlay] of this.overlays) {
      overlay.remove();
    }
    this.overlays.clear();
  }

  /**
   * Attaches a new image (e.g. from infinite scroll).
   * @param {HTMLImageElement} img
   * @param {number} index
   */
  attachImage(img, index) {
    if (this.active) this._attachOverlay(img, index);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _attachOverlay(img, imageIndex) {
    if (this.overlays.has(img)) return;

    // Wrap img in a relative-positioned container if needed
    const wrapper = this._ensureWrapper(img);

    const overlay = document.createElement('div');
    overlay.className = 'wt-selector-overlay';
    overlay.dataset.imageIndex = imageIndex;
    wrapper.appendChild(overlay);
    this.overlays.set(img, overlay);

    let startX, startY, selectionEl;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
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
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;

      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      const w = Math.abs(currentX - startX);
      const h = Math.abs(currentY - startY);

      selectionEl.style.left = `${x}px`;
      selectionEl.style.top = `${y}px`;
      selectionEl.style.width = `${w}px`;
      selectionEl.style.height = `${h}px`;
    };

    const onMouseUp = (e) => {
      if (!this._currentDrag || this._currentDrag.overlay !== overlay) return;

      const rect = overlay.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      const endY = e.clientY - rect.top;

      const px = Math.min(startX, endX);
      const py = Math.min(startY, endY);
      const pw = Math.abs(endX - startX);
      const ph = Math.abs(endY - startY);

      // Ignore tiny accidental clicks (< 10px)
      if (pw < 10 || ph < 10) {
        selectionEl.remove();
        this._currentDrag = null;
        return;
      }

      // Convert pixel coords to % of overlay (= % of image)
      const bbox = {
        x: (px / rect.width) * 100,
        y: (py / rect.height) * 100,
        w: (pw / rect.width) * 100,
        h: (ph / rect.height) * 100,
      };

      selectionEl.remove();
      this._currentDrag = null;

      this.onSelect({ bbox, imageEl: img, imageIndex });
    };

    overlay.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Store cleanup on overlay element
    overlay._cleanup = () => {
      overlay.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }

  _ensureWrapper(img) {
    const parent = img.parentElement;
    if (parent.classList.contains('wt-img-wrapper')) return parent;

    const wrapper = document.createElement('div');
    wrapper.className = 'wt-img-wrapper';

    // Copy img's layout so the wrapper doesn't shift anything
    const computed = getComputedStyle(img);
    wrapper.style.cssText = `
      position: relative;
      display: ${computed.display === 'inline' ? 'inline-block' : 'block'};
      width: ${img.offsetWidth}px;
      margin: 0;
      padding: 0;
    `;

    parent.insertBefore(wrapper, img);
    wrapper.appendChild(img);
    return wrapper;
  }
}
