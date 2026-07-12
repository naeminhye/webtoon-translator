# Models

Model files (`*.onnx`) are **not committed** — see below for how each one
reaches the extension at runtime.

## Bubble detector (Auto-detect bubbles)

`offscreen/ort-runner.js` loads:

```
extension/models/comic-text-detector.onnx
```

### For end users: the "Download model" button (primary path)

Same rationale as the PaddleOCR models below — this file can't be bundled in
the package (a Chrome-Web-Store install can't have files written into its own
install directory after the fact). Settings → General → Auto-detect bubbles
has a **"Download model"** button once the toggle is on: the background
service worker (`background/worker.js`, `comicDetectorDownload`) fetches it
at runtime from a GitHub Release of this repo into the extension's Cache
Storage API (`caches.open('comic-text-detector-models-v1')`) — same-origin
storage shared with the offscreen document that runs inference. Works
identically whether the extension was loaded unpacked or installed from the
Web Store. See `background/worker.js`'s `COMIC_DETECTOR_RELEASE`/
`COMIC_DETECTOR_FILE` constants for the exact URL.

### For maintainers: preparing the GitHub Release

1. Download the ONNX model from
   [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx/tree/main)
   (input `images [1,3,1024,1024]`, outputs `blk [1,64512,7]`, `seg`, `det`).

2. (Recommended) Convert to fp16 — ~30% faster on WebGPU, half the size,
   no JS changes needed thanks to `keep_io_types=True`. Use a throwaway
   virtual environment so `pip install` doesn't touch your system Python
   (macOS Homebrew Python and some Linux distros block system-wide
   `pip install` with an "externally-managed-environment" error otherwise):

   ```
   python3 -m venv .venv-model-convert
   source .venv-model-convert/bin/activate   # Windows: .venv-model-convert\Scripts\activate
   pip install onnx onnxconverter-common
   python -c "
   import onnx
   from onnxconverter_common import float16
   m = onnx.load(r'comic-text-detector.onnx')
   m16 = float16.convert_float_to_float16(m, keep_io_types=True)
   onnx.save(m16, r'comic-text-detector-fp16.onnx')
   "
   deactivate
   rm -rf .venv-model-convert   # optional cleanup — not part of the repo
   ```

3. Create a GitHub Release on this repo tagged **`comic-text-detector-v1`**
   and attach the file as a release asset named **exactly**
   `comic-text-detector.onnx` (that filename is the cache key `ort-runner.js`/
   `worker.js` look up). If the model ever changes, publish a **new** tag
   (e.g. `comic-text-detector-v2`) rather than overwriting this tag's asset —
   already-cached user bytes at the old URL wouldn't know to invalidate — and
   update `COMIC_DETECTOR_RELEASE` in both `worker.js` and `ort-runner.js`
   together.

### Dev fallback: local file + "Load unpacked"

`ort-runner.js` still checks `extension/models/comic-text-detector.onnx` as a
secondary source if the Cache Storage entry is empty — convenient if you're
iterating on the model itself and don't want to go through a Release each
time. Place the file here (exact name required) and reload the unpacked
extension; no button click needed. `scripts/create-stub-model.py` produces a
zero-output stub at this same path/shape for exercising the pipeline without
a real model.

Without either source, auto-detect shows an actionable "model not installed"
error pointing back at the Settings button; manual region selection is
unaffected.

## PaddleOCR (in-browser engine)

The `paddleocr-local` OCR engine (`offscreen/paddle-runner.js`) needs two
ONNX models plus a charset file:

```
paddle-det.onnx        (PP-OCRv4 text detector, ~4.7 MB)
paddle-rec-korean.onnx (PP-OCRv4 Korean recognizer, ~10.6 MB)
korean_dict.txt         (recognizer charset — committed, bundled in the package)
```

### For end users: the "Download models" button (primary path)

These `.onnx` files are **not** part of the extension package — a
Chrome-Web-Store-installed extension can't have files written into its own
install directory, so they can't be bundled-and-then-fetched-locally the way
`comic-text-detector.onnx` above is. Instead, Settings → OCR Engine →
PaddleOCR (in-browser) has a **"Download models"** button: the background
service worker (`background/worker.js`, `paddleModelsDownload`) fetches them
at runtime from a GitHub Release of this repo into the extension's Cache
Storage API (`caches.open('paddle-ocr-models-v1')`) — same-origin storage
shared with the offscreen document that actually runs inference, so nothing
needs to touch disk. This works identically whether the extension was loaded
unpacked or installed from the Web Store. See `background/worker.js`'s
`PADDLE_MODELS_RELEASE`/`PADDLE_MODEL_FILES` constants for the exact URLs.

### For maintainers: preparing the GitHub Release

The release the button downloads from doesn't populate itself — build it
once (and again whenever the models change):

1. Produce the two ONNX files locally, ideally in a throwaway venv on
   Python 3.9-3.12 (paddle2onnx has no wheel for newer Pythons yet, and pip
   silently falls back to a broken ancient release instead of erroring —
   see the script's module docstring for details):
   ```
   pip install paddle2onnx packaging paddlepaddle
   python scripts/fetch-paddle-models.py
   ```
   This downloads the official PaddleOCR inference tars and converts them
   (or, with `--fallback-only`, downloads pre-converted ONNX from the
   RapidOCR HuggingFace hub instead — no paddle2onnx/paddlepaddle needed,
   though that fallback URL is unverified and may 404; the detector alone
   also has a reliable pip-only fallback via `rapidocr-onnxruntime`, tried
   automatically). Output lands in `extension/models/paddle-det.onnx` and
   `extension/models/paddle-rec-korean.onnx`.
2. Create a GitHub Release on this repo tagged **`paddle-models-v1`** and
   attach those two files as release assets, with these **exact** filenames
   (they're the cache keys `paddle-runner.js`/`worker.js` look up):
   - `paddle-det.onnx`
   - `paddle-rec-korean.onnx`
3. That's it — the download URLs are
   `https://github.com/<owner>/<repo>/releases/download/paddle-models-v1/<filename>`,
   already wired into `worker.js` and `paddle-runner.js`. If the models ever
   change, publish a new tag (e.g. `paddle-models-v2`) and update the
   `PADDLE_MODELS_RELEASE` constant in both files together — don't overwrite
   assets on an existing tag, since users' already-cached bytes wouldn't
   know to invalidate.

### Dev fallback: local files + "Load unpacked"

`paddle-runner.js` still checks `extension/models/paddle-det.onnx` /
`paddle-rec-korean.onnx` as a secondary source if the Cache Storage entry is
empty — convenient if you're iterating on the models themselves and don't
want to go through a Release each time. Run step 1 above and reload the
unpacked extension; no button click needed.

Without either source, the "PaddleOCR (in-browser)" engine shows an
actionable "models not installed" error pointing back at the Settings
button; the other OCR engines are unaffected.
