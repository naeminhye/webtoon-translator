/**
 * bench/suite-b.js — Suite B: OCR provider comparison on GT crops.
 *
 * Providers: tesseract (offline, offscreen/ocr.js), paddleocr-local
 * (in-browser ONNX, offscreen/paddle-runner.js), paddleocr (self-hosted
 * HTTP server, server/paddleocr/ — not OCR.space, which was removed from
 * the product; see popup/settings.js's legacy-value fallback). Drives the
 * first two through the REAL offscreen document unmodified (same message
 * types production's background/worker.js uses); the third is a thin HTTP
 * client mirroring worker.js's paddleOcrRun exactly (see
 * lib/paddleocr-server-client.js).
 *
 * Input is GT-cropped regions (detection GT boxes, not detected boxes) —
 * isolates OCR quality from detection quality per the plan. Crops are used
 * directly, with NO auto-detect crop-refinement heuristics applied
 * (bundle.js/worker.js's OCR_CROP_INSET_PCT + refineOcrCropToTextCluster
 * exist specifically to compensate for imprecise AUTO-DETECTED regions;
 * hand-labeled GT boxes are already tight by construction, and skipping
 * that pipeline keeps this suite honest about what it isolates). All three
 * providers receive byte-identical crops — each still applies its own real
 * production preprocessing internally (Tesseract's upscale+contrast-stretch
 * in ocr.js, PaddleOCR's det+rec resize in paddle-runner.js).
 */

import { loadCorpus, tryLoadJson } from './lib/corpus.js';
import { computeCorpusHash } from './lib/hash.js';
import { captureEnvironment } from './lib/env.js';
import { runCalibration } from './lib/calibration.js';
import { summarize } from './lib/stats.js';
import { characterErrorRate } from './lib/cer.js';
import { runWithConcurrency } from './lib/pool.js';
import { runPaddleOcrServer } from './lib/paddleocr-server-client.js';
import { JsonlWriter } from './lib/jsonl.js';
import { ensureBenchOffscreenDocument, sendTesseractOcr, sendPaddleLocalOcr } from './lib/offscreen-client.js';

const TIERS = ['easy', 'medium', 'hard', 'edge'];
const CONCURRENCY = 3; // mirrors content/bundle.js's MAX_CONCURRENT_JOBS — the product's real concurrent-jobs setting, not an invented number
const DEFAULT_PADDLE_URL = 'http://127.0.0.1:8868'; // mirrors background/worker.js's DEFAULT_PADDLE_URL

const PROVIDERS = {
  tesseract: {
    offlineCapable: true,
    async run(dataUrl) {
      const res = await sendTesseractOcr({ dataUrl, isSingleLine: false });
      if (!res?.ok) throw new Error(res?.error || 'tesseract OCR failed');
      return res.text;
    },
  },
  'paddleocr-local': {
    offlineCapable: true,
    async run(dataUrl) {
      const res = await sendPaddleLocalOcr({ dataUrl });
      if (!res?.ok) throw new Error(res?.error || 'paddleocr-local OCR failed');
      return res.text;
    },
  },
  paddleocr: {
    offlineCapable: false, // requires a running local server process — not "offline" in the tesseract/paddleocr-local sense
    async run(dataUrl, { endpoint }) {
      const res = await runPaddleOcrServer(dataUrl, endpoint);
      if (!res.ok) throw new Error(res.error);
      return res.text;
    },
  },
};

async function loadLabeledRegions(manifest, onProgress) {
  const regions = [];
  const gtFilesForHash = [];
  let unlabeledPages = 0;

  for (const page of manifest.pages) {
    const [detGt, ocrGt] = await Promise.all([
      tryLoadJson(`fixtures/gt/detection/${page.id}.detection.json`),
      tryLoadJson(`fixtures/gt/ocr/${page.id}.ocr.json`),
    ]);
    if (!detGt || !ocrGt) { unlabeledPages++; continue; }
    gtFilesForHash.push(detGt, ocrGt);

    const textByBoxId = new Map(ocrGt.regions.map(r => [r.boxId, r.text]));
    for (const box of detGt.boxes) {
      const gtText = textByBoxId.get(box.id);
      if (!gtText) continue; // box drawn but never transcribed
      regions.push({ pageId: page.id, tier: page.tier, file: page.file, box, gtText });
    }
  }

  if (unlabeledPages) onProgress(`${unlabeledPages} corpus page(s) have no GT files yet — skipped.`);
  return { regions, gtFilesForHash };
}

async function cropRegion(imageCache, region) {
  let bitmap = imageCache.get(region.file);
  if (!bitmap) {
    const res = await fetch(`fixtures/${region.file}`);
    if (!res.ok) throw new Error(`Failed to load fixtures/${region.file}: HTTP ${res.status}`);
    const blob = await res.blob();
    bitmap = await createImageBitmap(blob);
    imageCache.set(region.file, bitmap);
  }
  const { x, y, w, h } = region.box;
  const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, Math.max(1, w), Math.max(1, h));
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('crop encode failed'));
    reader.readAsDataURL(blob);
  });
}

