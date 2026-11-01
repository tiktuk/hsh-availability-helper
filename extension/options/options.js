'use strict';

const DEFAULTS = {
  senderName: '',
  senderStreet: '',
  senderCity: '',
  taxNumber: '',
  recipientName: 'Stiftung Gedenkstätte Berlin-Höhenschönhausen',
  recipientStreet: 'Genslerstraße 66',
  recipientCity: '13055 Berlin',
  bankName: '',
  iban: '',
  bic: '',
  salutation: 'Sehr geehrte Damen und Herren,',
  intro: 'vielen Dank für Ihren Auftrag. Wie vereinbart stelle ich Ihnen folgende Leistung in Rechnung:',
  assurance:
    'dass für diese Leistungen ein weiteres Honorar von einer anderen Stelle weder erbeten noch gezahlt wurde\n' +
    'alle Steuern und Sozialabgaben, die sich aus den Gesamteinkünften dieser Abrechnung ergeben, von mir selbst getragen und abgeführt werden.',
  closing: 'Diese Rechnung ist auch ohne Unterschrift gültig.\nMit freundlichen Grüßen',
  invoiceStart: 1,
  invoicePrefix: '',
};

const FIELDS = [
  'senderName',
  'senderStreet',
  'senderCity',
  'taxNumber',
  'recipientName',
  'recipientStreet',
  'recipientCity',
  'bankName',
  'iban',
  'bic',
  'salutation',
  'intro',
  'assurance',
  'closing',
  'invoiceStart',
  'invoicePrefix',
];

const inputs = Object.fromEntries(FIELDS.map((id) => [id, document.querySelector(`#${id}`)]));
const signatureInput = document.querySelector('#signatureFile');
const signaturePreview = document.querySelector('#signaturePreview');
const signatureRemove = document.querySelector('#signatureRemove');
const saved = document.querySelector('#saved');

function flash(text) {
  saved.textContent = text;
  setTimeout(() => {
    saved.textContent = '';
  }, 1500);
}

function showSignature(src) {
  signaturePreview.hidden = !src;
  signatureRemove.hidden = !src;
  if (src) signaturePreview.src = src;
  else signaturePreview.removeAttribute('src');
}

// A signature scan is far bigger than it needs to be on paper; 800 px wide is
// plenty and keeps it out of the storage quota's way.
function shrinkToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Das ist kein Bild.'));
      img.onload = () => {
        const scale = Math.min(1, 800 / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const id of FIELDS) {
    const value = stored[id] ?? DEFAULTS[id];
    inputs[id].value = id === 'invoiceStart' ? String(value) : value;
  }
  const { signature = '' } = await chrome.storage.local.get({ signature: '' });
  showSignature(signature);
}

async function save() {
  const values = {};
  for (const id of FIELDS) {
    const input = inputs[id];
    values[id] = id === 'invoiceStart' ? Math.max(1, Number(input.value) || DEFAULTS.invoiceStart) : input.value.trim();
  }
  await chrome.storage.sync.set(values);
  flash('Gespeichert.');
}

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#reset').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  await chrome.storage.local.remove('signature');
  await load();
  flash('Zurückgesetzt.');
});

signatureInput.addEventListener('change', async () => {
  const file = signatureInput.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await shrinkToDataUrl(file);
    await chrome.storage.local.set({ signature: dataUrl });
    showSignature(dataUrl);
    flash('Unterschrift gespeichert.');
  } catch (err) {
    flash(`Fehler: ${err.message}`);
  } finally {
    signatureInput.value = '';
  }
});

signatureRemove.addEventListener('click', async () => {
  await chrome.storage.local.remove('signature');
  showSignature('');
  flash('Unterschrift entfernt.');
});

load();
