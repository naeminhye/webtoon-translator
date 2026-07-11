# PaddleOCR server

Self-hosted OCR backend for the **PaddleOCR** engine option in the Webtoon
Translate extension. PP-OCR's Korean models are noticeably more accurate on
webtoon dialogue than Tesseract or OCR.space — the trade-off is that you run
a small local server yourself.

The extension talks to it at `http://127.0.0.1:8868` by default; a different
URL can be set in the extension popup (Settings → OCR Engine → PaddleOCR).

## Run natively

Requires Python 3.9–3.12.

```bash
cd server/paddleocr
python -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python server.py
```

The first OCR request downloads the Korean PP-OCR models (~30–60 MB) to
`~/.paddlex` — expect it to take a minute. Pass `--preload` to do that at
startup instead. After that, requests are fast (CPU-only is fine).

## Run with Docker

```bash
cd server/paddleocr
docker build -t webtoon-paddleocr .
docker run --rm -p 8868:8868 webtoon-paddleocr
```

Models are baked into the image, so the container is ready immediately.

## Sanity test

```bash
curl -s http://127.0.0.1:8868/health
# {"engine":"paddleocr","lang":"korean","ok":true}

curl -s -X POST http://127.0.0.1:8868/ocr \
  -H 'Content-Type: application/json' \
  -d "{\"image\": \"$(base64 -w0 some-korean-text.png)\"}"
# {"ok":true,"text":"...","confidence":97.3,"lines":[...]}
```

## API

| Route | Method | Body | Response |
|---|---|---|---|
| `/health` | GET | – | `{"ok": true, "engine": "paddleocr", "lang": "korean"}` |
| `/ocr` | POST | `{"image": "<base64 or data: URL>"}` | `{"ok": true, "text", "confidence", "lines"}` or `{"ok": false, "error"}` |

- `text` — detected lines joined in reading order (top→bottom, left→right).
- `confidence` — average recognition score on a **0–100** scale, `null` if no
  text was found.
- `lines` — per-line `{text, confidence, box: [x1, y1, x2, y2]}`.
- OCR failures return `"ok": false` with HTTP 200; non-200 statuses mean
  transport-level problems.

## Notes

- **Security**: the server binds `127.0.0.1` and has no authentication.
  `--host 0.0.0.0` (what the Docker image uses) exposes it to your network —
  only do that on a network you trust.
- **Custom/LAN URLs**: the extension has host permission for
  `localhost`/`127.0.0.1` on any port. Any other host works too because every
  response carries `Access-Control-Allow-Origin: *`.
- **Language**: models are pinned to Korean (`OCR_LANG` in `server.py`) since
  the extension targets Korean webtoons.
