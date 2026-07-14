/**
 * Test all user-provided config URLs through the actual application.
 *
 * Connects to the running Electron app via CDP and:
 *  1. Calls store.loadConfig(url) for each config
 *  2. Verifies sites count > 0
 *  3. Calls store.loadHome() to test homeContent
 *  4. Tests detailContent for first video
 *  5. Tests playerContent for first episode
 *
 * Usage:
 *   node tools/e2e/test-configs-app.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIGS } = require('./data/configs');

const CDP_URL = 'http://127.0.0.1:9222';
const PER_CONFIG_TIMEOUT_MS = 120000;

function fmt(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   TVBox Desktop - 配置URL端到端测试 (通过实际应用)         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`配置数: ${CONFIGS.length}`);
  console.log(`时间: ${new Date().toISOString()}\n`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error('❌ 无法连接到 Electron 应用 (CDP port 9222)');
    console.error('   请确保应用已启动: pnpm dev');
    console.error('   错误:', e.message);
    process.exit(1);
  }

  const contexts = browser.contexts();
  const pages = [];
  for (const ctx of contexts) pages.push(...ctx.pages());
  const page = pages.find((p) => p.url().includes('localhost'));
  if (!page) {
    console.error('❌ 未找到 TVBox Desktop 页面');
    await browser.close();
    process.exit(1);
  }
  console.log('✓ 已连接到应用:', await page.title(), '\n');

  const results = [];

  for (let i = 0; i < CONFIGS.length; i++) {
    const cfg = CONFIGS[i];
    const r = {
      index: i + 1,
      name: cfg.name,
      url: cfg.url,
      ok: false,
      loadMs: 0,
      sitesCount: 0,
      spider: '',
      homeOk: false,
      homeCount: 0,
      homeError: '',
      detailOk: false,
      detailEpisodes: 0,
      detailError: '',
      playOk: false,
      playUrl: '',
      playError: '',
      error: '',
    };

    console.log(`[${String(i + 1).padStart(2)}/${CONFIGS.length}] ${cfg.name}`);
    console.log(`  URL: ${cfg.url}`);

    try {
      const startTime = Date.now();
      // Use the store's loadConfig flow which sets up spider base URL + active site
      const loadResult = await withTimeout(
        page.evaluate(async (configUrl) => {
          try {
            const { useAppStore } = await import('/src/store/app.ts');
            const { configParser } = await import('/src/core/ConfigParser.ts');
            const store = useAppStore();
            store.setConfigUrl(configUrl);
            // Call configParser.load directly to capture the actual error
            try {
              await configParser.load(configUrl);
            } catch (e) {
              return {
                ok: false,
                error: `configParser.load error: ${e.message || String(e)}`,
                stack: e.stack || '',
              };
            }
            // Now update the store state
            const ok = await store.loadConfig();
            if (!ok) {
              return { ok: false, error: 'loadConfig returned false' };
            }
            const sites = store.sites;
            return {
              ok: true,
              sitesCount: sites.length,
              spider: configParser.getSpider(),
              sites: sites.slice(0, 10).map((s) => ({
                key: s.key,
                name: s.name,
                api: s.api,
                hide: s.hide,
              })),
            };
          } catch (e) {
            return { ok: false, error: e.message || String(e) };
          }
        }, cfg.url),
        PER_CONFIG_TIMEOUT_MS,
        `config ${cfg.name} load`,
      );

      r.loadMs = Date.now() - startTime;

      if (!loadResult.ok) {
        r.error = loadResult.error || 'unknown error';
        console.log(`  ✗ load failed: ${r.error} (${fmt(r.loadMs)})\n`);
        results.push(r);
        continue;
      }

      r.sitesCount = loadResult.sitesCount;
      r.spider = loadResult.spider || '';

      if (r.sitesCount === 0) {
        r.error = 'no sites in config';
        console.log(`  ✗ ${r.error} (${fmt(r.loadMs)})\n`);
        results.push(r);
        continue;
      }

      console.log(
        `  ✓ loaded: ${r.sitesCount} sites, spider=${r.spider ? 'yes' : 'no'} (${fmt(r.loadMs)})`,
      );
      console.log(
        `    samples: ${loadResult.sites
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ')}`,
      );

      // Pick first visible site for testing
      const firstSite =
        loadResult.sites.find((s) => s.hide !== 1) || loadResult.sites[0];
      if (!firstSite) {
        r.error = 'no visible site to test';
        console.log(`  ✗ ${r.error}\n`);
        results.push(r);
        continue;
      }
      console.log(`  → testing site: ${firstSite.name} (api=${firstSite.api})`);

      // Test homeContent via store.loadHome()
      try {
        const homeResult = await withTimeout(
          page.evaluate(async (siteKey) => {
            try {
              const { useAppStore } = await import('/src/store/app.ts');
              const store = useAppStore();
              store.setActiveSite(siteKey);
              await store.loadHome(true);
              return {
                ok: true,
                listCount: store.homeVodList.length,
                classCount: store.classes.length,
                firstItem: store.homeVodList[0]
                  ? {
                      vod_id: store.homeVodList[0].vod_id,
                      vod_name: store.homeVodList[0].vod_name,
                    }
                  : null,
              };
            } catch (e) {
              return { ok: false, error: e.message || String(e) };
            }
          }, `${firstSite.key}-${firstSite.name}`),
          60000,
          `homeContent ${cfg.name}`,
        );

        if (homeResult.ok) {
          r.homeOk = true;
          r.homeCount = homeResult.listCount;
          console.log(
            `  ✓ homeContent: ${homeResult.listCount} videos, ${homeResult.classCount} classes`,
          );
          if (homeResult.firstItem) {
            console.log(
              `    first: ${homeResult.firstItem.vod_name} (id=${homeResult.firstItem.vod_id})`,
            );
          }
        } else {
          r.homeError = homeResult.error;
          console.log(`  ✗ homeContent failed: ${r.homeError}`);
        }
      } catch (e) {
        r.homeError = e.message;
        console.log(`  ✗ homeContent timeout/error: ${e.message}`);
      }

      // Test detailContent + playerContent via store.loadDetail + loadPlayUrl
      try {
        const detailResult = await withTimeout(
          page.evaluate(async (siteKey) => {
            try {
              const { useAppStore } = await import('/src/store/app.ts');
              const store = useAppStore();
              store.setActiveSite(siteKey);
              await store.loadHome(true);
              if (store.homeVodList.length === 0) {
                return {
                  ok: false,
                  error: 'no videos in home for detail test',
                };
              }
              const firstVideo = store.homeVodList[0];
              await store.loadDetail(firstVideo);
              const vod = store.currentVod;
              if (!vod) {
                return { ok: false, error: 'detail returned null vod' };
              }
              const episodes = store.currentEpisodes;
              return {
                ok: true,
                vodName: vod.vod_name,
                episodesCount: episodes.length,
                firstEpisode: episodes[0]
                  ? { name: episodes[0].name, url: episodes[0].url }
                  : null,
              };
            } catch (e) {
              return { ok: false, error: e.message || String(e) };
            }
          }, `${firstSite.key}-${firstSite.name}`),
          60000,
          `detailContent ${cfg.name}`,
        );

        if (detailResult.ok) {
          r.detailOk = true;
          r.detailEpisodes = detailResult.episodesCount;
          console.log(
            `  ✓ detailContent: ${detailResult.vodName}, ${detailResult.episodesCount} episodes`,
          );

          // Test playerContent
          if (detailResult.firstEpisode) {
            try {
              const playResult = await withTimeout(
                page.evaluate(
                  async (siteKey, epName, epUrl) => {
                    try {
                      const { useAppStore } = await import('/src/store/app.ts');
                      const store = useAppStore();
                      store.setActiveSite(siteKey);
                      // loadPlayUrl needs currentVod set; reload detail first
                      await store.loadHome(true);
                      if (store.homeVodList.length === 0) {
                        return { ok: false, error: 'no videos for play test' };
                      }
                      await store.loadDetail(store.homeVodList[0]);
                      await store.loadPlayUrl(epUrl, 0);
                      return {
                        ok: !!store.currentPlayUrl,
                        playUrl: store.currentPlayUrl
                          ? store.currentPlayUrl.substring(0, 100)
                          : '',
                        playError: store.playError || '',
                      };
                    } catch (e) {
                      return { ok: false, error: e.message || String(e) };
                    }
                  },
                  `${firstSite.key}-${firstSite.name}`,
                  detailResult.firstEpisode.name,
                  detailResult.firstEpisode.url,
                ),
                60000,
                `playerContent ${cfg.name}`,
              );

              if (playResult.ok) {
                r.playOk = true;
                r.playUrl = playResult.playUrl;
                console.log(`  ✓ playerContent: url=${r.playUrl}...`);
              } else {
                r.playError = playResult.error || playResult.playError;
                console.log(`  ✗ playerContent failed: ${r.playError}`);
              }
            } catch (e) {
              r.playError = e.message;
              console.log(`  ✗ playerContent timeout/error: ${e.message}`);
            }
          }
        } else {
          r.detailError = detailResult.error;
          console.log(`  ✗ detailContent failed: ${r.detailError}`);
        }
      } catch (e) {
        r.detailError = e.message;
        console.log(`  ✗ detailContent timeout/error: ${e.message}`);
      }
    } catch (e) {
      r.error = e.message || String(e);
      console.log(`  ✗ unexpected error: ${r.error}`);
    }

    // Mark ok if at least home + detail worked (player may need pan login)
    if (r.homeOk && r.detailOk) {
      r.ok = true;
    }

    console.log('');
    results.push(r);
  }

  // Summary
  console.log('═'.repeat(60));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`✓ 成功: ${okCount}/${results.length}`);
  console.log('═'.repeat(60));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('\n失败配置:');
    for (const f of failed) {
      const parts = [];
      if (f.error) parts.push(`load: ${f.error}`);
      if (f.homeError) parts.push(`home: ${f.homeError}`);
      if (f.detailError) parts.push(`detail: ${f.detailError}`);
      if (f.playError) parts.push(`play: ${f.playError}`);
      console.log(`  - ${f.name}: ${parts.join(' | ')}`);
    }
  }

  // Save report
  const reportDir = path.join(os.tmpdir(), 'tvbox_e2e_reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `configs_app_${ts}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n报告: ${reportPath}`);

  await browser.close();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
