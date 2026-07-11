#!/usr/bin/env python3
"""
Fetch + convert the PP-OCR models used by the extension's in-browser
'paddleocr-local' OCR engine (extension/offscreen/paddle-runner.js).

Produces, in extension/models/ :
  paddle-det.onnx        - PP-OCRv4 mobile text detector (DBNet, language-agnostic)
  paddle-rec-korean.onnx - PP-OCRv4 Korean text recognizer (CTC)
  korean_dict.txt        - recognizer charset (committed to git; re-fetched if missing)

The .onnx files are gitignored (see extension/models/README.md) — every
developer/user who wants the in-browser engine runs this script once.

Primary source: official PaddleOCR inference tars from paddleocr.bj.bcebos.com,
converted locally with paddle2onnx (pip install paddle2onnx). Fallback
sources, tried in order: (1) for the detector only, the identical official
weights bundled inside the `rapidocr-onnxruntime` PyPI package — no PaddlePaddle
or C++ toolchain needed, just pip; (2) pre-converted ONNX from the RapidOCR
model hub on HuggingFace, for whichever model still needs one (this URL is
best-effort and unverified against the live repo layout — if it 404s, please
open an issue with the corrected path).

Common paddle2onnx pitfalls:

- On Windows, `pip install paddle2onnx` with no version pin can silently
  resolve to the ancient 0.9.2 release (the only one with a
  Python-version-agnostic wheel) if your Python is newer than what current
  paddle2onnx wheels (cp38-cp312) support — e.g. Python 3.13+. That old
  0.9.2 needs a live `paddle.fluid` runtime and fails with
  `ModuleNotFoundError: No module named 'paddle.fluid'`. Fix: use Python
  3.9-3.12 for this script (a throwaway venv is fine), or explicitly
  `pip install "paddle2onnx>=1.0"` so pip fails loudly instead of
  downgrading silently if your Python is too new.
- Even the modern paddle2onnx (>=1.0) imports `paddlepaddle` (and
  `packaging`) at startup regardless of whether the conversion itself needs
  it — `pip install paddle2onnx` alone does NOT pull these in. In a fresh
  venv: `pip install paddle2onnx packaging paddlepaddle` (plain
  `paddlepaddle`, any recent version — no need to match the pin in
  server/paddleocr/requirements.txt, this is a separate one-off venv).

Usage:
  pip install paddle2onnx packaging paddlepaddle   # only needed for the primary source
  python scripts/fetch-paddle-models.py [--fallback-only]
"""

import argparse
import io
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / 'extension' / 'models'

BCEBOS = 'https://paddleocr.bj.bcebos.com'
DET_TAR = f'{BCEBOS}/PP-OCRv4/chinese/ch_PP-OCRv4_det_infer.tar'
# v4 first; v3 korean rec is the documented fallback (same input height 48,
# same korean_dict.txt charset).
REC_TARS = [
    f'{BCEBOS}/PP-OCRv4/multilingual/korean_PP-OCRv4_rec_infer.tar',
    f'{BCEBOS}/PP-OCRv3/multilingual/korean_PP-OCRv3_rec_infer.tar',
]

DICT_URL = ('https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/'
            'release/2.7/ppocr/utils/dict/korean_dict.txt')

# Pre-converted ONNX (RapidOCR model hub) — used with --fallback-only or when
# the primary path fails. Mirrors the same official Paddle checkpoints. Path
# layout is best-effort/unverified (see module docstring) — the det model has
# a more reliable fallback below (det_via_rapidocr_pip), so this URL mainly
# matters for rec, which has no pip-installable source.
HF = 'https://huggingface.co/SWHL/RapidOCR/resolve/main'
FALLBACK_DET = f'{HF}/PP-OCRv4/det/ch_PP-OCRv4_det_infer.onnx'
FALLBACK_RECS = [
    f'{HF}/PP-OCRv4/rec/korean_PP-OCRv4_rec_infer.onnx',
    f'{HF}/PP-OCRv3/rec/korean_PP-OCRv3_rec_infer.onnx',
]


def log(msg):
    print(f'[fetch-paddle-models] {msg}', flush=True)


def download(url, dest: Path):
    log(f'downloading {url}')
    with urllib.request.urlopen(url) as res:
        data = res.read()
    dest.write_bytes(data)
    log(f'  -> {dest} ({len(data) / 1e6:.1f} MB)')


