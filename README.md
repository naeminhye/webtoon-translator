# Webtoon Translate

Community-driven translation overlay for webtoon readers. Translators annotate panels directly; readers see text overlaid on the original images without modifying any copyrighted content.

## Supported sites

| Site | Status |
|---|---|
| Naver Webtoon | ✅ Phase 1 |
| Ridi | 🔜 Phase 2 stub |
| Kakao Page | 🔜 Phase 2 stub |

## Architecture

```
Chrome Extension (MV3)
├── content/index.js          Entry point (injected per page)
├── content/adapters/         One file per supported site
├── content/annotation-engine/
│   ├── selector.js           Drag-to-select bounding boxes
│   ├── overlay.js            Render translation bubbles
│   ├── input-dialog.js       Text input UI
│   └── hasher.js             Stable image fingerprinting
├── background/worker.js      Storage API, future: cloud sync
└── popup/                    Extension popup UI

Backend (Phase 2)
└── backend/supabase/         Postgres schema + RLS policies
    └── README-migration.md   How to swap Supabase for another backend
```

## Development

### Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Open any Naver Webtoon chapter

### Usage

1. Click the extension icon in the toolbar
2. **Read mode** (default): shows existing translations as text overlays
3. **Translate mode**: click and drag on any panel image to draw a bounding box → type your translation → Save

### Export / Import

- **Export**: saves all translations for the current title as a `.json` file
- **Import**: loads a previously exported `.json` file

Export format is documented in `docs/adapter-spec.md`.

## Phases

| Phase | Description | Storage |
|---|---|---|
| 1 (current) | Offline, single user | `chrome.storage.local` |
| 2 | Multi-user, cloud sync | Supabase |
| 3 | OCR (Tesseract.js), upvotes | — |

See `backend/README-migration.md` for Phase 2 setup and migration notes.
