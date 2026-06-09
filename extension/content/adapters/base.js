/**
 * content/adapters/base.js
 * Abstract base class for site adapters.
 *
 * Adding a new site:
 *   1. Create adapters/mysite.js extending SiteAdapter
 *   2. Implement all methods marked @abstract
 *   3. Register in content/index.js ADAPTERS array
 */

export class SiteAdapter {
  /**
   * @abstract
   * Returns true if this adapter handles the current page.
   * Called once on page load — keep it fast (URL check only).
   * @returns {boolean}
   */
  detect() {
    throw new Error('detect() not implemented');
  }

  /**
   * @abstract
   * Parses chapter metadata from the current URL/DOM.
   * @returns {import('../types.js').ChapterMeta}
   */
  getChapterMeta() {
    throw new Error('getChapterMeta() not implemented');
  }

  /**
   * @abstract
   * Returns all webtoon panel images in reading order.
   * Images must be fully loaded (naturalWidth > 0) or loading.
   * @returns {HTMLImageElement[]}
   */
  getImages() {
    throw new Error('getImages() not implemented');
  }

  /**
   * @abstract
   * Calls callback(images) whenever new images are added to the DOM.
   * Needed for infinite-scroll chapters.
   * Returns a cleanup function.
   * @param {(images: HTMLImageElement[]) => void} callback
   * @returns {() => void} cleanup
   */
  watchNewImages(callback) {
    throw new Error('watchNewImages() not implemented');
  }

  /**
   * Optional: Returns the canonical chapter URL (used for export metadata).
   * Default: window.location.href
   */
  getChapterUrl() {
    return window.location.href;
  }
}
