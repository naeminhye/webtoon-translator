#!/usr/bin/env python3
"""
Create a minimal valid ONNX model for testing the ORT pipeline end-to-end.

This stub outputs all-zeros — no real bubble detections — but it lets you
verify that ORT loads correctly in the extension before spending time getting
a real model.

Usage:
    pip install onnx        # ~10 MB, no PyTorch needed
    python3 scripts/create-stub-model.py

The output file (extension/models/bubble-detector.onnx) can then be replaced
with a real YOLOv8 model whenever you have one — see extension/models/README.md.
"""
import os, sys

try:
    import onnx
    import onnx.helper as h
    import numpy as np
except ImportError:
    print("Missing dependencies. Run:  pip install onnx numpy")
    sys.exit(1)

OUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'extension', 'models', 'bubble-detector.onnx')
OUT_PATH = os.path.normpath(OUT_PATH)

# Mimic YOLOv8n detection output: [1, 5, 8400]
# 5 = cx, cy, w, h, confidence  |  8400 = num anchors at 640x640
SHAPE = [1, 5, 8400]

input_t  = h.make_tensor_value_info('images',  onnx.TensorProto.FLOAT, [1, 3, 640, 640])
output_t = h.make_tensor_value_info('output0', onnx.TensorProto.FLOAT, SHAPE)

zeros    = np.zeros(SHAPE, dtype=np.float32)
const_nd = h.make_node(
    'Constant', inputs=[], outputs=['output0'],
    value=h.make_tensor('v', onnx.TensorProto.FLOAT, SHAPE, zeros.flatten().tolist())
)

graph = h.make_graph([const_nd], 'bubble-detector-stub', [input_t], [output_t])
model = h.make_model(graph, opset_imports=[h.make_opsetid('', 17)])
model.ir_version = 8

onnx.checker.check_model(model)
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
onnx.save(model, OUT_PATH)

size_kb = os.path.getsize(OUT_PATH) / 1024
print(f"✓ Stub model saved: {OUT_PATH}  ({size_kb:.1f} KB)")
print()
print("This model outputs all-zeros — ORT pipeline test only, no real detections.")
print("Replace with a real model from extension/models/README.md when ready.")
