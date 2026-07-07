/**
 * content/adapters/bomtoon.js
 * Adapter for Bomtoon webtoon viewer:
 *   https://www.bomtoon.com/viewer/{alias}/{episodeNum}
 *
 * Bomtoon is a Next.js app. Episode images are client-side decoded and served
 * as blob: URLs inside wrapper divs (class "sc-ehMyHa"). We select images by
 * the blob: src pattern and filter out small UI chrome images.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

// Minimum width (px) to treat an <img> as a webtoon panel
const MIN_W = 200;

export class BomtoonAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'www.bomtoon.com' &&
           location.pathname.startsWith('/viewer/');
  }

  getChapterMeta() {
    // URL: /viewer/{alias}/{episodeNum}
    const match = location.pathname.match(/\/viewer\/([^/]+)\/([^/]+)/);
    const alias     = match?.[1] || 'unknown';
    const chapterId = match?.[2] || 'unknown';

    // Prefer the comic numeric ID from __NEXT_DATA__ if available
    let titleId = alias;
    try {
      const raw = document.getElementById('__NEXT_DATA__')?.textContent;
      if (raw) {
        const json = JSON.parse(raw);
        const comicId =
          json?.props?.pageProps?.comicId ||
          json?.props?.pageProps?.episodeInfo?.comicId ||
          json?.props?.pageProps?.viewerInfo?.comicId;
        if (comicId) titleId = String(comicId);
      }
    } catch (_) { /* fall through */ }

    return { site: SITES.BOMTOON, titleId, chapterId };
  }

  getImages() {
    // Bomtoon renders panels as <img src="blob:..."> inside wrapper divs.
    // Skip copyright / UI images which are loaded from HTTPS CDN (not blob:).
    return [...document.querySelectorAll('img')].filter(img => this._isPanel(img));
  }

  _isPanel(img) {
    const src = img.src || '';
    if (!src.startsWith('blob:')) return false;
    const w = img.naturalWidth || img.offsetWidth || parseInt(img.getAttribute('width') || '0', 10);
    return w >= MIN_W;
  }

  watchNewImages(callback) {
    // Images are blob: URLs swapped in after client-side decode.
    // Watch both src attribute changes and new child elements.
    const root = document.querySelector('#__next') || document.body;

    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const imgs = this.getImages();
        if (imgs.length) callback(imgs);
      }, 150);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    return () => observer.disconnect();
  }
}
