# Models

Model files (`*.onnx`) are **not committed** — download and convert them
locally. The bubble detector (`offscreen/ort-runner.js`) loads:

```
extension/models/comic-text-detector.onnx
```

## Setup

1. Download the ONNX model from
   [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx/tree/main)
   (input `images [1,3,1024,1024]`, outputs `blk [1,64512,7]`, `seg`, `det`).

2. (Recommended) Convert to fp16 — ~30% faster on WebGPU, half the size,
   no JS changes needed thanks to `keep_io_types=True`:

   ```
   pip install onnx onnxconverter-common
   python -c "
   import onnx
   from onnxconverter_common import float16
   m = onnx.load(r'comic-text-detector.onnx')
   m16 = float16.convert_float_to_float16(m, keep_io_types=True)
   onnx.save(m16, r'comic-text-detector-fp16.onnx')
   "
   ```

3. Place the file here as `comic-text-detector.onnx` (exact name required).

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
