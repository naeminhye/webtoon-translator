/**
 * bench/suite-c.js — Suite C: full pipeline E2E, replay mode.
 *
 * Drives the REAL content/bundle.js pipeline (bootForPage → bubbleDetector
 * → jobManager's runOcr/runTranslate/onDone → OverlayRenderer) via
 * window.__WT_BENCH__, using a BenchAdapter registered in bundle.js only
 * when __BENCH_MODE__ is true (see bundle.js's ADAPTERS array). Translation
 * goes through replay-llm-adapter.js's fixture adapter — see that file for
 * why replay mode needs no bundle.js changes at all.
 *
 * Scope of this pass: replay mode only (live mode — real API calls — is a
 * documented follow-up, per the plan's own "replay first, live second"
 * ordering). Scenarios covered: cold viewport, warm scroll, soak. The
 * concurrency sweep (concurrent-jobs = 1/2/4) is NOT implemented —
 * content/bundle.js's MAX_CONCURRENT_JOBS is a hardcoded const, not read
 * from storage; making it configurable is a further bundle.js change this
 * pass didn't get approval for, so the sweep is skipped rather than faked.
 *
 * "Detect" stage latency is intentionally NOT part of this suite's stage
 * attribution — Suite A already measures raw detection latency in
 * isolation (per-tile, controlled tile size/EP). Here, `wt:detect-done:*`
 * marks the moment a region's job is CREATED (i.e. dispatched to OCR),
 * which conflates real detection time with job-queue wait time — mixing
 * that into "detect %" here would double-count and confuse Suite A's
 * cleaner number, so stage attribution below is OCR / translate / render
 * only.
 */

import { loadCorpus } from './lib/corpus.js';
import { captureEnvironment } from './lib/env.js';
import { runCalibration } from './lib/calibration.js';
import { summarize } from './lib/stats.js';
import { JsonlWriter } from './lib/jsonl.js';

const MARK_RE = /^wt:(detect-done|ocr-done|translate-start|translate-done|render-done):(.+)$/;
const SCROLL_STEP_WAIT_MS = 250; // > bubbleDetector's 150ms scroll debounce

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setReplayConfig({ delayMs, fixtureText }) {
  window.__WT_BENCH_REPLAY__ = { delayMs, fixtureText };
}

async function configureStorageForRun({ ocrProvider }) {
  await chrome.storage.local.set({
    'wt:enabled': true,
    'wt:auto-detect': true,
    'wt:ocr-provider': ocrProvider,
    'wt:translate-provider': 'byok',
    'wt:byok-mode': 'always',
    // Dummy but non-empty — autoTranslate() only checks these are truthy
    // before calling getLlmAdapter(), which replay-llm-adapter.js has
    // already overridden to ignore providerId entirely.
    'wt:byok-provider': 'openai',
    'wt:byok-key': 'bench-fake-key',
    'wt:byok-model': 'bench-model',
  });
}

async function closeOffscreenIfOpen() {
  if (chrome.offscreen?.hasDocument && (await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.closeDocument();
  }
}

function clearWtMarks() {
  performance.getEntriesByType('mark')
    .filter((m) => m.name.startsWith('wt:'))
    .forEach((m) => performance.clearMarks(m.name));
}

async function injectPages(pages) {
  const stage = document.getElementById('benchStage');
  stage.innerHTML = '';
  for (const page of pages) {
    const img = document.createElement('img');
    img.className = 'wt-bench-page';
    img.style.display = 'block';
    // Deliberately NO forced width. content/bundle.js's bubbleDetector tiles
    // off getBoundingClientRect() (displayed size), not naturalWidth/Height —
    // forcing a small display width here would shrink real page content
    // before the detector ever sees it, silently tanking recall (this was
    // a real bug: an earlier version forced width:400px "for deterministic
    // tiling math", which instead produced 0 detections against a real
    // corpus with real page resolutions). Natural size is what a real
    // webtoon viewer actually renders close to, so it's what belongs here.
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`Failed to load fixtures/${page.file}`));
      img.src = `fixtures/${page.file}`;
    });
    stage.appendChild(img);
  }
}

function waitForPipelineIdle({ timeoutMs, graceMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const check = () => {
      const badge = document.getElementById('wt-job-badge');
      const busy = badge?.classList.contains('wt-job-badge-visible');
      if (!busy) { resolve(); return; }
      if (performance.now() - start > timeoutMs) { reject(new Error('Pipeline did not go idle within timeout')); return; }
      setTimeout(check, 200);
    };
    setTimeout(check, graceMs); // let the badge appear first if there's any work to do at all
  });
}

