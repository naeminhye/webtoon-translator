# Benchmark harness

Suite A (detection latency), Suite B (OCR provider comparison), Suite C
(E2E, replay mode), and a JSONL comparator script — see `benchmark-plan.md`
for the full methodology, and this file's git history for what each phase
added.

This directory is **not shipped** — `scripts/build.js` excludes `bench/`
when copying `extension/` into `dist/`.

## Layout

```
bench/
  label.html / label.css / label.js   GT labeling tool (load a corpus page,
                                       draw/adjust/delete boxes, transcribe,
                                       export GT JSON)
  bench.html / bench.js               Suite A + Suite B runner (talks to the
                                       real offscreen document — see
                                       lib/offscreen-client.js)
  bench-c.html / bench-c.js           Suite C runner (drives the real
                                       bootForPage()/jobManager pipeline —
                                       needs content/bundle.js loaded as a
                                       page script, so it's a separate entry
                                       point from bench.html)
  bench-offscreen.html                offscreen document for Suites A/B —
                                       same script set as the real
                                       extension/offscreen/ocr.html
  offscreen-hooks.js                  bench-only: Long Task collection +
                                       blob-worker CSP probe
  replay-llm-adapter.js               Suite C replay mode: fixture LLM
                                       adapter with synthetic delay
  suite-a.js / suite-b.js / suite-c.js  the three suites' orchestration
  lib/corpus.js                       corpus.json loader/validator
  lib/hash.js                         corpus integrity hash (SHA-256)
  lib/env.js, lib/model-info.js       environment + model-hash capture
  lib/calibration.js                  thermal calibration gate
  lib/stats.js                        p50/p95 summary (never mean)
  lib/cer.js                          Character Error Rate
  lib/synthetic.js                    placeholder tiles for Suite A before a
                                       real corpus exists
  lib/pool.js                         bounded-concurrency runner (Suite B
                                       throughput)
  lib/paddleocr-server-client.js      HTTP client for the self-hosted
                                       PaddleOCR server provider
  schema/*.md                         corpus.json + GT file schemas
  fixtures/                           gitignored — your local corpus lives here
    corpus.json.example               committed template — copy to corpus.json
    corpus.json                       (you create this)
    pages/*.jpg                       (you add these)
    gt/detection/<pageId>.detection.json  (exported by label.html)
    gt/ocr/<pageId>.ocr.json              (exported by label.html)

scripts/bench-compare.mjs             diffs two JSONL files, flags regressions
```

## Setting up a corpus

1. Copy `fixtures/corpus.json.example` to `fixtures/corpus.json` and edit
   the `pages` array to match your actual page images (see
   `schema/corpus.schema.md`).
2. Drop the page images at the paths named in `file` (e.g.
   `fixtures/pages/easy-01.jpg`).
3. Load the unpacked extension (`chrome://extensions` → Load unpacked →
   `extension/`), then open
   `chrome-extension://<your-extension-id>/bench/label.html`.
4. Pick a page from the dropdown, draw boxes over each text region, type
   the transcription in that box's row in the sidebar (Tab/Enter move
   between rows), then **Export GT JSON**. Move the two downloaded files
   into `fixtures/gt/detection/` and `fixtures/gt/ocr/` respectively.
5. Repeat for every page. Re-opening a page in the labeling tool picks up
   its existing GT files automatically if they're already in place.

## Running the suites

