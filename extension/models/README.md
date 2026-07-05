# ONNX Model Installation

Place `bubble-detector.onnx` in this directory before loading the extension.
The model is not bundled in the repo because of its size.

---

## Cách 1 — curl (đơn giản nhất, không cần Python)

```bash
# Chạy từ thư mục gốc của project
curl -L "https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/model.onnx" \
     -o extension/models/bubble-detector.onnx
```

Sau khi tải xong, reload extension tại `chrome://extensions` và thử nút grid icon
(góc dưới trái) trên một trang webtoon.

---

## Cách 2 — Python venv (tránh conflict dependencies trên Mac)

```bash
# Tạo môi trường ảo — không ảnh hưởng đến các package đã cài
python3 -m venv /tmp/ort-venv
source /tmp/ort-venv/bin/activate

pip install huggingface_hub ultralytics

python3 - <<'EOF'
from huggingface_hub import hf_hub_download
from ultralytics import YOLO
import shutil, glob

pt = hf_hub_download(
    repo_id='ogkalu/comic-speech-bubble-detector',
    filename='comic-speech-bubble-detector.pt'
)
YOLO(pt).export(format='onnx', imgsz=640, opset=17, simplify=True)
onnx_file = glob.glob('*.onnx')[0]
shutil.copy(onnx_file, 'extension/models/bubble-detector.onnx')
print('Done →', 'extension/models/bubble-detector.onnx')
EOF

deactivate
```

---

## Inspect model output shape (để debug nếu cần)

```bash
pip install onnx
python3 - <<'EOF'
import onnx
m = onnx.load("extension/models/bubble-detector.onnx")
print("Inputs:")
for inp in m.graph.input:
    shape = [d.dim_value or d.dim_param for d in inp.type.tensor_type.shape.dim]
    print(f"  {inp.name}: {shape}")
print("Outputs:")
for out in m.graph.output:
    shape = [d.dim_value or d.dim_param for d in out.type.tensor_type.shape.dim]
    print(f"  {out.name}: {shape}")
EOF
```

---

## Output shape dự kiến

| Model | Input | Output |
|-------|-------|--------|
| YOLOv8 detection | `[1, 3, 640, 640]` | `[1, 5, 8400]` — (cx,cy,w,h,conf) |
| YOLOv8 detection (transposed) | `[1, 3, 640, 640]` | `[1, 8400, 5]` — cần transpose |
| CRAFT | `[1, 3, H, W]` | heatmap `[1, H/2, W/2, 2]` |

`ort-runner.js` tự động phát hiện format dựa trên shape của output tensor.

---

## Sau khi cài model

1. Reload extension tại `chrome://extensions`
2. Mở bất kỳ chapter nào trên Naver/Kakao webtoon
3. Nhấn nút **grid icon** (góc dưới trái, phía trên nút scan đơn) → extension sẽ quét toàn bộ panel và tự động detect bong bóng
4. Mỗi bong bóng được detect sẽ đi vào pipeline OCR + dịch như bình thường
