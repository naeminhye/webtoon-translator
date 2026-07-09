const $ = id => document.getElementById(id);
const OCR_PROVIDER_KEY       = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR      = 'wt:ocrspace-key';
const TRANSLATE_PROVIDER_KEY = 'wt:translate-provider';
const TRANSLATE_LANG_KEY     = 'wt:translate-lang';
const DEEPL_KEY_STR          = 'wt:deepl-key';
const BYOK_KEY_STR           = 'wt:byok-key';
const BYOK_PROVIDER_KEY      = 'wt:byok-provider';
const BYOK_MODEL_STR         = 'wt:byok-model';
const BYOK_MODE_KEY          = 'wt:byok-mode';
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

  providerSelect.addEventListener('change', (e) => applyByokProviderPlaceholder(e.target.value));

  radios.forEach(r => r.addEventListener('change', () => applyProvider(r.value)));

  // Global Save button — validate then persist all translation settings at once
  $('save-translation').addEventListener('click', async () => {
    const provider = [...radios].find(r => r.checked)?.value || 'google';
    const deeplKey = $('deepl-key').value.trim();
    const byokKey  = $('byok-key').value.trim();
    const byokProv = $('byok-provider').value;
    const byokMod  = $('byok-model').value.trim();
    const byokMode = [...document.querySelectorAll('input[name="byok-mode"]')].find(r => r.checked)?.value || 'always';
    const lang     = $('target-lang').value;

    // Validate: key required for paid providers
    let valid = true;
    $('deepl-key-error').classList.add('hidden');
    $('byok-key-error').classList.add('hidden');
    if (provider === 'deepl' && !deeplKey) {
      $('deepl-key-error').classList.remove('hidden');
      $('deepl-key').focus();
      valid = false;
    }
    if (provider === 'byok' && !byokKey) {
      $('byok-key-error').classList.remove('hidden');
      $('byok-key').focus();
      valid = false;
    }
    if (!valid) {
      showSaveFeedback('Please enter an API key first.', 'error');
      return;
    }

    await chrome.storage.local.set({
      [TRANSLATE_PROVIDER_KEY]: provider,
      [TRANSLATE_LANG_KEY]:     lang,
      [DEEPL_KEY_STR]:          deeplKey,
      [BYOK_KEY_STR]:           byokKey,
      [BYOK_PROVIDER_KEY]:      byokProv,
      [BYOK_MODEL_STR]:         byokMod,
      [BYOK_MODE_KEY]:          byokMode,
    });
    showSaveFeedback('Settings saved!', 'success');
  });

  function showSaveFeedback(msg, type) {
    const el = $('save-translation-feedback');
    el.textContent = msg;
    el.className = `save-feedback ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2500);
  }
}

async function initDisplaySettings() {
  const stored = await chrome.storage.local.get({ [OVERLAY_MODE_KEY]: 'overlay' });
  const radios = document.querySelectorAll('input[name="overlay-mode"]');
  radios.forEach(r => { r.checked = r.value === stored[OVERLAY_MODE_KEY]; });
  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OVERLAY_MODE_KEY]: r.value });
  }));
}

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

  const fontSel = document.getElementById('bubble-font');
  fontSel.value = stored['wt:bubble-font'] || '';
  fontSel.addEventListener('change', async () => {
    await chrome.storage.local.set({ 'wt:bubble-font': fontSel.value });
  });
}

initTranslationSettings();
initOcrSettings();
initDisplaySettings();
initAppearanceSettings();
