# Benchmark harness

Phase 1: corpus infrastructure. Later phases (Suite A/B/C runners,
`bench.html`, the comparator script) build on top of this — see
`benchmark-plan.md` for the full methodology.

This directory is **not shipped** — `scripts/build.js` excludes `bench/`
when copying `extension/` into `dist/`.

## Layout

```
bench/
  label.html / label.css / label.js   GT labeling tool (load a corpus page,
                                       draw/adjust/delete boxes, transcribe,
                                       export GT JSON)
  lib/corpus.js                       corpus.json loader/validator
  lib/hash.js                         corpus integrity hash (SHA-256)
  schema/*.md                         corpus.json + GT file schemas
  fixtures/                           gitignored — your local corpus lives here
    corpus.json.example               committed template — copy to corpus.json
    corpus.json                       (you create this)
    pages/*.jpg                       (you add these)
    gt/detection/<pageId>.detection.json  (exported by label.html)
    gt/ocr/<pageId>.ocr.json              (exported by label.html)
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

## Corpus hash

Every benchmark run (Phase 2+) records a `corpus_hash` — a SHA-256 over the
manifest plus every GT file (`lib/hash.js`) — so a result recorded against
an edited/incomplete corpus is detectable later. The labeling tool shows a
partial hash after export as a sanity check that the utility works; it only
covers the page just exported, not the whole corpus (that requires loading
every GT file, which only the benchmark runners do).