All three suites are extension pages — load the unpacked extension first
(`chrome://extensions` → Developer mode → Load unpacked → `extension/`, or
**Reload** if it's already loaded), then find its ID on that same page and
open the relevant `chrome-extension://<id>/bench/...` URL below.

Each suite writes one JSONL file when it finishes (**Download JSONL**
button). Run once to establish a baseline; only run a second time when you
want to compare against that baseline (e.g. after a code/model change) —
see "Comparing two runs" below.

### Suite A — detection latency (EP × tile size)

`chrome-extension://<id>/bench/bench.html` → **Run Suite A** (first
section on the page).

- No corpus needed — runs against synthetic placeholder tiles, so you can
  run this before labeling anything. Every record is tagged
  `corpus: "synthetic"`.
- For real (non-zero) numbers, install the real detector model first:
  popup → **General → Auto-detect bubbles** → toggle on → **Download
  model**. Without it, WASM/WebGPU sessions fail to create and every config
  gets recorded as a `metrics.error` (harmless, just uninformative).
- `webgpu` configs will fail with "Failed to get GPU adapter" on a machine/
  environment without real WebGPU support (e.g. some headless or sandboxed
  setups) — recorded as an error, doesn't stop the rest of the run.
- Run this on **both target machines** (the i7-1255U laptop and the 2018
  MacBook Pro) — that comparison is the actual point of Suite A (main-
  thread blocking on the weaker machine).

### Suite B — OCR provider comparison (GT crops)

`chrome-extension://<id>/bench/bench.html` → **Run Suite B** (second
section, same page).

- **Needs a labeled corpus** — see "Setting up a corpus" above. Runs
  against every region that has both a detection box and a transcription;
  pages without GT files yet are skipped with a warning, not an error.
- Tick whichever providers you want (all 3 by default). For
  `paddleocr-local`, download its models first: popup → **OCR Engine →
  PaddleOCR (in-browser)** → **Download models**.
- For `paddleocr` (self-hosted server, NOT OCR.space — that provider was
  removed from the product), start `server/paddleocr/` first (see its
  README) and set the URL field if it's not the default
  `http://127.0.0.1:8868`. If the server isn't running, that provider
  records a clear `metrics.error` instead of failing the whole suite.
- Every record is tagged `corpus: "real"` with a real `corpus_hash`.

### Suite C — full pipeline E2E (replay mode)

`chrome-extension://<id>/bench/bench-c.html` → **Run Suite C**.

- Separate page from Suite A/B because it needs `content/bundle.js` loaded
  as a real page script (drives the actual `bootForPage()`/`jobManager`
  pipeline via a bench-only `BenchAdapter`, active only on this page).
- Needs the real detector model installed (same "Download model" step as
  Suite A) — without it, auto-detect finds nothing and every scenario
  reports `regionCount: 0`.
- Needs a corpus (`fixtures/corpus.json` + page images) but **not** GT
  files — Suite C uses the real auto-detector, not GT boxes, so unlabeled
  pages are fine here.
- Translation is replayed from a fixture with synthetic delay — no API key
  needed, no real network calls. Live mode (real API calls) isn't
  implemented yet.
- Runs 3 scenarios automatically: cold viewport, warm scroll (10 pages),
  soak (up to 50 pages, capped by however many pages your corpus has).
  Concurrency sweep (1/2/4 concurrent jobs) isn't implemented — see
  `suite-c.js`'s header comment for why.
- If `regionCount: 0` across all scenarios despite Suite B successfully
  OCRing real regions from the same corpus, that's a real bug, not your
  setup — check `console` output on the bench-c.html page for detector
  errors first.

## Corpus hash

Every benchmark run records a `corpus_hash` — a SHA-256 over the manifest
plus every GT file (`lib/hash.js`) — so a result recorded against an
edited/incomplete corpus is detectable later. The labeling tool shows a
partial hash after export as a sanity check that the utility works; it only
covers the page just exported, not the whole corpus (that requires loading
every GT file, which only the benchmark runners do). Suite A tags every
record `corpus: "synthetic"` with `corpus_hash: null` (no real corpus
involved); Suite C's `corpus_hash` is also `null` since it doesn't score
against GT at all (see suite-c.js's header).

## Comparing two runs

```
node scripts/bench-compare.mjs baseline.jsonl candidate.jsonl
# or: npm run bench:compare -- baseline.jsonl candidate.jsonl
```

Matches records by `(suite, config)` between the two files and flags:

- p95 latency regressions >10% (relative) — finds any `{p50, p95, ...}`
  stats object anywhere in `metrics`, so this works across all three suites
  without per-suite special-casing
- CER regressions >2pp absolute (`cerAggregate`, `cerByTier.<tier>.meanCer`)
- F1 regressions >2pp absolute — not produced by any suite yet (Suite A is
  latency-only; detection precision/recall/F1 against GT isn't implemented),
  the scanner just won't find anything until that lands
- a warning (not a failure) when the two records' `corpus_hash` differ, or
  when either run's thermal calibration was flagged dirty

Exits 1 if any regression is flagged, 0 otherwise — usable as a CI gate.
Override thresholds with `--latency-pct=`, `--cer-pp=`, `--f1-pp=`.
