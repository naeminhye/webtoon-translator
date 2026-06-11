/**
 * content/adapters/ridi.js
 * Adapter for Ridi Webtoon viewer: https://ridibooks.com/books/{b_id}/view
 *
 * The viewer is a Vite/React SPA. All episode images render as
 * <img data-index="N" class="wv-1ago99h"> inside a single scrolling
 * container. Initially unloaded images carry a tiny SVG placeholder src;
 * the viewer swaps in blob: URLs as the user scrolls down.
 *
 * Chapter meta is embedded in <script id="app_init" type="application/json">.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class RidiAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'ridibooks.com' &&
           /\/books\/\w+\/view/.test(location.pathname);
  }

  getChapterMeta() {
    // URL: /books/{b_id}/view
    const bId = location.pathname.match(/\/books\/(\w+)\/view/)?.[1] || 'unknown';

    // Prefer series_id + volume from the embedded JSON so that all episodes
    // of the same series share a titleId and chapters are numbered cleanly.
    try {
      const raw = document.getElementById('app_init')?.textContent;
      if (raw) {
        const json = JSON.parse(raw);
        const book = json?.detail?.book;
        if (book) {
          const titleId   = String(book.series_id  || bId);
          const chapterId = String(book.b_id       || bId);
          return { site: SITES.RIDI, titleId, chapterId };
        }
      }
    } catch (_) { /* fall through to URL-only fallback */ }

    return { site: SITES.RIDI, titleId: bId, chapterId: bId };
  }

  getImages() {
    // All panel images carry data-index. Skip unloaded SVG placeholders —
    // only blob: URLs represent real, rendered images we can hash.
    return [...document.querySelectorAll('img[data-index]')].filter(
      img => img.src && img.src.startsWith('blob:')
    );
  }

  watchNewImages(callback) {
    // The viewer loads images into existing <img> nodes by swapping their src
    // from the SVG placeholder to a blob: URL. We watch for attribute mutations
    // rather than childList additions.
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

    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    return () => observer.disconnect();
  }
}
