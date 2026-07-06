# ONNX Model

Place `bubble-detector.onnx` here before using auto-detect.

## Quick setup

```bash
# From repo root — downloads or exports a real YOLOv8 bubble detector:
bash scripts/get-bubble-model.sh

# If the HuggingFace repo is gated, pass your token:
HF_TOKEN=hf_xxx bash scripts/get-bubble-model.sh
```

The script tries two paths:
1. **HF download** — `kitsumed/yolov8m_seg-speech-bubble` ONNX (~50 MB), fastest
2. **PyTorch export** — `ogkalu/comic-speech-bubble-detector` → ultralytics export (~6 MB YOLOv8n)

After running, reload the extension at `chrome://extensions`.

## Test with stub (no model needed)

To verify the ORT pipeline without a real model:

```bash
pip install onnx
python3 scripts/create-stub-model.py
```

The stub outputs all-zeros (no detections), but confirms ORT WASM loads and the
`DETECT_BUBBLES` message pipeline works end-to-end.

## Expected output shape

| Model | Output shape |
|-------|-------------|
| Stub (test) | `[1, 5, 8400]` all zeros |
| YOLOv8 detect | `[1, 5, 8400]` |
| YOLOv8 seg | `[1, 37, 8400]` + mask protos |

`ort-runner.js` auto-detects the format from the output tensor shape.
