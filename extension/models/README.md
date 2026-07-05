# ONNX Model Installation

Place `bubble-detector.onnx` in this directory before loading the extension.
The model is not bundled in the repo because of its size.

---

## Cách 1 — curl (đơn giản nhất, không cần Python)

```bash
# Chạy từ thư mục gốc của project
curl -L "https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble/resolve/main/model_dynamic.onnx" \
     -o extension/models/bubble-detector.onnx
```

> **Lưu ý**: File này khoảng ~50MB, chờ tải xong (curl hiển thị progress).
> Nếu curl báo xong nhưng file chỉ vài chục bytes → URL không đúng, thử Cách 2.

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

## Kiểm tra model đã tải đúng chưa

```bash
# File phải lớn hơn 1MB — nếu nhỏ hơn thì là lỗi redirect HTML
ls -lh extension/models/bubble-detector.onnx

# Inspect input/output shape (cần pip install onnx)
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
| YOLOv8 detection (1 class) | `[1, 3, 640, 640]` | `[1, 5, 8400]` |
| YOLOv8 segmentation (1 class) | `[1, 3, 640, 640]` | `[1, 37, 8400]` + mask protos |
| YOLOv8 transposed | `[1, 3, 640, 640]` | `[1, 8400, 5+]` |

`ort-runner.js` tự động phát hiện format. Mở DevTools → offscreen document console để xem log `[ORT] Output shape:`.

---

## Debug "Can't create a session"

Lỗi này xảy ra khi file model không hợp lệ (ví dụ: file HTML 40 bytes thay vì ONNX). Kiểm tra:

```bash
# Kích thước file — phải > 1MB
wc -c extension/models/bubble-detector.onnx

# 4 bytes đầu của file ONNX hợp lệ là: 08 XX 08 XX (protobuf magic)
xxd extension/models/bubble-detector.onnx | head -1
```

Nếu thấy `3c 21 44 4f` (`<!DO`) hoặc `7b 22 65` (`{"e`) → file là HTML lỗi, cần tải lại.

---

## Sau khi cài model

1. Reload extension tại `chrome://extensions`
2. Mở bất kỳ chapter nào trên Naver/Kakao webtoon
3. Nhấn nút **grid icon** (góc dưới trái, phía trên nút scan đơn)
4. Extension quét toàn bộ panel và tự động detect bong bóng → OCR + dịch
