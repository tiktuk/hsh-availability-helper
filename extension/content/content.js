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
  invoiceStart: 1,
  invoicePrefix: '',
};

const state = {
  settings: { ...DEFAULTS },
  anchor: null,
  busy: false,
  undo: null,
  undoTimeout: null,
  days: [], // booleans per visible column
  invoicePreview: null,
  invoiceToken: 0,
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

function dayCells(col) {
  const from = parseTime(state.settings.dayFrom);
  const to = parseTime(state.settings.dayTo);
  const lo = from ? from.hh * 60 + from.mm : 0;
  const hi = to ? to.hh * 60 + to.mm : 24 * 60;
  return col.filter((td) => {
    const m = minutesOf(td.dataset.timestamp);
    return m >= lo && m < hi;
  });
}

function dayHeadNode(col, header) {
  const th = el('th', { class: 'tah-day-head' });
  th.append(el('span', { class: 'tah-day-name', text: header.replace(',', '') }));

  const cells = dayCells(col);
  const info = summarize(cells);
  const range = `${state.settings.dayFrom}–${state.settings.dayTo}`;
  const tools = el('div', { class: 'tah-day-tools' });

  const make = (kind, icon, title) => {
    const btn = el('button', {
      class: `tah-daybtn${info.kind === kind ? ' tah-daybtn-on' : ''} tah-daybtn-${kind}`,
      type: 'button',
      title: `${header.replace(',', '')}: ${range} ${title}`,
    });
    btn.append(el('i', { class: `fa ${icon}` }));
    btn.addEventListener('click', () =>
      applyToCells(cells, info.kind === kind ? 'not_set' : kind, `${header.replace(',', '')} ${range} ${title}`)
    );
    return btn;
  };

  tools.append(make('available', 'fa-check', 'verfügbar'));
  tools.append(make('unavailable', 'fa-times', 'nicht verfügbar'));
  th.append(tools);
  return th;
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
  grid.headers.forEach((header, i) => headRow.append(dayHeadNode(grid.cols[i], header)));
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
    invoiceStart: Math.max(1, Number(stored.invoiceStart) || DEFAULTS.invoiceStart),
    invoicePrefix: typeof stored.invoicePrefix === 'string' ? stored.invoicePrefix : DEFAULTS.invoicePrefix,
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

/* ---------- invoice ---------- */

const BOOKINGS_URL = '/guide/bookings';
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function parseGermanDate(text) {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+)\.?\s*(\d{4})/.exec(text || '');
  const month = m ? MONTH_NAMES.indexOf(m[2]) : -1;
  return month < 0 ? null : { day: Number(m[1]), month, year: Number(m[3]) };
}

function parseMonthLabel(text) {
  const m = /([A-Za-zÄÖÜäöüß]+)\s+(\d{4})/.exec(text || '');
  const month = m ? MONTH_NAMES.indexOf(m[1]) : -1;
  return month < 0 ? null : `${m[2]}-${String(month + 1).padStart(2, '0')}`;
}

// The site prints German prices ("97,50 €"); a comma means the dot is a thousands separator.
function parseMoney(text) {
  const raw = String(text).replace(/[^\d.,-]/g, '');
  if (!raw) return 0;
  return Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw) || 0;
}

function guideName() {
  const node = document.querySelector('.profile-element .font-bold, .profile-element strong');
  return node ? node.textContent.trim() : '';
}

function currencySymbol() {
  return document.body.dataset.currencysymbol || '€';
}

function calendarBox() {
  return [...document.querySelectorAll('.ibox')].find((box) => /Buchungskalender/.test(box.querySelector('.ibox-title')?.textContent || ''));
}

function calendarMonth() {
  const legend = calendarBox()?.querySelector('legend');
  const fromLegend = parseMonthLabel(legend?.textContent);
  if (fromLegend) return fromLegend;
  const startAt = new URLSearchParams(location.search).get('start_at');
  return startAt && /^\d{4}-\d{2}/.test(startAt) ? startAt.slice(0, 7) : monthKey(new Date());
}

