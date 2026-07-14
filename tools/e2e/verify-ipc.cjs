// Quick test to verify IPC handler exists and works
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages = [];
  for (const ctx of contexts) pages.push(...ctx.pages());
  const page = pages.find((p) => p.url().includes('localhost'));

  console.log('Testing IPC handler...');
  const result = await page.evaluate(async () => {
    try {
      const ipc = window.electronIPC || require('electron').ipcRenderer;
      const r = await ipc.invoke('config:fetchRemote', 'https://d.kstore.dev/download/12441/dc6.json');
      return {
        ok: r.ok,
        status: r.status,
        contentType: r.contentType,
        bodyLength: r.bodyBase64 ? r.bodyBase64.length : 0,
        error: r.error,
        bodyPreview: r.bodyBase64 ? atob(r.bodyBase64).substring(0, 200) : '',
      };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('IPC result:', JSON.stringify(result, null, 2));

  console.log('\nTesting ConfigParser.load...');
  const loadResult = await page.evaluate(async () => {
    try {
      const { configParser } = await import('/src/core/ConfigParser.ts');
      // Check if my new functions exist by checking the source
      const src = configParser.constructor.toString();
      const hasLenient = src.includes('lenientJsonParse');
      console.log('ConfigParser source preview:', src.substring(0, 200));
      await configParser.load('https://d.kstore.dev/download/12441/dc6.json');
      return { ok: true, sites: configParser.getSites().length };
    } catch (e) {
      return { ok: false, error: e.message, stack: e.stack };
    }
  });
  console.log('Load result:', JSON.stringify(loadResult, null, 2));

  await browser.close();
})();
