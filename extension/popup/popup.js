const $ = id => document.getElementById(id);
const ENABLED_KEY = 'wt:enabled';

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
    $('action-buttons').classList.remove('hidden');

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
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  const stored = await chrome.storage.local.get({ [ENABLED_KEY]: true });
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

  $('btn-panel').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_PANEL' }); window.close(); });
  $('btn-export').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_EXPORT' }); window.close(); });
  $('btn-import').addEventListener('click', () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_IMPORT' }); window.close(); });
  $('btn-clear').addEventListener('click',  () => { chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_CLEAR' }); window.close(); });
}

init();