function parseBookingRow(tr, group, month) {
  const cells = [...tr.children];
  const info = cells.find((td) => /Datum:/.test(td.textContent));
  if (!info) return null;
  const text = info.textContent.replace(/\s+/g, ' ');
  const when = /Datum:\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+),?\s*(\d{1,2}):(\d{2})\s*Uhr/.exec(text);
  if (!when) return null;
  const monthIndex = MONTH_NAMES.indexOf(when[2]);
  const id = (tr.id.match(/\d+/) || [])[0];
  if (!id || monthIndex < 0) return null;
  const duration = /Dauer:\s*(\d+)\s*Minuten/.exec(text);
  const year = group ? group.year : Number(month.slice(0, 4));
  return {
    id,
    tour: (cells[2]?.querySelector('strong')?.textContent || '').trim(),
    date: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(when[1])).padStart(2, '0')}`,
    time: `${when[3].padStart(2, '0')}:${when[4]}`,
    duration: duration ? Number(duration[1]) : null,
    customer: '',
    price: 0,
  };
}

async function fetchMonthBookings(month) {
  const query = new URLSearchParams({
    start_at: `${month}-01`,
    end_at: `${addMonths(month, 1)}-01`,
    per_page: '200',
  });
  query.append('status[]', '20'); // Gebucht
  // E-Mail wird versendet, Unbestätigt, Bestätigt, E-Mail-Versand fehlgeschlagen:
  // past shifts belong on the invoice even when the guide never confirmed them.
  for (const status of ['11', '15', '20', '500']) query.append('guide_status_types[]', status);

  const res = await fetch(`${BOOKINGS_URL}?${query}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Buchungsliste: HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

  const rows = [];
  let group = null;
  for (const tr of doc.querySelectorAll('table tr')) {
    if (tr.classList.contains('sticky-top')) {
      group = parseGermanDate(tr.textContent);
      continue;
    }
    if (!tr.classList.contains('booking-list-item')) continue;
    const row = parseBookingRow(tr, group, month);
    if (row) rows.push(row);
  }
  return rows;
}

async function enrichBooking(row) {
  const res = await fetch(`${BOOKINGS_URL}/${row.id}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Buchung ${row.id}: HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const box = (name) => [...doc.querySelectorAll('.ibox')].find((node) => new RegExp(name).test(node.querySelector('.ibox-title')?.textContent || ''));
  const kunde = box('Kundendaten');
  const abrechnung = box('Abrechnung');
  const hinweise = box('Hinweise');

  const customer = (kunde?.querySelector('dd')?.textContent || '').replace(/\s+/g, ' ').trim();
  // The comment block holds more than the group name ("Alternative language: …"),
  // so keep only the Gruppenbezeichnung line.
  const commentText = hinweise?.querySelector('.booking-comment')?.textContent || '';
  const comment = (/Gruppenbezeichnung:\s*([^\n]+)/.exec(commentText) || [])[1]?.trim() || '';

  row.price = abrechnung ? [...abrechnung.querySelectorAll('td.price')].reduce((sum, td) => sum + parseMoney(td.textContent), 0) : 0;
  row.customer = customer || comment || row.tour || `Buchung ${row.id}`;
  return row;
}

async function invoiceNumberState() {
  const stored = await chrome.storage.sync.get({ invoiceNumbers: {}, invoiceStart: DEFAULTS.invoiceStart, invoicePrefix: DEFAULTS.invoicePrefix });
  const numbers = stored.invoiceNumbers || {};
  // Only the trailing digits count: prefixes may contain digits of their own ("RE-2026-100").
  const trailing = (value) => Number((/(\d+)\s*$/.exec(String(value)) || [])[1]) || 0;
  const highest = Object.values(numbers).reduce((max, value) => Math.max(max, trailing(value)), 0);
  const next = `${stored.invoicePrefix || ''}${String(Math.max(Number(stored.invoiceStart) || 1, highest + 1)).padStart(3, '0')}`;
  return { numbers, next };
}

// The preview shows the number the month would get, so it must not claim one.
async function peekInvoiceNumber(month) {
  const { numbers, next } = await invoiceNumberState();
  return numbers[month] || next;
}

async function assignInvoiceNumber(month) {
  const { numbers, next } = await invoiceNumberState();
  if (numbers[month]) return numbers[month];
  await chrome.storage.sync.set({ invoiceNumbers: { ...numbers, [month]: next } });
  return next;
}

function formatMoney(value) {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencySymbol()}`;
}

function openInvoicePage() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'tah-open-invoice' }, (reply) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!reply || !reply.ok) reject(new Error((reply && reply.error) || 'Tab konnte nicht geöffnet werden.'));
        else resolve(reply);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function loadInvoiceRows(month) {
  const rows = await fetchMonthBookings(month);
  await pool(rows, CONCURRENCY, enrichBooking);
  rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return rows;
}

function setGenerateEnabled(enabled) {
  const go = document.querySelector('#tah-invoice-go');
  if (go) go.disabled = !enabled;
}

