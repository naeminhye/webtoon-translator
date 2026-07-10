# Models

Model files (`*.onnx`) are **not committed** — download and convert them
locally. The bubble detector (`offscreen/ort-runner.js`) loads:

```
extension/models/comic-text-detector.onnx
```

## Setup

1. Download the ONNX model from
   [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx/tree/main)
   (input `images [1,3,1024,1024]`, outputs `blk [1,64512,7]`, `seg`, `det`).

2. (Recommended) Convert to fp16 — ~30% faster on WebGPU, half the size,
   no JS changes needed thanks to `keep_io_types=True`:

   ```
   pip install onnx onnxconverter-common
   python -c "
   import onnx
   from onnxconverter_common import float16
   m = onnx.load(r'comic-text-detector.onnx')
   m16 = float16.convert_float_to_float16(m, keep_io_types=True)
   onnx.save(m16, r'comic-text-detector-fp16.onnx')
   "
   ```

3. Place the file here as `comic-text-detector.onnx` (exact name required).
