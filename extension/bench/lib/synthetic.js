/**
 * bench/lib/synthetic.js — placeholder tiles for latency-only screening
 * before a real labeled corpus exists. Every record produced against these
 * must be tagged `corpus: 'synthetic'` (see suite-a.js) so they can never
 * be mistaken for a real baseline later — quality metrics are meaningless
 * against these (no real text, no GT) and stay blank.
 */

/** Deterministic PRNG (mulberry32) — same seed always produces the same tile, so repeated runs are comparable. */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawSyntheticContent(ctx, size, seed) {
  const rng = mulberry32(seed);
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, size, size);

  // A handful of bubble-like rectangles with tick marks standing in for
  // text — enough non-uniform structure that the detector's conv layers do
  // real work, without needing a real corpus.
  for (let i = 0; i < 5; i++) {
    const w = size * 0.32, h = size * 0.12;
    const x = rng() * (size - w), y = rng() * (size - h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, size / 300);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#333';
    for (let j = 0; j < 6; j++) {
      ctx.fillRect(x + w * 0.08 + j * (w / 7), y + h / 2, w / 12, size / 200);
    }
  }
}

async function canvasToDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to encode synthetic tile'));
    reader.readAsDataURL(blob);
  });
}

/** One square synthetic tile of the given size, as a data: URL — same shape as what bundleDetector's composeTileLocally hands ort-runner.js in production. */
export async function makeSyntheticTile(size, seed = 0) {
  const canvas = new OffscreenCanvas(size, size);
  drawSyntheticContent(canvas.getContext('2d'), size, seed);
  return canvasToDataUrl(canvas);
}
