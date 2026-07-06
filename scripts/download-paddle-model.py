#!/usr/bin/env python3
"""
Download PP-OCRv3 Korean recognition model and convert to ONNX for the
Webtoon Translator extension.

Requirements (auto-installed by this script):
    pip install "paddle2onnx>=1.0.6" "onnx>=1.12" paddlepaddle

All packages have pre-built wheels — no cmake or build tools needed.

Usage:
    python3 scripts/download-paddle-model.py
"""

import os
import sys
import shutil
import subprocess
import tarfile
import glob

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS     = os.path.join(ROOT, 'extension', 'models')
DICT_DEST  = os.path.join(MODELS, 'paddle-kor-dict.txt')
MODEL_DEST = os.path.join(MODELS, 'paddle-kor-rec.onnx')

DICT_URL = ('https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR'
            '/release/2.7/ppocr/utils/dict/korean_dict.txt')

# PP-OCRv3 Korean inference model (Paddle format, .tar)
# This URL is stable and publicly accessible without auth.
MODEL_TAR_URL = ('https://paddleocr.bj.bcebos.com/PP-OCRv3/multilingual/'
                 'korean_PP-OCRv3_rec_infer.tar')

TMP_TAR  = '/tmp/paddle-kor-rec.tar'
TMP_DIR  = '/tmp/paddle-kor-rec-infer'


def run_curl(url, dest, label):
    """Download url → dest using system curl. Works on macOS/Linux, handles SSL."""
    print(f'Downloading {label}...')
    r = subprocess.run(
        ['curl', '-fL', '--progress-bar', '--retry', '3', url, '-o', dest],
        check=False,
    )
    if r.returncode != 0:
        print(f'ERROR: curl failed (exit {r.returncode}) for:\n  {url}')
        return False
    size = os.path.getsize(dest) if os.path.exists(dest) else 0
    if size < 100:
        print(f'ERROR: downloaded file is suspiciously small ({size} bytes)')
        return False
    print(f'  → {dest} ({size // 1024} KB)')
    return True


def ensure_pip_packages():
    """Install paddle2onnx and onnx if missing. Uses pre-built wheels only."""
    needed = []
    try:
        import paddle2onnx  # noqa: F401
    except ImportError:
        needed.append('paddle2onnx>=1.0.6')
    try:
        import onnx  # noqa: F401
    except ImportError:
        needed.append('onnx>=1.12')
    try:
        import paddle  # noqa: F401
    except ImportError:
        needed.append('paddlepaddle')

    if needed:
        print(f'Installing: {", ".join(needed)}')
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--quiet', *needed],
            check=True,
        )


def download_dict():
    if os.path.exists(DICT_DEST) and os.path.getsize(DICT_DEST) > 1000:
        print(f'Dict already exists — skipping.')
        return True
    return run_curl(DICT_URL, DICT_DEST, 'Korean character dictionary')


def download_model_tar():
    if not run_curl(MODEL_TAR_URL, TMP_TAR, 'PP-OCRv3 Korean model (Paddle format, ~10 MB)'):
        print()
        print('Manual download instructions:')
        print(f'  curl -L "{MODEL_TAR_URL}" -o {TMP_TAR}')
        print(f'  python3 {__file__}   # re-run after download')
        return False
    return True


def extract_paddle_model():
    """Extract the .tar into TMP_DIR, return the model directory path."""
    os.makedirs(TMP_DIR, exist_ok=True)
    print(f'Extracting...')
    with tarfile.open(TMP_TAR, 'r') as tf:
        tf.extractall(TMP_DIR)

    # Model dir contains inference.pdmodel + inference.pdiparams
    pdmodel_files = glob.glob(os.path.join(TMP_DIR, '**', '*.pdmodel'), recursive=True)
    if not pdmodel_files:
        print('ERROR: No .pdmodel file found in extracted archive.')
        return None
    return os.path.dirname(pdmodel_files[0])


def convert_to_onnx(model_dir):
    """Convert Paddle inference model → ONNX using paddle2onnx >= 1.0."""
    onnx_out = '/tmp/paddle-kor-rec.onnx'
    print('Converting to ONNX (paddle2onnx)...')
    r = subprocess.run([
        sys.executable, '-m', 'paddle2onnx',
        '--model_dir',        model_dir,
        '--model_filename',   'inference.pdmodel',
        '--params_filename',  'inference.pdiparams',
        '--save_file',        onnx_out,
        '--opset_version',    '11',
        '--enable_onnx_checker', 'True',
    ], check=False, capture_output=True, text=True)

    if r.returncode != 0:
        print('ERROR: paddle2onnx conversion failed.')
        print(r.stdout[-1000:] if r.stdout else '')
        print(r.stderr[-1000:] if r.stderr else '')
        return False

    if not os.path.exists(onnx_out) or os.path.getsize(onnx_out) < 1_000_000:
        print(f'ERROR: Output ONNX file missing or too small: {onnx_out}')
        return False

    shutil.copy(onnx_out, MODEL_DEST)
    size_mb = os.path.getsize(MODEL_DEST) / 1024 / 1024
    print(f'  → {MODEL_DEST} ({size_mb:.1f} MB)')
    return True


if __name__ == '__main__':
    os.makedirs(MODELS, exist_ok=True)

    download_dict()

    real_model = os.path.exists(MODEL_DEST) and os.path.getsize(MODEL_DEST) > 1_000_000
    if real_model:
        size_mb = os.path.getsize(MODEL_DEST) / 1024 / 1024
        print(f'Real model already present ({size_mb:.1f} MB) — skipping download.')
        print(f'Delete {MODEL_DEST} to force re-download.')
        sys.exit(0)

    print('Stub model detected — downloading and converting real PP-OCRv3 Korean model...')

    ensure_pip_packages()

    if not download_model_tar():
        sys.exit(1)

    model_dir = extract_paddle_model()
    if not model_dir:
        sys.exit(1)

    if not convert_to_onnx(model_dir):
        sys.exit(1)

    # Cleanup temp files
    shutil.rmtree(TMP_DIR, ignore_errors=True)
    if os.path.exists(TMP_TAR):
        os.remove(TMP_TAR)

    print()
    print('Done! Reload the extension in chrome://extensions to use PaddleOCR.')
    print('Then: popup → Settings → OCR Engine → PaddleOCR.')
