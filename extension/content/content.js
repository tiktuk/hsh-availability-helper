'use strict';

const SLOT_SECONDS = 300;
const CYCLE = ['not_set', 'available', 'unavailable'];
const TOGGLE_URL = '/guide/availables/toggle_available_date';
const CONCURRENCY = 8;

const DEFAULTS = {
  duration: 90,
  presets: ['09:55', '10:55', '11:55', '12:55', '13:55', '14:55', '16:35'],
  altClickBlock: true,
  hideOutside: true,
  dayFrom: '09:55',
  dayTo: '18:30',
  view: 'blocks',
};

const state = {
  settings: { ...DEFAULTS },
  anchor: null,
  busy: false,
  undo: null,
  undoTimeout: null,
  days: [], // booleans per visible column
};

/* ---------- helpers ---------- */

const gridTable = () => document.querySelector('table.available-table');

function stateOfClass(cls) {
  if (cls.includes('not_available')) return 'unavailable';
  if (cls.includes('available_')) return 'available';
  return 'not_set';
}

function csrfToken() {
  const meta = document.querySelector('meta[name=csrf-token]');
  return meta ? meta.content : '';
}

function unescapeJsString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc) => {
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return esc; // \' \" \\ \/ and anything else
    }
  });
}

function parseReplace(js) {
  const m = js.match(/\.replaceWith\('((?:[^'\\]|\\.)*)'\)/s);
  if (!m) return null;
  const html = unescapeJsString(m[1]);
  const doc = new DOMParser().parseFromString(`<table><tbody><tr>${html}</tr></tbody></table>`, 'text/html');
  const td = doc.querySelector('td');
  return td ? { cls: td.className, inner: td.innerHTML } : null;
}

const CELL_MARKUP = {
  not_set: '<small><i class="fa fa-square-o"></i></small>',
  unavailable: '<small><i class="fa fa-square-o"></i></small>',
  available: '<small><i class="fa fa-check-square-o"></i></small>',
};

const looksBroken = (cell) => !cell.querySelector('i, span, div, a') || /[<\\]/.test(cell.textContent);

function paintCell(cell, parsed) {
  cell.className = parsed.cls;
  cell.innerHTML = parsed.inner;
  if (looksBroken(cell)) cell.innerHTML = CELL_MARKUP[stateOfClass(cell.className)];
}

