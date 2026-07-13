# `corpus.json` manifest schema

Lives at `extension/bench/fixtures/corpus.json` (gitignored — see
`corpus.json.example` in this same fixtures directory for a committed
template). One manifest describes every page in the shared benchmark corpus,
used by all three suites (A/B/C) so results stay comparable.

```jsonc
{
  "version": 1,          // bump if the schema shape changes
  "language": "kor",      // corpus-wide source language (Korean only for now)
  "pages": [
    {
      "id": "easy-01",           // stable identifier — GT files reference pages by this, not by array index
      "tier": "easy",            // one of: easy | medium | hard | edge
      "file": "pages/easy-01.jpg", // path relative to fixtures/
      "width": 1080,             // natural pixel width of the full page image
      "height": 6400,            // natural pixel height (webtoon pages are long vertical strips)
      "sourceLanguage": "kor",   // per-page override if a corpus ever mixes languages
      "regionCount": 6,          // number of text regions on this page (informational, cross-checked against GT box count)
      "notes": ""                // free text, optional
    }
  ]
}
```

## Field notes

- **`tier`** mirrors the product's Easy/Medium/Hard/Edge OCR-routing tiers
  (see `benchmark-plan.md` §0), so results map directly onto routing
  decisions. Stratification target: 4-6 Easy, 4-6 Medium, 4-6 Hard, 2-4 Edge.
- **`id`** must be filename-safe (no spaces/slashes/colons) — it's reused as
  the base name for this page's GT files (`gt/detection/<id>.json`,
  `gt/ocr/<id>.json`) and appears in JSONL benchmark records.
- A corpus-wide **hash** (over this manifest plus every GT file) is computed
  by `lib/hash.js` and recorded in every benchmark run so a stale/edited
  corpus is detectable across time (see `benchmark-plan.md` §"Methodology").
