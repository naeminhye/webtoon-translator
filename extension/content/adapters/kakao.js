/**
 * content/adapters/kakao.js
 * Adapter for Kakao Page: https://page.kakao.com/content/{contentId}/viewer/{episodeId}
 *
 * Kakao Page is a Next.js app. Class names are hashed, so we select images
 * by size rather than by class. The viewer renders a vertical strip of panels
 * loaded lazily via IntersectionObserver — we watch via MutationObserver.
 */

import { SiteAdapter } from './base.js';
import { SITES } from '../types.js';

// Minimum rendered width to consider an element a webtoon panel image
const MIN_W = 200;

export class KakaoAdapter extends SiteAdapter {
  detect() {
    return location.hostname === 'page.kakao.com' &&
           location.pathname.includes('/content/');
  }

  getChapterMeta() {
    const match = location.pathname.match(/\/content\/(\w+)\/viewer\/(\w+)/);
    const titleId   = match?.[1] || 'unknown';
    const chapterId = match?.[2] || 'unknown';
    return { site: SITES.KAKAO, titleId, chapterId };
  }

  getImages() {
    // Try known structural selectors first (more precise), then fall back to
    // a broad scan for any large <img> on the page.
    const candidates = this._fromSelectors() || this._broadScan();
    // Dedupe by src — Kakao sometimes renders duplicate img nodes for slices
    const seen = new Set();
    return candidates.filter(img => {
      const key = img.src || img.dataset.src || img.getAttribute('data-original') || img.outerHTML.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _fromSelectors() {
    const roots = [
      'div[class*="viewer"]',
      'div[class*="Viewer"]',
      'div[class*="episode"]',
      'div[class*="Episode"]',
      'div[class*="content_wrap"]',
      'div[class*="ContentWrap"]',
      'main',
      '#__next',
    ];
    for (const sel of roots) {
      const root = document.querySelector(sel);
      if (!root) continue;
      const imgs = [...root.querySelectorAll('img')].filter(img => this._isPanel(img));
      if (imgs.length) return imgs;
    }
    return null;
  }

  _broadScan() {
    return [...document.querySelectorAll('img')].filter(img => this._isPanel(img));
  }

  _isPanel(img) {
    // Keep only large-enough visible panel images; skip icons, logos, UI chrome
    const w = img.naturalWidth || img.offsetWidth || img.width;
    if (w < MIN_W) return false;
    const src = img.src || img.dataset.src || '';
    if (!src || src.startsWith('data:') || src.includes('logo') || src.includes('icon')) return false;
    return true;
  }

  watchNewImages(callback) {
    // Kakao lazily reveals images in a vertically scrolling container.
    // Watch for DOM mutations anywhere under the viewer root.
    const root = document.querySelector('div[class*="viewer"]') ||
                 document.querySelector('#__next') ||
                 document.body;

    let debounce = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const imgs = this.getImages();
        if (imgs.length) callback(imgs);
      }, 150);
    });

    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    return () => observer.disconnect();
  }
}
