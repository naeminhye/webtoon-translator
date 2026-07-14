const $ = id => document.getElementById(id);
const THEME_KEY  = 'wt:settings-theme';
const TAB_KEY    = 'wt:settings-tab';
const LOCALE_KEY = 'wt:locale';

// ── UI language ──────────────────────────────────────────────────────────
// See extension/shared/i18n.js — currently only the pre-translate overlay's
// strings are wired through WT_I18N; everything else stays English-only.
async function initLocale() {
  const stored = await chrome.storage.local.get({ [LOCALE_KEY]: 'en' });
  WT_I18N.setLocale(stored[LOCALE_KEY]);
  $('ui-locale').value = WT_I18N.getLocale();

  $('ui-locale').addEventListener('change', async (e) => {
    WT_I18N.setLocale(e.target.value);
    await chrome.storage.local.set({ [LOCALE_KEY]: e.target.value });
  });
}

// ── Version display ─────────────────────────────────────────────────────
// Reads the real extension version from manifest.json instead of a
// hardcoded string, so the UI can never drift out of sync with it.
function initVersion() {
  const version = `v${chrome.runtime.getManifest().version}`;
  $('navbar-version').textContent = version;
  $('footer-version').textContent = version;
}

// ── Theme (light/dark) ──────────────────────────────────────────────────
// Persisted separately from every other 'wt:' setting below — this is a
// UI preference for this settings page only, not an extension behavior.
async function initTheme() {
  const stored = await chrome.storage.local.get({ [THEME_KEY]: '' });
  const btn = $('theme-toggle');

  function apply(theme) {
    // '' (no stored choice) leaves data-theme unset so the
    // prefers-color-scheme media query in settings.css decides — the
    // toggle button still needs a concrete label, so fall back to what
    // the media query would currently resolve to.
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = theme || (systemDark ? 'dark' : 'light');
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    btn.textContent = effective === 'dark' ? 'Light' : 'Dark';
  }

  apply(stored[THEME_KEY]);

  btn.addEventListener('click', async () => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = document.documentElement.getAttribute('data-theme') || (systemDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    apply(next);
    await chrome.storage.local.set({ [THEME_KEY]: next });
  });
}

// ── Tabs ─────────────────────────────────────────────────────────────────
async function initTabs() {
  const pills  = document.querySelectorAll('.tab-pill');
  const panels = document.querySelectorAll('.tab-panel');
  const stored = await chrome.storage.local.get({ [TAB_KEY]: 'general' });

  function activate(tab) {
    pills.forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
    panels.forEach(s => s.classList.toggle('hidden', s.dataset.tabPanel !== tab));
  }

  const initial = [...pills].some(p => p.dataset.tab === stored[TAB_KEY]) ? stored[TAB_KEY] : 'general';
  activate(initial);

  pills.forEach(p => p.addEventListener('click', async () => {
    activate(p.dataset.tab);
    await chrome.storage.local.set({ [TAB_KEY]: p.dataset.tab });
  }));
}

const OCR_PROVIDER_KEY       = 'wt:ocr-provider';
const PADDLE_URL_KEY         = 'wt:paddleocr-url';
const TRANSLATE_PROVIDER_KEY = 'wt:translate-provider';
const TRANSLATE_LANG_KEY     = 'wt:translate-lang';
const BYOK_KEY_STR           = 'wt:byok-key';
const BYOK_PROVIDER_KEY      = 'wt:byok-provider';
const BYOK_MODEL_STR         = 'wt:byok-model';
const BYOK_MODE_KEY          = 'wt:byok-mode';
const BYOK_PRESETS_KEY       = 'wt:byok-presets';
const BYOK_ACTIVE_PRESET_KEY = 'wt:byok-active-preset';
const OVERLAY_MODE_KEY       = 'wt:overlay-mode';
const AUTO_DETECT_KEY        = 'wt:auto-detect';

