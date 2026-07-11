const $ = id => document.getElementById(id);
const OCR_PROVIDER_KEY       = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR      = 'wt:ocrspace-key';
const PADDLE_URL_KEY         = 'wt:paddleocr-url';
const TRANSLATE_PROVIDER_KEY = 'wt:translate-provider';
const TRANSLATE_LANG_KEY     = 'wt:translate-lang';
const DEEPL_KEY_STR          = 'wt:deepl-key';
const BYOK_KEY_STR           = 'wt:byok-key';
const BYOK_PROVIDER_KEY      = 'wt:byok-provider';
const BYOK_MODEL_STR         = 'wt:byok-model';
const BYOK_MODE_KEY          = 'wt:byok-mode';
const OVERLAY_MODE_KEY       = 'wt:overlay-mode';
const AUTO_DETECT_KEY        = 'wt:auto-detect';

// Mirrors background/worker.js — keep in sync.
const DEV_OCR_SPACE_KEY = '';

// Mirrors background/worker.js — keep in sync. Shown as the input placeholder;
// an empty stored URL means "use this default" (never persisted, so a future
// default change still takes effect for users who kept the default).
const DEFAULT_PADDLE_URL = 'http://127.0.0.1:8868';

async function initOcrSettings() {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [OCR_SPACE_KEY_STR]: '',
    [PADDLE_URL_KEY]:    '',
  });

  const radios = document.querySelectorAll('input[name="ocr-provider"]');
  const devKeyBundled = Boolean(DEV_OCR_SPACE_KEY);

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    const needsKey = provider === 'ocrspace' && !devKeyBundled;
    $('ocrspace-key-row').classList.toggle('hidden', !needsKey);
    $('ocrspace-key-saved').classList.add('hidden');
    $('paddleocr-url-row').classList.toggle('hidden', provider !== 'paddleocr');
    $('paddleocr-url-saved').classList.add('hidden');
  }

  applyProvider(stored[OCR_PROVIDER_KEY]);
  if (stored[OCR_SPACE_KEY_STR]) $('ocrspace-key').value = stored[OCR_SPACE_KEY_STR];
  if (stored[PADDLE_URL_KEY]) $('paddleocr-url').value = stored[PADDLE_URL_KEY];

  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OCR_PROVIDER_KEY]: r.value });
    applyProvider(r.value);
  }));

  // Autosave the OCR.space key as it's typed (debounced) — no Save button.
  let ocrKeyTimer = null;
  $('ocrspace-key').addEventListener('input', () => {
    clearTimeout(ocrKeyTimer);
    ocrKeyTimer = setTimeout(async () => {
      await chrome.storage.local.set({ [OCR_SPACE_KEY_STR]: $('ocrspace-key').value.trim() });
      $('ocrspace-key-saved').classList.remove('hidden');
      setTimeout(() => $('ocrspace-key-saved').classList.add('hidden'), 1500);
    }, 400);
  });

  // Autosave the PaddleOCR server URL the same way. An empty value is stored
  // as '' so the background falls back to DEFAULT_PADDLE_URL.
  let paddleUrlTimer = null;
  $('paddleocr-url').addEventListener('input', () => {
    clearTimeout(paddleUrlTimer);
    paddleUrlTimer = setTimeout(async () => {
      await chrome.storage.local.set({ [PADDLE_URL_KEY]: $('paddleocr-url').value.trim() });
      $('paddleocr-url-saved').classList.remove('hidden');
      setTimeout(() => $('paddleocr-url-saved').classList.add('hidden'), 1500);
    }, 400);
  });

  // Setup-guide download chips: files bundled inside the extension package
  // (extension/assets/paddleocr-server/, a mirror of server/paddleocr/ in the
  // repo) so users who only installed the packed extension — no git/GitHub
  // access — can still get server.py etc. onto their machine. chrome.runtime
  // .getURL() resolves the per-install chrome-extension:// origin; no
  // web_accessible_resources entry is needed since this popup page already
  // shares that origin.
  // chrome.runtime.getURL() is always rooted at the extension package root
  // (extension/), not relative to this script's own location.
  const PADDLE_SERVER_ASSETS = 'assets/paddleocr-server/';
  [
    ['dl-paddle-server-py',    'server.py'],
    ['dl-paddle-requirements', 'requirements.txt'],
    ['dl-paddle-dockerfile',   'Dockerfile'],
    ['dl-paddle-readme',       'README.md'],
  ].forEach(([id, filename]) => {
    $(id).href = chrome.runtime.getURL(PADDLE_SERVER_ASSETS + filename);
  });
}

