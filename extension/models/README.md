# ONNX Model Installation

Place `bubble-detector.onnx` in this directory before using the ONNX scan feature.

---

## Bước 1 — Test pipeline trước (không cần PyTorch, không cần HuggingFace)

Tạo một stub model hợp lệ để xác nhận ORT chạy được trong extension:

```bash
pip install onnx          # ~10 MB, KHÔNG cần torch/CUDA
python3 scripts/create-stub-model.py
```

Stub model này output all-zeros (không detect được bubble thật), nhưng xác nhận:
- ORT WASM load được trong offscreen document
- Session tạo thành công
- Pipeline message `DETECT_BUBBLES` chạy end-to-end

Sau khi chạy xong, reload extension tại `chrome://extensions`, mở webtoon,
nhấn nút grid icon → sẽ thấy toast "No bubbles detected" (bình thường với stub).

---

## Bước 2 — Thay bằng real model

### Option A — HuggingFace (cần tạo free account)

1. Vào https://huggingface.co/settings/tokens → tạo token với quyền "Read"
2. Tải model:
```bash
curl -L \
  -H "Authorization: Bearer hf_YOUR_TOKEN_HERE" \
  "https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble/resolve/main/model_dynamic.onnx" \
  -o extension/models/bubble-detector.onnx
```

### Option B — Export từ PyTorch (dùng venv tránh conflict Mac)

```bash
python3 -m venv /tmp/ort-venv
source /tmp/ort-venv/bin/activate
pip install ultralytics huggingface_hub

python3 - <<'EOF'
from huggingface_hub import hf_hub_download
from ultralytics import YOLO
import shutil, glob

pt = hf_hub_download(
    repo_id='ogkalu/comic-speech-bubble-detector',
    filename='comic-speech-bubble-detector.pt'
)
YOLO(pt).export(format='onnx', imgsz=640, opset=17, simplify=True)
shutil.copy(glob.glob('*.onnx')[0], 'extension/models/bubble-detector.onnx')
print('Done!')
EOF

deactivate
```

---

## Kiểm tra file hợp lệ

```bash
# Phải > 1 MB (stub ~170 KB, real model ~5–50 MB)
ls -lh extension/models/bubble-detector.onnx

# 4 bytes đầu file ONNX hợp lệ bắt đầu bằng 0x08 (protobuf field tag)
# Nếu thấy "3c 21 44 4f" (<!DO) hoặc "7b 22" ({"e) → là HTML lỗi
xxd extension/models/bubble-detector.onnx | head -1
```

---

## Debug "Can't create a session / protobuf parsing failed"

Nguyên nhân thường gặp: file tải về là HTML error page (thường chỉ vài chục bytes), không phải ONNX binary.

Mở DevTools của offscreen document (`chrome://extensions` → "Inspect views: offscreen document") → Console sẽ hiện log `[ORT]` chi tiết.

---

## Output shape dự kiến

| Model | Input | Output |
|-------|-------|--------|
| Stub (test only) | `[1, 3, 640, 640]` | `[1, 5, 8400]` all zeros |
| YOLOv8 detection | `[1, 3, 640, 640]` | `[1, 5, 8400]` |
| YOLOv8 segmentation | `[1, 3, 640, 640]` | `[1, 37, 8400]` + mask protos |

`ort-runner.js` tự động phát hiện format từ shape của output tensor.
