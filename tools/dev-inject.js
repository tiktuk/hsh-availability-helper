// Dev harness: inject the content script + styles into the live page without
// loading the unpacked extension. Run through Playwright's `run_code_unsafe`.
// Storage writes are captured on `window.__tahLocal` / `window.__tahSync`, and
// runtime messages on `window.__tahMessages`, so a flow can be inspected
// without the extension installed.
async (page) => {
  await page.evaluate(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = {
      sync: {
        get: async (defaults) => ({ ...defaults, ...(window.__tahSync || {}) }),
        set: async (values) => {
          window.__tahSync = { ...(window.__tahSync || {}), ...values };
        },
      },
      local: {
        get: async () => ({ ...(window.__tahLocal || {}) }),
        set: async (values) => {
          window.__tahLocal = { ...(window.__tahLocal || {}), ...values };
        },
      },
      onChanged: { addListener: () => {} },
    };
    window.chrome.runtime = {
      sendMessage: (message, callback) => {
        window.__tahMessages = [...(window.__tahMessages || []), message];
        const reply = message?.type === 'tah-fetch-ical' ? { ok: true, text: window.__tahIcalText || '' } : { ok: true };
        if (callback) callback(reply);
        return Promise.resolve(reply);
      },
    };
  });
  await page.addStyleTag({ path: 'extension/content/content.css' });
  await page.addScriptTag({ path: 'extension/content/ical.js' });
  await page.addScriptTag({ path: 'extension/content/content.js' });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const panel = document.querySelector('#tah-panel');
    const invoice = document.querySelector('#tah-invoice-panel');
    return {
      mounted: Boolean(panel || invoice),
      presets: [...document.querySelectorAll('.tah-preset')].map((b) => b.textContent),
      days: [...document.querySelectorAll('.tah-day')].map((b) => b.innerText.replace(/\n/g, ' ')),
      panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
      parent: panel ? panel.parentElement.className : null,
      invoiceButton: document.querySelector('.tah-invoice-trigger')?.textContent.trim() || null,
      invoiceMonth: document.querySelector('#tah-invoice-month')?.value || null,
      events: [...document.querySelectorAll('.tah-day-head')].map((th) => th.title).filter(Boolean),
      conflicts: document.querySelectorAll('.tah-block-conflict').length,
      calendarBar: document.querySelector('.tah-cal-bar')?.textContent || null,
    };
  });
}
