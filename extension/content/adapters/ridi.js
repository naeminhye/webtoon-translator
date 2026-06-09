/**
 * content/adapters/ridi.js
 * Adapter for Ridi: https://www.ridi.com/viewer/{bookId}
 *
 * Status: stub — implement in Phase 2.
 *
 * Implementation notes for Phase 2:
 *   - Ridi uses a custom JS viewer; images are loaded into a shadow DOM or
 *     canvas. Inspect Network tab for actual image requests.
 *   - titleId: parse from URL path segment or API response in page state
 *   - chapterId: look for episode metadata in __NEXT_DATA__ or window.__RIDI_*
 *   - Images may be rendered in an <iframe> — content script needs
 *     "all_frames": true in manifest if so.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class RidiAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'www.ridi.com' &&
           location.pathname.startsWith('/viewer/');
  }

  getChapterMeta() {
    const parts = location.pathname.split('/');
    const bookId = parts[2] || 'unknown';
    // Ridi book IDs double as titleId; no separate chapterId in URL
    return { site: SITES.RIDI, titleId: bookId, chapterId: bookId };
  }

  getImages() {
    // TODO Phase 2: identify correct image container
    console.warn('[WebtoonTranslate] Ridi adapter not yet implemented');
    return [];
  }

  watchNewImages(callback) {
    console.warn('[WebtoonTranslate] Ridi adapter not yet implemented');
    return () => {};
  }
}