async function previewInvoice(month) {
  const token = ++state.invoiceToken;
  state.invoicePreview = null;
  renderInvoicePreview();
  setGenerateEnabled(false);
  invoiceStatus('Lade Buchungen …');
  try {
    const rows = await loadInvoiceRows(month);
    const number = await peekInvoiceNumber(month);
    if (token !== state.invoiceToken) return;
    state.invoicePreview = rows.length
      ? { month, rows, total: rows.reduce((sum, row) => sum + row.price, 0), number }
      : null;
    renderInvoicePreview();
    setGenerateEnabled(rows.length > 0);
    invoiceStatus(rows.length ? '' : `${monthLabel(month)}: keine Buchungen – es gibt nichts zu berechnen.`);
  } catch (err) {
    if (token !== state.invoiceToken) return;
    setGenerateEnabled(true);
    invoiceStatus(`Fehler: ${err.message}`, { error: true });
  }
}

function renderInvoicePreview() {
  const box = document.querySelector('#tah-invoice-preview');
  if (!box) return;
  const preview = state.invoicePreview;
  box.hidden = !preview;
  if (!preview) return;

  const stat = (value, label) => {
    const node = el('span', { class: 'tah-invoice-stat' });
    node.append(el('strong', { text: value }), el('small', { text: label }));
    return node;
  };
  box.replaceChildren(
    stat(String(preview.rows.length), preview.rows.length === 1 ? 'Einsatz' : 'Einsätze'),
    stat(formatMoney(preview.total), 'Summe'),
    stat(preview.number, 'Rechnungsnummer')
  );
}

