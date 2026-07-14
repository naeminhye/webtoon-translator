/**
 * bench/lib/hash.js — corpus integrity hash.
 *
 * Computes a stable SHA-256 over the corpus manifest plus every GT file, so
 * a benchmark JSONL record's `corpus_hash` field changes the moment anyone
 * edits a page's boxes/transcriptions or adds/removes a page — catching
 * stale-corpus comparisons across time (benchmark-plan.md's "Methodology").
 *
 * Object key order is not meaningful in JSON, but plain JSON.stringify()
 * preserves insertion order — two logically-identical GT files produced by
 * different code paths (or a re-saved file where a key got re-inserted)
 * would hash differently. canonicalJson() sorts object keys recursively
 * before serializing so the hash only reflects actual content.
 */

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  return canonicalize(value);
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * `manifest` is the parsed corpus.json object. `gtFiles` is every GT JSON
 * object (detection + OCR, all pages) sorted by the caller into a stable
 * order before calling this — order matters here since it's part of what
 * gets hashed, unlike object key order within each file.
 */
export async function computeCorpusHash({ manifest, gtFiles = [] }) {
  const parts = [canonicalize(manifest), ...gtFiles.map(canonicalize)];
  return sha256Hex(parts.join('\n'));
}
