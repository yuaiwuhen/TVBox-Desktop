import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.env.TEMP || '/tmp', 'tvbox_cdp_v2_run.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

fs.writeFileSync(LOG_FILE, '');

async function main() {
  log('Connecting to CDP at http://127.0.0.1:9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('index.html'));
  if (!page) throw new Error('TVBox page not found');
  log(`Using page: ${page.url()}`);

  page.on('console', (msg) => {
    const text = msg.text();
    if (
      text.includes('DexConverter') ||
      text.includes('detailContent') ||
      text.includes('playerContent') ||
      text.includes('loadDetail')
    ) {
      log(`[renderer] ${text.substring(0, 250)}`);
    }
  });

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

  async function getStore() {
    return await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.__vue_app__) {
        const pinia = app.__vue_app__.config.globalProperties.$pinia;
        if (pinia && pinia.state.value.app) {
          const s = pinia.state.value.app;
          return {
            activeSiteKey: s.activeSiteKey,
            classesCount: s.classes?.length || 0,
            homeVodCount: s.homeVodList?.length || 0,
            categoryVodCount: s.categoryVodList?.length || 0,
            firstCategoryVod: s.categoryVodList?.[0]
              ? {
                  vod_name: s.categoryVodList[0].vod_name,
                  vod_id: (s.categoryVodList[0].vod_id || '')
                    .toString()
                    .substring(0, 40),
                }
              : null,
            currentVod: s.currentVod
              ? { vod_name: s.currentVod.vod_name }
              : null,
            currentPlayUrl: s.currentPlayUrl
              ? s.currentPlayUrl.substring(0, 100)
              : null,
            currentPlayFlag: s.currentPlayFlag,
            episodesCount: s.currentEpisodes?.length || 0,
            detailLoading: s.detailLoading,
            playLoading: s.playLoading,
            playError: s.playError,
          };
        }
      }
      return null;
    });
  }

  log('\n=== Step 1: Initial state ===');
  log(`Store: ${JSON.stringify(await getStore(), null, 2)}`);

  // Step 2: Use existing category videos (already loaded by app)
  const initialState = await getStore();
  let firstVod = initialState?.firstCategoryVod
    ? await page.evaluate(() => {
        const app = document.querySelector('#app');
        if (app && app.__vue_app__) {
          const pinia = app.__vue_app__.config.globalProperties.$pinia;
          if (pinia && pinia.state.value.app) {
            return pinia.state.value.app.categoryVodList?.[0] || null;
          }
        }
        return null;
      })
    : null;

  // If no category videos, try loading category 10
  if (!firstVod) {
    log('\n=== Step 2a: No category videos, loading category 10 ===');
    await callStoreAction('loadCategory', '10', true);
    try {
      await page.waitForFunction(
        () => {
          const app = document.querySelector('#app');
          if (app && app.__vue_app__) {
            const pinia = app.__vue_app__.config.globalProperties.$pinia;
            if (pinia && pinia.state.value.app) {
              return (pinia.state.value.app.categoryVodList?.length || 0) >= 1;
            }
          }
          return false;
        },
        { timeout: 30000 },
      );
    } catch (e) {
      log(`categoryVodList waitForFunction timed out: ${e.message}`);
    }
    firstVod = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.__vue_app__) {
        const pinia = app.__vue_app__.config.globalProperties.$pinia;
        if (pinia && pinia.state.value.app) {
          return pinia.state.value.app.categoryVodList?.[0] || null;
        }
      }
      return null;
    });
  } else {
    log(`\n=== Step 2: Using existing category video ===`);
  }

  // Step 3: Open detail page
  if (firstVod) {
    log(
      `\n=== Step 3: Open detail for: ${firstVod.vod_name} (vod_id=${firstVod.vod_id}) ===`,
    );
    const detailResult = await callStoreAction('loadDetail', String(firstVod.vod_id));
    log(`loadDetail result: ${JSON.stringify(detailResult).substring(0, 200)}`);

    // Wait for detail to populate
    try {
      await page.waitForFunction(
        () => {
          const app = document.querySelector('#app');
          if (app && app.__vue_app__) {
            const pinia = app.__vue_app__.config.globalProperties.$pinia;
            if (pinia && pinia.state.value.app) {
              return !!pinia.state.value.app.currentVod?.vod_play_url;
            }
          }
          return false;
        },
        { timeout: 60000 },
      );
    } catch (e) {
      log(`detail waitForFunction timed out: ${e.message}`);
    }

    const stateAfterDetail = await getStore();
    log(`\n=== State after loadDetail ===`);
    log(JSON.stringify(stateAfterDetail, null, 2));

    // Step 4: Trigger play
    if (stateAfterDetail?.episodesCount > 0) {
      log('\n=== Step 4: Trigger play ===');
      const playResult = await callStoreAction('play', 0);
      log(`play result: ${JSON.stringify(playResult).substring(0, 200)}`);

      try {
        await page.waitForFunction(
          () => {
            const app = document.querySelector('#app');
            if (app && app.__vue_app__) {
              const pinia = app.__vue_app__.config.globalProperties.$pinia;
              if (pinia && pinia.state.value.app) {
                return !!pinia.state.value.app.currentPlayUrl;
              }
            }
            return false;
          },
          { timeout: 30000 },
        );
      } catch (e) {
        log(`play waitForFunction timed out: ${e.message}`);
      }

      const stateAfterPlay = await getStore();
      log(`\n=== State after play ===`);
      log(JSON.stringify(stateAfterPlay, null, 2));
    } else {
      log('\n=== Step 4 skipped: no episodes ===');
    }
  } else {
    log('No video found to test detail');
  }

  await browser.close();
  log('Done.');
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  log(e.stack || '');
  process.exit(1);
});
