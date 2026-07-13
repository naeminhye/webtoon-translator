/**
 * bench/label.js — GT labeling tool.
 *
 * Draw/adjust/delete detection boxes over a corpus page and type a
 * transcription per box, then export both GT files (see schema/*.md).
 * Deliberately plain: no framework, canvas + a DOM list, native Tab order
 * for keyboard nav between transcription fields.
 */

import { loadCorpus, tryLoadJson } from './lib/corpus.js';
import { computeCorpusHash } from './lib/hash.js';

const MIN_BOX = 6;      // natural px — discard draws smaller than this as accidental clicks
const HANDLE_PX = 8;    // display px hit-radius for a corner resize handle
const OPPOSITE = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };

const pageSelect = document.getElementById('pageSelect');
const exportBtn  = document.getElementById('exportBtn');
const statusMsg  = document.getElementById('statusMsg');
const canvas     = document.getElementById('stage');
const ctx        = canvas.getContext('2d');
const boxList    = document.getElementById('boxList');
const boxCountEl = document.getElementById('boxCount');

let manifest = null;
let currentPage = null;
let image = null;   // HTMLImageElement, natural size
let scale = 1;
let boxes = [];      // {id, x, y, w, h, text} — natural px coords
let selectedId = null;
let nextBoxNum = 1;

let drag = null; // { mode: 'draw'|'move'|'nw'|'ne'|'sw'|'se', anchor:{x,y}, origBox:{...}, box }

function setStatus(msg) { statusMsg.textContent = msg; }

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    manifest = await loadCorpus('fixtures/corpus.json');
  } catch (err) {
    setStatus(String(err.message || err));
    boxCountEl.textContent = 'No corpus loaded';
    boxList.innerHTML = '<div class="empty">Copy fixtures/corpus.json.example to fixtures/corpus.json (and add page images) to get started.</div>';
    return;
  }

  for (const page of manifest.pages) {
    const opt = document.createElement('option');
    opt.value = page.id;
    opt.textContent = `[${page.tier}] ${page.id}`;
    pageSelect.appendChild(opt);
  }

  pageSelect.addEventListener('change', () => loadPage(pageSelect.value));
  if (manifest.pages.length) await loadPage(manifest.pages[0].id);
}