// Mirrors background/worker.js — keep in sync. Shown as the input placeholder;
// an empty stored URL means "use this default" (never persisted, so a future
// default change still takes effect for users who kept the default).
const DEFAULT_PADDLE_URL = 'http://127.0.0.1:8868';

async function initOcrSettings() {
  const stored = await chrome.storage.local.get({
    [OCR_PROVIDER_KEY]:  'tesseract',
    [PADDLE_URL_KEY]:    '',
  });

  const radios = document.querySelectorAll('input[name="ocr-provider"]');

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    $('paddleocr-url-row').classList.toggle('hidden', provider !== 'paddleocr');
    $('paddleocr-url-saved').classList.add('hidden');
    $('paddleocr-local-row').classList.toggle('hidden', provider !== 'paddleocr-local');
    if (provider === 'paddleocr-local') refreshPaddleModelsStatus();
  }

  // 'ocrspace' was removed as an option — fall a stored legacy value back to
  // the default engine so the UI doesn't render with nothing selected, and
  // persist the fallback so it sticks.
  let initialProvider = stored[OCR_PROVIDER_KEY];
  if (initialProvider === 'ocrspace') {
    initialProvider = 'tesseract';
    chrome.storage.local.set({ [OCR_PROVIDER_KEY]: initialProvider });
  }
  applyProvider(initialProvider);
  if (stored[PADDLE_URL_KEY]) $('paddleocr-url').value = stored[PADDLE_URL_KEY];

  // Surface a capability warning on the PaddleOCR (in-browser) card itself —
  // shown regardless of which engine is currently selected, so it can inform
  // the choice rather than only appearing after the user has already picked
  // this engine. No hard cutoff exists for "too weak"; this is a soft nudge
  // based on the same navigator.gpu check ort-runner.js/paddle-runner.js use
  // to pick an execution provider, plus a low core-count heuristic.
  const hasGpu = !!navigator.gpu;
  const cores  = navigator.hardwareConcurrency || 0;
  const weakHardware = !hasGpu && cores > 0 && cores < 4;
  $('paddleocr-local-hw-warning').classList.toggle('hidden', !weakHardware);

  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OCR_PROVIDER_KEY]: r.value });
    applyProvider(r.value);
  }));

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

  // ── PaddleOCR (in-browser) model status + download/remove ────────────────
  // Model bytes live in the background service worker's Cache Storage (see
  // worker.js paddleModelsDownload/Status/Clear) — this popup only ever
  // asks it for status or tells it to download/clear, never touches the
  // cache directly, so state stays correct even if a download that started
  // from a since-closed popup is still running when this popup opens.

  function setModelDot(key, state) {
    const dot = $(`paddle-${key}-dot`);
    dot.classList.remove('is-ready', 'is-downloading', 'is-error');
    if (state === 'ready' || state === 'downloading' || state === 'error') {
      dot.classList.add(`is-${state}`);
    }
    const text = $(`paddle-${key}-text`);
    text.textContent = { ready: 'ready', downloading: 'downloading…', error: 'error', missing: 'not downloaded' }[state] || state;
  }

  function renderPaddleModelsStatus(status) {
    setModelDot('det', status.det === 'cached' ? 'ready' : (status.downloading ? 'downloading' : 'missing'));
    setModelDot('rec', status.rec === 'cached' ? 'ready' : (status.downloading ? 'downloading' : 'missing'));
    const bothReady = status.det === 'cached' && status.rec === 'cached';
    const btn = $('paddle-models-download-btn');
    btn.disabled = status.downloading || bothReady;
    btn.textContent = status.downloading ? 'Downloading…' : (bothReady ? 'Models ready' : 'Download models');
    $('paddle-models-clear-btn').classList.toggle('hidden', !bothReady || status.downloading);
    if (!status.downloading) $('paddle-models-error').classList.add('hidden');
  }

  async function refreshPaddleModelsStatus() {
    const status = await chrome.runtime.sendMessage({ type: 'PADDLE_MODELS_STATUS' });
    if (status) renderPaddleModelsStatus(status);
  }

  // Live progress while a download is in flight — also covers the case where
  // a previously-opened popup started the download and was then closed; the
  // background keeps downloading regardless, and this popup's listener still
  // receives the remaining broadcast events.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'PADDLE_MODELS_EVENT') return;
    const { stage, state, error } = message.payload;
    if (stage === 'det' || stage === 'rec') {
      setModelDot(stage, state === 'done' ? 'ready' : 'downloading');
    } else if (stage === 'all' && state === 'done') {
      refreshPaddleModelsStatus();
    } else if (stage === 'error') {
      $('paddle-models-error').textContent = error || 'Download failed.';
      $('paddle-models-error').classList.remove('hidden');
      refreshPaddleModelsStatus();
    }
  });

  $('paddle-models-download-btn').addEventListener('click', async () => {
    $('paddle-models-download-btn').disabled = true;
    $('paddle-models-download-btn').textContent = 'Downloading…';
    $('paddle-models-error').classList.add('hidden');
    const res = await chrome.runtime.sendMessage({ type: 'PADDLE_MODELS_DOWNLOAD' });
    if (res && !res.ok) {
      $('paddle-models-error').textContent = res.error || 'Download failed.';
      $('paddle-models-error').classList.remove('hidden');
    }
    refreshPaddleModelsStatus();
  });

  $('paddle-models-clear-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'PADDLE_MODELS_CLEAR' });
    refreshPaddleModelsStatus();
  });

  if (stored[OCR_PROVIDER_KEY] === 'paddleocr-local') refreshPaddleModelsStatus();
}

