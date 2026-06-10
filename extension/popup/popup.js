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

    // Show human-readable title, truncated if long
    const title = meta.title || meta.titleId;
    $('title-id').textContent   = title.length > 28 ? title.slice(0, 26) + '…' : title;
    $('title-id').title         = title; // full title on hover
    $('chapter-id').textContent = meta.chapterId;

    const translated = meta.translatedPanels ?? 0;
    const total      = meta.imageCount ?? 0;
    const pct        = total > 0 ? Math.round((translated / total) * 100) : 0;
    $('progress-text').textContent = total > 0 ? `${translated}/${total} panels (${pct}%)` : '—';
    $('progress-bar-fill').style.width = `${pct}%`;

    const badge = $('site-badge');
    badge.textContent = meta.site;
    badge.className   = `badge badge-${meta.site}`;

    if (meta.currentMode === 'annotate') {
      $('btn-annotate').classList.add('active');
      $('btn-read').classList.remove('active');
    } else {
      $('btn-read').classList.add('active');
      $('btn-annotate').classList.remove('active');
    }
  });

  $('btn-read').addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'SET_MODE', mode: 'read' });
    $('btn-read').classList.add('active');
    $('btn-annotate').classList.remove('active');
  });
  $('btn-annotate').addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'SET_MODE', mode: 'annotate' });
    $('btn-annotate').classList.add('active');
    $('btn-read').classList.remove('active');
  });
  $('btn-panel').addEventListener('click',  () => { chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }); window.close(); });
  $('btn-export').addEventListener('click', () => { chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_EXPORT' }); window.close(); });
  $('btn-import').addEventListener('click', () => { chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_IMPORT' }); window.close(); });
}

init();
