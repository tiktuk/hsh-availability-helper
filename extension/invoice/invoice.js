'use strict';

const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const $ = (id) => document.getElementById(id);

function formatDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderRows(invoice) {
  const body = $('rows');
  body.replaceChildren();
  for (const row of invoice.rows) {
    const customer = cell(row.customer, 'col-customer');
    if (row.cancelled) {
      const tag = document.createElement('small');
      tag.className = 'tag';
      tag.textContent = row.fee || 'storniert';
      customer.append(tag);
    }
    const tr = document.createElement('tr');
    tr.append(
      customer,
      cell(formatDate(row.date), 'col-date'),
      cell(row.time, 'col-time'),
      cell(row.duration ? `${row.duration} Min` : '–', 'col-duration'),
      cell(row.id, 'col-id'),
      cell(money.format(row.price), 'col-amount')
    );
    body.append(tr);
  }
}

async function saveNumber(invoice, value) {
  const stored = await chrome.storage.sync.get({ invoiceNumbers: {} });
  const invoiceNumbers = { ...(stored.invoiceNumbers || {}), [invoice.month]: value };
  await chrome.storage.sync.set({ invoiceNumbers });
  invoice.number = value;
  await chrome.storage.local.set({ invoice });
  document.title = `Rechnung ${value} – ${invoice.monthLabel}`;
}

function render(invoice) {
  document.title = `Rechnung ${invoice.number} – ${invoice.monthLabel}`;
  $('period').textContent = `${invoice.monthLabel} · ${invoice.rows.length} Einsätze`;
  $('issued').textContent = formatTimestamp(invoice.createdAt);
  $('guide').textContent = invoice.guide || '–';
  $('total').textContent = money.format(invoice.total);
  $('empty').hidden = true;

  const number = $('number');
  number.value = invoice.number;
  number.addEventListener('change', () => {
    const value = number.value.trim();
    if (!value) {
      number.value = invoice.number;
      return;
    }
    saveNumber(invoice, value);
  });

  renderRows(invoice);
}

async function load() {
  const { invoice } = await chrome.storage.local.get('invoice');
  if (!invoice || !Array.isArray(invoice.rows)) {
    document.querySelector('.meta').hidden = true;
    document.querySelector('table.rows').hidden = true;
    $('note').hidden = true;
    $('empty').hidden = false;
    return;
  }
  render(invoice);
}

$('print').addEventListener('click', () => window.print());
load();
