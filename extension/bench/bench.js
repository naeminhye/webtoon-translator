import { runSuiteA } from './suite-a.js';

const runBtn      = document.getElementById('runBtn');
const downloadBtn = document.getElementById('downloadBtn');
const logEl       = document.getElementById('log');
const calibBadge  = document.getElementById('calibBadge');

let lastWriter = null;

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadBtn.disabled = true;
  calibBadge.textContent = '';
  logEl.textContent = '';

  try {
    lastWriter = await runSuiteA({ onProgress: log });
    downloadBtn.disabled = false;

    const calibRecord = lastWriter.records[0]?.calibration;
    if (calibRecord) {
      calibBadge.textContent = calibRecord.dirty ? 'calibration: DIRTY' : 'calibration: ok';
      calibBadge.className = 'badge ' + (calibRecord.dirty ? 'dirty' : 'ok');
    }
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
