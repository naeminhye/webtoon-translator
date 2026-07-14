# Baselines

Committed (unlike `../bench-results/`, which is gitignored) — this is for
JSONL files you've deliberately decided are a reference point, e.g. "Suite B
on the i7-1255U laptop, 2026-07-13, before switching the default OCR engine
to paddleocr-local."

## Workflow

1. Run a suite, download its JSONL (lands wherever Chrome saves downloads).
2. Move it into `../bench-results/` if it's just this run's raw output, or
   straight here if you want it kept as a named baseline. A clear filename
   matters more than the auto-generated timestamp one — e.g.
   `suite-b_i7-1255u_2026-07-13_pre-engine-switch.jsonl`.
3. Compare a later run against it:
   ```
   node scripts/bench-compare.mjs extension/bench/baselines/<baseline>.jsonl <new-run>.jsonl
   ```
4. Commit the baseline file itself (plain JSONL, diffs fine in git) so it
   survives across clones/machines/teammates — this is the one exception to
   "benchmark output isn't source."

Don't dump every run here — that's what the gitignored `bench-results/` is
for. Only files you've decided are worth keeping under version control.
