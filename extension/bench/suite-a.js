/**
 * bench/suite-a.js — Suite A screening: execution provider × tile size,
 * no overlap, native resolution (9 in the full plan, 6 here since the
 * `wasm-threads` variant is a documented dead end in this codebase — see
 * the blob-worker CSP capability probe below, run once per session instead
 * of faked as a full config).
 *
 * Drives the REAL offscreen/ort-runner.js unmodified via the same
 * DETECT_RUN message background/worker.js uses in production — see
 * bench-offscreen.html. Placeholder synthetic tiles only (no real corpus
 * yet) — every record is tagged corpus: 'synthetic' and carries no quality
 * metrics, so it can never be mistaken for a real baseline later.
 */

import { captureEnvironment } from './lib/env.js';
import { getComicDetectorModelInfo } from './lib/model-info.js';
import { runCalibration } from './lib/calibration.js';
import { summarize } from './lib/stats.js';
import { makeSyntheticTile } from './lib/synthetic.js';
import { JsonlWriter } from './lib/jsonl.js';

const TILE_SIZES = [640, 960, 1280];
const EXECUTION_PROVIDERS = ['wasm', 'webgpu'];
const WARMUP_RUNS = 3;
const STEADY_RUNS = 30;

async function ensureBenchOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API unavailable — Chrome 109+ required');
  }
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('bench/bench-offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'Benchmark harness driving the real comic-text-detector ONNX session',
    });
  }
}

function sendDetect(payload) {
  return chrome.runtime.sendMessage({ type: 'DETECT_RUN', payload });
}

async function drainLongTasks() {
  const res = await chrome.runtime.sendMessage({ type: 'BENCH_GET_LONGTASKS' });
  return res?.longTasks || [];
}

async function getHeapBytes() {
  const res = await chrome.runtime.sendMessage({ type: 'BENCH_GET_HEAP_BYTES' });
  return res?.usedJSHeapSize ?? null;
}

async function runOneConfig({ executionProvider, tileSize }) {
  // Distinct seed per config so configs aren't literally pixel-identical
  // (irrelevant to a fixed-size detector's cost, but keeps tiles visibly
  // distinguishable if anyone inspects them while debugging).
  const seed = tileSize * 7 + (executionProvider === 'wasm' ? 1 : 2);
  const tileDataUrl = await makeSyntheticTile(tileSize, seed);

  await drainLongTasks(); // clear any carry-over from the previous config

  let sessionInitMs = null, warmupMs = null, firstInferenceMs = null;
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const t0 = performance.now();
    const res = await sendDetect({ dataUrl: tileDataUrl, tileIndex: `warmup-${i}`, executionProvider });
    const elapsed = performance.now() - t0;
    if (res?.error) throw new Error(`${executionProvider}/${tileSize}px warmup: ${res.error}`);
    if (res.coldStartTiming) {
      sessionInitMs = res.coldStartTiming.sessionInitMs;
      warmupMs = res.coldStartTiming.warmupMs;
      firstInferenceMs = elapsed; // full first-call wall time, incl. shader compile for WebGPU
    }
  }

  const memBefore = await getHeapBytes();
  const perTileMs = [], preMs = [], runMs = [], postMs = [];
  for (let i = 0; i < STEADY_RUNS; i++) {
    const t0 = performance.now();
    const res = await sendDetect({ dataUrl: tileDataUrl, tileIndex: `steady-${i}`, executionProvider });
    const elapsed = performance.now() - t0;
    if (res?.error) throw new Error(`${executionProvider}/${tileSize}px steady-state: ${res.error}`);
    perTileMs.push(elapsed);
    if (res.timing) {
      preMs.push(res.timing.preMs);
      runMs.push(res.timing.runMs);
      postMs.push(res.timing.postMs);
    }
  }
  const memAfter = await getHeapBytes();
  const longTasks = await drainLongTasks();

  return {
    sessionInitMs,
    warmupMs,
    firstInferenceMs,
    perTileLatencyMs: summarize(perTileMs),
    preprocessLatencyMs: summarize(preMs),
    inferenceRunLatencyMs: summarize(runMs),
    postprocessLatencyMs: summarize(postMs),
    longTaskCount: longTasks.length,
    longTaskTotalMs: longTasks.reduce((s, t) => s + t.duration, 0),
    heapUsedBeforeBytes: memBefore,
    heapUsedAfterBytes: memAfter,
    heapDeltaBytes: (memBefore != null && memAfter != null) ? memAfter - memBefore : null,
  };
}

export async function runSuiteA({ onProgress = () => {} } = {}) {
  const writer = new JsonlWriter();

  onProgress('Capturing environment…');
  const [pageEnv, modelInfo] = await Promise.all([captureEnvironment(), getComicDetectorModelInfo()]);
  if (!modelInfo.available) {
    throw new Error(`Cannot run Suite A: ${modelInfo.reason}`);
  }

  onProgress('Running thermal calibration…');
  const calibration = runCalibration();
  if (calibration.dirty) {
    onProgress(`Calibration drifted ${calibration.driftPct.toFixed(1)}% from this machine's baseline — session marked dirty.`);
  }

  await ensureBenchOffscreenDocument();
  const offscreenEnvRes = await chrome.runtime.sendMessage({ type: 'BENCH_GET_OFFSCREEN_ENV' });

  const env = {
    ...pageEnv,
    modelSha256: modelInfo.sha256,
    modelByteLength: modelInfo.byteLength,
    offscreenCrossOriginIsolated: offscreenEnvRes?.crossOriginIsolated ?? null,
  };

  onProgress('Probing blob: worker CSP (multi-threaded WASM capability)…');
  const blobProbe = await chrome.runtime.sendMessage({ type: 'BENCH_PROBE_BLOB_WORKER_CSP' });
  writer.add({
    suite: 'A-capability-probe',
    config: { probe: 'blob-worker-csp' },
    env,
    metrics: {
      blobWorkerAllowed: blobProbe.blobWorkerAllowed,
      reason: blobProbe.reason ?? null,
      note: blobProbe.blobWorkerAllowed
        ? "blob: workers succeeded in this extension-page context — multi-threaded WASM MAY be viable here; ort-runner.js still hardcodes numThreads=1 in production, this is a probe only, not a benchmarked config"
        : "blob: workers blocked — matches ort-runner.js's documented finding (MV3 extension-page CSP), independent of crossOriginIsolated. Multi-threaded WASM is not viable in this context; wasm numbers below are the realistic single-thread ceiling",
    },
    corpus: 'synthetic',
    corpus_hash: null,
    calibration,
  });

  for (const executionProvider of EXECUTION_PROVIDERS) {
    for (const tileSize of TILE_SIZES) {
      onProgress(`Running ${executionProvider} × ${tileSize}px (${WARMUP_RUNS} warmup + ${STEADY_RUNS} steady-state)…`);
      let metrics;
      try {
        metrics = await runOneConfig({ executionProvider, tileSize });
      } catch (err) {
        onProgress(`  ${executionProvider}/${tileSize}px FAILED: ${err.message}`);
        writer.add({
          suite: 'A',
          config: { executionProvider, tileSize, overlap: 0, inputScaling: 'native' },
          env,
          metrics: { error: err.message },
          corpus: 'synthetic',
          corpus_hash: null,
          calibration,
        });
        continue;
      }
      writer.add({
        suite: 'A',
        config: { executionProvider, tileSize, overlap: 0, inputScaling: 'native' },
        env,
        metrics,
        corpus: 'synthetic',
        corpus_hash: null,
        calibration,
      });
    }
  }

  onProgress('Suite A complete.');
  return writer;
}
