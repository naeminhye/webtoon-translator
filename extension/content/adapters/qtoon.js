/**
 * content/adapters/qtoon.js
 * Adapter for Qtoon webtoon viewer:
 *   https://www.qtoon.co.kr/toon/view.mg?tcode={tcode}&cuid={cuid}&isview=R
 *
 * Qtoon is a server-rendered site. All panel <img> elements are injected into
 * #img_area at page load. Images lazy-load via class change from "loading" to
 * "loaded" and src assignment as the user scrolls. We select only loaded imgs
 * and watch for attribute changes to pick up newly loaded panels.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class QtoonAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'www.qtoon.co.kr' &&
           location.pathname === '/toon/view.mg';
  }

  getChapterMeta() {
    const params = new URLSearchParams(location.search);
    return {
      site: SITES.QTOON,
      titleId: params.get('tcode') || 'unknown',
      chapterId: params.get('cuid') || 'unknown',
    };
  }

  getImages() {
    return [...document.querySelectorAll('#img_area img')].filter(
      img => img.src && img.classList.contains('loaded'),
    );
  }

  watchNewImages(callback) {
    const root = document.querySelector('#img_area') || document.body;
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        callback(this.getImages());
      }, 150);
    });
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
    return () => observer.disconnect();
  }
}
