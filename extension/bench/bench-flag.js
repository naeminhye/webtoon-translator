// Loaded via <script src> BEFORE content/bundle.js in any bench page that
// needs to reuse bundle.js's internals (bubbleDetector, OverlayRenderer).
// Must be a separate file, not an inline <script> block — manifest.json's
// CSP is `script-src 'self' 'wasm-unsafe-eval'`, which blocks inline
// scripts on extension pages, so an inline flag-setter would fail silently.
window.__WT_BENCH_LOAD__ = true;
