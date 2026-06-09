/**
 * content/annotation-engine/input-dialog.js
 *
 * Shows a floating input panel after user draws a bounding box.
 * Positioned near the selection without going off-screen.
 */

export class InputDialog {
  constructor() {
    this._el = null;
    this._resolve = null;
    this._build();
  }

  /**
   * Shows the dialog near a given DOM position.
   * Returns a Promise that resolves with { originalText, translatedText }
   * or null if the user cancelled.
   *
   * @param {{ x: number, y: number }} screenPos - Absolute page coords
   * @param {{ originalText?: string }} prefill
   * @returns {Promise<{originalText: string, translatedText: string} | null>}
   */
  show(screenPos, prefill = {}) {
    return new Promise(resolve => {
      this._resolve = resolve;

      this._el.querySelector('.wt-input-original').value = prefill.originalText || '';
      this._el.querySelector('.wt-input-translated').value = '';
      this._el.querySelector('.wt-input-translated').focus();

      // Position near the click, but keep inside viewport
      const { innerWidth, innerHeight } = window;
      const { offsetWidth: w, offsetHeight: h } = this._el;

      let top = scrollY + screenPos.y + 10;
      let left = scrollX + screenPos.x;

      if (left + w > scrollX + innerWidth - 20) left = scrollX + innerWidth - w - 20;
      if (top + h > scrollY + innerHeight - 20) top = screenPos.y - h - 10 + scrollY;

      this._el.style.top = `${top}px`;
      this._el.style.left = `${left}px`;
      this._el.style.display = 'block';

      // Focus trap — close on Escape
      this._escHandler = (e) => {
        if (e.key === 'Escape') this._cancel();
      };
      document.addEventListener('keydown', this._escHandler);
    });
  }

  hide() {
    this._el.style.display = 'none';
    document.removeEventListener('keydown', this._escHandler);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _build() {
    this._el = document.createElement('div');
    this._el.className = 'wt-input-dialog';
    this._el.innerHTML = `
      <div class="wt-dialog-header">
        <span>Add translation</span>
        <button class="wt-btn-close" aria-label="Cancel">✕</button>
      </div>
      <label class="wt-dialog-label">Original text (optional)</label>
      <input class="wt-input-original" type="text" placeholder="Source text…" />
      <label class="wt-dialog-label">Translation</label>
      <textarea class="wt-input-translated" rows="3" placeholder="Enter translation…"></textarea>
      <div class="wt-dialog-actions">
        <button class="wt-btn-cancel">Cancel</button>
        <button class="wt-btn-save">Save</button>
      </div>
    `;

    this._el.querySelector('.wt-btn-close').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-btn-cancel').addEventListener('click', () => this._cancel());
    this._el.querySelector('.wt-btn-save').addEventListener('click', () => this._save());

    // Save on Ctrl+Enter / Cmd+Enter inside textarea
    this._el.querySelector('.wt-input-translated').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._save();
    });

    document.body.appendChild(this._el);
  }

  _save() {
    const originalText = this._el.querySelector('.wt-input-original').value.trim();
    const translatedText = this._el.querySelector('.wt-input-translated').value.trim();
    if (!translatedText) {
      this._el.querySelector('.wt-input-translated').focus();
      return;
    }
    this.hide();
    this._resolve?.({ originalText, translatedText });
    this._resolve = null;
  }

  _cancel() {
    this.hide();
    this._resolve?.(null);
    this._resolve = null;
  }
}
