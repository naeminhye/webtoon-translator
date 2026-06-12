const $ = id => document.getElementById(id);
const OCR_PROVIDER_KEY  = 'wt:ocr-provider';
const OCR_SPACE_KEY_STR = 'wt:ocrspace-key';

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

async function initSyncSettings() {
  const status = await chrome.runtime.sendMessage({ type: 'SB_GET_STATUS' });

  function setSyncDot(state) {
    const pill = $('sync-status-pill');
    if (state === 'off') {
      pill.className = 'status-pill status-off';
      pill.textContent = 'Not configured';
    } else if (state === 'on') {
      pill.className = 'status-pill status-on';
      pill.textContent = 'Connected';
    } else {
      pill.className = 'status-pill status-synced';
      pill.textContent = 'Synced ✓';
    }
  }

  function showConfigured(user) {
    $('sb-config-wrap').classList.add('hidden');
    $('sb-auth-wrap').classList.remove('hidden');
    if (user) {
      $('sb-login-form').classList.add('hidden');
      $('sb-user-row').classList.remove('hidden');
      $('sb-user-email').textContent = user.email;
      setSyncDot('synced');
      $('footer-sync-label').textContent = 'Supabase sync ✓';
    } else {
      $('sb-login-form').classList.remove('hidden');
      $('sb-user-row').classList.add('hidden');
      setSyncDot('on');
      $('footer-sync-label').textContent = 'Supabase (not signed in)';
    }
  }

  function showNotConfigured() {
    $('sb-config-wrap').classList.remove('hidden');
    $('sb-auth-wrap').classList.add('hidden');
    setSyncDot('off');
    $('footer-sync-label').textContent = 'local only';
  }

  if (status.configured) showConfigured(status.user);
  else showNotConfigured();

  $('sb-save-config').addEventListener('click', async () => {
    const url     = $('sb-url').value.trim().replace(/\/$/, '');
    const anonKey = $('sb-anon-key').value.trim();
    if (!url || !anonKey) return;
    await chrome.runtime.sendMessage({ type: 'SB_SAVE_CONFIG', payload: { url, anonKey } });
    showConfigured(null);
  });

  async function doSignIn() {
    const email    = $('sb-email').value.trim();
    const password = $('sb-password').value;
    if (!email || !password) return;
    $('sb-signin-btn').disabled = true;
    $('sb-auth-error').classList.add('hidden');
    const res = await chrome.runtime.sendMessage({ type: 'SB_SIGN_IN', payload: { email, password } });
    $('sb-signin-btn').disabled = false;
    if (res.ok) { showConfigured(res.user); }
    else { $('sb-auth-error').textContent = res.error; $('sb-auth-error').classList.remove('hidden'); }
  }

  $('sb-signin-btn').addEventListener('click', doSignIn);
  $('sb-password').addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });

  $('sb-signout-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SB_SIGN_OUT' });
    showConfigured(null);
  });
}

initOcrSettings();
initSyncSettings();
