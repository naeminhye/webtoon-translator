/** bench/lib/pool.js — bounded-concurrency runner for the Suite B throughput measurement (regions/sec at a realistic concurrent-jobs setting). */

export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runner() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}
