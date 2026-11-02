'use strict';

const DEFAULTS = {
  duration: 90,
  presets: ['09:55', '10:55', '11:55', '12:55', '13:55', '14:55', '16:35'],
  altClickBlock: true,
  hideOutside: true,
  weekdaysOnly: true,
  navLabels: true,
  dayFrom: '09:55',
  dayTo: '18:30',
};

const durationInput = document.querySelector('#duration');
const presetsInput = document.querySelector('#presets');
const altClickInput = document.querySelector('#altClick');
const hideOutsideInput = document.querySelector('#hideOutside');
const dayFromInput = document.querySelector('#dayFrom');
const dayToInput = document.querySelector('#dayTo');
const navLabelsInput = document.querySelector('#navLabels');
const saved = document.querySelector('#saved');

function parsePresets(value) {
  const list = value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => {
      const [hh, mm] = s.split(':');
      return `${hh.padStart(2, '0')}:${mm}`;
    });
  return [...new Set(list)].sort();
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  durationInput.value = String(stored.duration);
  presetsInput.value = (stored.presets || DEFAULTS.presets).join(', ');
  altClickInput.checked = stored.altClickBlock !== false;
  hideOutsideInput.checked = stored.hideOutside !== false;
  dayFromInput.value = stored.dayFrom || DEFAULTS.dayFrom;
  dayToInput.value = stored.dayTo || DEFAULTS.dayTo;
  navLabelsInput.checked = stored.navLabels !== false;
}

async function save() {
  const presets = parsePresets(presetsInput.value);
  await chrome.storage.sync.set({
    duration: Math.max(5, Number(durationInput.value) || DEFAULTS.duration),
    presets: presets.length ? presets : DEFAULTS.presets,
    altClickBlock: altClickInput.checked,
    hideOutside: hideOutsideInput.checked,
    dayFrom: dayFromInput.value || DEFAULTS.dayFrom,
    dayTo: dayToInput.value || DEFAULTS.dayTo,
    navLabels: navLabelsInput.checked,
  });
  saved.textContent = 'Gespeichert.';
  setTimeout(() => {
    saved.textContent = '';
  }, 1500);
}

document.querySelector('#save').addEventListener('click', save);
document.querySelector('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelector('#reset').addEventListener('click', async () => {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  saved.textContent = 'Zurückgesetzt.';
});

load();
