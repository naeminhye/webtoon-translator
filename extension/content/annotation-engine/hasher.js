/**
 * content/annotation-engine/hasher.js
 *
 * Produces a stable SHA-256 fingerprint for a webtoon panel image.
 *
 * Why not use src URL?
 *   CDN URLs for Naver/Kakao contain signed tokens that rotate. Two requests
 *   to the same panel get different URLs. Hashing a fixed-size chunk of the
 *   image bytes gives a stable identity regardless of URL.
 *
 * Strategy:
 *   1. Fetch the image as a blob (uses browser cache, no extra network request
 *      if the image is already loaded)
 *   2. Hash the first 64 KB — enough to be unique, fast to compute
 *   3. Cache the result on the img element to avoid rehashing on re-render
 */

const CHUNK_SIZE = 64 * 1024; // 64 KB

/**
 * Returns a hex SHA-256 string for the given image element.
 * Caches the result on img.__wtHash to avoid redundant fetches.
 *
 * @param {HTMLImageElement} img
 * @returns {Promise<string>} e.g. "sha256:abcdef1234..."
 */
export async function hashImage(img) {
  if (img.__wtHash) return img.__wtHash;

  try {
    const response = await fetch(img.src, { credentials: 'include' });
    const buffer = await response.arrayBuffer();
    const chunk = buffer.slice(0, CHUNK_SIZE);
    const hashBuffer = await crypto.subtle.digest('SHA-256', chunk);
    const hex = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const result = `sha256:${hex}`;
    img.__wtHash = result;
    return result;
  } catch (err) {
    // Fallback: use src URL stripped of query params (removes CDN tokens)
    console.warn('[WebtoonTranslate] hash fallback for', img.src, err);
    const urlHash = img.src.split('?')[0].split('/').slice(-2).join('/');
    img.__wtHash = `url:${urlHash}`;
    return img.__wtHash;
  }
}
