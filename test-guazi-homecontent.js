/**
 * Playwright script to test Guazi source's homeContent method
 * and capture detailed logs from the Electron main process.
 *
 * Usage: node test-guazi-homecontent.js
 */

const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('=== Starting Playwright Electron Test ===');

  // Launch the Electron app
  // Note: We're launching a NEW instance using the built main.js
  // This ensures we capture all logs from the beginning
  const electronPath = path.join(
    __dirname,
    'node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe',
  );
  const mainPath = path.join(__dirname, 'dist-electron/main.js');

  console.log('[Playwright] Electron path:', electronPath);
  console.log('[Playwright] Main path:', mainPath);

  const electronApp = await electron.launch({
    path: electronPath,
    args: [__dirname], // Pass the project directory as the app path
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined, // Ensure Electron runs as app, not as Node
    },
  });

  console.log('[Playwright] Electron app launched');

  // Get the main window
  const window = await electronApp.firstWindow();
  console.log('[Playwright] Got main window');

  // Wait for the app to fully load
  await window.waitForLoadState('domcontentloaded');
  console.log('[Playwright] DOM content loaded');

  // Wait a bit more for all services to initialize
  await window.waitForTimeout(5000);
  console.log('[Playwright] Services initialized');

  // Get electronIPC from the window
  const ipc = await window.evaluate(() => window.electronIPC);
  if (!ipc) {
    console.error('[Playwright] electronIPC not found on window');
    await electronApp.close();
    return;
  }
  console.log('[Playwright] electronIPC found');

  // Define the global JAR
  const GLOBAL_JAR =
    'https://img2.gelonghui.com/library/e2693-9aa941a0-f96a-40c2-ac23-e6af358d19a7.png;md5;e2693c58ebc58abecc7282b721db79ca';

  // Define Guazi source
  const guaziSource = {
    key: '瓜子',
    api: 'csp_GuaziTY',
    ext: '',
  };

  console.log('\n=== Testing Guazi homeContent ===');

  try {
    // Step 1: Load the global JAR
    console.log('[Test] Loading global JAR...');
    const loadResult = await window.evaluate(async (jarUrl) => {
      const ipc = window.electronIPC;
      return await ipc.invoke('jar:load', jarUrl, '', false);
    }, GLOBAL_JAR);

    if (!loadResult?.success) {
      console.error('[Test] JAR load failed:', loadResult?.error);
      await electronApp.close();
      return;
    }
    console.log('[Test] JAR loaded successfully');

    // Step 2: Get the spider
    const className = 'com.github.catvod.spider.GuaziTY';
    console.log('[Test] Getting spider for Guazi...');
    const spiderResult = await window.evaluate(
      async (params) => {
        const ipc = window.electronIPC;
        return await ipc.invoke(
          'jar:getSpider',
          params.key,
          params.className,
          params.ext,
          params.jarUrl,
        );
      },
      {
        key: guaziSource.key,
        className: className,
        ext: guaziSource.ext,
        jarUrl: GLOBAL_JAR,
      },
    );

    if (!spiderResult?.success) {
      console.error('[Test] getSpider failed:', spiderResult?.error);
      await electronApp.close();
      return;
    }
    console.log('[Test] Spider obtained successfully');

    // Step 3: Init the spider
    console.log('[Test] Initializing spider...');
    await window.evaluate(
      async (params) => {
        const ipc = window.electronIPC;
        return await ipc.invoke('jar:initSpider', params.key, params.ext);
      },
      {
        key: guaziSource.key,
        ext: guaziSource.ext,
      },
    );
    console.log('[Test] Spider initialized');

    // Step 4: Call homeContent (this will trigger the main process logs)
    console.log('[Test] Calling homeContent...');
    console.log('[Test] Waiting for main process logs...');

    // Wait a bit to ensure we see the logs
    await window.waitForTimeout(1000);

    const homeResult = await window.evaluate(
      async (params) => {
        const ipc = window.electronIPC;
        return await ipc.invoke(
          'jar:callMethod',
          params.key,
          'homeContent',
          [true],
          {},
        );
      },
      {
        key: guaziSource.key,
      },
    );

    console.log('[Test] homeContent call completed');
    console.log('[Test] Result type:', typeof homeResult);
    console.log('[Test] Result length:', homeResult?.length || 0);

    // Wait for logs to flush
    await window.waitForTimeout(3000);

    // Parse the result
    try {
      const parsed = JSON.parse(homeResult || '{}');
      console.log('[Test] Parsed result:');
      console.log('  - classes:', parsed.classes?.length || 0);
      console.log('  - list:', parsed.list?.length || 0);

      if (parsed.classes && parsed.classes.length > 0) {
        console.log('  - first class:', JSON.stringify(parsed.classes[0]));
      }

      if (parsed.list && parsed.list.length > 0) {
        console.log('  - first video:', JSON.stringify(parsed.list[0]));
      }
    } catch (e) {
      console.error('[Test] Failed to parse result:', e.message);
      console.log('[Test] Raw result preview:', homeResult?.substring(0, 200));
    }

    console.log('\n=== Test Complete ===');
    console.log(
      '[Playwright] Check the main process logs above for detailed homeContent output',
    );
    console.log('[Playwright] Key logs to look for:');
    console.log('  - [JarLoader] homeContent RAW RESULT (length=...)');
    console.log('  - [JarLoader] homeContent preview: ...');
    console.log('  - [JarLoader] homeContent first 50 bytes: ...');
  } catch (error) {
    console.error('[Test] Error:', error.message);
    console.error('[Test] Stack:', error.stack);
  }

  // Keep the app running for a bit to see all logs
  console.log(
    '\n[Playwright] Keeping app running for 10 seconds to capture all logs...',
  );
  await window.waitForTimeout(10000);

  // Close the app
  console.log('[Playwright] Closing Electron app...');
  await electronApp.close();

  console.log('[Playwright] Test finished');
})();