async function initTranslationSettings() {
  const stored = await chrome.storage.local.get({
    [TRANSLATE_PROVIDER_KEY]: 'google',
    [TRANSLATE_LANG_KEY]:     'vi',
    [DEEPL_KEY_STR]:          '',
    [BYOK_KEY_STR]:           '',
    [BYOK_PROVIDER_KEY]:      '',
    [BYOK_MODEL_STR]:         '',
    [BYOK_MODE_KEY]:          'always',
  });

  const radios = document.querySelectorAll('input[name="translate-provider"]');

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    $('deepl-key-row').classList.toggle('hidden', provider !== 'deepl');
    $('byok-key-row').classList.toggle('hidden', provider !== 'byok');
  }

  // "none" (Disabled) was removed as an option — fall back a stored legacy
  // value to the default provider so the UI doesn't render with nothing
  // selected, and persist the fallback so it sticks.
  let initialProvider = stored[TRANSLATE_PROVIDER_KEY];
  if (initialProvider === 'none') {
    initialProvider = 'google';
    chrome.storage.local.set({ [TRANSLATE_PROVIDER_KEY]: initialProvider });
  }
  applyProvider(initialProvider);
  $('target-lang').value = stored[TRANSLATE_LANG_KEY];
  if (stored[DEEPL_KEY_STR]) $('deepl-key').value = stored[DEEPL_KEY_STR];
  if (stored[BYOK_KEY_STR]) $('byok-key').value = stored[BYOK_KEY_STR];

  // Provider dropdown is populated from the shared adapter registry
  // (extension/shared/llm-adapters.js) — never a separately hardcoded list —
  // so a new adapter registered there appears here automatically.
  const providerSelect = $('byok-provider');
  providerSelect.innerHTML = WT_LLM_ADAPTERS
    .map(a => `<option value="${a.id}">${a.label}</option>`)
    .join('');

  let byokProvider = stored[BYOK_PROVIDER_KEY];
  let byokModel    = stored[BYOK_MODEL_STR];
  // Migrate a pre-existing combined "provider/model" string (the old single
  // free-text field) into the two new separate fields, once, on first load.
  if (!byokProvider && byokModel.includes('/')) {
    const slash = byokModel.indexOf('/');
    byokProvider = byokModel.slice(0, slash);
    byokModel    = byokModel.slice(slash + 1);
    await chrome.storage.local.set({ [BYOK_PROVIDER_KEY]: byokProvider, [BYOK_MODEL_STR]: byokModel });
  }
  if (!byokProvider) byokProvider = WT_LLM_ADAPTERS[0]?.id || '';

  function applyByokProviderPlaceholder(providerId) {
    const adapter = getLlmAdapter(providerId);
    $('byok-model').placeholder = adapter?.modelPlaceholder || '';
  }

  providerSelect.value = byokProvider;
  applyByokProviderPlaceholder(byokProvider);
  if (byokModel) $('byok-model').value = byokModel;

  // BYOK mode radio
  const byokModeRadios = document.querySelectorAll('input[name="byok-mode"]');
  byokModeRadios.forEach(r => { r.checked = r.value === stored[BYOK_MODE_KEY]; });
  byokModeRadios.forEach(r => r.addEventListener('change', async () => {
    if (r.checked) await chrome.storage.local.set({ [BYOK_MODE_KEY]: r.value });
  }));

  providerSelect.addEventListener('change', async (e) => {
    applyByokProviderPlaceholder(e.target.value);
    await chrome.storage.local.set({ [BYOK_PROVIDER_KEY]: e.target.value });
  });

  // ── Autosave: every control persists on change; no Save button ──
  // Provider radios: warn (not block) when a paid provider is picked without
  // a key — the key field autosaves as you type, so the warning clears itself.
  function updateKeyWarnings() {
    const provider = [...radios].find(r => r.checked)?.value || 'google';
    $('deepl-key-error').classList.toggle('hidden', !(provider === 'deepl' && !$('deepl-key').value.trim()));
    $('byok-key-error').classList.toggle('hidden', !(provider === 'byok' && !$('byok-key').value.trim()));
  }

  radios.forEach(r => r.addEventListener('change', async () => {
    applyProvider(r.value);
    updateKeyWarnings();
    await chrome.storage.local.set({ [TRANSLATE_PROVIDER_KEY]: r.value });
  }));

  $('target-lang').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [TRANSLATE_LANG_KEY]: e.target.value });
  });

  // Debounced autosave for text inputs so we don't hammer storage per keystroke.
  function autosaveInput(el, key) {
    let t = null;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await chrome.storage.local.set({ [key]: el.value.trim() });
        updateKeyWarnings();
      }, 400);
    });
  }
  autosaveInput($('deepl-key'),   DEEPL_KEY_STR);
  autosaveInput($('byok-key'),    BYOK_KEY_STR);
  autosaveInput($('byok-model'),  BYOK_MODEL_STR);
}

