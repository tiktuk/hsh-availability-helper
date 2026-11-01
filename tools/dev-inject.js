// Dev harness: inject the content script + styles into the live page without
// loading the unpacked extension. Run through Playwright's `run_code_unsafe`.
async (page) => {
  await page.evaluate(() => {
    window.chrome = window.chrome || {};
    window.chrome.storage = {
      sync: {
        get: async (defaults) => ({ ...defaults }),
        set: async () => {},
      },
      onChanged: { addListener: () => {} },
    };
  });
  await page.addStyleTag({ path: 'extension/content/content.css' });
  await page.addScriptTag({ path: 'extension/content/content.js' });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const panel = document.querySelector('#tah-panel');
    return {
      mounted: Boolean(panel),
      presets: [...document.querySelectorAll('.tah-preset')].map((b) => b.textContent),
      days: [...document.querySelectorAll('.tah-day')].map((b) => b.innerText.replace(/\n/g, ' ')),
      panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
      parent: panel ? panel.parentElement.className : null,
    };
  });
}
