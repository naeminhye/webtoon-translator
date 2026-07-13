/** bench/lib/stats.js — percentile summary. Never report mean (see benchmark-plan.md's Methodology: WebGPU/network distributions are skewed; mean hides the tail). */

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}
