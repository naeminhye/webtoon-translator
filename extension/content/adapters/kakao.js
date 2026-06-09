/**
 * content/adapters/kakao.js
 * Adapter for Kakao Page: https://page.kakao.com/content/{contentId}/viewer/{episodeId}
 *
 * Status: stub — implement in Phase 2.
 *
 * Implementation notes for Phase 2:
 *   - Kakao Page is a Next.js app; page data is in <script id="__NEXT_DATA__">
 *   - titleId = contentId from URL path
 *   - chapterId = episodeId from URL path
 *   - Images are loaded lazily via IntersectionObserver — watchNewImages
 *     must use MutationObserver on the scroll container
 *   - Some images may be split into 2–3 horizontal slices per panel;
 *     getImages() should group by vertical position or return all slices.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

export class KakaoAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'page.kakao.com' &&
           location.pathname.includes('/content/');
  }

  getChapterMeta() {
    // URL format: /content/{contentId}/viewer/{episodeId}
    const match = location.pathname.match(/\/content\/(\w+)\/viewer\/(\w+)/);
    const titleId = match?.[1] || 'unknown';
    const chapterId = match?.[2] || 'unknown';
    return { site: SITES.KAKAO, titleId, chapterId };
  }

  getImages() {
    console.warn('[WebtoonTranslate] Kakao adapter not yet implemented');
    return [];
  }

  watchNewImages(callback) {
    console.warn('[WebtoonTranslate] Kakao adapter not yet implemented');
    return () => {};
  }
}
