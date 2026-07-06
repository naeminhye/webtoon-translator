#!/usr/bin/env bash
# Download or export a real YOLOv8 bubble detection model.
# Run this from the repo root: bash scripts/get-bubble-model.sh
set -euo pipefail

DEST="extension/models/bubble-detector.onnx"

echo "=== Webtoon Translator — bubble detector model setup ==="

# ── Option A: kitsumed/yolov8m_seg-speech-bubble (ONNX, ~50 MB) ──────────────
# This model is gated on HuggingFace — you need a free account + read token.
# Get a token at: https://huggingface.co/settings/tokens
HF_TOKEN="${HF_TOKEN:-}"
if [[ -n "$HF_TOKEN" ]]; then
  echo "[A] Downloading from HuggingFace (token provided)…"
  curl -fL \
    -H "Authorization: Bearer $HF_TOKEN" \
    "https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble/resolve/main/model_dynamic.onnx" \
    -o "$DEST"
  echo "[A] Done: $(ls -lh "$DEST" | awk '{print $5}')"
  exit 0
fi

# ── Option B: Export YOLOv8n trained on comic-speech-bubble-detector ──────────
# Requires: pip install ultralytics huggingface_hub
# Uses the ogkalu/comic-speech-bubble-detector .pt weights (public HF repo).
echo "[B] No HF_TOKEN set — trying PyTorch export…"

if ! python3 -c "import ultralytics" 2>/dev/null; then
  echo "    Installing ultralytics (this may take a minute)…"
  pip install ultralytics huggingface_hub --quiet
fi

python3 - <<'PYEOF'
import sys, os, glob, shutil
from pathlib import Path

print("    Downloading comic-speech-bubble-detector.pt from HuggingFace…")
try:
    from huggingface_hub import hf_hub_download
    pt_path = hf_hub_download(
        repo_id="ogkalu/comic-speech-bubble-detector",
        filename="comic-speech-bubble-detector.pt",
        local_dir="/tmp/bubble-model",
    )
    print(f"    Downloaded: {pt_path}")
except Exception as e:
    print(f"    HuggingFace download failed: {e}")
    print("    → Set HF_TOKEN env var and re-run, or download manually.")
    sys.exit(1)

print("    Exporting to ONNX…")
from ultralytics import YOLO
model = YOLO(pt_path)
export_dir = Path("/tmp/bubble-export")
export_dir.mkdir(exist_ok=True)
onnx_path = model.export(
    format="onnx",
    imgsz=640,
    opset=17,
    simplify=True,
    dynamic=False,
    half=False,
)
shutil.copy(onnx_path, "extension/models/bubble-detector.onnx")
print(f"    Copied to extension/models/bubble-detector.onnx")
size = os.path.getsize("extension/models/bubble-detector.onnx")
print(f"    Size: {size/1024/1024:.1f} MB")
PYEOF

echo "[B] Done."
