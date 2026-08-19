import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_FILE = path.join(process.env.TEMP || '/tmp', 'tvbox_cdp_test3.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

fs.writeFileSync(LOG_FILE, '');

const CONFIG_URL = 'http://肥猫.net/tv';

async function main() {
  log('Connecting to CDP at http://127.0.0.1:9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('index.html'));
  if (!page) throw new Error('TVBox page not found');
  log(`Using page: ${page.url()}`);

  // Listen to console messages from renderer
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      text.includes('Store') ||
      text.includes('Spider') ||
      text.includes('Proxy') ||
      text.includes('homeContent')
    ) {
      log(`[renderer] ${text.substring(0, 200)}`);
    }
  });

  // Helper to access Pinia store
  async function getStore() {
    return await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.__vue_app__) {
        const pinia = app.__vue_app__.config.globalProperties.$pinia;
        if (pinia && pinia.state.value.app) {
          const s = pinia.state.value.app;
          return {
            configUrl: s.configUrl,
            sitesCount: s.sites?.length || 0,
            sites: (s.sites || [])
              .slice(0, 15)
              .map((x) => ({ key: x.key, name: x.name })),
            activeSiteKey: s.activeSiteKey,
            classesCount: s.classes?.length || 0,
            homeVodCount: s.homeVodList?.length || 0,
            homeLoading: s.homeLoading,
            firstVod: s.homeVodList?.[0]
              ? {
                  vod_name: s.homeVodList[0].vod_name,
                  vod_id: (s.homeVodList[0].vod_id || '').substring(0, 30),
                }
              : null,
            currentVod: s.currentVod
              ? {
                  vod_name: s.currentVod.vod_name,
                  vod_id: (s.currentVod.vod_id || '').substring(0, 30),
                }
              : null,
            currentPlayUrl: s.currentPlayUrl
              ? s.currentPlayUrl.substring(0, 80)
              : null,
            detailLoading: s.detailLoading,
            playLoading: s.playLoading,
            playError: s.playError,
          };
        }
      }
      return null;
    });
  }

  // Helper to call store actions
  async function callStoreAction(action, ...args) {
    return await page.evaluate(
      async ({ action, args }) => {
        const app = document.querySelector('#app');
        if (app && app.__vue_app__) {
          const pinia = app.__vue_app__.config.globalProperties.$pinia;
          if (pinia) {
            const store = pinia._s.get('app');
            if (store && typeof store[action] === 'function') {
              const result = await store[action](...args);
              return { ok: true, result };
            }
            return { ok: false, error: `action ${action} not found` };
          }
        }
        return { ok: false, error: 'no store' };
      },
      { action, args },
    );
  }

  // Step 1: Check current store state
  log('\n=== Step 1: Initial state ===');
  log(`Store: ${JSON.stringify(await getStore(), null, 2)}`);

  // Step 2: If no config loaded, load it
  const initialState = await getStore();
  if (!initialState || initialState.sitesCount === 0) {
    log('\n=== Step 2: Navigate to settings and load config ===');
    await page.evaluate(() => {
      const router =
        document.querySelector('#app')?.__vue_app__?.config?.globalProperties
          ?.$router;
      if (router) router.push('/settings');
    });
    await page.waitForTimeout(800);

    const configInput = page.locator('input[placeholder*="配置链接"]');
    if (await configInput.count()) {
      await configInput.fill(CONFIG_URL);
      await page.waitForTimeout(300);
      log(`Filled config URL: ${CONFIG_URL}`);
    } else {
      log('Config input not found, falling back to first text input');
      await page.locator('input[type="text"]').nth(1).fill(CONFIG_URL);
    }

    const loadBtn = page.locator('button:has-text("加载")');
    if (await loadBtn.count()) {
      await loadBtn.click();
      log('Clicked "加载" button, waiting for sites to load...');
    }

    // Wait for sites to populate
    try {
      await page.waitForFunction(
        () => {
          const app = document.querySelector('#app');
          if (app && app.__vue_app__) {
            const pinia = app.__vue_app__.config.globalProperties.$pinia;
            if (pinia && pinia.state.value.app) {
              return (pinia.state.value.app.sites?.length || 0) >= 5;
            }
          }
          return false;
        },
        { timeout: 30000 },
      );
    } catch (e) {
      log(`sites waitForFunction timed out: ${e.message}`);
    }
    await page.waitForTimeout(1500);
    log(`After load: ${JSON.stringify(await getStore(), null, 2)}`);
  } else {
    log(`Config already loaded: ${initialState.sitesCount} sites`);
  }

  // Step 3: Find target site — prefer 潮流, fallback to first non-config site
  const stateAfterLoad = await getStore();
  const sites = stateAfterLoad?.sites || [];
  const targetSite =
    sites.find((s) => s.name?.includes('潮流')) ||
    sites.find(
      (s) => !s.key?.includes('config') && !s.name?.includes('配置'),
    ) ||
    sites[0];
  if (!targetSite) {
    throw new Error('No suitable site found');
  }
  const uniqueKey = `${targetSite.key}-${targetSite.name}`;
  log(
    `\n=== Step 3: Switch to site "${targetSite.name}" (key=${targetSite.key}, uniqueKey=${uniqueKey}) ===`,
  );

  // Navigate to home first
  await page.evaluate(() => {
    const router =
      document.querySelector('#app')?.__vue_app__?.config?.globalProperties
        ?.$router;
    if (router) router.push('/');
  });
  await page.waitForTimeout(800);

  // Call setActiveSite + loadHome
  log('Calling setActiveSite...');
  const setActiveResult = await callStoreAction('setActiveSite', uniqueKey);
  log(`setActiveSite result: ${JSON.stringify(setActiveResult)}`);

  log('Calling loadHome...');
  const loadHomeResult = await callStoreAction('loadHome', false);
  log(`loadHome result: ${JSON.stringify(loadHomeResult)}`);

  // Wait for homeVodList to populate
  try {
    await page.waitForFunction(
      () => {
        const app = document.querySelector('#app');
        if (app && app.__vue_app__) {
          const pinia = app.__vue_app__.config.globalProperties.$pinia;
          if (pinia && pinia.state.value.app) {
            return (pinia.state.value.app.homeVodList?.length || 0) >= 1;
          }
        }
        return false;
      },
      { timeout: 60000 },
    );
  } catch (e) {
    log(`homeVodList waitForFunction timed out: ${e.message}`);
  }

  const stateAfterHome = await getStore();
  log(`\n=== Home state after loadHome ===`);
  log(JSON.stringify(stateAfterHome, null, 2));

  // Step 4: If home populated, trigger detailContent
  if (stateAfterHome?.homeVodCount > 0) {
    log('\n=== Step 4: Trigger detailContent ===');
    const firstVod = stateAfterHome.firstVod;
    log(`First VOD: ${JSON.stringify(firstVod)}`);

    // Open detail by calling openDetail action
    log('Calling openDetail...');
    const vodObj = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.__vue_app__) {
        const pinia = app.__vue_app__.config.globalProperties.$pinia;
        if (pinia && pinia.state.value.app) {
          return pinia.state.value.app.homeVodList?.[0] || null;
        }
      }
      return null;
    });
    if (vodObj) {
      const detailResult = await callStoreAction('openDetail', vodObj);
      log(
        `openDetail result: ${JSON.stringify(detailResult).substring(0, 200)}`,
      );

      // Wait for detail to populate
      try {
        await page.waitForFunction(
          () => {
            const app = document.querySelector('#app');
            if (app && app.__vue_app__) {
              const pinia = app.__vue_app__.config.globalProperties.$pinia;
              if (pinia && pinia.state.value.app) {
                return pinia.state.value.app.currentVod?.vod_play_url;
              }
            }
            return false;
          },
          { timeout: 30000 },
        );
      } catch (e) {
        log(`detail waitForFunction timed out: ${e.message}`);
      }

      const stateAfterDetail = await getStore();
      log(`\n=== Detail state ===`);
      log(JSON.stringify(stateAfterDetail, null, 2));
    }
  }

  await browser.close();
  log('Done.');
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  log(e.stack || '');
  process.exit(1);
});
