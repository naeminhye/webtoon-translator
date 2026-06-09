/**
 * popup/popup.js
 */

const $ = id => document.getElementById(id);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'GET_META' }, (meta) => {
    if (chrome.runtime.lastError || !meta) return;

    $('no-chapter').classList.add('hidden');
    $('chapter-info').classList.remove('hidden');
    $('mode-toggle').classList.remove('hidden');
    $('action-buttons').classList.remove('hidden');

    $('title-id').textContent   = meta.titleId;
    $('chapter-id').textContent = meta.chapterId;
    $('ann-count').textContent  = meta.annotationCount ?? '0';

    const badge = $('site-badge');
    badge.textContent = meta.site;
    badge.className   = `badge badge-${meta.site}`;

    // Restore current mode so popup reflects actual state
    if (meta.currentMode === 'annotate') {
      $('btn-annotate').classList.add('active');
      $('btn-read').classList.remove('active');
    } else {
      $('btn-read').classList.add('active');
      $('btn-annotate').classList.remove('active');
    }
  });

  $('btn-read').addEventListener('click', () => {
    setMode(tab.id, 'read');
    $('btn-read').classList.add('active');
    $('btn-annotate').classList.remove('active');
  });

  $('btn-annotate').addEventListener('click', () => {
    setMode(tab.id, 'annotate');
    $('btn-annotate').classList.add('active');
    $('btn-read').classList.remove('active');
  });

  $('btn-export').addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_EXPORT' });
    window.close();
  });

  $('btn-import').addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_IMPORT' });
    window.close();
  });
}

function setMode(tabId, mode) {
  chrome.tabs.sendMessage(tabId, { type: 'SET_MODE', mode });
}

init();
