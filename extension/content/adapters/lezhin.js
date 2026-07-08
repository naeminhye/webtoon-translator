/**
 * content/adapters/lezhin.js
 * Adapter for Lezhin webtoon viewer:
 *   https://www.lezhin.com/{lang}/comic/{titleSlug}/{episodeNum}
 *
 * Lezhin is a Next.js/React app using virtual scrolling. Panel containers
 * (div[data-cut-index="N"]) are always in DOM with fixed inline dimensions,
 * but their content toggles between a blob: <img> (when in viewport) and a
 * .cut-loader placeholder (when scrolled out). We anchor to the stable divs
 * and expose _ocrCanvas as a live getter to the blob: img.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class LezhinAdapter extends SiteAdapter {
  get usesFixedOverlay() { return true; }

  detect() {
    return location.hostname === 'www.lezhin.com' &&
           /^\/[a-z]{2}\/comic\/[^/]+\/[^/?#]+/.test(location.pathname);
  }

  getChapterMeta() {
    // /ko/comic/{titleSlug}/{episodeNum}
    const parts = location.pathname.split('/').filter(Boolean);
    return { site: SITES.LEZHIN, titleId: parts[2] || 'unknown', chapterId: parts[3] || 'unknown' };
  }

  getImages() {
    const panels = [...document.querySelectorAll('div[data-cut-index]')];
    panels.forEach((el, i) => {
      if (!el.src) el.src = `lezhin-panel-${i}`;
      if (!Object.getOwnPropertyDescriptor(el, '_ocrCanvas')) {
        Object.defineProperty(el, '_ocrCanvas', {
          get() { return el.querySelector('img[src^="blob:"]'); },
          configurable: true,
        });
      }
    });
    return panels;
  }

  watchNewImages(callback) {
    let seenCount = 0;
    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const panels = this.getImages();
        if (panels.length !== seenCount) {
          seenCount = panels.length;
          callback(panels);
        }
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
}
