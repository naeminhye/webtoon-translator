/**
 * bench/lib/model-info.js — hashes the comic-text-detector model bytes for
 * the environment-capture record (benchmark-plan.md asks for "model file
 * hashes" so a silently-updated model doesn't get compared against an old
 * baseline).
 *
 * Reads the SAME Cache Storage entry background/worker.js's
 * comicDetectorDownload() populates and offscreen/ort-runner.js's
 * loadModelBytes() reads — this is read-only and duplicates only the two
 * tiny constants (cache name + release URL), not any logic. Kept in sync by
 * comment, same convention as ort-runner.js/worker.js's own duplication of
 * these same constants.
 */
const COMIC_DETECTOR_CACHE_NAME = 'comic-text-detector-models-v1';
const COMIC_DETECTOR_RELEASE_URL = 'https://github.com/naeminhye/webtoon-translator/releases/download/comic-text-detector-v1/comic-text-detector.onnx';
const BUNDLED_MODEL_PATH = 'models/comic-text-detector.onnx';

export async function getComicDetectorModelInfo() {
  try {
    const cache = await caches.open(COMIC_DETECTOR_CACHE_NAME);
    let bytes = null;

    const cached = await cache.match(COMIC_DETECTOR_RELEASE_URL);
    if (cached) {
      bytes = await cached.arrayBuffer();
    } else {
      const res = await fetch(chrome.runtime.getURL(BUNDLED_MODEL_PATH));
      if (res.ok) bytes = await res.arrayBuffer();
    }

    if (!bytes) {
      return { available: false, reason: 'model not installed — Settings → General → Auto-detect bubbles → Download model' };
    }

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return { available: true, sha256, byteLength: bytes.byteLength };
  } catch (err) {
    return { available: false, reason: String(err.message || err) };
  }
}
