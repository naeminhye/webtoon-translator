# Detection ground-truth schema

Lives at `extension/bench/fixtures/gt/detection/<pageId>.detection.json`
(gitignored).
One file per corpus page. Produced/edited by `bench/label.html`.

```jsonc
{
  "pageId": "easy-01",     // must match a corpus.json pages[].id
  "boxes": [
    {
      "id": "b1",           // stable per-box id, referenced by the OCR GT file's regions[].boxId
      "x": 120,             // natural pixel coords, top-left origin, unrotated page image
      "y": 340,
      "w": 260,
      "h": 90
    }
  ]
}
```

Used by Suite A (`benchmark-plan.md` §"Suite A" — precision/recall/F1 at
IoU ≥ 0.5 against these boxes, after tile-merge/NMS) and as the crop source
for Suite B (GT-cropped regions, not detected boxes, to isolate OCR quality
from detection quality).