function summarizeMarks() {
  const byJob = new Map();
  for (const entry of performance.getEntriesByType('mark')) {
    const m = MARK_RE.exec(entry.name);
    if (!m) continue;
    const [, stage, jobId] = m;
    if (!byJob.has(jobId)) byJob.set(jobId, {});
    byJob.get(jobId)[stage] = entry.startTime;
  }

  const viewportEnter = performance.getEntriesByName('wt:viewport-enter')[0]?.startTime ?? null;
  const jobs = [...byJob.values()].filter((j) => j['render-done'] != null);
  const renderDoneTimes = jobs.map((j) => j['render-done']).sort((a, b) => a - b);

  const ocrMs = [], translateMs = [], renderMs = [];
  for (const j of jobs) {
    if (j['detect-done'] != null && j['ocr-done'] != null) ocrMs.push(j['ocr-done'] - j['detect-done']);
    if (j['translate-start'] != null && j['translate-done'] != null) translateMs.push(j['translate-done'] - j['translate-start']);
    if (j['translate-done'] != null && j['render-done'] != null) renderMs.push(j['render-done'] - j['translate-done']);
  }
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  const totalStageMs = sum(ocrMs) + sum(translateMs) + sum(renderMs);

  return {
    regionCount: jobs.length,
    ttfrMs: (viewportEnter != null && renderDoneTimes.length) ? renderDoneTimes[0] - viewportEnter : null,
    totalCompletionMs: (viewportEnter != null && renderDoneTimes.length) ? renderDoneTimes[renderDoneTimes.length - 1] - viewportEnter : null,
    ocrLatencyMs: summarize(ocrMs),
    translateLatencyMs: summarize(translateMs),
    renderLatencyMs: summarize(renderMs),
    stageAttributionPct: totalStageMs > 0 ? {
      ocr: (sum(ocrMs) / totalStageMs) * 100,
      translate: (sum(translateMs) / totalStageMs) * 100,
      render: (sum(renderMs) / totalStageMs) * 100,
    } : null,
  };
}

async function runScenario({ onProgress, pages, cold, ocrProvider, replayDelayMs }) {
  if (cold) {
    onProgress('  closing offscreen document for a true cold start…');
    await closeOffscreenIfOpen();
  }

  setReplayConfig({ delayMs: replayDelayMs, fixtureText: '[replay] fixture translation' });
  await configureStorageForRun({ ocrProvider });

  window.__WT_BENCH__.teardown?.();
  clearWtMarks();
  await injectPages(pages);

  performance.mark('wt:viewport-enter');
  window.__WT_BENCH__.bootForPage();

  for (let i = 0; i < pages.length; i++) {
    window.scrollBy(0, window.innerHeight);
    await sleep(SCROLL_STEP_WAIT_MS);
  }
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(SCROLL_STEP_WAIT_MS);

  await waitForPipelineIdle({ timeoutMs: 30000 + pages.length * 15000 });

  const metrics = summarizeMarks();
  window.__WT_BENCH__.teardown?.();
  return metrics;
}

export async function runSuiteC({ onProgress = () => {}, ocrProvider = 'tesseract', replayDelayMs = 400 } = {}) {
  if (!window.__WT_BENCH__?.bootForPage) {
    throw new Error('window.__WT_BENCH__ not found — bench-flag.js must load before content/bundle.js in bench-c.html');
  }

  const writer = new JsonlWriter();
  const env = await captureEnvironment();

  onProgress('Running thermal calibration…');
  const calibration = runCalibration();
  if (calibration.dirty) {
    onProgress(`Calibration drifted ${calibration.driftPct.toFixed(1)}% from this machine's baseline — session marked dirty.`);
  }

  onProgress('Loading corpus…');
  const manifest = await loadCorpus('fixtures/corpus.json');
  if (!manifest.pages.length) throw new Error('Corpus has no pages');

  const scenarios = [
    { name: 'cold-viewport', viewportCount: 1, cold: true },
    { name: 'warm-scroll-10', viewportCount: Math.min(10, manifest.pages.length), cold: false },
    { name: 'soak-50', viewportCount: Math.min(50, manifest.pages.length), cold: false },
  ];

  for (const scenario of scenarios) {
    onProgress(`--- Scenario: ${scenario.name} (${scenario.viewportCount} page(s), cold=${scenario.cold}) ---`);
    const pages = manifest.pages.slice(0, scenario.viewportCount);
    try {
      const metrics = await runScenario({ onProgress, pages, cold: scenario.cold, ocrProvider, replayDelayMs });
      onProgress(`  ${metrics.regionCount} region(s) completed, TTFT-R=${metrics.ttfrMs?.toFixed(0) ?? 'n/a'}ms, total=${metrics.totalCompletionMs?.toFixed(0) ?? 'n/a'}ms`);
      writer.add({
        suite: 'C',
        config: { scenario: scenario.name, viewportCount: scenario.viewportCount, cold: scenario.cold, mode: 'replay', ocrProvider, replayDelayMs },
        env,
        metrics,
        corpus: 'real',
        corpus_hash: null, // Suite C doesn't score quality against GT, so no GT files are hashed here — see file header
        calibration,
      });
    } catch (err) {
      onProgress(`  FAILED: ${err.message}`);
      writer.add({
        suite: 'C',
        config: { scenario: scenario.name, mode: 'replay', ocrProvider, replayDelayMs },
        env,
        metrics: { error: err.message },
        corpus: 'real',
        corpus_hash: null,
        calibration,
      });
    }
  }

  onProgress('Suite C complete. (Concurrency sweep skipped — see file header comment.)');
  return writer;
}
