const $ = id => document.getElementById(id);
const ENABLED_KEY       = 'wt:enabled';
const OCR_PROVIDER_KEY  = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR = 'wt:ocrspace-key';

let activeTabId = null;

function applyEnabledUI(enabled) {
  $('enabled-toggle').checked = enabled;
  $('main-ui').classList.toggle('hidden', !enabled);
  $('disabled-notice').classList.toggle('hidden', enabled);
}

function refreshMeta() {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'GET_META' }, (meta) => {
    if (chrome.runtime.lastError || !meta) return;

    $('no-chapter').classList.add('hidden');
    $('chapter-info').classList.remove('hidden');
    $('mode-toggle').classList.remove('hidden');

    const title = meta.title || meta.titleId;
    $('title-id').textContent = title;
    $('title-id').title       = title; // full title on hover
    $('chapter-id').textContent = meta.chapterId;

    const translated = meta.translatedPanels ?? 0;
    const total      = meta.imageCount ?? 0;
    const pct        = total > 0 ? Math.round((translated / total) * 100) : 0;
    $('progress-text').textContent = total > 0 ? `${translated}/${total} panels (${pct}%)` : '—';
    $('progress-bar-fill').style.width = `${pct}%`;

    const badge = $('site-badge');
    badge.textContent = meta.site;
    badge.className   = `badge badge-${meta.site}`;

    setActiveMode(meta.currentMode === 'annotate' ? 'annotate' : 'read');
  });
}

function setActiveMode(mode) {
  const annotate = mode === 'annotate';
  $('btn-read').classList.toggle('active', !annotate);
  $('btn-annotate').classList.toggle('active', annotate);
  $('action-buttons').classList.remove('hidden');
  $('btn-panel').classList.toggle('hidden', !annotate);
  $('btn-export').classList.toggle('hidden', !annotate);
  $('ocr-settings').classList.toggle('hidden', !annotate);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  const stored  = await chrome.storage.local.get({ [ENABLED_KEY]: true });
  const enabled = stored[ENABLED_KEY];
  applyEnabledUI(enabled);
  if (enabled) refreshMeta();

  $('enabled-toggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ [ENABLED_KEY]: on });
    applyEnabledUI(on);
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: 'SET_ENABLED', enabled: on }, () => {
        // Content script may not be injected on this tab — ignore
        void chrome.runtime.lastError;
        // Content script needs a moment to boot before it can answer GET_META
        if (on) setTimeout(refreshMeta, 400);
      });
    }
  });

  $('btn-read').addEventListener('click', () => {
    chrome.tabs.sendMessage(activeTabId, { type: 'SET_MODE', mode: 'read' });
    setActiveMode('read');
  });
  $('btn-annotate').addEventListener('click', () => {
    chrome.tabs.sendMessage(activeTabId, { type: 'SET_MODE', mode: 'annotate' });
    setActiveMode('annotate');
  });
  $('btn-panel').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_PANEL' }); window.close(); });
  $('btn-export').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_EXPORT' }); window.close(); });
  $('btn-import').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_IMPORT' }); window.close(); });
  $('btn-clear').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_CLEAR' }); window.close(); });
}

// Mirrors the constant in background/worker.js — keep in sync.
const DEV_OCR_SPACE_KEY = '';

async function initOcrSettings() {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [OCR_SPACE_KEY_STR]: '',
  });

  const radios = document.querySelectorAll('input[name="ocr-provider"]');

  // When a developer key is bundled, hide the key input row entirely so
  // end users never have to deal with API keys.
  const devKeyBundled = Boolean(DEV_OCR_SPACE_KEY);

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    const needsKey = provider === 'ocrspace' && !devKeyBundled;
    $('ocrspace-key-row').classList.toggle('hidden', !needsKey);
    $('ocrspace-key-saved').classList.add('hidden');
  }

  applyProvider(stored[OCR_PROVIDER_KEY]);
  if (stored[OCR_SPACE_KEY_STR]) $('ocrspace-key').value = stored[OCR_SPACE_KEY_STR];

  radios.forEach(r => r.addEventListener('change', async () => {
    const provider = r.value;
    await chrome.storage.local.set({ [OCR_PROVIDER_KEY]: provider });
    applyProvider(provider);
  }));

  $('save-ocrspace-key').addEventListener('click', async () => {
    const key = $('ocrspace-key').value.trim();
    await chrome.storage.local.set({ [OCR_SPACE_KEY_STR]: key });
    $('ocrspace-key-saved').classList.remove('hidden');
    setTimeout(() => $('ocrspace-key-saved').classList.add('hidden'), 2500);
  });
}

init();
initOcrSettings();
