#!/usr/bin/env python3
"""
Download PP-OCRv4 Korean recognition model (ONNX) for the Webtoon Translator
extension. No cmake, no paddlepaddle, no paddle2onnx required.

Requirements: Python 3.6+, curl, tar (all pre-installed on macOS/Linux)

Usage:
    python3 scripts/download-paddle-model.py
"""

import os
import sys
import shutil
import subprocess
import tarfile
import glob

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS    = os.path.join(ROOT, 'extension', 'models')
DICT_DEST = os.path.join(MODELS, 'paddle-kor-dict.txt')
MODEL_DEST = os.path.join(MODELS, 'paddle-kor-rec.onnx')

DICT_URL  = ('https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR'
             '/release/2.7/ppocr/utils/dict/korean_dict.txt')

# PP-OCRv4 Korean rec model as ONNX, hosted on Baidu BOS (public, no auth)
MODEL_TAR_URL = ('https://paddle-model-ecology.bj.bcebos.com/paddlex/'
                 'official_inference_model/paddle3.0b2/'
                 'korean_PP-OCRv4_rec_infer.tar.gz')


def run_curl(url, dest, label):
    """Download url → dest using system curl. Works on macOS/Linux, handles SSL."""
    print(f'Downloading {label}...')
    r = subprocess.run(
        ['curl', '-fL', '--progress-bar', '--retry', '3', url, '-o', dest],
        check=False,
    )
    if r.returncode != 0:
        print(f'ERROR: curl failed (exit {r.returncode}) for {url}')
        return False
    size = os.path.getsize(dest) if os.path.exists(dest) else 0
    if size < 100:
        print(f'ERROR: downloaded file is too small ({size} bytes) — URL may be wrong or blocked')
        return False
    print(f'  → {dest} ({size // 1024} KB)')
    return True


def download_dict():
    if os.path.exists(DICT_DEST) and os.path.getsize(DICT_DEST) > 1000:
        print(f'Dict already exists — skipping. ({DICT_DEST})')
        return True
    return run_curl(DICT_URL, DICT_DEST, 'Korean character dictionary')


def extract_onnx(tar_path):
    """Extract the .onnx file from the downloaded tar.gz."""
    extract_dir = os.path.join('/tmp', 'paddle-kor-rec-extract')
    os.makedirs(extract_dir, exist_ok=True)
    print(f'Extracting {os.path.basename(tar_path)}...')
    with tarfile.open(tar_path, 'r:gz') as tf:
        tf.extractall(extract_dir)

    onnx_files = glob.glob(os.path.join(extract_dir, '**', '*.onnx'), recursive=True)
    if not onnx_files:
        print('ERROR: No .onnx file found in archive.')
        print('Contents:', os.listdir(extract_dir))
        return False

    src = onnx_files[0]
    shutil.copy(src, MODEL_DEST)
    size_mb = os.path.getsize(MODEL_DEST) / 1024 / 1024
    print(f'  → {MODEL_DEST} ({size_mb:.1f} MB)')
    shutil.rmtree(extract_dir, ignore_errors=True)
    return True


def download_model():
    tar_path = '/tmp/paddle-kor-rec.tar.gz'
    ok = run_curl(MODEL_TAR_URL, tar_path, 'PP-OCRv4 Korean rec model (~10 MB)')
    if not ok:
        print()
        print('Fallback: try downloading manually with one of these commands:')
        print()
        print('  # macOS/Linux:')
        print(f'  curl -L "{MODEL_TAR_URL}" -o /tmp/paddle-kor-rec.tar.gz')
        print(f'  tar -xzf /tmp/paddle-kor-rec.tar.gz -C /tmp/')
        print(f'  cp /tmp/korean_PP-OCRv4_rec_infer/*.onnx "{MODEL_DEST}"')
        print()
        print('  # ModelScope alternative (if Baidu BOS is blocked):')
        print('  pip install modelscope')
        print('  python3 -c "from modelscope import snapshot_download; snapshot_download(\'PaddlePaddle/PP-OCRv4\', local_dir=\'/tmp/pp-ocrv4\')"')
        print(f'  cp /tmp/pp-ocrv4/korean_PP-OCRv4_rec_infer.onnx "{MODEL_DEST}"')
        return False

    return extract_onnx(tar_path)


if __name__ == '__main__':
    os.makedirs(MODELS, exist_ok=True)

    dict_ok = download_dict()
    if not dict_ok:
        print('WARNING: Dict download failed. The dict is already committed to the repo.')
        print(f'         If {DICT_DEST} exists, it will be used.')

    real_model = os.path.exists(MODEL_DEST) and os.path.getsize(MODEL_DEST) > 1_000_000
    if real_model:
        size_mb = os.path.getsize(MODEL_DEST) / 1024 / 1024
        print(f'Real model already present ({size_mb:.1f} MB) — skipping download.')
        print(f'Delete {MODEL_DEST} to force re-download.')
    else:
        print('Stub model detected — downloading real PP-OCRv4 Korean model...')
        model_ok = download_model()
        if not model_ok:
            print()
            print('Stub model is still in place. PaddleOCR provider will return empty text.')
            sys.exit(1)

    print()
    print('Done. Reload the extension in chrome://extensions to use PaddleOCR.')
    print('Then open popup → Settings → OCR Engine → PaddleOCR.')
