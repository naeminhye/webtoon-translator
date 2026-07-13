/**
 * bench/lib/offscreen-client.js — talks to bench/bench-offscreen.html, the
 * offscreen document that hosts the REAL, unmodified detection/OCR runners
 * (ort-runner.js, paddle-runner.js, ocr.js) plus bench-only instrumentation
 * (offscreen-hooks.js). Shared by suite-a.js and suite-b.js so there's one
 * place that knows the message contract.
 */

export async function ensureBenchOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API unavailable — Chrome 109+ required');
  }
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('bench/bench-offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Benchmark harness driving the real detection/OCR pipeline (ort-runner.js, paddle-runner.js, ocr.js) unmodified',
    });
  }
}

export function sendDetect(payload) {
  return chrome.runtime.sendMessage({ type: 'DETECT_RUN', payload });
}

export function sendTesseractOcr(payload) {
  return chrome.runtime.sendMessage({ type: 'OCR_RUN', payload });
}

export function sendPaddleLocalOcr(payload) {
  return chrome.runtime.sendMessage({ type: 'PADDLE_OCR_RUN', payload });
}

export async function drainLongTasks() {
  const res = await chrome.runtime.sendMessage({ type: 'BENCH_GET_LONGTASKS' });
  return res?.longTasks || [];
}

export async function getHeapBytes() {
  const res = await chrome.runtime.sendMessage({ type: 'BENCH_GET_HEAP_BYTES' });
  return res?.usedJSHeapSize ?? null;
}

export async function getOffscreenEnv() {
  return chrome.runtime.sendMessage({ type: 'BENCH_GET_OFFSCREEN_ENV' });
}

export async function probeBlobWorkerCsp() {
  return chrome.runtime.sendMessage({ type: 'BENCH_PROBE_BLOB_WORKER_CSP' });
}
