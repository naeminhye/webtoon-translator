#!/usr/bin/env python3
"""
PaddleOCR HTTP server for the Webtoon Translate extension.

Exposes a tiny JSON API the extension's 'paddleocr' provider calls
(see extension/background/worker.js, paddleOcrRun):

  GET  /health -> {"ok": true, "engine": "paddleocr", "lang": "korean"}
  POST /ocr    body {"image": "<base64 or full data: URL>"}
       success -> {"ok": true, "text": "...", "confidence": <0-100|null>,
                   "lines": [{"text", "confidence", "box": [x1,y1,x2,y2]}]}
       failure -> {"ok": false, "error": "..."}  (HTTP 200; non-200 is
                   reserved for transport-level problems)

Confidence is on the 0-100 scale to match what the extension expects from
its OCR providers. Run with:  python server.py [--host 127.0.0.1] [--port 8868]
"""

import argparse
import base64
import io
import logging

import numpy as np
from flask import Flask, jsonify, request
from PIL import Image

log = logging.getLogger('paddleocr-server')
app = Flask(__name__)

OCR_LANG = 'korean'
_ocr = None


def get_ocr():
    """Lazy singleton — the first call downloads models (~30-60 MB) to ~/.paddlex."""
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR
        log.info('Loading PaddleOCR (lang=%s)… first run downloads models', OCR_LANG)
        # Doc-orientation / unwarping / textline-orientation stages are for
        # photographed documents; webtoon crops are clean screen pixels, so
        # skipping them saves model downloads and per-request latency.
        _ocr = PaddleOCR(
            lang=OCR_LANG,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        log.info('PaddleOCR ready')
    return _ocr


@app.after_request
def add_cors(resp):
    # Permissive CORS so the extension can call a non-localhost instance
    # (localhost is already covered by the extension's host_permissions).
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return resp


@app.get('/health')
def health():
    return jsonify(ok=True, engine='paddleocr', lang=OCR_LANG)


def _extract_lines(result_page):
    """Map one paddleocr 3.x OCRResult page to [{text, confidence, box}]."""
    texts = result_page['rec_texts']
    scores = result_page['rec_scores']
    # rec_boxes are axis-aligned [x1,y1,x2,y2]; some builds only expose
    # rec_polys (4-point quads) — derive rects from those in that case.
    boxes = result_page.get('rec_boxes')
    if boxes is None or len(boxes) == 0:
        polys = result_page.get('rec_polys') or result_page.get('dt_polys') or []
        boxes = [
            [
                int(min(p[0] for p in poly)), int(min(p[1] for p in poly)),
                int(max(p[0] for p in poly)), int(max(p[1] for p in poly)),
            ]
            for poly in polys
        ]
    lines = []
    for text, score, box in zip(texts, scores, boxes):
        text = (text or '').strip()
        if not text:
            continue
        x1, y1, x2, y2 = (int(v) for v in box)
        lines.append({
            'text': text,
            'confidence': round(float(score) * 100, 1),
            'box': [x1, y1, x2, y2],
        })
    return lines


@app.route('/ocr', methods=['POST', 'OPTIONS'])
def run_ocr():
    if request.method == 'OPTIONS':
        return ('', 204)
    try:
        payload = request.get_json(force=True, silent=True) or {}
        b64 = payload.get('image', '')
        if not b64:
            return jsonify(ok=False, error='missing "image" field')
        if b64.startswith('data:'):
            b64 = b64.split(',', 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')
        arr = np.array(img)[:, :, ::-1]  # RGB -> BGR (OpenCV convention)

        lines = []
        for page in get_ocr().predict(arr):
            lines.extend(_extract_lines(page))

        # Reading order: top-to-bottom, then left-to-right.
        lines.sort(key=lambda l: (l['box'][1], l['box'][0]))
        text = ' '.join(l['text'] for l in lines)
        conf = round(sum(l['confidence'] for l in lines) / len(lines), 1) if lines else None
        log.info('OCR %dx%d -> %d line(s), conf=%s', img.width, img.height, len(lines), conf)
        return jsonify(ok=True, text=text, confidence=conf, lines=lines)
    except Exception as e:  # noqa: BLE001 — surface anything to the extension
        log.exception('OCR request failed')
        return jsonify(ok=False, error=f'{type(e).__name__}: {e}')


def main():
    parser = argparse.ArgumentParser(description='PaddleOCR server for Webtoon Translate')
    parser.add_argument('--host', default='127.0.0.1',
                        help='bind address (default 127.0.0.1; 0.0.0.0 exposes an '
                             'unauthenticated service to your network — LAN use only)')
    parser.add_argument('--port', type=int, default=8868)
    parser.add_argument('--preload', action='store_true',
                        help='load models at startup instead of on the first request')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if args.preload:
        get_ocr()
    app.run(host=args.host, port=args.port, threaded=False)


if __name__ == '__main__':
    main()
