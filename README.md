# Webtoon Translator

Chrome extension (Manifest V3) that overlays translations on webtoon panels — fully offline by default, no server required. Translators annotate panels directly; readers see text overlaid on the original images without modifying any copyrighted content.

## Supported sites

| Site | Status |
|---|---|
| Naver Webtoon (`comic.naver.com`) | ✅ Full support |
| Kakao Page (`page.kakao.com`) | ✅ Full support |
| Ridi (`ridibooks.com`) | ✅ Full support |
| Bomtoon (`bomtoon.com`) | ✅ Full support |
| Lezhin Comics (`lezhin.com`) | ✅ Full support |
| Qtoon (`qtoon.co.kr`) | ✅ Full support |

## Features

### OCR

Three interchangeable engines, picked in Settings → OCR Engine:

- **Tesseract.js** (offline) — Korean LSTM model bundled in `vendor/tesseract/`, no internet required
- **PaddleOCR — in-browser** (offline) — PP-OCRv4 detector + Korean recognizer run locally via ONNX Runtime Web (WebGPU with WASM fallback). Models (~15 MB) aren't bundled in the extension package — they're fetched once from a GitHub Release into the browser's Cache Storage API from the Settings page, which works whether the extension was loaded unpacked or installed from the Chrome Web Store
- **PaddleOCR — self-hosted** (optional) — best Korean accuracy; talks to a small Python/Flask server you run yourself (`server/paddleocr/`). Settings includes an in-page setup guide with one-click downloads for the server files, so it works even without a git checkout
- **Vision LLM OCR+translate** — when OCR confidence is low (tier = `vision` per the difficulty classifier), the crop is sent to the configured BYOK vision LLM for combined OCR + translation in one step

An **OCR Confidence Stats** panel (Settings → OCR Engine) tracks each engine's average self-reported confidence and call count locally on-device, so you can compare how confident each engine tends to be — not a verified accuracy score, since there's no ground truth to check against, just each engine's own certainty.

### Translation

- **Google Translate** (free, no key) — default fallback
- **BYOK LLM** (optional) — bring your own key for OpenAI, Anthropic, or Gemini; enables LLM-quality translation and vision fallback
  - **Presets**: save multiple key/provider/model/mode combos (e.g. "Fast & cheap" vs "High quality") in Settings → Translation & Appearance and switch the active one instantly, without retyping a key

### Bubble detection

- **ONNX text detector** — offline, runs in an offscreen document via ONNX Runtime Web (WebGPU/WASM); pre-warms on page load so the first click is instant
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

- All annotations and OCR stats stored in `chrome.storage.local` — no server, no account needed
- Export/import as `.json` per title
- OCR confidence stats never leave the device

## Architecture

```
extension/
├── manifest.json
├── background/
│   └── worker.js               Service worker: storage, OCR dispatch (all 4 providers),
│                                 PaddleOCR model download (Cache Storage API), ONNX bubble detection
├── content/
│   ├── bundle.js                Main content script (bundled): UI, OCR pipeline, difficulty classifier
│   ├── adapters/                One adapter per supported site (naver, kakao, ridi, bomtoon, lezhin, qtoon)
│   └── overlay.css              Bubble overlay styles
├── offscreen/
│   ├── ocr.html                 Offscreen document host
│   ├── ocr.js                   Tesseract.js runner (singleton worker)
│   ├── ort-runner.js            ONNX Runtime Web runner (bubble detector)
│   └── paddle-runner.js         ONNX Runtime Web runner (PaddleOCR in-browser: det + rec + CTC decode)
├── popup/
│   ├── popup.html / popup.js    Extension toolbar popup
│   └── settings.html / .js      Settings page (tabbed: General / OCR Engine / Translation & Appearance),
│                                 opened as a full tab, light/dark theme
├── shared/
│   └── llm-adapters.js          BYOK LLM adapters (OpenAI, Anthropic, Gemini) — shared by content + popup
├── models/
│   ├── comic-text-detector.onnx Bubble/text detection model (not committed — fetched via Settings or dev script)
│   ├── paddle-det.onnx          PaddleOCR detector (not committed — fetched via Settings or dev script)
│   ├── paddle-rec-korean.onnx   PaddleOCR Korean recognizer (not committed)
│   └── korean_dict.txt          PaddleOCR recognizer charset (committed)
├── assets/
│   └── paddleocr-server/        Mirror of server/paddleocr/ bundled in the package, so the setup guide
│                                 in Settings can offer direct downloads without a git checkout
└── vendor/
    ├── tesseract/                Tesseract.js + Korean LSTM model (offline)
    └── ort/                     ONNX Runtime Web (offline)

server/
└── paddleocr/                   Self-hosted PaddleOCR HTTP server (Flask) — server.py, requirements.txt,
                                   Dockerfile, README.md

scripts/
├── build.js                     Production build: extension/ -> dist/, strips dev-only blocks
└── fetch-paddle-models.py       Dev helper: converts/downloads the two PaddleOCR ONNX models locally
                                   (only needed for "Load unpacked" iteration or to prep the GitHub
                                   Release the in-browser engine downloads from)
```

## Development

### Versioning

`package.json`, `extension/manifest.json`, and the "applies to version …" line in
`data/publish/privacy-policy.html` must all agree. Run `npm run check:version` after bumping
the version (also enforced automatically by `npm run build`).

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

**Pre-translate whole chapter:** click the extension icon → **Pre-translate whole chapter** to scroll through the entire chapter automatically and queue OCR/translation for every detected bubble (same pipeline as auto-detect-while-scrolling, just driven end-to-end), so the chapter is ready to read offline without manual scrolling.

### Settings

Open the extension icon → **Settings** (opens as a full tab, three sub-tabs):

- **General**: auto-detect bubbles toggle, keyboard shortcuts
- **OCR Engine**: Tesseract / PaddleOCR (in-browser) / PaddleOCR (self-hosted), provider-specific
  fields (API key, server URL + setup guide, model download status), and the OCR Confidence Stats panel
- **Translation & Appearance**: Google / BYOK LLM provider, target language, display mode
  (overlay vs. side-by-side), bubble background opacity, translation font

A light/dark theme toggle lives in the top bar and follows your OS preference until you pick one explicitly.

### Export / Import

In the popup: **Export** saves all annotations for the current title as a `.json` file. **Import** loads a previously exported file.

### Self-hosted PaddleOCR server (optional)

For the best Korean OCR accuracy, run the bundled server:

```bash
cd server/paddleocr
pip install -r requirements.txt
python server.py
```

See `server/paddleocr/README.md` for Docker instructions, the HTTP API, and troubleshooting. If you only have the packed extension (no git checkout), Settings → OCR Engine → PaddleOCR (self-hosted) → "Setup guide" has direct download links for all the files you need.

### PaddleOCR in-browser models (optional)

The in-browser engine's models are fetched on demand from Settings (click "Download models" — works for any install type, packed or unpacked). For local development, `scripts/fetch-paddle-models.py` can produce the same files directly into `extension/models/` as a fallback the runner also checks; see `extension/models/README.md` for both paths and known pitfalls (Python version / paddle2onnx compatibility on Windows).

## Notes

- The extension never modifies page content — overlays are injected as separate DOM elements
- No data is sent to any server unless you configure a BYOK API key, or a PaddleOCR server URL
- Naver/Kakao CDN images are canvas-captured directly from the DOM to avoid hotlink-protection errors in the service worker