def convert_tar_to_onnx(tar_url: str, out_path: Path):
    """Download an official inference tar and convert it with paddle2onnx."""
    if shutil.which('paddle2onnx') is None:
        raise RuntimeError('paddle2onnx not on PATH — pip install paddle2onnx, '
                           'or rerun with --fallback-only')
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        log(f'downloading {tar_url}')
        with urllib.request.urlopen(tar_url) as res:
            buf = io.BytesIO(res.read())
        with tarfile.open(fileobj=buf) as tar:
            tar.extractall(tmp)
        # tars contain a single directory with inference.pdmodel/.pdiparams
        model_dir = next(p for p in tmp.iterdir() if p.is_dir())
        # newer exports name the files inference.json/pdiparams; probe both
        model_file = 'inference.pdmodel'
        if not (model_dir / model_file).exists():
            candidates = list(model_dir.glob('*.pdmodel')) + list(model_dir.glob('*.json'))
            if not candidates:
                raise RuntimeError(f'no model file found in {tar_url}')
            model_file = candidates[0].name
        cmd = [
            'paddle2onnx',
            '--model_dir', str(model_dir),
            '--model_filename', model_file,
            '--params_filename', 'inference.pdiparams',
            '--opset_version', '14',
            '--save_file', str(out_path),
        ]
        log('converting: ' + ' '.join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            if 'paddle.fluid' in proc.stderr:
                raise RuntimeError(
                    "installed paddle2onnx is the legacy pre-1.0 release (needs a live "
                    "PaddlePaddle 'paddle.fluid' runtime this repo doesn't install) — this "
                    "usually means pip silently picked an old version because no current "
                    "paddle2onnx wheel supports your Python version. Use Python 3.9-3.12 for "
                    "this script, or run `pip install \"paddle2onnx>=1.0\"` explicitly so pip "
                    "fails loudly instead of downgrading if that's still not available."
                )
            # paddle2onnx>=1.0's own __init__.py unconditionally imports a few
            # packages before it does anything else — none of them are pulled
            # in automatically by `pip install paddle2onnx` alone, so a fresh
            # venv hits these one at a time. Surface the fix instead of the
            # raw traceback; ModuleNotFoundError's message is always exactly
            # `No module named '<name>'`.
            missing = re.search(r"No module named '([\w.]+)'", proc.stderr)
            if missing:
                mod = missing.group(1)
                pip_name = 'paddlepaddle' if mod == 'paddle' else mod
                raise RuntimeError(
                    f"paddle2onnx failed to import '{mod}' — install it in the same "
                    f"environment: pip install {pip_name}"
                )
            sys.stderr.write(proc.stderr)
            raise RuntimeError(f'paddle2onnx exited with status {proc.returncode}')
    log(f'  -> {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)')


def det_via_rapidocr_pip(out_path: Path):
    """Detector-only fallback: rapidocr-onnxruntime bundles the identical
    official ch_PP-OCRv4_det_infer.onnx as package data (the detector is
    shared across every PP-OCR language pack, so "ch" here just means the
    package's default install, not a language restriction). Pure pip, no
    PaddlePaddle/C++ toolchain, no bcebos.com/HuggingFace network dependency —
    the most reliable of the three det sources.
    """
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'rapidocr-onnxruntime'],
                       check=True)
        import rapidocr_onnxruntime
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f'pip install rapidocr-onnxruntime failed: {e}') from e
    src = Path(rapidocr_onnxruntime.__file__).parent / 'models' / 'ch_PP-OCRv4_det_infer.onnx'
    if not src.exists():
        raise RuntimeError(f'rapidocr-onnxruntime installed but {src.name} not found at {src}')
    shutil.copyfile(src, out_path)
    log(f'  -> {out_path} ({out_path.stat().st_size / 1e6:.1f} MB, via rapidocr-onnxruntime)')


def fetch_first(urls, fetch, label):
    last_err = None
    for url in urls:
        try:
            fetch(url)
            return
        except Exception as e:  # noqa: BLE001
            log(f'  {label} source failed ({url}): {e}')
            last_err = e
    raise RuntimeError(f'all {label} sources failed') from last_err


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument('--fallback-only', action='store_true',
                        help='skip paddle2onnx and download pre-converted ONNX '
                             'from the RapidOCR HuggingFace hub instead')
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    det_path = MODELS_DIR / 'paddle-det.onnx'
    rec_path = MODELS_DIR / 'paddle-rec-korean.onnx'
    dict_path = MODELS_DIR / 'korean_dict.txt'

    if not dict_path.exists():
        download(DICT_URL, dict_path)
    else:
        log(f'{dict_path.name} already present, skipping')

    def get(out_path, primary_urls, fallback_fns, label):
        if out_path.exists():
            log(f'{out_path.name} already present, skipping (delete it to re-fetch)')
            return
        if not args.fallback_only:
            try:
                fetch_first(primary_urls, lambda u: convert_tar_to_onnx(u, out_path), label)
                return
            except Exception as e:  # noqa: BLE001
                log(f'primary path failed for {label} ({e}); trying fallback source(s)')
        last_err = None
        for fn in fallback_fns:
            try:
                fn(out_path)
                return
            except Exception as e:  # noqa: BLE001
                log(f'  {label} fallback failed: {e}')
                last_err = e
        raise RuntimeError(f'all {label} sources failed') from last_err

    get(det_path, [DET_TAR],
        [det_via_rapidocr_pip, lambda p: download(FALLBACK_DET, p)], 'det')
    get(rec_path, REC_TARS,
        [lambda p: fetch_first(FALLBACK_RECS, lambda u: download(u, p), 'rec')], 'rec')

    log('done. Reload the extension and pick "PaddleOCR (in-browser)" in settings.')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log(f'ERROR: {e}')
        sys.exit(1)
