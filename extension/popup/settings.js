const $ = id => document.getElementById(id);
const OCR_PROVIDER_KEY       = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR      = 'wt:ocrspace-key';
const TRANSLATE_PROVIDER_KEY = 'wt:translate-provider';
const TRANSLATE_LANG_KEY     = 'wt:translate-lang';
const DEEPL_KEY_STR          = 'wt:deepl-key';
const BYOK_KEY_STR           = 'wt:byok-key';
const BYOK_MODEL_STR         = 'wt:byok-model';
const OVERLAY_MODE_KEY       = 'wt:overlay-mode';

// Mirrors background/worker.js — keep in sync.
const DEV_OCR_SPACE_KEY = '';

async function initOcrSettings() {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [OCR_SPACE_KEY_STR]: '',
  });

  const radios = document.querySelectorAll('input[name="ocr-provider"]');
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
    await chrome.storage.local.set({ [OCR_PROVIDER_KEY]: r.value });
    applyProvider(r.value);
  }));

  $('save-ocrspace-key').addEventListener('click', async () => {
    const key = $('ocrspace-key').value.trim();
    await chrome.storage.local.set({ [OCR_SPACE_KEY_STR]: key });
    $('ocrspace-key-saved').classList.remove('hidden');
    setTimeout(() => $('ocrspace-key-saved').classList.add('hidden'), 2500);
  });
}

async function initTranslationSettings() {
  const stored = await chrome.storage.local.get({
    [TRANSLATE_PROVIDER_KEY]: 'google',
    [TRANSLATE_LANG_KEY]:     'vi',
    [DEEPL_KEY_STR]:          '',
    [BYOK_KEY_STR]:           '',
    [BYOK_MODEL_STR]:         '',
  });

  const radios = document.querySelectorAll('input[name="translate-provider"]');

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    $('deepl-key-row').classList.toggle('hidden', provider !== 'deepl');
    $('deepl-key-saved').classList.add('hidden');
    $('byok-key-row').classList.toggle('hidden', provider !== 'byok');
    $('byok-key-saved').classList.add('hidden');
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
  if (stored[BYOK_MODEL_STR]) $('byok-model').value = stored[BYOK_MODEL_STR];

  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [TRANSLATE_PROVIDER_KEY]: r.value });
    applyProvider(r.value);
  }));

  $('target-lang').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [TRANSLATE_LANG_KEY]: e.target.value });
  });

  $('save-deepl-key').addEventListener('click', async () => {
    const key = $('deepl-key').value.trim();
    await chrome.storage.local.set({ [DEEPL_KEY_STR]: key });
    $('deepl-key-saved').classList.remove('hidden');
    setTimeout(() => $('deepl-key-saved').classList.add('hidden'), 2500);
  });

  $('save-byok-key').addEventListener('click', async () => {
    const key = $('byok-key').value.trim();
    const model = $('byok-model').value.trim();
    await chrome.storage.local.set({ [BYOK_KEY_STR]: key, [BYOK_MODEL_STR]: model });
    $('byok-key-saved').classList.remove('hidden');
    setTimeout(() => $('byok-key-saved').classList.add('hidden'), 2500);
  });

  $('byok-model').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [BYOK_MODEL_STR]: e.target.value.trim() });
  });
}

async function initDisplaySettings() {
  const stored = await chrome.storage.local.get({ [OVERLAY_MODE_KEY]: 'overlay' });
  const radios = document.querySelectorAll('input[name="overlay-mode"]');
  radios.forEach(r => { r.checked = r.value === stored[OVERLAY_MODE_KEY]; });
  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OVERLAY_MODE_KEY]: r.value });
  }));
}

initTranslationSettings();
initOcrSettings();
initDisplaySettings();