async function loadPage(pageId) {
  currentPage = manifest.pages.find(p => p.id === pageId);
  if (!currentPage) return;
  selectedId = null;

  const [detGt, ocrGt] = await Promise.all([
    tryLoadJson(`fixtures/gt/detection/${pageId}.detection.json`),
    tryLoadJson(`fixtures/gt/ocr/${pageId}.ocr.json`),
  ]);

  const textByBoxId = new Map((ocrGt?.regions || []).map(r => [r.boxId, r.text]));
  boxes = (detGt?.boxes || []).map(b => ({ ...b, text: textByBoxId.get(b.id) || '' }));
  nextBoxNum = 1 + boxes.reduce((max, b) => {
    const m = /^b(\d+)$/.exec(b.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);

  const res = await fetch(`fixtures/${currentPage.file}`);
  if (!res.ok) {
    setStatus(`Could not load image fixtures/${currentPage.file}: HTTP ${res.status}`);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to decode fixtures/${currentPage.file}`));
    img.src = url;
  });

  const availableW = Math.max(200, window.innerWidth - 380);
  scale = Math.min(1, availableW / image.naturalWidth);
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);

  setStatus(`${pageId}: ${boxes.length} box(es) loaded`);
  render();
  renderList();
}

// ── Coordinate helpers ───────────────────────────────────────────────────────

function toNatural(evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) / scale,
    y: (evt.clientY - rect.top) / scale,
  };
}

function cornersOf(b) {
  return {
    nw: { x: b.x, y: b.y },
    ne: { x: b.x + b.w, y: b.y },
    sw: { x: b.x, y: b.y + b.h },
    se: { x: b.x + b.w, y: b.y + b.h },
  };
}

function clampBox(b) {
  const x = Math.max(0, Math.min(b.x, image.naturalWidth));
  const y = Math.max(0, Math.min(b.y, image.naturalHeight));
  const w = Math.max(0, Math.min(b.w, image.naturalWidth - x));
  const h = Math.max(0, Math.min(b.h, image.naturalHeight - y));
  return { ...b, x, y, w, h };
}

function hitTest(pt) {
  const handleR = HANDLE_PX / scale;
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    for (const [name, c] of Object.entries(cornersOf(b))) {
      if (Math.abs(pt.x - c.x) <= handleR && Math.abs(pt.y - c.y) <= handleR) {
        return { box: b, mode: name };
      }
    }
    if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
      return { box: b, mode: 'move' };
    }
  }
  return null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const b of boxes) {
    const selected = b.id === selectedId;
    const dx = b.x * scale, dy = b.y * scale, dw = b.w * scale, dh = b.h * scale;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#3366ff' : '#ff3366';
    ctx.strokeRect(dx, dy, dw, dh);

    if (selected) {
      ctx.fillStyle = '#3366ff';
      for (const c of Object.values(cornersOf(b))) {
        ctx.fillRect(c.x * scale - 4, c.y * scale - 4, 8, 8);
      }
    }
  }
}

function renderList() {
  boxCountEl.textContent = `Boxes (${boxes.length})`;
  boxList.innerHTML = '';
  if (!boxes.length) {
    boxList.innerHTML = '<div class="empty">Draw a box on the image to start.</div>';
    return;
  }
  for (const b of boxes) {
    const row = document.createElement('div');
    row.className = 'box-row' + (b.id === selectedId ? ' selected' : '');

    const idEl = document.createElement('span');
    idEl.className = 'box-id';
    idEl.textContent = b.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = b.text || '';
    input.placeholder = 'transcription…';
    input.dataset.boxId = b.id;
    input.addEventListener('input', () => { b.text = input.value; });
    input.addEventListener('focus', () => selectBox(b.id, { skipListFocus: true }));
    input.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter') return;
      evt.preventDefault();
      const idx = boxes.findIndex(x => x.id === b.id);
      const next = boxList.querySelector(`input[data-box-id="${boxes[idx + 1]?.id}"]`);
      if (next) next.focus();
      else input.blur();
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete box';
    del.addEventListener('click', () => deleteBox(b.id));

    row.append(idEl, input, del);
    row.addEventListener('click', (evt) => { if (evt.target === row) selectBox(b.id); });
    boxList.appendChild(row);
  }
}

function selectBox(id, opts = {}) {
  selectedId = id;
  render();
  const rows = boxList.querySelectorAll('.box-row');
  rows.forEach(r => r.classList.remove('selected'));
  const input = boxList.querySelector(`input[data-box-id="${id}"]`);
  if (input) {
    input.closest('.box-row')?.classList.add('selected');
    if (!opts.skipListFocus) input.focus();
  }
}

function deleteBox(id) {
  boxes = boxes.filter(b => b.id !== id);
  if (selectedId === id) selectedId = null;
  render();
  renderList();
}

// ── Mouse interaction ────────────────────────────────────────────────────────

canvas.addEventListener('pointerdown', (evt) => {
  const pt = toNatural(evt);
  const hit = hitTest(pt);

  if (hit) {
    selectBox(hit.box.id, { skipListFocus: true });
    drag = { mode: hit.mode, anchor: pt, origBox: { ...hit.box }, box: hit.box };
  } else {
    const box = { id: null, x: pt.x, y: pt.y, w: 0, h: 0, text: '' };
    drag = { mode: 'draw', anchor: pt, origBox: box, box };
  }
  canvas.setPointerCapture(evt.pointerId);
});

canvas.addEventListener('pointermove', (evt) => {
  if (!drag) return;
  const pt = toNatural(evt);

  if (drag.mode === 'move') {
    const dx = pt.x - drag.anchor.x, dy = pt.y - drag.anchor.y;
    Object.assign(drag.box, clampBox({ ...drag.origBox, x: drag.origBox.x + dx, y: drag.origBox.y + dy }));
  } else {
    // 'draw' or a corner resize — both are "rect between a fixed anchor and the live point"
    const anchor = drag.mode === 'draw'
      ? drag.anchor
      : cornersOf(drag.origBox)[OPPOSITE[drag.mode]];
    const x = Math.min(anchor.x, pt.x), y = Math.min(anchor.y, pt.y);
    const w = Math.abs(pt.x - anchor.x), h = Math.abs(pt.y - anchor.y);
    Object.assign(drag.box, clampBox({ ...drag.box, x, y, w, h }));
  }

  if (drag.mode === 'draw' && !boxes.includes(drag.box)) {
    // show the in-progress box immediately without committing it to the list yet
    render();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3366ff';
    ctx.strokeRect(drag.box.x * scale, drag.box.y * scale, drag.box.w * scale, drag.box.h * scale);
  } else {
    render();
  }
});

canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.mode === 'draw') {
    if (drag.box.w >= MIN_BOX && drag.box.h >= MIN_BOX) {
      drag.box.id = `b${nextBoxNum++}`;
      boxes.push(drag.box);
      renderList();
      selectBox(drag.box.id);
    } else {
      render(); // discard the too-small draft
    }
  } else {
    render();
  }
  drag = null;
});

// ── Export ───────────────────────────────────────────────────────────────────

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', async () => {
  if (!currentPage) return;
  const pageId = currentPage.id;

  const detectionGt = {
    pageId,
    boxes: boxes.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })),
  };
  const ocrGt = {
    pageId,
    regions: boxes.map(b => ({ boxId: b.id, text: b.text || '', language: currentPage.sourceLanguage || manifest.language })),
  };

  downloadJson(`${pageId}.detection.json`, detectionGt);
  downloadJson(`${pageId}.ocr.json`, ocrGt);

  // Informational only — the real corpus_hash used in benchmark JSONL
  // records covers every page's GT files, computed at benchmark run time
  // (Phase 2+), not just the page open here.
  const hash = await computeCorpusHash({ manifest, gtFiles: [detectionGt, ocrGt] });
  setStatus(
    `Exported ${pageId} — move the two downloaded files into ` +
    `fixtures/gt/detection/ and fixtures/gt/ocr/. Partial hash (this page only): ${hash.slice(0, 12)}…`
  );
});

boot();
