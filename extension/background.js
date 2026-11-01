'use strict';

// The content script runs in the page's origin, so a calendar feed on another
// host would be a cross-origin request from hsh.gomus.de and die on CORS. A
// service-worker fetch is not subject to CORS once the host permission is
// granted, which is the whole reason this round trip exists.
const FEED_HINT = 'Kein Zugriff auf den Kalender. Bitte die iCal-Adresse in den Einstellungen erneut speichern.';

async function fetchFeed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Ungültige Kalender-Adresse.' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'Nur http(s)-Adressen lassen sich laden.' };

  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `Der Kalender antwortet mit HTTP ${res.status}.` };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false, error: FEED_HINT };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tah-fetch-ical') {
    fetchFeed(String(message.url || '')).then(sendResponse);
    return true;
  }

  if (message?.type !== 'tah-open-invoice') return;

  // The content script cannot open a chrome-extension:// page itself, so it asks
  // the worker to put the invoice in a new tab. Opening it in the sender's window
  // and in front matters: without a windowId Chrome uses whichever window is
  // focused, and the tab then appears somewhere the user is not looking.
  const options = { url: chrome.runtime.getURL('invoice/invoice.html'), active: true };
  if (sender.tab && sender.tab.windowId !== undefined) options.windowId = sender.tab.windowId;

  chrome.tabs.create(options).then(
    (tab) => sendResponse({ ok: true, tabId: tab.id }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true;
});
