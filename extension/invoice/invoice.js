'use strict';

const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const $ = (id) => document.getElementById(id);

// Same keys as options/options.js – the letter is drawn from the settings, the
// rows come from the payload the calendar page wrote.
const DEFAULTS = {
  senderName: '',
  senderStreet: '',
  senderCity: '',
  taxNumber: '',
  recipientName: '',
  recipientStreet: '',
  recipientCity: '',
  bankName: '',
  iban: '',
  bic: '',
  salutation: 'Sehr geehrte Damen und Herren,',
  intro: 'vielen Dank für Ihren Auftrag. Wie vereinbart stelle ich Ihnen folgende Leistung in Rechnung:',
  assurance:
    'dass für diese Leistungen ein weiteres Honorar von einer anderen Stelle weder erbeten noch gezahlt wurde\n' +
    'alle Steuern und Sozialabgaben, die sich aus den Gesamteinkünften dieser Abrechnung ergeben, von mir selbst getragen und abgeführt werden.',
  closing: 'Diese Rechnung ist auch ohne Unterschrift gültig.\nMit freundlichen Grüßen',
};

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function endTime(time, duration) {
  if (!time || !duration) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const total = hours * 60 + minutes + duration;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
      cell(row.id, 'col-id'),
      cell(formatDate(row.date), 'col-date'),
      cell(row.time, 'col-time'),
      cell(endTime(row.time, row.duration), 'col-time'),
      cell(row.tour, 'col-tour'),
      customer,
      cell(money.format(row.price), 'col-amount')
    );
    body.append(tr);
  }
}

function renderLetter(invoice, settings, signature) {
  const sender = [settings.senderName || invoice.guide, settings.senderStreet, settings.senderCity].filter(Boolean);
  $('sender').textContent = sender.join('\n');
  $('sender').hidden = !sender.length;
  // Nothing is prefilled, so an unconfigured invoice says what is missing instead
  // of printing a letter without a sender or a recipient.
  $('warn').hidden = Boolean(settings.senderName && settings.recipientName);

  const recipient = [settings.recipientName, settings.recipientStreet, settings.recipientCity].filter(Boolean);
  $('recipient').textContent = recipient.join('\n');
  $('recipient').hidden = !recipient.length;

  $('subject').textContent = `Honorar für ${invoice.monthLabel}`;

  $('tax').textContent = settings.taxNumber ? `Steuernummer: ${settings.taxNumber}` : '';
  $('tax').hidden = !settings.taxNumber;

  $('salutation').textContent = settings.salutation;
  $('salutation').hidden = !settings.salutation;

  $('intro').textContent = settings.intro;
  $('intro').hidden = !settings.intro;

  const assurance = lines(settings.assurance);
  $('assuranceLead').hidden = !assurance.length;
  $('assurance').hidden = !assurance.length;
  $('assurance').replaceChildren(
    ...assurance.map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    })
  );

  const bank = [
    ['Name der Bank', settings.bankName],
    ['IBAN', settings.iban],
    ['BIC', settings.bic],
  ].filter(([, value]) => value);
  $('bankLead').hidden = !bank.length;
  $('bank').hidden = !bank.length;
  $('bank').replaceChildren(
    ...bank.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = `${label}:`;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    })
  );

  $('closing').textContent = settings.closing;
  $('closing').hidden = !settings.closing;

  const img = $('signature');
  img.hidden = !signature;
  if (signature) img.src = signature;
  else img.removeAttribute('src');
}

async function saveNumber(invoice, value) {
  const stored = await chrome.storage.sync.get({ invoiceNumbers: {} });
  const invoiceNumbers = { ...(stored.invoiceNumbers || {}), [invoice.month]: value };
  await chrome.storage.sync.set({ invoiceNumbers });
  invoice.number = value;
  await chrome.storage.local.set({ invoice });
  document.title = `Rechnung ${value} – ${invoice.monthLabel}`;
}

function render(invoice, settings, signature) {
  document.title = `Rechnung ${invoice.number} – ${invoice.monthLabel}`;
  $('letter').hidden = false;
  $('services').hidden = false;
  $('empty').hidden = true;
  $('servicesHead').textContent = `${invoice.monthLabel} · ${invoice.rows.length} ${invoice.rows.length === 1 ? 'Einsatz' : 'Einsätze'}`;
  $('total').textContent = money.format(invoice.total);

  renderLetter(invoice, settings, signature);
  renderRows(invoice);

  const number = $('number');
  number.value = invoice.number;
  number.style.width = `calc(${Math.max(5, invoice.number.length)}ch + 6px)`;
  number.addEventListener('change', () => {
    const value = number.value.trim();
    if (!value) {
      number.value = invoice.number;
      return;
    }
    saveNumber(invoice, value);
    number.style.width = `calc(${Math.max(5, value.length)}ch + 6px)`;
  });
}

async function load() {
  const [settings, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ invoice: null, signature: '' }),
  ]);
  const invoice = local.invoice;
  if (!invoice || !Array.isArray(invoice.rows)) {
    $('letter').hidden = true;
    $('services').hidden = true;
    $('warn').hidden = true;
    $('empty').hidden = false;
    document.querySelector('.actions').hidden = true;
    return;
  }
  render(invoice, settings, local.signature || '');
}

$('print').addEventListener('click', () => window.print());
load();