async function createInvoice(month) {
  // Reuse what the preview just loaded, so the invoice matches what was on screen.
  const preview = state.invoicePreview?.month === month ? state.invoicePreview : null;
  const rows = preview ? preview.rows : await loadInvoiceRows(month);
  if (!rows.length) throw new Error(`${monthLabel(month)}: keine Buchungen – es gibt nichts zu berechnen.`);

  const invoice = {
    month,
    monthLabel: monthLabel(month),
    number: await assignInvoiceNumber(month),
    guide: guideName(),
    currency: currencySymbol(),
    rows,
    total: rows.reduce((sum, row) => sum + row.price, 0),
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({ invoice });
  await openInvoicePage();
  return invoice;
}

function invoiceStatus(text, { error = false } = {}) {
  const node = document.querySelector('#tah-invoice-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('tah-error', error);
}

let invoiceTimer = null;

function scheduleInvoicePreview(delay = 350) {
  clearTimeout(invoiceTimer);
  const month = document.querySelector('#tah-invoice-month');
  if (!month) return;
  const value = month.value;
  if (!/^\d{4}-\d{2}$/.test(value)) {
    state.invoiceToken += 1;
    state.invoicePreview = null;
    renderInvoicePreview();
    setGenerateEnabled(false);
    invoiceStatus('');
    return;
  }
  invoiceTimer = setTimeout(() => previewInvoice(value), delay);
}

function toggleInvoicePanel(open) {
  const panel = document.querySelector('#tah-invoice-panel');
  if (!panel) return false;
  panel.classList.toggle('tah-open', open);
  if (!open) {
    clearTimeout(invoiceTimer);
    state.invoiceToken += 1;
    return false;
  }
  document.querySelector('#tah-invoice-month').value = calendarMonth();
  invoiceStatus('');
  scheduleInvoicePreview(0);
  return true;
}

function mountInvoice() {
  if (document.querySelector('#tah-invoice-panel')) return;
  const box = calendarBox();
  const title = box?.querySelector('.ibox-title');
  if (!title) return;

  const group = el('div', { class: 'btn-group nobr' });
  const trigger = el('button', { class: 'btn btn-default btn-xs tah-invoice-trigger', type: 'button', title: 'Monatsrechnung erstellen (Alt+R)' });
  trigger.append(el('i', { class: 'fa fa-fw fa-file-text-o' }), el('span', { class: 'hidden-xs', text: ' Rechnung' }));
  group.append(trigger);
  (title.querySelector('.pull-right') || title).append(group);

  const panel = el('div', { id: 'tah-invoice-panel' });
  const month = el('input', { id: 'tah-invoice-month', type: 'month', class: 'tah-input' });
  const go = el('button', { id: 'tah-invoice-go', class: 'tah-btn', type: 'button', text: 'Rechnung erstellen' });
  const label = el('label', {}, ['Monat', month]);
  const previewBox = el('div', { id: 'tah-invoice-preview', class: 'tah-invoice-preview' });
  previewBox.hidden = true;
  panel.append(label, go, el('span', { id: 'tah-invoice-status', class: 'tah-invoice-status' }));
  panel.append(previewBox);
  panel.append(el('div', { class: 'tah-hint', text: 'Alle gebuchten Einsätze des Monats, auch vergangene und unbestätigte. Alt+R zeigt die Vorschau, nochmal Alt+R erstellt die Rechnung.' }));
  title.append(panel);

  month.addEventListener('input', () => scheduleInvoicePreview());
  month.addEventListener('change', () => scheduleInvoicePreview());
  trigger.addEventListener('click', () => toggleInvoicePanel(!panel.classList.contains('tah-open')));

  go.addEventListener('click', async () => {
    const value = month.value;
    if (!/^\d{4}-\d{2}$/.test(value)) {
      invoiceStatus('Bitte einen Monat wählen.', { error: true });
      return;
    }
    go.disabled = true;
    if (state.invoicePreview?.month !== value) invoiceStatus('Lade Buchungen …');
    try {
      const invoice = await createInvoice(value);
      invoiceStatus(`Rechnung ${invoice.number} geöffnet.`);
    } catch (err) {
      invoiceStatus(`Fehler: ${err.message}`, { error: true });
    }
    go.disabled = false;
  });
}

/* ---------- shortcuts ---------- */

function navLinks() {
  const nav = document.querySelector('nav[role=navigation]');
  return nav ? [...nav.querySelectorAll('ul.nav > li > a[href]')].slice(0, 9) : [];
}

function annotateNav() {
  navLinks().forEach((link, i) => {
    if (link.dataset.tahShortcut) return;
    link.dataset.tahShortcut = `Alt+${i + 1}`;
    link.title = link.title ? `${link.title} (${link.dataset.tahShortcut})` : link.dataset.tahShortcut;
  });
}

// The month arrows are plain links to ?start_at=<month>; the month they point at
// is the only reliable way to tell previous from next (their labels are tooltips).
// Match exactly ±1: the middle "aktueller Monat" link points at today's month,
// not the one on screen, so a < / > comparison can pick the wrong arrow.
function calendarNavLinks() {
  const box = calendarBox();
  if (!box) return {};
  const current = calendarMonth();
  const links = [...box.querySelectorAll('.ibox-title a[href]')]
    .map((link) => ({ link, month: (new URL(link.href).searchParams.get('start_at') || '').slice(0, 7) }))
    .filter((entry) => /^\d{4}-\d{2}$/.test(entry.month));
  return {
    previous: links.find((entry) => entry.month === addMonths(current, -1))?.link,
    next: links.find((entry) => entry.month === addMonths(current, 1))?.link,
  };
}

// First Alt+R opens the panel with the preview, a second one bills the month —
// the same two steps as looking at the numbers and pressing the button.
function invoiceShortcut() {
  const panel = document.querySelector('#tah-invoice-panel');
  if (!panel) return false;

  if (!panel.classList.contains('tah-open')) {
    toggleInvoicePanel(true);
    return true;
  }

  const go = document.querySelector('#tah-invoice-go');
  const month = document.querySelector('#tah-invoice-month')?.value;
  if (go && !go.disabled && state.invoicePreview?.month === month) go.click();
  else scheduleInvoicePreview(0);
  return true;
}

// Alt+1…9 follow the site's own sidebar order, Alt+R opens the invoice panel,
// Alt+P / Alt+N walk the calendar month by month.
function onShortcutKey(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;

  if (event.code === 'KeyR') {
    if (invoiceShortcut()) event.preventDefault();
    return;
  }

  if (event.code === 'KeyP' || event.code === 'KeyN') {
    const { previous, next } = calendarNavLinks();
    const link = event.code === 'KeyP' ? previous : next;
    if (!link) return;
    event.preventDefault();
    link.click();
    return;
  }

  const digit = /^Digit([1-9])$/.exec(event.code);
  if (!digit) return;
  const link = navLinks()[Number(digit[1]) - 1];
  if (!link) return;
  event.preventDefault();
  link.click();
}

function installShortcuts() {
  annotateNav();
  document.addEventListener('keydown', onShortcutKey, true);
}

/* ---------- boot ---------- */

(async function boot() {
  await loadSettings();
  installShortcuts();
  if (gridTable()) {
    mountPanel();
    document.addEventListener('click', onGridClick, true);
  }
  mountInvoice();
})();
