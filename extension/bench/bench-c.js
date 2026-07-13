import { runSuiteC } from './suite-c.js';

const runBtn      = document.getElementById('runCBtn');
const downloadBtn = document.getElementById('downloadCBtn');
const logEl       = document.getElementById('logC');

let lastWriter = null;

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadBtn.disabled = true;
  logEl.textContent = '';

  try {
    lastWriter = await runSuiteC({ onProgress: log });
    downloadBtn.disabled = false;
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
  lastWriter.download(`suite-c_${stamp}.jsonl`);
});