async function toggleCell(cell) {
  const token = csrfToken();
  const body = new URLSearchParams({ form_update_td_id: cell.dataset.timestamp, authenticity_token: token });
  const res = await fetch(TOGGLE_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': token,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/javascript, */*',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const parsed = parseReplace(await res.text());
  if (parsed) {
    // Mutate in place so the site's own click handler stays bound.
    paintCell(cell, parsed);
  } else {
    const next = CYCLE[(CYCLE.indexOf(stateOfClass(cell.className)) + 1) % CYCLE.length];
    cell.className = cell.className.replace(/not_set|not_available_no_bookings|available_no_bookings/, '');
    cell.classList.add(next === 'not_set' ? 'not_set' : next === 'available' ? 'available_no_bookings' : 'not_available_no_bookings');
    cell.innerHTML = CELL_MARKUP[next];
  }
}

async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ---------- grid model ---------- */

function readGrid() {
  const t = gridTable();
  if (!t) return null;
  const headers = [...t.querySelectorAll('thead th')].slice(1).map((th) => {
    // the th also holds a hidden dropdown with "Kernzeit ..." actions, so read the label only
    const small = th.querySelector('small');
    return (small ? small.textContent : th.innerText).trim().split('\n')[0].trim();
  });
  const cols = headers.map(() => []);
  t.querySelectorAll('tbody tr').forEach((tr) => {
    tr.querySelectorAll('td.timestampbutton').forEach((td, i) => {
      if (cols[i]) cols[i].push(td);
    });
  });
  return { t, headers, cols };
}

function findCellAtTime(col, hh, mm) {
  return col.find((td) => {
    const d = new Date(Number(td.dataset.timestamp) * 1000);
    return d.getHours() === hh && d.getMinutes() === mm;
  });
}

function blockCells(col, startTs, durationMin) {
  const end = startTs + durationMin * 60;
  return col.filter((td) => {
    const ts = Number(td.dataset.timestamp);
    return ts >= startTs && ts < end;
  });
}

/* ---------- writes ---------- */

function status(text, { undo = false } = {}) {
  const el = document.querySelector('#tah-status');
  if (!el) return;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  if (undo) {
    const btn = document.createElement('button');
    btn.className = 'tah-link';
    btn.textContent = 'Rückgängig';
    btn.addEventListener('click', undoLast);
    el.append(' ', btn);
  }
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('#tah-panel button, #tah-panel input').forEach((el) => {
    el.disabled = busy;
  });
}

async function applyToCells(cells, target, label) {
  if (state.busy) return;
  const clickable = cells.filter((c) => c.classList.contains('clickable'));
  const skipped = cells.length - clickable.length;
  if (!clickable.length) {
    status(skipped ? 'Keine bearbeitbaren Slots (Vergangenheit).' : 'Keine Slots gefunden.');
    return;
  }

  const changed = [];
  let done = 0;
  setBusy(true);
  status(`${label}: 0/${clickable.length} …`);

  try {
    await pool(clickable, CONCURRENCY, async (cell) => {
      const before = { ts: cell.dataset.timestamp, state: stateOfClass(cell.className) };
      if (before.state !== target) {
        let guard = 0;
        while (stateOfClass(cell.className) !== target && guard++ < 4) {
          await toggleCell(cell);
        }
        if (stateOfClass(cell.className) === target) changed.push(before);
      }
      done += 1;
      status(`${label}: ${done}/${clickable.length} …`);
    });
  } catch (err) {
    status(`Fehler: ${err.message}`);
    setBusy(false);
    return;
  }
  setBusy(false);
  refreshBlockView();

  if (!changed.length) {
    status(`${label}: bereits aktuell (${clickable.length} Slots).`);
    return;
  }

  state.undo = changed;
  clearTimeout(state.undoTimeout);
  state.undoTimeout = setTimeout(() => {
    state.undo = null;
    status(`${label}: ${changed.length} Slots geändert${skipped ? `, ${skipped} übersprungen` : ''}.`);
  }, 20000);

  status(`${label}: ${changed.length} Slots geändert${skipped ? `, ${skipped} übersprungen` : ''}.`, { undo: true });
}

async function undoLast() {
  if (!state.undo || state.busy) return;
  const changes = state.undo;
  state.undo = null;
  setBusy(true);
  status('Rückgängig …');
  try {
    await pool(changes, CONCURRENCY, async (change) => {
      const cell = document.getElementById(`avail_${change.ts}`);
      if (!cell) return;
      let guard = 0;
      while (stateOfClass(cell.className) !== change.state && guard++ < 4) {
        await toggleCell(cell);
      }
    });
    status(`Rückgängig: ${changes.length} Slots wiederhergestellt.`);
  } catch (err) {
    status(`Fehler beim Rückgängig: ${err.message}`);
  }
  setBusy(false);
  refreshBlockView();
}

/* ---------- actions ---------- */

function selectedColumns(grid) {
  return grid.cols.filter((_, i) => state.days[i]);
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

async function applyBlock(startTime, duration, target) {
  const grid = readGrid();
  if (!grid) return;
  const time = parseTime(startTime);
  if (!time) {
    status('Ungültige Startzeit.');
    return;
  }
  const cols = selectedColumns(grid);
  if (!cols.length) {
    status('Kein Tag ausgewählt.');
    return;
  }
  const cells = [];
  let missing = 0;
  for (const col of cols) {
    const start = findCellAtTime(col, time.hh, time.mm);
    if (!start) {
      missing += 1;
      continue;
    }
    cells.push(...blockCells(col, Number(start.dataset.timestamp), duration));
  }
  if (!cells.length) {
    status('Startzeit liegt außerhalb des Rasters.');
    return;
  }
  const label = `${startTime} + ${duration} Min`;
  if (missing && missing === cols.length) {
    status('Startzeit liegt außerhalb des Rasters.');
    return;
  }
  await applyToCells(cells, target, label);
}

function applyPreset(startTime) {
  const duration = Number(document.querySelector('#tah-duration')?.value) || state.settings.duration;
  applyBlock(startTime, duration, 'available');
}

function cellsBetween(a, b) {
  const grid = readGrid();
  if (!grid) return [];
  const rows = [...grid.t.querySelectorAll('tbody tr')];
  const iA = rows.indexOf(a.closest('tr'));
  const iB = rows.indexOf(b.closest('tr'));
  if (iA < 0 || iB < 0) return [];
  const [from, to] = iA <= iB ? [iA, iB] : [iB, iA];
  const colA = a.cellIndex - 1;
  const colB = b.cellIndex - 1;
  const [c0, c1] = colA <= colB ? [colA, colB] : [colB, colA];
  const cells = [];
  for (let c = c0; c <= c1; c++) {
    for (const td of grid.cols[c] || []) {
      const row = rows.indexOf(td.closest('tr'));
      if (row >= from && row <= to) cells.push(td);
    }
  }
  return cells;
}

function blockFromCell(cell) {
  const grid = readGrid();
  if (!grid) return [];
  const colIndex = cell.cellIndex - 1;
  const col = grid.cols[colIndex];
  if (!col) return [];
  const duration = Number(document.querySelector('#tah-duration')?.value) || state.settings.duration;
  return blockCells(col, Number(cell.dataset.timestamp), duration);
}

/* ---------- row visibility ---------- */

function minutesOf(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

function rowSpan(tr) {
  const cell = tr.querySelector('td.timestampbutton');
  if (cell) {
    const start = minutesOf(cell.dataset.timestamp);
    return { start, end: start + 5 };
  }
  const label = tr.querySelector('td')?.textContent || '';
  const m = label.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

function applyRowVisibility() {
  const t = gridTable();
  if (!t) return;
  const on = state.settings.hideOutside;
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;
  for (const tr of t.querySelectorAll('tbody tr')) {
    const span = rowSpan(tr);
    const outside = on && span && (span.end <= lo || span.start >= hi);
    tr.classList.toggle('tah-row-hidden', Boolean(outside));
  }
}

/* ---------- block view ---------- */

function addMinutes(hhmm, mins) {
  const t = parseTime(hhmm);
  if (!t) return '';
  const total = (t.hh * 60 + t.mm + mins) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function summarize(cells) {
  const active = cells.filter((c) => c.classList.contains('clickable'));
  if (!active.length) return { kind: 'past', counts: null, total: 0, booked: false };
  const counts = { available: 0, unavailable: 0, not_set: 0 };
  let booked = false;
  for (const c of active) {
    counts[stateOfClass(c.className)] += 1;
    if (c.className.includes('with_bookings')) booked = true;
  }
  const total = active.length;
  const kind =
    counts.available === total
      ? 'available'
      : counts.unavailable === total
        ? 'unavailable'
        : counts.not_set === total
          ? 'not_set'
          : 'mixed';
  return { kind, counts, total, booked };
}

function blockRows() {
  const grid = readGrid();
  if (!grid) return [];
  const duration = Number(document.querySelector('#tah-duration')?.value) || state.settings.duration;
  return state.settings.presets.map((time) => {
    const t = parseTime(time);
    const cells = grid.cols.map((col) => {
      const start = t && findCellAtTime(col, t.hh, t.mm);
      return start ? blockCells(col, Number(start.dataset.timestamp), duration) : [];
    });
    return { time, end: addMinutes(time, duration), cells };
  });
}

async function toggleBlock(cells, label, kind) {
  await applyToCells(cells, kind === 'available' ? 'not_set' : 'available', label);
  refreshBlockView();
}

function blockCellNode(cells, label) {
  const info = summarize(cells);
  const td = el('td', { class: `tah-block-cell tah-block-${info.kind}` });

  const icon = el('i', { class: `fa ${info.kind === 'available' ? 'fa-check-square-o' : 'fa-square-o'}` });
  td.append(icon);

  if (info.kind === 'mixed') td.append(el('small', { text: `${info.counts.available}/${info.total}` }));
  if (info.booked) td.append(el('i', { class: 'fa fa-fw fa-bookmark tah-block-booked' }));

  if (info.kind !== 'past') {
    td.title = `${label} · ${info.counts.available}/${info.total} verfügbar`;
    td.addEventListener('click', () => toggleBlock(cells, label, info.kind));
  }
  return td;
}

function renderBlockView() {
  const host = document.querySelector('#tah-block-view');
  const grid = readGrid();
  if (!host || !grid) return;

  const duration = Number(document.querySelector('#tah-duration')?.value) || state.settings.duration;
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;

  const table = el('table', { class: 'tah-block-table' });
  const headRow = el('tr');
  headRow.append(el('th', { class: 'tah-block-label', text: 'Block' }));
  for (const header of grid.headers) headRow.append(el('th', { text: header.replace(',', '') }));
  table.append(el('thead', {}, [headRow]));

  const tbody = el('tbody');
  for (const row of blockRows()) {
    const t = parseTime(row.time);
    const startMin = t ? t.hh * 60 + t.mm : 0;
    if (state.settings.hideOutside && (startMin + duration <= lo || startMin >= hi)) continue;
    const tr = el('tr');
    tr.append(el('th', { class: 'tah-block-label', text: `${row.time}–${row.end}` }));
    row.cells.forEach((cells, i) => {
      tr.append(blockCellNode(cells, `${row.time}–${row.end} ${grid.headers[i] || ''}`.trim()));
    });
    tbody.append(tr);
  }
  table.append(tbody);
  host.replaceChildren(table);
}

function refreshBlockView() {
  if (state.settings.view !== 'slots') renderBlockView();
}

function applyView() {
  const grid = readGrid();
  const host = document.querySelector('#tah-block-view');
  if (!grid || !host) return;
  const blocks = state.settings.view !== 'slots';
  grid.t.style.display = blocks ? 'none' : '';
  host.style.display = blocks ? '' : 'none';
  document.querySelectorAll('.tah-seg').forEach((btn) => {
    btn.classList.toggle('tah-seg-on', btn.dataset.view === (blocks ? 'blocks' : 'slots'));
  });
  if (blocks) renderBlockView();
}

/* ---------- UI ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function renderPresets() {
  const wrap = document.querySelector('#tah-presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const preset of state.settings.presets) {
    const btn = el('button', { class: 'tah-preset', type: 'button', text: preset, title: `${preset} · ${state.settings.duration} Min verfügbar` });
    btn.addEventListener('click', () => applyPreset(preset));
    wrap.append(btn);
  }
}

function renderDays(grid) {
  const wrap = document.querySelector('#tah-days');
  if (!wrap) return;
  wrap.innerHTML = '';
  grid.headers.forEach((header, i) => {
    const label = header.split(',')[0] || `Tag ${i + 1}`;
    const date = header.split(',')[1]?.trim() || '';
    const chip = el('button', { class: 'tah-day' + (state.days[i] ? ' tah-day-on' : ''), type: 'button', title: header });
    chip.append(el('span', { text: label }));
    if (date) chip.append(el('small', { text: date }));
    chip.addEventListener('click', () => {
      state.days[i] = !state.days[i];
      chip.classList.toggle('tah-day-on', state.days[i]);
    });
    wrap.append(chip);
  });
}

function buildPanel(grid) {
  const panel = el('div', { id: 'tah-panel' });

  const head = el('div', { class: 'tah-head' });
  head.append(el('strong', { text: 'Tour-Blöcke' }));
  head.append(el('span', { class: 'tah-sub', id: 'tah-sub', text: `Blöcke à ${state.settings.duration} Min` }));
  panel.append(head);

  const presetsRow = el('div', { class: 'tah-row' });
  presetsRow.append(el('span', { class: 'tah-label', text: 'Block ab' }));
  const presets = el('div', { id: 'tah-presets' });
  presetsRow.append(presets);
  panel.append(presetsRow);

  const customRow = el('div', { class: 'tah-row' });
  const startInput = el('input', { id: 'tah-start', type: 'time', step: '300', value: state.settings.presets[0] || '09:55', class: 'tah-input' });
  const durationInput = el('input', { id: 'tah-duration', type: 'number', min: '5', step: '5', value: String(state.settings.duration), class: 'tah-input tah-input-num' });
  durationInput.addEventListener('change', () => {
    const sub = document.querySelector('#tah-sub');
    if (sub) sub.textContent = `Blöcke à ${durationInput.value} Min`;
  });
  customRow.append(el('label', { class: 'tah-field' }, ['von', startInput]));
  customRow.append(el('label', { class: 'tah-field' }, ['Dauer', durationInput, 'Min']));
  const days = el('div', { id: 'tah-days', class: 'tah-days' });
  customRow.append(days);
  panel.append(customRow);

  const actions = el('div', { class: 'tah-row tah-actions' });
  const makeAction = (label, target, cls) => {
    const btn = el('button', { class: `tah-btn ${cls}`, type: 'button', text: label });
    btn.addEventListener('click', () => {
      const start = document.querySelector('#tah-start').value;
      const dur = Number(document.querySelector('#tah-duration').value) || state.settings.duration;
      applyBlock(start, dur, target);
    });
    return btn;
  };
  actions.append(makeAction('verfügbar', 'available', 'tah-yes'));
  actions.append(makeAction('nicht verfügbar', 'unavailable', 'tah-no'));
  actions.append(makeAction('zurücksetzen', 'not_set', 'tah-clear'));
  panel.append(actions);

  const viewRow = el('div', { class: 'tah-row' });
  viewRow.append(el('span', { class: 'tah-label', text: 'Ansicht' }));
  const segs = el('div', { class: 'tah-segs' });
  for (const [value, label] of [['blocks', 'Blöcke'], ['slots', '5 Min']]) {
    const seg = el('button', { class: `tah-seg${state.settings.view === value ? ' tah-seg-on' : ''}`, type: 'button', text: label, 'data-view': value });
    seg.addEventListener('click', async () => {
      state.settings.view = value;
      await chrome.storage.sync.set({ view: value });
      applyView();
    });
    segs.append(seg);
  }
  viewRow.append(segs);

  const hideLabel = el('label', { class: 'tah-field tah-toggle', title: 'Blendet die Zeiten außerhalb der Arbeitszeit aus' });
  const hideInput = el('input', { id: 'tah-hide', type: 'checkbox' });
  hideInput.checked = state.settings.hideOutside;
  hideInput.addEventListener('change', async () => {
    state.settings.hideOutside = hideInput.checked;
    await chrome.storage.sync.set({ hideOutside: hideInput.checked });
    applyRowVisibility();
    refreshBlockView();
  });
  hideLabel.append(hideInput, el('span', { id: 'tah-hide-label', text: `nur ${state.settings.dayFrom}–${state.settings.dayTo}` }));
  viewRow.append(hideLabel);
  panel.append(viewRow);

  panel.append(el('div', { class: 'tah-hint', text: 'Alt+Klick: Block ab Zelle · Shift+Klick: Bereich bis hierher (beides = verfügbar)' }));
  panel.append(el('div', { id: 'tah-status', class: 'tah-status' }));

  return panel;
}

function repairCells() {
  // Heals cells left with escaped markup by earlier versions of this extension.
  for (const cell of document.querySelectorAll('td.timestampbutton')) {
    if (/[<\\]/.test(cell.textContent)) cell.innerHTML = CELL_MARKUP[stateOfClass(cell.className)];
  }
}

function mountPanel() {
  if (document.querySelector('#tah-panel')) return;
  const grid = readGrid();
  if (!grid || !grid.t) return;

  repairCells();
  state.days = grid.headers.map(() => true);

  const panel = buildPanel(grid);
  const row = grid.t.closest('.row');
  if (row && row.parentElement) row.parentElement.insertBefore(panel, row);
  else grid.t.parentElement.insertBefore(panel, grid.t);

  const host = el('div', { id: 'tah-block-view' });
  grid.t.parentElement.insertBefore(host, grid.t);

  renderPresets();
  renderDays(grid);
  applyRowVisibility();
  applyView();
}

/* ---------- interaction on the grid ---------- */

function onGridClick(event) {
  const cell = event.target.closest('td.timestampbutton');
  if (!cell) return;

  if (event.shiftKey && state.anchor) {
    event.preventDefault();
    event.stopPropagation();
    const cells = cellsBetween(state.anchor, cell);
    state.anchor = null;
    applyToCells(cells, 'available', 'Bereich');
    return;
  }

  if (event.altKey && state.settings.altClickBlock) {
    event.preventDefault();
    event.stopPropagation();
    const cells = blockFromCell(cell);
    applyToCells(cells, 'available', `Block ab ${new Date(Number(cell.dataset.timestamp) * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
    return;
  }

  state.anchor = cell;
}

/* ---------- settings ---------- */

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state.settings = {
    duration: Number(stored.duration) || DEFAULTS.duration,
    presets: Array.isArray(stored.presets) && stored.presets.length ? stored.presets : DEFAULTS.presets,
    altClickBlock: stored.altClickBlock !== false,
    hideOutside: stored.hideOutside !== false,
    dayFrom: /^\d{1,2}:\d{2}$/.test(stored.dayFrom) ? stored.dayFrom : DEFAULTS.dayFrom,
    dayTo: /^\d{1,2}:\d{2}$/.test(stored.dayTo) ? stored.dayTo : DEFAULTS.dayTo,
    view: stored.view === 'slots' ? 'slots' : 'blocks',
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  loadSettings().then(() => {
    renderPresets();
    const dur = document.querySelector('#tah-duration');
    if (dur) dur.value = String(state.settings.duration);
    const sub = document.querySelector('#tah-sub');
    if (sub) sub.textContent = `Blöcke à ${state.settings.duration} Min`;
    const hide = document.querySelector('#tah-hide');
    if (hide) hide.checked = state.settings.hideOutside;
    const hideLabel = document.querySelector('#tah-hide-label');
    if (hideLabel) hideLabel.textContent = `nur ${state.settings.dayFrom}–${state.settings.dayTo}`;
    applyRowVisibility();
    applyView();
  });
});

/* ---------- boot ---------- */

(async function boot() {
  if (!gridTable()) return;
  await loadSettings();
  mountPanel();
  document.addEventListener('click', onGridClick, true);
})();