async function initDisplaySettings() {
  const stored = await chrome.storage.local.get({ [OVERLAY_MODE_KEY]: 'overlay', [AUTO_DETECT_KEY]: true });
  const radios = document.querySelectorAll('input[name="overlay-mode"]');
  radios.forEach(r => { r.checked = r.value === stored[OVERLAY_MODE_KEY]; });
  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OVERLAY_MODE_KEY]: r.value });
  }));

  const autoDetect = $('auto-detect-toggle');
  autoDetect.checked = !!stored[AUTO_DETECT_KEY];
  autoDetect.addEventListener('change', async () => {
    await chrome.storage.local.set({ [AUTO_DETECT_KEY]: autoDetect.checked });
  });
}

const PRESET_FONTS = ['', 'Pangolin', 'Patrick Hand SC'];

async function initAppearanceSettings() {
  const stored = await chrome.storage.local.get({ 'wt:bubble-bg-opacity': 0.88, 'wt:bubble-font': '' });

  const slider  = document.getElementById('bubble-bg-opacity');
  const valSpan = document.getElementById('bubble-bg-opacity-val');
  const pct     = Math.round(stored['wt:bubble-bg-opacity'] * 100);
  slider.value        = pct;
  valSpan.textContent = `${pct}%`;
  slider.addEventListener('input', async () => {
    valSpan.textContent = `${slider.value}%`;
    await chrome.storage.local.set({ 'wt:bubble-bg-opacity': Number(slider.value) / 100 });
  });

  // Font picker
  const savedFont     = stored['wt:bubble-font'] || '';
  const customRow     = document.getElementById('font-custom-row');
  const customInput   = document.getElementById('font-custom-input');
  const customPreview = document.getElementById('font-custom-preview');
  const customApply   = document.getElementById('font-custom-apply');
  const customRadio   = document.getElementById('font-radio-custom');
  const radios        = document.querySelectorAll('input[name="bubble-font"]');

  function loadGf(font) {
    if (!font) return;
    const id = 'gf-' + font.replace(/\s+/g, '-');
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id   = id;
      link.rel  = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}&display=swap`;
      document.head.appendChild(link);
    }
  }

  function setPickerValue(font) {
    const isCustom = font && !PRESET_FONTS.includes(font);
    radios.forEach(r => { r.checked = isCustom ? r.value === '__custom__' : r.value === font; });
    customRow.classList.toggle('hidden', !isCustom);
    if (isCustom) {
      customInput.value = font;
      customPreview.textContent = font;
      customPreview.style.fontFamily = `'${font}', system-ui, sans-serif`;
      customPreview.style.color = '';
      loadGf(font);
    }
  }

  loadGf('Pangolin');
  loadGf('Patrick Hand SC');
  setPickerValue(savedFont);

  radios.forEach(r => r.addEventListener('change', async () => {
    if (r.value === '__custom__') {
      customRow.classList.remove('hidden');
      customInput.focus();
      return;
    }
    customRow.classList.add('hidden');
    await chrome.storage.local.set({ 'wt:bubble-font': r.value });
  }));

  async function applyCustomFont() {
    const font = customInput.value.trim();
    customPreview.textContent = font || 'Enter a Google Font name';
    customPreview.style.color = font ? '' : '#94a3b8';
    if (font) {
      customPreview.style.fontFamily = `'${font}', system-ui, sans-serif`;
      loadGf(font);
      customRadio.checked = true;
      await chrome.storage.local.set({ 'wt:bubble-font': font });
    }
  }

  customApply.addEventListener('click', applyCustomFont);
  customInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustomFont(); });

  document.getElementById('font-gfonts-link').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://fonts.google.com' });
  });
}

initTranslationSettings();
initOcrSettings();
initDisplaySettings();
initAppearanceSettings();
