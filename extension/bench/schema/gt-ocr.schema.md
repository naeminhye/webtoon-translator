# OCR ground-truth schema

Lives at `extension/bench/fixtures/gt/ocr/<pageId>.ocr.json` (gitignored).
One file per corpus page. Produced/edited by `bench/label.html`.

```jsonc
{
  "pageId": "easy-01",       // must match a corpus.json pages[].id
  "regions": [
    {
      "boxId": "b1",          // references a box id from gt/detection/<pageId>.json
      "text": "안녕하세요",     // transcription, NOT yet normalized
      "language": "kor"
    }
  ]
}
```

## Normalization (applied at benchmark time, not stored here)

CER (the primary accuracy metric, per `benchmark-plan.md` §"Suite B") is
computed after:

1. Unicode NFKC normalization
2. Whitespace collapse (`\s+` → single space, trim)
3. Character-level Levenshtein distance / GT length

The GT file stores the raw transcription as typed so re-normalizing with a
different rule later doesn't require re-labeling.