async function initTranslationSettings() {
  const stored = await chrome.storage.local.get({
    [TRANSLATE_PROVIDER_KEY]: 'chrome-builtin',
    [TRANSLATE_LANG_KEY]:     'vi',
    [BYOK_KEY_STR]:           '',
    [BYOK_PROVIDER_KEY]:      '',
    [BYOK_MODEL_STR]:         '',
    [BYOK_MODE_KEY]:          'always',
  });

  const radios = document.querySelectorAll('input[name="translate-provider"]');

  function applyProvider(provider) {
    radios.forEach(r => { r.checked = r.value === provider; });
    $('byok-key-row').classList.toggle('hidden', provider !== 'byok');
    $('chrome-builtin-row').classList.toggle('hidden', provider !== 'chrome-builtin');
    if (provider === 'chrome-builtin') refreshChromeBuiltinStatus();
  }

  // ── Chrome built-in Translator status (source is always Korean — this
  // extension only ever OCRs Korean webtoon dialogue) ─────────────────────
  // Availability is per source→target language PAIR, not a one-time global
  // download like the OCR models, so this is checked live against the API
  // itself rather than driven by a Cache-Storage-backed download flow. This
  // settings page is a real top-level-window extension page (opened via
  // chrome.tabs.create), which is exactly the context the Translator API
  // requires — no offscreen-document indirection needed, unlike OCR/detection.
  function setChromeBuiltinDot(state) {
    const dot = $('chrome-builtin-dot');
    dot.classList.remove('is-ready', 'is-downloading', 'is-error');
    if (state === 'ready' || state === 'downloading' || state === 'error') dot.classList.add(`is-${state}`);
  }

  async function refreshChromeBuiltinStatus() {
    const langName = $('target-lang').selectedOptions[0]?.textContent || $('target-lang').value;
    $('chrome-builtin-lang-name').textContent = langName;
    $('chrome-builtin-error').classList.add('hidden');
    const btn = $('chrome-builtin-download-btn');

    if (!('Translator' in self)) {
      setChromeBuiltinDot('error');
      $('chrome-builtin-text').textContent = 'unsupported browser';
      btn.disabled = true;
      btn.textContent = 'Download model';
      return;
    }

    setChromeBuiltinDot('downloading'); // "checking…" reuses the pulsing dot
    $('chrome-builtin-text').textContent = 'checking…';
    try {
      const availability = await Translator.availability({ sourceLanguage: 'ko', targetLanguage: $('target-lang').value });
      if (availability === 'available') {
        setChromeBuiltinDot('ready');
        $('chrome-builtin-text').textContent = 'ready';
        btn.disabled = true;
        btn.textContent = 'Model ready';
      } else if (availability === 'downloadable') {
        setChromeBuiltinDot(null);
        $('chrome-builtin-text').textContent = 'not downloaded';
        btn.disabled = false;
        btn.textContent = 'Download model';
      } else if (availability === 'downloading') {
        setChromeBuiltinDot('downloading');
        $('chrome-builtin-text').textContent = 'downloading…';
        btn.disabled = true;
        btn.textContent = 'Downloading…';
      } else {
        setChromeBuiltinDot('error');
        $('chrome-builtin-text').textContent = 'unsupported language';
        btn.disabled = true;
        btn.textContent = 'Download model';
      }
    } catch (err) {
      setChromeBuiltinDot('error');
      $('chrome-builtin-text').textContent = 'error';
      $('chrome-builtin-error').textContent = err?.message || 'Could not check model availability.';
      $('chrome-builtin-error').classList.remove('hidden');
      btn.disabled = true;
    }
  }

  $('chrome-builtin-download-btn').addEventListener('click', async () => {
    const btn = $('chrome-builtin-download-btn');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    setChromeBuiltinDot('downloading');
    $('chrome-builtin-text').textContent = 'downloading…';
    $('chrome-builtin-error').classList.add('hidden');
    try {
      const translator = await Translator.create({
        sourceLanguage: 'ko',
        targetLanguage: $('target-lang').value,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            $('chrome-builtin-text').textContent = `downloading… ${Math.round(e.loaded * 100)}%`;
          });
        },
      });
      translator.destroy?.();
      await refreshChromeBuiltinStatus();
    } catch (err) {
      setChromeBuiltinDot('error');
      $('chrome-builtin-text').textContent = 'download failed';
      $('chrome-builtin-error').textContent = err?.message || 'Model download failed.';
      $('chrome-builtin-error').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Download model';
    }
  });

  // "none" (Disabled) and "deepl" were removed as options — fall a stored
  // legacy value back to the default provider so the UI doesn't render with
  // nothing selected, and persist the fallback so it sticks.
  let initialProvider = stored[TRANSLATE_PROVIDER_KEY];
  if (initialProvider === 'none' || initialProvider === 'deepl') {
    initialProvider = 'chrome-builtin';
    chrome.storage.local.set({ [TRANSLATE_PROVIDER_KEY]: initialProvider });
  }
  applyProvider(initialProvider);
  $('target-lang').value = stored[TRANSLATE_LANG_KEY];

  // Provider dropdown is populated from the shared adapter registry
  // (extension/shared/llm-adapters.js) — never a separately hardcoded list —
  // so a new adapter registered there appears here automatically.
  const providerSelect = $('byok-provider');
  providerSelect.innerHTML = WT_LLM_ADAPTERS
    .map(a => `<option value="${a.id}">${a.label}</option>`)
    .join('');

  function applyByokProviderPlaceholder(providerId) {
    const adapter = getLlmAdapter(providerId);
    $('byok-model').placeholder = adapter?.modelPlaceholder || '';
  }

  // ── BYOK presets ─────────────────────────────────────────────────────
  // Each preset bundles {name, provider, model, key, mode} so users can
  // save e.g. a "Fast & cheap" and a "High quality" combo and switch
  // between them without retyping a key. The active preset's fields are
  // mirrored into the legacy flat wt:byok-* keys on every change, so the
  // content-script translate pipeline (bundle.js) keeps reading a single
  // "current" value and never needs to know presets exist.
  function makePresetId() {
    return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const presetStored = await chrome.storage.local.get({
    [BYOK_PRESETS_KEY]: [],
    [BYOK_ACTIVE_PRESET_KEY]: '',
  });
  let presets = presetStored[BYOK_PRESETS_KEY];
  let activePresetId = presetStored[BYOK_ACTIVE_PRESET_KEY];

  if (!presets.length) {
    // First run after presets shipped (or a fresh install): migrate
    // whatever single BYOK config already existed (or blanks) into one
    // "Default" preset.
    let legacyProvider = stored[BYOK_PROVIDER_KEY];
    let legacyModel    = stored[BYOK_MODEL_STR];
    // Migrate a pre-existing combined "provider/model" string (the old
    // single free-text field) into the two separate fields, once.
    if (!legacyProvider && legacyModel.includes('/')) {
      const slash = legacyModel.indexOf('/');
      legacyProvider = legacyModel.slice(0, slash);
      legacyModel    = legacyModel.slice(slash + 1);
    }
    presets = [{
      id: makePresetId(),
      name: 'Default',
      provider: legacyProvider || WT_LLM_ADAPTERS[0]?.id || '',
      model: legacyModel,
      key: stored[BYOK_KEY_STR],
      mode: stored[BYOK_MODE_KEY] || 'always',
    }];
    activePresetId = presets[0].id;
    await chrome.storage.local.set({ [BYOK_PRESETS_KEY]: presets, [BYOK_ACTIVE_PRESET_KEY]: activePresetId });
  }
  if (!presets.some(p => p.id === activePresetId)) activePresetId = presets[0].id;

  function getActivePreset() {
    return presets.find(p => p.id === activePresetId) || presets[0];
  }

  async function persistPresets() {
    await chrome.storage.local.set({ [BYOK_PRESETS_KEY]: presets, [BYOK_ACTIVE_PRESET_KEY]: activePresetId });
  }

  async function mirrorActivePresetToLegacy() {
    const preset = getActivePreset();
    await chrome.storage.local.set({
      [BYOK_KEY_STR]:      preset.key,
      [BYOK_PROVIDER_KEY]: preset.provider,
      [BYOK_MODEL_STR]:    preset.model,
      [BYOK_MODE_KEY]:     preset.mode,
    });
  }

  function renderPresetSelect() {
    const select = $('byok-preset-select');
    select.innerHTML = presets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    select.value = activePresetId;
    $('byok-preset-delete-btn').disabled = presets.length <= 1;
  }

  function applyActivePresetToFields() {
    const preset = getActivePreset();
    $('byok-key').value = preset.key || '';
    providerSelect.value = preset.provider || WT_LLM_ADAPTERS[0]?.id || '';
    applyByokProviderPlaceholder(providerSelect.value);
    $('byok-model').value = preset.model || '';
    byokModeRadios.forEach(r => { r.checked = r.value === (preset.mode || 'always'); });
    updateKeyWarnings();
  }

  renderPresetSelect();

  $('byok-preset-select').addEventListener('change', async (e) => {
    activePresetId = e.target.value;
    applyActivePresetToFields();
    await persistPresets();
    await mirrorActivePresetToLegacy();
  });

  $('byok-preset-add-btn').addEventListener('click', async () => {
    const name = window.prompt('Preset name:', `Preset ${presets.length + 1}`);
    if (!name) return;
    const preset = { id: makePresetId(), name: name.trim(), provider: WT_LLM_ADAPTERS[0]?.id || '', model: '', key: '', mode: 'always' };
    presets.push(preset);
    activePresetId = preset.id;
    renderPresetSelect();
    applyActivePresetToFields();
    await persistPresets();
    await mirrorActivePresetToLegacy();
  });

  $('byok-preset-rename-btn').addEventListener('click', async () => {
    const preset = getActivePreset();
    const name = window.prompt('Preset name:', preset.name);
    if (!name) return;
    preset.name = name.trim();
    renderPresetSelect();
    await persistPresets();
  });

  $('byok-preset-delete-btn').addEventListener('click', async () => {
    if (presets.length <= 1) return;
    const preset = getActivePreset();
    if (!window.confirm(`Delete preset "${preset.name}"?`)) return;
    presets = presets.filter(p => p.id !== preset.id);
    activePresetId = presets[0].id;
    renderPresetSelect();
    applyActivePresetToFields();
    await persistPresets();
    await mirrorActivePresetToLegacy();
  });

  // BYOK mode radio — scoped to the active preset.
  const byokModeRadios = document.querySelectorAll('input[name="byok-mode"]');
  byokModeRadios.forEach(r => r.addEventListener('change', async () => {
    if (!r.checked) return;
    getActivePreset().mode = r.value;
    await persistPresets();
    await mirrorActivePresetToLegacy();
  }));

  providerSelect.addEventListener('change', async (e) => {
    applyByokProviderPlaceholder(e.target.value);
    getActivePreset().provider = e.target.value;
    await persistPresets();
    await mirrorActivePresetToLegacy();
  });

  applyActivePresetToFields();

  // ── Autosave: every control persists on change; no Save button ──
  // Provider radios: warn (not block) when a paid provider is picked without
  // a key — the key field autosaves as you type, so the warning clears itself.
  function updateKeyWarnings() {
    const provider = [...radios].find(r => r.checked)?.value || 'google';
    $('byok-key-error').classList.toggle('hidden', !(provider === 'byok' && !$('byok-key').value.trim()));
  }

  radios.forEach(r => r.addEventListener('change', async () => {
    applyProvider(r.value);
    updateKeyWarnings();
    await chrome.storage.local.set({ [TRANSLATE_PROVIDER_KEY]: r.value });
  }));

  $('target-lang').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ [TRANSLATE_LANG_KEY]: e.target.value });
    // Availability is per language pair — re-check against the new target
    // whenever Chrome Built-in AI is the active provider.
    if ([...radios].find(r => r.checked)?.value === 'chrome-builtin') refreshChromeBuiltinStatus();
  });

  // Debounced autosave for text inputs — writes into the active preset and
  // mirrors to the legacy flat key bundle.js reads.
  function autosavePresetField(el, field, legacyKey) {
    let t = null;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const value = el.value.trim();
        getActivePreset()[field] = value;
        await persistPresets();
        await chrome.storage.local.set({ [legacyKey]: value });
        updateKeyWarnings();
      }, 400);
    });
  }
  autosavePresetField($('byok-key'),   'key',   BYOK_KEY_STR);
  autosavePresetField($('byok-model'), 'model', BYOK_MODEL_STR);
}

