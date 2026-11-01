'use strict';

// The content script cannot open a chrome-extension:// page itself, so it asks
// the worker to put the invoice in a new tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'tah-open-invoice') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('invoice/invoice.html') }).then(
    (tab) => sendResponse({ ok: true, tabId: tab.id }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true;
});
