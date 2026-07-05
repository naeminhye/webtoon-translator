# ONNX Model Installation

The bubble detector model (`bubble-detector.onnx`) is not bundled in the repository
because of its size (~6 MB). Download and place it here before loading the extension.

## Option A — YOLOv8n Speech Bubble Detector (Recommended)

Download from HuggingFace: `ogkalu/comic-speech-bubble-detector`

```bash
pip install huggingface_hub
python - <<'EOF'
from huggingface_hub import hf_hub_download
path = hf_hub_download(
    repo_id="ogkalu/comic-speech-bubble-detector",
    filename="comic-speech-bubble-detector.pt"
)
print("Downloaded to:", path)
EOF

# Export to ONNX (requires ultralytics)
pip install ultralytics
python - <<'EOF'
from ultralytics import YOLO
model = YOLO("comic-speech-bubble-detector.pt")
model.export(format="onnx", imgsz=640, opset=17, simplify=True)
# Rename output
import shutil, glob
onnx_file = glob.glob("*.onnx")[0]
shutil.copy(onnx_file, "extension/models/bubble-detector.onnx")
print("Saved to extension/models/bubble-detector.onnx")
EOF
```

## Option B — CRAFT Text Detector

```bash
git clone https://github.com/clovaai/CRAFT-pytorch
cd CRAFT-pytorch
# Download pretrained weights: craft_mlt_25k.pth
python -c "
import torch, sys
sys.path.insert(0, '.')
from craft import CRAFT
net = CRAFT()
net.load_state_dict(torch.load('craft_mlt_25k.pth', map_location='cpu'))
net.eval()
dummy = torch.randn(1, 3, 768, 768)
torch.onnx.export(
    net, dummy,
    '../extension/models/bubble-detector.onnx',
    input_names=['input'],
    output_names=['score_text', 'score_link'],
    dynamic_axes={'input': {2: 'H', 3: 'W'}},
    opset_version=17,
)
print('Exported CRAFT to extension/models/bubble-detector.onnx')
"
```

## Verifying installation

After placing the file, reload the extension in `chrome://extensions`.
Open a Naver/Kakao webtoon chapter — the grid icon button (bottom-left)
will scan all panels automatically using the ONNX model.
