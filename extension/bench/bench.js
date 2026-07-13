import { runSuiteA } from './suite-a.js';
import { runSuiteB } from './suite-b.js';

const runBtn      = document.getElementById('runBtn');
const downloadBtn = document.getElementById('downloadBtn');
const logEl       = document.getElementById('log');
const calibBadge  = document.getElementById('calibBadge');

let lastWriter = null;

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function showCalibBadge(el, writer) {
  const calibRecord = writer.records[0]?.calibration;
  if (!calibRecord) return;
  el.textContent = calibRecord.dirty ? 'calibration: DIRTY' : 'calibration: ok';
  el.className = 'badge ' + (calibRecord.dirty ? 'dirty' : 'ok');
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadBtn.disabled = true;
  calibBadge.textContent = '';
  logEl.textContent = '';

  try {
    lastWriter = await runSuiteA({ onProgress: log });
    downloadBtn.disabled = false;
    showCalibBadge(calibBadge, lastWriter);
  } catch (err) {
    log(`FAILED: ${err.message}`);
    console.error(err);
  } finally {
    runBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastWriter) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  lastWriter.download(`suite-a_${stamp}.jsonl`);
});

// ── Suite B ──────────────────────────────────────────────────────────────────

const runBBtn      = document.getElementById('runBBtn');
const downloadBBtn = document.getElementById('downloadBBtn');
const logBEl       = document.getElementById('logB');
const calibBadgeB  = document.getElementById('calibBadgeB');
const paddleUrlEl  = document.getElementById('paddleUrl');

let lastWriterB = null;

function logB(msg) {
  logBEl.textContent += msg + '\n';
  logBEl.scrollTop = logBEl.scrollHeight;
}

runBBtn.addEventListener('click', async () => {
  runBBtn.disabled = true;
  downloadBBtn.disabled = true;
  calibBadgeB.textContent = '';
  logBEl.textContent = '';

  const providerIds = Array.from(document.querySelectorAll('.providerCheck:checked')).map(el => el.value);
  const paddleServerUrl = paddleUrlEl.value.trim().replace(/\/+$/, '');

  try {
    lastWriterB = await runSuiteB({ onProgress: logB, providerIds, paddleServerUrl });
    downloadBBtn.disabled = false;
    showCalibBadge(calibBadgeB, lastWriterB);
  } catch (err) {
    logB(`FAILED: ${err.message}`);
    console.error(err);
  } finally {
    runBBtn.disabled = false;
  }
});

downloadBBtn.addEventListener('click', () => {
  if (!lastWriterB) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  lastWriterB.download(`suite-b_${stamp}.jsonl`);
});