async function initDisplaySettings() {
  const stored = await chrome.storage.local.get({ [OVERLAY_MODE_KEY]: 'overlay', [AUTO_DETECT_KEY]: false });
  const radios = document.querySelectorAll('input[name="overlay-mode"]');
  radios.forEach(r => { r.checked = r.value === stored[OVERLAY_MODE_KEY]; });
  radios.forEach(r => r.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OVERLAY_MODE_KEY]: r.value });
  }));

  function applyAutoDetect(enabled) {
    $('comic-detector-row').classList.toggle('hidden', !enabled);
    if (enabled) refreshComicDetectorStatus();
    else $('auto-detect-model-warning').classList.add('hidden');
  }

  const autoDetect = $('auto-detect-toggle');
  autoDetect.checked = !!stored[AUTO_DETECT_KEY];
  applyAutoDetect(autoDetect.checked);
  autoDetect.addEventListener('change', async () => {
    await chrome.storage.local.set({ [AUTO_DETECT_KEY]: autoDetect.checked });
    applyAutoDetect(autoDetect.checked);
  });

  // ── Bubble detector model status + download/remove ─────────────────────
  // Same rationale as the PaddleOCR in-browser model block in initOcrSettings:
  // model bytes live in the background service worker's Cache Storage (see
  // worker.js comicDetectorDownload/Status/Clear) — this popup only asks it
  // for status or tells it to download/clear, never touches the cache
  // directly.

  function setComicDetectorDot(state) {
    const dot = $('comic-detector-dot');
    dot.classList.remove('is-ready', 'is-downloading', 'is-error');
    if (state === 'ready' || state === 'downloading' || state === 'error') {
      dot.classList.add(`is-${state}`);
    }
    $('comic-detector-text').textContent =
      { ready: 'ready', downloading: 'downloading…', error: 'error', missing: 'not downloaded' }[state] || state;
  }

  function renderComicDetectorStatus(status) {
    const ready = status.det === 'cached';
    setComicDetectorDot(ready ? 'ready' : (status.downloading ? 'downloading' : 'missing'));
    const btn = $('comic-detector-download-btn');
    btn.disabled = status.downloading || ready;
    btn.textContent = status.downloading ? 'Downloading…' : (ready ? 'Model ready' : 'Download model');
    $('comic-detector-clear-btn').classList.toggle('hidden', !ready || status.downloading);
    if (!status.downloading) $('comic-detector-error').classList.add('hidden');
    // Auto-detect is a no-op without this model — surface it near the toggle
    // itself, not just as a small status dot the user might not scroll to.
    $('auto-detect-model-warning').classList.toggle('hidden', ready || !autoDetect.checked);
  }

  async function refreshComicDetectorStatus() {
    const status = await chrome.runtime.sendMessage({ type: 'COMIC_DETECTOR_STATUS' });
    if (status) renderComicDetectorStatus(status);
  }

  // Live progress while a download is in flight — also covers the case where
  // a previously-opened popup started the download and was then closed.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'COMIC_DETECTOR_EVENT') return;
    const { stage, state, error } = message.payload;
    if (stage === 'det') {
      setComicDetectorDot(state === 'done' ? 'ready' : 'downloading');
    } else if (stage === 'all' && state === 'done') {
      refreshComicDetectorStatus();
    } else if (stage === 'error') {
      $('comic-detector-error').textContent = error || 'Download failed.';
      $('comic-detector-error').classList.remove('hidden');
      refreshComicDetectorStatus();
    }
  });

  $('comic-detector-download-btn').addEventListener('click', async () => {
    $('comic-detector-download-btn').disabled = true;
    $('comic-detector-download-btn').textContent = 'Downloading…';
    $('comic-detector-error').classList.add('hidden');
    const res = await chrome.runtime.sendMessage({ type: 'COMIC_DETECTOR_DOWNLOAD' });
    if (res && !res.ok) {
      $('comic-detector-error').textContent = res.error || 'Download failed.';
      $('comic-detector-error').classList.remove('hidden');
    }
    refreshComicDetectorStatus();
  });

  $('comic-detector-clear-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'COMIC_DETECTOR_CLEAR' });
    refreshComicDetectorStatus();
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

// ── OCR confidence stats ──────────────────────────────────────────────────
// Mirrors background/worker.js's OCR_STATS_KEY shape: { [provider]: { count,
// confCount, confSum } }. Rendered per provider id, matching the four
// ocr-provider radio values (see initOcrSettings).
const OCR_STATS_PROVIDERS = ['tesseract', 'paddleocr-local', 'paddleocr'];

function renderOcrStats(stats) {
  for (const provider of OCR_STATS_PROVIDERS) {
    const s = stats[provider] || { count: 0, confCount: 0, confSum: 0 };
    $(`stat-${provider}-count`).textContent = `${s.count} call${s.count === 1 ? '' : 's'}`;
    $(`stat-${provider}-avg`).textContent = s.confCount > 0
      ? `${(s.confSum / s.confCount).toFixed(1)}%`
      : '–';
  }
}

async function initOcrStatsSettings() {
  async function refresh() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_OCR_STATS' });
    renderOcrStats(res?.stats || {});
  }

  await refresh();

  $('ocr-stats-reset-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'RESET_OCR_STATS' });
    await refresh();
  });
}

initVersion();
initLocale();
initTheme();
initTabs();
initTranslationSettings();
initOcrSettings();
initOcrStatsSettings();
initDisplaySettings();
initAppearanceSettings();
