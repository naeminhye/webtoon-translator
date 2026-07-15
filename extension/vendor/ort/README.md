# ONNX Runtime Web (vendored)

Only the files the extension can actually load at runtime are vendored — this
directory ships inside the Chrome Web Store package, so every extra build
variant is dead weight for every install:

- `ort.webgpu.min.js` — the JSEP (webgpu-enabled) bundle. It is the only JS
  entry point referenced anywhere (`offscreen/ocr.html`,
  `bench/bench-offscreen.html`), and it only ever fetches the `.jsep.wasm`
  binaries below. It also serves the pure-WASM fallback path.
- `ort-wasm-simd.jsep.wasm` — what production loads: `ort-runner.js` hardcodes
  `ort.env.wasm.numThreads = 1` (blob: workers are blocked by MV3 extension
  CSP, so multi-threading is not viable — see the note in `ort-runner.js`).
- `ort-wasm-simd-threaded.jsep.wasm` — kept for the dev-only bench harness
  (`extension/bench/`, never shipped in `dist/`), which doesn't pin
  `numThreads` and can select the threaded binary in a crossOriginIsolated
  context.

Deliberately NOT vendored (deleted when trimming the package): `ort.min.js`
and the non-JSEP `ort-wasm*.wasm` variants — the JSEP bundle never requests
them; they were only reachable via `ort.min.js`, which nothing loads.

When upgrading the vendored build, copy the matching files from
`node_modules/onnxruntime-web/dist/` and keep this list in sync
(also update the version note in `bench/lib/env.js`).
