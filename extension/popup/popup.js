const $ = id => document.getElementById(id);
const ENABLED_KEY = 'wt:enabled';

let activeTabId  = null;
let userLoggedIn = false;

function applyEnabledUI(enabled) {
  $('enabled-toggle').checked = enabled;
  $('main-ui').classList.toggle('hidden', !enabled);
  $('disabled-notice').classList.toggle('hidden', enabled);
}

function applyAuthUI(loggedIn) {
  userLoggedIn = loggedIn;
  $('btn-annotate').classList.toggle('hidden', !loggedIn);
  $('login-hint').classList.toggle('hidden', loggedIn);
  // If currently in annotate mode but user is no longer logged in, switch to read
  if (!loggedIn && $('btn-annotate').classList.contains('active')) {
    chrome.tabs.sendMessage(activeTabId, { type: 'SET_MODE', mode: 'read' });
    setActiveMode('read');
  }
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
    $('title-id').title       = title;
    $('chapter-id').textContent = meta.chapterId;

    const translated = meta.translatedPanels ?? 0;
    const total      = meta.imageCount ?? 0;
    const pct        = total > 0 ? Math.round((translated / total) * 100) : 0;
    $('progress-text').textContent = total > 0 ? `${translated}/${total} panels (${pct}%)` : '—';
    $('progress-bar-fill').style.width = `${pct}%`;

    const badge = $('site-badge');
    badge.textContent = meta.site;
    badge.className   = `badge badge-${meta.site}`;

    const mode = meta.currentMode === 'annotate' && userLoggedIn ? 'annotate' : 'read';
    setActiveMode(mode);
  });
}

function setActiveMode(mode) {
  const annotate = mode === 'annotate';
  $('btn-read').classList.toggle('active', !annotate);
  $('btn-annotate').classList.toggle('active', annotate);
  $('action-buttons').classList.remove('hidden');
  $('btn-panel').classList.toggle('hidden', !annotate);
  $('btn-export').classList.toggle('hidden', !annotate);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  // Check auth status and extension enabled state in parallel
  const [stored, authStatus] = await Promise.all([
    chrome.storage.local.get({ [ENABLED_KEY]: true }),
    chrome.runtime.sendMessage({ type: 'SB_GET_STATUS' }).catch(() => ({ user: null })),
  ]);

  applyAuthUI(Boolean(authStatus?.user));

  const enabled = stored[ENABLED_KEY];
  applyEnabledUI(enabled);
  if (enabled) refreshMeta();

  $('enabled-toggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ [ENABLED_KEY]: on });
    applyEnabledUI(on);
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: 'SET_ENABLED', enabled: on }, () => {
        void chrome.runtime.lastError;
        if (on) setTimeout(refreshMeta, 400);
      });
    }
  });

  const openSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('popup/settings.html') });
  $('btn-settings').addEventListener('click', openSettings);
  $('login-hint-link').addEventListener('click', openSettings);

  $('btn-read').addEventListener('click', () => {
    chrome.tabs.sendMessage(activeTabId, { type: 'SET_MODE', mode: 'read' });
    setActiveMode('read');
  });
  $('btn-annotate').addEventListener('click', () => {
    if (!userLoggedIn) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'SET_MODE', mode: 'annotate' });
    setActiveMode('annotate');
  });
  $('btn-panel').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_PANEL' }); window.close(); });
  $('btn-export').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_EXPORT' }); window.close(); });
  $('btn-import').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_IMPORT' }); window.close(); });
  $('btn-clear').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_CLEAR' }); window.close(); });
}

init();
