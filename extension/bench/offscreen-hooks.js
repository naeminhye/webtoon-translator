/**
 * bench/offscreen-hooks.js — loaded into bench/bench-offscreen.html
 * alongside the REAL offscreen/ort-runner.js (unmodified), never into
 * production's offscreen/ocr.html. Adds two things ort-runner.js has no
 * reason to carry itself:
 *
 *  1. Long Task collection (PerformanceObserver) — main-thread blocking is
 *     the headline concern for Suite A on both target machines (see
 *     benchmark-plan.md), and Long Tasks can only be observed from inside
 *     the document whose main thread is blocked — i.e. this offscreen
 *     document, not bench.html's own page.
 *  2. A one-shot blob: Worker probe — verifies ort-runner.js's documented
 *     claim that MV3 extension-page CSP blocks the blob: worker scripts
 *     ORT's multi-threaded WASM backend needs, independent of
 *     crossOriginIsolated. This does not touch ort.env.wasm.numThreads or
 *     create any ORT session, so it can never perturb the real sessions
 *     ort-runner.js's getSession() manages.
 */

const _longTasks = [];

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        _longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (err) {
    console.warn('[bench offscreen-hooks] longtask observation unavailable:', err);
  }
}

function probeBlobWorkerCsp() {
  return new Promise((resolve) => {
    // Bare blob-worker spawn (no importScripts) is NOT what ort-runner.js's
    // comment describes failing — its comment is specific: "ORT spawns its
    // thread pool via blob: worker scripts... (importScripts NetworkError)".
    // A worker that just posts a message back never touches importScripts,
    // so it can succeed even when ORT's real thread-pool worker would not.
    // This probe reproduces the actual failure mode: the blob worker calls
    // importScripts() on a same-origin extension resource, same as ORT's
    // pthread worker loading the wasm runtime.
    const ortUrl = chrome.runtime.getURL('vendor/ort/ort.webgpu.min.js');
    const workerSrc = `try { importScripts(${JSON.stringify(ortUrl)}); self.postMessage('ok'); } catch (e) { self.postMessage('importScripts-failed:' + e.message); }`;

    let url;
    try {
      url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    } catch (err) {
      resolve({ blobWorkerAllowed: false, reason: `Blob/URL.createObjectURL failed: ${err.message || err}` });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ blobWorkerAllowed: false, reason: 'worker never responded (timed out)' }), 1000);

    let worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      finish({ blobWorkerAllowed: false, reason: err.message || String(err) });
      return;
    }
    worker.onmessage = (msg) => {
      worker.terminate();
      if (typeof msg.data === 'string' && msg.data.startsWith('importScripts-failed:')) {
        finish({ blobWorkerAllowed: false, reason: msg.data.slice('importScripts-failed:'.length) });
      } else {
        finish({ blobWorkerAllowed: true });
      }
    };
    worker.onerror = (err) => { worker.terminate(); finish({ blobWorkerAllowed: false, reason: err.message || 'blob worker execution error' }); };
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BENCH_GET_LONGTASKS') {
    sendResponse({ longTasks: _longTasks.splice(0, _longTasks.length) });
    return false;
  }
  if (message.type === 'BENCH_GET_OFFSCREEN_ENV') {
    sendResponse({ crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated === true : null });
    return false;
  }
  if (message.type === 'BENCH_GET_HEAP_BYTES') {
    // Sampled HERE (the offscreen document) not the bench page — this is
    // where ORT actually allocates tensors/session buffers. Chrome-only,
    // coarse (quantized), but catches gross leaks per benchmark-plan.md.
    sendResponse({ usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null });
    return false;
  }
  if (message.type === 'BENCH_PROBE_BLOB_WORKER_CSP') {
    probeBlobWorkerCsp().then(sendResponse);
    return true;
  }
  return false;
});
