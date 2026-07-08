/**
 * content/types.js
 * Shared type definitions (JSDoc) and constants.
 */

/**
 * @typedef {Object} BBox
 * @property {number} x  - Left edge as % of image width  (0–100)
 * @property {number} y  - Top edge as % of image height (0–100)
 * @property {number} w  - Width as % of image width      (0–100)
 * @property {number} h  - Height as % of image height    (0–100)
 */

/**
 * @typedef {Object} Annotation
 * @property {string} imageHash      - SHA-256 of first 64KB of image blob (stable across CDN URL changes)
 * @property {number} imageIndex     - 0-based position in chapter image list (fallback if hash fails)
 * @property {BBox}   bbox           - Position as percentages
 * @property {string} originalText   - Source text (may be empty if typed manually)
 * @property {string} translatedText - The translation
 * @property {string} language       - BCP-47 e.g. "vi", "en"
 * @property {string} createdAt      - ISO timestamp
 * @property {string} [contributorId] - Phase 2: Supabase user id
 */

/**
 * @typedef {Object} ChapterMeta
 * @property {string} site       - "naver" | "ridi" | "kakao"
 * @property {string} titleId    - Unique comic ID on this site
 * @property {string} chapterId  - Episode/chapter identifier
 */

export const SITES = {
  NAVER: 'naver',
  RIDI: 'ridi',
  KAKAO: 'kakao',
  BOMTOON: 'bomtoon',
  LEZHIN: 'lezhin',
  QTOON: 'qtoon',
};

export const MODES = {
  READ: 'read',       // Show translations only
  ANNOTATE: 'annotate', // Enable bbox selection + input
};

export const MSG = {
  SAVE_TRANSLATIONS: 'SAVE_TRANSLATIONS',
  LOAD_TRANSLATIONS: 'LOAD_TRANSLATIONS',
  EXPORT_CHAPTER: 'EXPORT_CHAPTER',
  IMPORT_FILE: 'IMPORT_FILE',
};
