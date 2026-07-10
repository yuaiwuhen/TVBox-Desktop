/**
 * Direct test script to test Guazi source's homeContent method
 * by injecting test code into the running Electron process.
 *
 * Usage: This script will be executed via IPC call from the running app.
 */

// This script is meant to be loaded and executed by the JarLoader
// We'll add a test function that can be called via IPC

const testGuaziHomeContent = async () => {
  console.log('\n=== TEST: Guazi homeContent ===\n');

  const GLOBAL_JAR =
    'https://img2.gelonghui.com/library/e2693-9aa941a0-f96a-40c2-ac23-e6af358d19a7.png;md5;e2693c58ebc58abecc7282b721db79ca';

  const guaziSource = {
    key: '瓜子',
    api: 'csp_GuaziTY',
    ext: '',
  };

  try {
    console.log('[Test] Loading global JAR...');
    const loadOk = await jarLoader.loadJar(GLOBAL_JAR, '', false);
    if (!loadOk) {
      console.error('[Test] JAR load failed:', jarLoader.getLastError());
      return { success: false, error: 'JAR load failed' };
    }
    console.log('[Test] JAR loaded successfully\n');

    const className = 'com.github.catvod.spider.GuaziTY';
    console.log('[Test] Getting spider for Guazi...');
    const getOk = jarLoader.getSpider(
      guaziSource.key,
      className,
      guaziSource.ext,
      GLOBAL_JAR
    );
    if (!getOk) {
      console.error('[Test] getSpider failed:', jarLoader.getLastError());
      return { success: false, error: 'getSpider failed' };
    }
    console.log('[Test] Spider obtained successfully\n');

    console.log('[Test] Initializing spider...');
    await jarLoader.initSpider(guaziSource.key, guaziSource.ext);
    console.log('[Test] Spider initialized\n');

    console.log('[Test] Calling homeContent...');
    console.log('[Test] Watch for main process logs below:\n');

    const homeStr = await jarLoader.callSpiderMethod(guaziSource.key, 'homeContent', [true]);

    console.log('\n[Test] homeContent call completed');
    console.log('[Test] Result type:', typeof homeStr);
    console.log('[Test] Result length:', homeStr?.length || 0);

    let parsed;
    try {
      parsed = JSON.parse(homeStr || '{}');
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
      console.log('[Test] Raw result preview:', homeStr?.substring(0, 200));
    }

    console.log('\n=== TEST COMPLETE ===\n');

    return {
      success: true,
      classes: parsed?.classes?.length || 0,
      list: parsed?.list?.length || 0,
      rawLength: homeStr?.length || 0,
    };
  } catch (error) {
    console.error('[Test] Error:', error.message);
    console.error('[Test] Stack:', error.stack);
    return { success: false, error: error.message };
  }
};

// Export for IPC
module.exports = { testGuaziHomeContent };