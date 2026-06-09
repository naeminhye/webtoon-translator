/**
 * content/adapters/naver.js
 * Adapter for Naver Webtoon: https://comic.naver.com/webtoon/detail?titleId=X&no=Y
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class NaverAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'comic.naver.com' &&
           location.pathname.startsWith('/webtoon/detail');
  }

  getChapterMeta() {
    const params = new URLSearchParams(location.search);
    const titleId = params.get('titleId') || 'unknown';
    const chapterId = params.get('no') || 'unknown';
    return { site: SITES.NAVER, titleId, chapterId };
  }

  getImages() {
    // Naver renders panels inside .wt_viewer or #comic_view_area
    // The main image container changed over time — try both selectors.
    const containers = [
      document.querySelector('.wt_viewer'),
      document.querySelector('#comic_view_area'),
      document.querySelector('.viewer_lst'),
    ].filter(Boolean);

    if (containers.length === 0) return [];

    const imgs = [];
    for (const container of containers) {
      container.querySelectorAll('img').forEach(img => {
        // Filter out UI chrome (arrows, icons) — panel images are wide
        if (img.naturalWidth > 100 || img.width > 100) {
          imgs.push(img);
        }
      });
    }

    // Deduplicate (same img may appear in multiple selectors)
    return [...new Set(imgs)];
  }

  watchNewImages(callback) {
    // Naver loads all panels at once (no infinite scroll per chapter),
    // but images may still be loading when we first run.
    const observer = new MutationObserver(() => {
      const imgs = this.getImages();
      if (imgs.length > 0) callback(imgs);
    });

    const target = document.querySelector('.wt_viewer') ||
                   document.querySelector('#comic_view_area') ||
                   document.body;

    observer.observe(target, { childList: true, subtree: true });

    return () => observer.disconnect();
  }
}