function cerByTier(perRegion) {
  const out = {};
  for (const tier of TIERS) {
    const inTier = perRegion.filter(r => r.region.tier === tier);
    if (!inTier.length) continue;
    const cers = inTier.map(r => characterErrorRate(r.text, r.region.gtText)).filter(v => v !== null);
    out[tier] = {
      n: inTier.length,
      meanCer: cers.length ? cers.reduce((s, v) => s + v, 0) / cers.length : null,
    };
  }
  return out;
}

function latencyByTier(perRegion) {
  const out = {};
  for (const tier of TIERS) {
    const inTier = perRegion.filter(r => r.region.tier === tier);
    if (!inTier.length) continue;
    out[tier] = summarize(inTier.map(r => r.latencyMs));
  }
  return out;
}

export async function runSuiteB({ onProgress = () => {}, paddleServerUrl = DEFAULT_PADDLE_URL, providerIds = Object.keys(PROVIDERS) } = {}) {
  const writer = new JsonlWriter();

  onProgress('Loading corpus…');
  const manifest = await loadCorpus('fixtures/corpus.json');
  const { regions, gtFilesForHash } = await loadLabeledRegions(manifest, onProgress);
  if (!regions.length) {
    throw new Error('No labeled regions found — label pages in bench/label.html first (needs matching gt/detection/<id>.detection.json + gt/ocr/<id>.ocr.json files)');
  }
  onProgress(`${regions.length} labeled region(s) across ${manifest.pages.length} corpus page(s).`);

  const tierCounts = TIERS.map(t => `${t}=${regions.filter(r => r.tier === t).length}`).join(' ');
  onProgress(`Region counts by tier: ${tierCounts}`);

  const corpusHash = await computeCorpusHash({ manifest, gtFiles: gtFilesForHash });
  const env = await captureEnvironment();

  onProgress('Running thermal calibration…');
  const calibration = runCalibration();
  if (calibration.dirty) {
    onProgress(`Calibration drifted ${calibration.driftPct.toFixed(1)}% from this machine's baseline — session marked dirty.`);
  }

  await ensureBenchOffscreenDocument();
  const imageCache = new Map();

  onProgress('Cropping all labeled regions once (shared across every provider)…');
  const crops = [];
  for (const region of regions) {
    crops.push({ region, dataUrl: await cropRegion(imageCache, region) });
  }

  for (const providerId of providerIds) {
    const provider = PROVIDERS[providerId];
    if (!provider) { onProgress(`Unknown provider "${providerId}" — skipping.`); continue; }

    onProgress(`Running provider: ${providerId}…`);
    const runOne = (dataUrl) => provider.run(dataUrl, { endpoint: paddleServerUrl });

    // First call = init cost (worker/model spin-up, or server/connection
    // warm-up for the HTTP provider) — kept separate from steady state.
    let initMs = null;
    const perRegion = [];
    try {
      const t0 = performance.now();
      const text = await runOne(crops[0].dataUrl);
      initMs = performance.now() - t0;
      perRegion.push({ region: crops[0].region, text, latencyMs: initMs });
    } catch (err) {
      onProgress(`  ${providerId} FAILED on first call: ${err.message}`);
      writer.add({
        suite: 'B',
        config: { provider: providerId, ...(providerId === 'paddleocr' ? { endpoint: paddleServerUrl } : {}) },
        env,
        metrics: { error: err.message },
        corpus: 'real',
        corpus_hash: corpusHash,
        calibration,
      });
      continue;
    }

    for (let i = 1; i < crops.length; i++) {
      const t1 = performance.now();
      try {
        const text = await runOne(crops[i].dataUrl);
        perRegion.push({ region: crops[i].region, text, latencyMs: performance.now() - t1 });
      } catch (err) {
        perRegion.push({ region: crops[i].region, text: null, latencyMs: performance.now() - t1, error: err.message });
      }
    }

    onProgress(`  measuring throughput at concurrency=${CONCURRENCY}…`);
    const throughputT0 = performance.now();
    await runWithConcurrency(crops, CONCURRENCY, (c) => runOne(c.dataUrl).catch(() => null));
    const throughputElapsedS = (performance.now() - throughputT0) / 1000;

    const allCers = perRegion.map(r => characterErrorRate(r.text, r.region.gtText)).filter(v => v !== null);

    writer.add({
      suite: 'B',
      config: {
        provider: providerId,
        concurrency: CONCURRENCY,
        ...(providerId === 'paddleocr' ? { endpoint: paddleServerUrl } : {}),
      },
      env,
      metrics: {
        initMs,
        regionCount: perRegion.length,
        errorCount: perRegion.filter(r => r.error).length,
        cerAggregate: allCers.length ? allCers.reduce((s, v) => s + v, 0) / allCers.length : null,
        cerByTier: cerByTier(perRegion),
        latencyMsAggregate: summarize(perRegion.map(r => r.latencyMs)),
        latencyMsByTier: latencyByTier(perRegion),
        throughputRegionsPerSec: crops.length / throughputElapsedS,
        offlineCapable: provider.offlineCapable,
      },
      corpus: 'real',
      corpus_hash: corpusHash,
      calibration,
    });
  }

  onProgress('Suite B complete.');
  return writer;
}
