'use strict';

// The content script cannot open a chrome-extension:// page itself, so it asks
// the worker to put the invoice in a new tab. Opening it in the sender's window
// and in front matters: without a windowId Chrome uses whichever window is
// focused, and the tab then appears somewhere the user is not looking.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'tah-open-invoice') return;

  const options = { url: chrome.runtime.getURL('invoice/invoice.html'), active: true };
  if (sender.tab && sender.tab.windowId !== undefined) options.windowId = sender.tab.windowId;

  chrome.tabs.create(options).then(
    (tab) => sendResponse({ ok: true, tabId: tab.id }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true;
});
