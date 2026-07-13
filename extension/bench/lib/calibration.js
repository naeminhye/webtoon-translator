/**
 * bench/lib/calibration.js — fixed-work thermal calibration, per
 * benchmark-plan.md's Methodology: run a fixed-work loop before each
 * session; if timing drifts >10% from this machine's stored baseline, warn
 * and mark the session dirty (results still recorded, just flagged).
 *
 * Baseline is stored in localStorage, scoped to this browser profile on
 * this machine — there is no cross-machine meaning to compare against.
 */

const STORAGE_KEY = 'wt-bench-calibration-baseline-ms';
const ITERATIONS = 20_000_000;
const DRIFT_WARN_PCT = 10;

/** CPU-bound busy loop with no shortcuts a JIT can constant-fold away (accumulator depends on i every iteration and is returned). */
function fixedWork() {
  let acc = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    acc += Math.sqrt(i) * Math.sin(i);
  }
  return acc;
}

export function runCalibration() {
  const t0 = performance.now();
  const acc = fixedWork();
  const elapsedMs = performance.now() - t0;
  void acc; // consumed only to prevent dead-code elimination, not meaningful itself

  const stored = Number(localStorage.getItem(STORAGE_KEY));
  if (!stored || Number.isNaN(stored)) {
    localStorage.setItem(STORAGE_KEY, String(elapsedMs));
    return { elapsedMs, baselineMs: elapsedMs, driftPct: 0, dirty: false, isNewBaseline: true };
  }

  const driftPct = ((elapsedMs - stored) / stored) * 100;
  const dirty = Math.abs(driftPct) > DRIFT_WARN_PCT;
  return { elapsedMs, baselineMs: stored, driftPct, dirty, isNewBaseline: false };
}

/** Overwrites the stored baseline with the current machine's timing — use after a deliberate hardware/environment change, not to silence a real thermal issue. */
export function resetCalibrationBaseline() {
  localStorage.removeItem(STORAGE_KEY);
}
