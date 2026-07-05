#!/usr/bin/env python3
"""
Download PP-OCRv4 Korean recognition model and export to ONNX for use with
the Webtoon Translator extension.

Requirements:
    pip install paddlepaddle paddleocr paddle2onnx

Usage:
    python3 scripts/download-paddle-model.py

The script downloads the Korean PP-OCRv3 rec model (~10 MB) and converts it
to ONNX format, then copies it to extension/models/paddle-kor-rec.onnx.
The character dictionary is downloaded directly from GitHub (no auth needed).
"""

import os
import sys
import shutil
import subprocess
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(ROOT, 'extension', 'models')

DICT_URL = 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/dict/korean_dict.txt'
DICT_DEST = os.path.join(MODELS_DIR, 'paddle-kor-dict.txt')
MODEL_DEST = os.path.join(MODELS_DIR, 'paddle-kor-rec.onnx')


def download_dict():
    print('Downloading Korean character dictionary...')
    urllib.request.urlretrieve(DICT_URL, DICT_DEST)
    with open(DICT_DEST) as f:
        lines = f.read().strip().split('\n')
    print(f'  Dictionary: {len(lines)} characters → {DICT_DEST}')


def download_and_convert_model():
    """
    Option A: Use paddleocr (2.x API) to auto-download and convert.
    The model is cached in ~/.paddleocr after the first run.
    """
    try:
        import paddleocr
        import paddle2onnx
    except ImportError:
        print('ERROR: Missing dependencies. Run:')
        print('  pip install paddlepaddle paddleocr paddle2onnx')
        sys.exit(1)

    print('Initializing PaddleOCR (will download Korean rec model ~10 MB)...')
    from paddleocr import PaddleOCR
    # 2.x API: triggers model download to ~/.paddleocr/whl/rec/korean/
    ocr = PaddleOCR(use_angle_cls=False, lang='korean', show_log=False)

    # Find the downloaded Paddle model directory
    home = os.path.expanduser('~')
    paddle_home = os.path.join(home, '.paddleocr', 'whl', 'rec', 'korean')
    model_dirs = []
    for d in os.listdir(paddle_home):
        full = os.path.join(paddle_home, d)
        if os.path.isdir(full):
            model_dirs.append(full)

    if not model_dirs:
        print('ERROR: Could not find downloaded model under', paddle_home)
        sys.exit(1)

    model_dir = model_dirs[0]
    print(f'  Found Paddle model: {model_dir}')

    # Convert to ONNX
    onnx_out = os.path.join('/tmp', 'paddle-kor-rec-onnx')
    os.makedirs(onnx_out, exist_ok=True)
    print('Converting to ONNX (paddle2onnx)...')
    subprocess.run([
        sys.executable, '-m', 'paddle2onnx',
        '--model_dir', model_dir,
        '--model_filename', 'inference.pdmodel',
        '--params_filename', 'inference.pdiparams',
        '--save_file', os.path.join(onnx_out, 'rec.onnx'),
        '--opset_version', '11',
        '--enable_onnx_checker', 'True',
    ], check=True)

    src = os.path.join(onnx_out, 'rec.onnx')
    shutil.copy(src, MODEL_DEST)
    size_mb = os.path.getsize(MODEL_DEST) / 1024 / 1024
    print(f'  ONNX model saved: {MODEL_DEST} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    os.makedirs(MODELS_DIR, exist_ok=True)

    download_dict()

    if os.path.exists(MODEL_DEST) and os.path.getsize(MODEL_DEST) > 1_000_000:
        print(f'Real model already exists ({os.path.getsize(MODEL_DEST)//1024} KB) — skipping download.')
        print('Delete', MODEL_DEST, 'to force re-download.')
    else:
        print('Stub model detected — downloading real PP-OCRv4 Korean model...')
        download_and_convert_model()

    print('\nDone. Reload the extension in chrome://extensions to use PaddleOCR.')
