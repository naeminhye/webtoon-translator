/**
 * bench/lib/paddleocr-server-client.js — thin HTTP client mirroring
 * background/worker.js's paddleOcrRun() exactly: same endpoint, same
 * request/response shape. This is glue to an EXTERNAL process
 * (server/paddleocr/, which the user runs themselves), not pipeline logic —
 * there is no client-side OCR algorithm here to reuse. worker.js's
 * paddleOcrRun lives in the background service worker and isn't exported
 * (bench.html can't import across execution contexts anyway), so
 * duplicating this ~15-line HTTP call is the pragmatic choice, same
 * convention as other small intentional duplications in this codebase
 * (e.g. worker.js's own OCR_TEXT_DILATE_PX comment). Keep this in sync with
 * worker.js's paddleOcrRun if the server contract ever changes.
 */

export async function runPaddleOcrServer(dataUrl, endpoint) {
  let res;
  try {
    res = await fetch(`${endpoint}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
  } catch (_) {
    return { ok: false, error: `PaddleOCR server unreachable at ${endpoint} — is it running? (see server/paddleocr/README.md)` };
  }
  if (!res.ok) return { ok: false, error: `PaddleOCR server HTTP ${res.status}` };

  let json;
  try {
    json = await res.json();
  } catch (_) {
    return { ok: false, error: 'PaddleOCR server returned invalid JSON' };
  }
  if (!json.ok) return { ok: false, error: `PaddleOCR: ${json.error || 'unknown error'}` };

  const text = (json.text || '').replace(/\s+/g, ' ').trim();
  const confidence = typeof json.confidence === 'number' ? json.confidence : null;
  return { ok: true, text, confidence };
}
