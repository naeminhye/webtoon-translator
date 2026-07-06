# Webtoon Translate

Chrome extension (Manifest V3) that overlays translations on webtoon panels — fully offline by default, no server required. Translators annotate panels directly; readers see text overlaid on the original images without modifying any copyrighted content.

## Supported sites

| Site | Status |
|---|---|
| Naver Webtoon (`comic.naver.com`) | ✅ Full support |
| Kakao Page (`page.kakao.com`) | ✅ Full support |
| Bomtoon (`bomtoon.com`) | ✅ Full support |
| Ridi (`ridibooks.com`) | 🔜 Stub |

## Features

### OCR
- **Tesseract.js** (offline) — Korean LSTM model bundled in `vendor/tesseract/`, no internet required
- **OCR.space** (optional) — cloud API fallback, faster for some stylized fonts; requires free API key
- **Vision LLM OCR+translate** — when Tesseract confidence is low (tier = vision per DifficultyClassifier), crop is sent to the configured BYOK vision LLM for combined OCR + translation in one step

### Translation
- **Google Translate** (free, no key) — default fallback
- **DeepL** (optional) — higher quality; requires API key
- **BYOK LLM** (optional) — bring your own key for OpenAI, Anthropic, or Gemini; enables LLM-quality translation and vision fallback

### Bubble detection
- **ONNX YOLOv8** bubble detector — offline, runs in offscreen document via ONNX Runtime Web v1.18.0; pre-warms on page load so first click is instant
- **Flood-fill fallback** — always available without the ONNX model; triggered by click position

### Difficulty classifier
Each OCR result is classified into a tier before translation:

| Tier | Trigger | Action |
|---|---|---|
| `easy` | Short text, high confidence | Machine translation (fast) |
| `medium` | Normal text | Machine translation |
| `hard` | Honorifics, complex text | LLM translation (if BYOK configured) |
| `vision` | Low OCR confidence or high skew angle | Vision LLM OCR+translate (if BYOK configured) |

### Storage
- All annotations stored in `chrome.storage.local` — no server, no account needed
- Export/import as `.json` per title
- Storage usage indicator in settings

## Architecture

```
extension/
├── manifest.json
├── background/
│   └── worker.js              Service worker: storage, OCR dispatch, ONNX bubble detection
├── content/
│   ├── bundle.js              Main content script (bundled): UI, OCR pipeline, difficulty classifier
│   ├── adapters/              One adapter per supported site (naver, kakao, ridi)
│   └── overlay.css            Bubble overlay styles
├── offscreen/
│   ├── ocr.html               Offscreen document host
│   ├── ocr.js                 Tesseract.js runner (singleton worker)
│   └── ort-runner.js          ONNX Runtime Web runner (YOLOv8 bubble detector)
├── popup/
│   ├── popup.html / popup.js  Extension toolbar popup
│   └── settings.html / .js   Settings page (OCR provider, BYOK keys, translation language)
├── shared/
│   └── llm-adapters.js        BYOK LLM adapters (OpenAI, Anthropic, Gemini) — shared by content + popup
├── models/
│   └── bubble-detector.onnx   YOLOv8n bubble detection model
└── vendor/
    ├── tesseract/              Tesseract.js + Korean LSTM model (offline)
    └── ort/                   ONNX Runtime Web v1.18.0 (offline)
```

## Development

### Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Open any supported webtoon chapter

### Usage

**Read mode** (default):
- Existing translations appear as overlays automatically

**Translate mode:**
1. Click the extension icon → enable Translate mode
2. Click any panel to auto-detect the speech bubble (ONNX + flood-fill)
3. Or click and drag to manually draw a bounding box
4. OCR runs automatically → translation appears in the overlay
5. Click an existing bubble to edit or delete it

### Settings

Open the extension icon → **Settings** to configure:
- **OCR provider**: Tesseract (default, offline) or OCR.space (online, free key)
- **Translation**: Google Translate (default) or DeepL (API key)
- **BYOK LLM**: OpenAI / Anthropic / Gemini key + model — enables LLM translation and vision OCR fallback
- **Target language**: language code for translations (default: `vi`)

### Export / Import

In the popup: **Export** saves all annotations for the current title as a `.json` file. **Import** loads a previously exported file.

## Notes

- The extension never modifies page content — overlays are injected as separate DOM elements
- No data is sent to any server unless you configure a BYOK API key or OCR.space key
- Naver/Kakao CDN images are canvas-captured directly from the DOM to avoid hotlink-protection errors in the service worker
