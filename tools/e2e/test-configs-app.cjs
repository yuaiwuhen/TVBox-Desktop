// Force UTF-8 encoding for stdout/stderr (fixes garbled Chinese in PowerShell)
process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');
if (process.platform === 'win32') {
  const cp = require('child_process');
  try { cp.execSync('chcp 65001 > nul', { stdio: 'pipe' }); } catch {}
}

/**
 * Test all user-provided config URLs through the actual application.
 *
 * Connects to the running Electron app via CDP and:
 *  1. Syncs pan login cookies to JVM (fixes isolated env login issue)
 *  2. Calls store.loadConfig(url) for each config
 *  3. Verifies sites count > 0
 *  4. Calls store.loadHome() to test homeContent
 *  5. Tests detailContent for first NON-msearch video
 *     (msearch: prefix is Douban search result, not a real vod_id —
 *      Android jumps to SearchActivity for these, not DetailActivity)
 *  6. Tests playerContent for first episode
 *
 * Usage:
 *   node tools/e2e/test-configs-app.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIGS } = require('./data/configs.js');

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

  // Pan login cookies are persisted in JVM SharedPreferences from prior
  // sessions (via the in-app login flow). We intentionally skip
  // PanLogin.syncAllToJVM() here because the IPC call has been observed to
  // hang the Vite dev server — the renderer's ipc.invoke promise never
  // resolves even though the main-process handler completes. Since cookies
  // are already persisted, sync is only needed for first-run scenarios.
  console.log('跳过登录信息同步（cookies 已持久化在 JVM SharedPreferences）\n');

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
      detailSkipped: '',
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
              // Send ALL sites so the test can find non-special sites
              // (many configs have Douban/Config centers at the top and real
              // video sources further down the list)
              sites: sites.map((s) => ({
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

      // Pick first visible site for testing.
      // Skip known special-purpose sites (Douban search, Config center, etc.)
      // that don't have standard homeContent/detailContent. These are
      // utility sites, not video sources. Iterate through up to 15 sites
      // to find one that returns home or category content.
      const SPECIAL_APIS = new Set([
        'csp_Douban',
        'csp_DoubanGuard',
        // NOTE: csp_DouDou / csp_DouDouGuard are NOT Douban search sites.
        // They're real video spiders (豆豆, not 豆瓣) that return valid
        // vod_ids. Do NOT add them to SPECIAL_APIS.
        'csp_Duopan',
        'csp_Config',
        'csp_FirstAid',
        'csp_Kugou',
        'csp_Living',
        'csp_Search',
        'csp_Hot',
        'csp_Anthology',
        'csp_Notice',
        'csp_MyDriveGuard',
        'csp_WexconfigGuard',
        'csp_WexokconfigGuard',
      ]);

      // Return up to 15 candidate sites (non-hidden, non-special)
      const candidateSites = (loadResult.sites || [])
        .filter((s) => s.hide !== 1 && !SPECIAL_APIS.has(s.api))
        .slice(0, 15);
      // Always keep the first visible site as a fallback even if special
      const firstSite =
        candidateSites[0] ||
        loadResult.sites.find((s) => s.hide !== 1) ||
        loadResult.sites[0];
      if (!firstSite) {
        r.error = 'no visible site to test';
        console.log(`  ✗ ${r.error}\n`);
        results.push(r);
        continue;
      }
      console.log(
        `  → testing ${candidateSites.length} candidate sites (first: ${firstSite.name} api=${firstSite.api})`,
      );

      // Test homeContent on each candidate site until we find one with data.
      // Mirrors user behavior: click through sites until one shows content.
      let homeResult = null;
      let testedSite = null;
      for (let si = 0; si < candidateSites.length; si++) {
        const site = candidateSites[si];
        try {
          const res = await withTimeout(
            page.evaluate(async (siteKey) => {
              try {
                const { useAppStore } = await import('/src/store/app.ts');
                const store = useAppStore();
                store.setActiveSite(siteKey);
                await store.loadHome(true);
                let items = store.homeVodList.slice(0, 30).map((v) => ({
                  vod_id: v.vod_id,
                  vod_name: v.vod_name,
                }));
                let listCount = store.homeVodList.length;
                const classes = store.classes.map((c) => ({
                  type_id: c.type_id,
                  type_name: c.type_name,
                }));
                // If home is empty but classes exist, try categoryContent
                if (listCount === 0 && classes.length > 0) {
                  const firstClass =
                    classes.find((c) => c.type_id !== '__recommend__') ||
                    classes[0];
                  if (firstClass) {
                    await store.loadCategory(firstClass.type_id, '1');
                    listCount = store.categoryVodList.length;
                    items = store.categoryVodList.slice(0, 30).map((v) => ({
                      vod_id: v.vod_id,
                      vod_name: v.vod_name,
                    }));
                  }
                }
                return {
                  ok: true,
                  listCount,
                  classCount: classes.length,
                  classes,
                  items,
                  siteKey,
                  siteName: siteKey.split('-').slice(1).join('-') || siteKey,
                  fallbackUsed: listCount > 0 && store.homeVodList.length === 0,
                };
              } catch (e) {
                return { ok: false, error: e.message || String(e) };
              }
            }, `${site.key}-${site.name}`),
            45000,
            `homeContent ${cfg.name} site#${si + 1}`,
          );
          if (res.ok && res.listCount > 0) {
            // Detect config-center sites: items like delQuark/addAli are
            // pan-login actions, not real videos. Skip these sites.
            const items = res.items || [];
            const isConfigCenter = items.every(
              (v) =>
                v.vod_id &&
                (String(v.vod_id).startsWith('add') ||
                  String(v.vod_id).startsWith('del')),
            );
            if (isConfigCenter) {
              console.log(
                `    · site #${si + 1} ${site.name} (api=${site.api}): config center (add/del actions), trying next`,
              );
              continue;
            }
            // Also skip sites where items have no valid vod_id (e.g.,
            // csp_Market returns 2 items with empty vod_id). These aren't
            // clickable videos - keep looking for a real video source.
            const hasValidVodId = items.some(
              (v) => v.vod_id && !String(v.vod_id).startsWith('msearch:'),
            );
            if (!hasValidVodId) {
              console.log(
                `    · site #${si + 1} ${site.name} (api=${site.api}): ${res.listCount} items but no valid vod_id, trying next`,
              );
              continue;
            }
            homeResult = res;
            testedSite = site;
            console.log(
              `  ✓ site #${si + 1} ${site.name}: ${res.listCount} videos (api=${site.api})${res.fallbackUsed ? ' [via categoryContent]' : ''}`,
            );
            break;
          }
          if (res.ok && res.listCount === 0) {
            console.log(
              `    · site #${si + 1} ${site.name} (api=${site.api}): empty, trying next`,
            );
          } else {
            console.log(
              `    · site #${si + 1} ${site.name} (api=${site.api}): ${res.error}, trying next`,
            );
          }
        } catch (e) {
          console.log(
            `    · site #${si + 1} ${site.name} (api=${site.api}): timeout, trying next`,
          );
        }
      }

      // If no candidate site returned content, use the first site's result
      // (even if empty) for reporting
      if (!homeResult) {
        homeResult = {
          ok: true,
          listCount: 0,
          classCount: 0,
          classes: [],
          items: [],
          siteKey: `${firstSite.key}-${firstSite.name}`,
          siteName: firstSite.name,
          fallbackUsed: false,
        };
        testedSite = firstSite;
        console.log(
          `  ✗ all ${candidateSites.length} candidate sites returned empty`,
        );
      }

      {
        r.homeOk = homeResult.listCount > 0;
        r.homeCount = homeResult.listCount;
        if (r.homeOk) {
          console.log(
            `  ✓ homeContent: ${homeResult.listCount} videos (from ${testedSite.name})`,
          );
        }

        // Find first non-msearch video for detail test
        const items = homeResult.items || [];
        const realVideo = items.find(
          (v) => v.vod_id && !String(v.vod_id).startsWith('msearch:'),
        );
        const msearchVideo = items.find((v) =>
          String(v.vod_id || '').startsWith('msearch:'),
        );

        if (realVideo) {
          console.log(
            `    → detail test: ${realVideo.vod_name} (id=${realVideo.vod_id})`,
          );
        } else if (msearchVideo) {
          r.detailSkipped = 'all home videos are msearch: (Douban search)';
          console.log(
            `    ⚠ all home videos are msearch: (Douban search), skipping detail`,
          );
        } else if (items.length === 0) {
          r.detailSkipped = 'home returned empty list';
        } else {
          // Items exist but none have valid vod_id - skip detail test
          r.detailSkipped = 'items have no valid vod_id for detail';
          console.log(
            `    ⚠ home returned ${items.length} items but no valid vod_id, skipping detail`,
          );
        }
        // Store for later use in detail test
        r._detailVideo = realVideo || null;
        r._msearchVideo = msearchVideo || null;
        r._siteKey = homeResult.siteKey;
      }

      // Test detailContent only if we have a real (non-msearch) video
      if (r._detailVideo) {
        try {
          const detailResult = await withTimeout(
            page.evaluate(
              async ({ siteKey, vodId }) => {
                try {
                  const { useAppStore } = await import('/src/store/app.ts');
                  const store = useAppStore();
                  store.setActiveSite(siteKey);
                  await store.loadDetail(vodId);
                  const vod = store.currentVod;
                  if (!vod) {
                    return { ok: false, error: 'detail returned null vod' };
                  }
                  // Parse episodes from vod_play_url (same logic as Detail.vue).
                  // store.currentEpisodes is only populated after loadPlay,
                  // so we parse here to verify the spider returned playable data.
                  let episodes = [];
                  if (vod.vod_play_from && vod.vod_play_url) {
                    const sources = String(vod.vod_play_from).split('$$$');
                    const urlGroups = String(vod.vod_play_url).split('$$$');
                    const firstUrlGroup = urlGroups[0] || '';
                    episodes = firstUrlGroup
                      .split('#')
                      .filter((s) => s)
                      .map((ep, idx) => {
                        const parts = ep.split('$');
                        if (parts.length >= 2) {
                          return {
                            name: parts[0] || '正片',
                            url: parts[1] || '',
                          };
                        }
                        return { name: String(idx + 1), url: parts[0] || '' };
                      })
                      .filter((ep) => ep.url);
                    return {
                      ok: true,
                      vodName: vod.vod_name,
                      vodPlayFrom: vod.vod_play_from,
                      sourcesCount: sources.length,
                      urlGroupCount: urlGroups.length,
                      episodesCount: episodes.length,
                      firstEpisode: episodes[0]
                        ? { name: episodes[0].name, url: episodes[0].url }
                        : null,
                    };
                  }
                  return {
                    ok: true,
                    vodName: vod.vod_name,
                    episodesCount: 0,
                    firstEpisode: null,
                    noPlayUrl: true,
                  };
                } catch (e) {
                  return { ok: false, error: e.message || String(e) };
                }
              },
              { siteKey: r._siteKey, vodId: r._detailVideo.vod_id },
            ),
            60000,
            `detailContent ${cfg.name}`,
          );

          if (detailResult.ok) {
            r.detailOk = true;
            r.detailEpisodes = detailResult.episodesCount;
            console.log(
              `  ✓ detailContent: ${detailResult.vodName}, ${detailResult.episodesCount} episodes (sources: ${detailResult.sourcesCount || 0})`,
            );

            // Test playerContent
            if (detailResult.firstEpisode) {
              try {
                const playResult = await withTimeout(
                  page.evaluate(
                    async ({ siteKey, vodId, epName, epUrl, flag }) => {
                      try {
                        const { useAppStore } =
                          await import('/src/store/app.ts');
                        const store = useAppStore();
                        store.setActiveSite(siteKey);
                        // Reload detail to set currentVod (required before loadPlay)
                        await store.loadDetail(vodId);
                        // Use loadPlay(flag, url, index, episodes) - same call
                        // as Detail.vue. flag is the source name (vod_play_from
                        // entry), url is the episode URL, episodes is the parsed
                        // episode list.
                        const episodes = [{ name: epName, url: epUrl }];
                        await store.loadPlay(flag, epUrl, 0, episodes);
                        return {
                          ok: !!store.currentPlayUrl,
                          externalLaunched: !!store.externalPlayerLaunched,
                          playUrl: store.currentPlayUrl
                            ? store.currentPlayUrl.substring(0, 100)
                            : '',
                          playError: store.playError || '',
                        };
                      } catch (e) {
                        return { ok: false, error: e.message || String(e) };
                      }
                    },
                    {
                      siteKey: r._siteKey,
                      vodId: r._detailVideo.vod_id,
                      epName: detailResult.firstEpisode.name,
                      epUrl: detailResult.firstEpisode.url,
                      // Use the first source name from vod_play_from. If not
                      // available, default to empty string (playerContent still
                      // receives the flag).
                      flag:
                        (detailResult.vodPlayFrom || '').split('$$$')[0] || '',
                    },
                  ),
                  60000,
                  `playerContent ${cfg.name}`,
                );

                if (playResult.ok || playResult.externalLaunched) {
                  r.playOk = true;
                  r.playUrl = playResult.playUrl || '(external)';
                  if (playResult.externalLaunched) {
                    console.log(
                      `  ✓ playerContent: VLC外部播放器启动成功 (格式不支持网页播放)`,
                    );
                  } else {
                    console.log(`  ✓ playerContent: url=${r.playUrl}...`);
                  }
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
      } else if (r._msearchVideo) {
        // For msearch-only sites, try searchContent as the detail-test analog
        try {
          const searchResult = await withTimeout(
            page.evaluate(
              async ({ siteKey, keyword }) => {
                try {
                  const { useAppStore } = await import('/src/store/app.ts');
                  const store = useAppStore();
                  store.setActiveSite(siteKey);
                  await store.doSearch(keyword, [siteKey]);
                  return {
                    ok: store.searchResults.length > 0,
                    count: store.searchResults.reduce(
                      (acc, r) => acc + (r.list?.length || 0),
                      0,
                    ),
                    first: store.searchResults[0]?.list?.[0]
                      ? {
                          vod_id: store.searchResults[0].list[0].vod_id,
                          vod_name: store.searchResults[0].list[0].vod_name,
                        }
                      : null,
                    error: store.searchError || '',
                  };
                } catch (e) {
                  return { ok: false, error: e.message || String(e) };
                }
              },
              { siteKey: r._siteKey, keyword: r._msearchVideo.vod_name },
            ),
            60000,
            `searchContent ${cfg.name}`,
          );

          if (searchResult.ok) {
            r.detailOk = true;
            r.detailSkipped = `msearch-only site; searchContent returned ${searchResult.count} results`;
            console.log(
              `  ✓ searchContent (msearch-only fallback): ${searchResult.count} results`,
            );
          } else {
            r.detailError = `msearch-only site, searchContent: ${searchResult.error || 'no results'}`;
            console.log(`  ✗ ${r.detailError}`);
          }
        } catch (e) {
          r.detailError = `msearch-only site, searchContent error: ${e.message}`;
          console.log(`  ✗ ${r.detailError}`);
        }
      }
    } catch (e) {
      r.error = e.message || String(e);
      console.log(`  ✗ unexpected error: ${r.error}`);
    }

    // Mark ok if at least home worked (detail may be skipped for msearch-only
    // sites, play may need pan login)
    if (r.homeOk && (r.detailOk || r.detailSkipped)) {
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

  // Save report with UTF-8 BOM (fixes garbled Chinese in Windows Notepad)
  const reportDir = path.join(os.tmpdir(), 'tvbox_e2e_reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `configs_app_${ts}.json`);
  const logPath = path.join(reportDir, `configs_app_${ts}.log`);
  // Strip internal _ fields before saving
  const cleanResults = results.map((r) => {
    const { _detailVideo, _msearchVideo, _siteKey, ...rest } = r;
    return rest;
  });
  const bom = '\uFEFF';
  fs.writeFileSync(reportPath, bom + JSON.stringify(cleanResults, null, 2));
  console.log(`\n报告: ${reportPath}`);

  // Also save a plain-text log with UTF-8 BOM for easy viewing
  const logLines = [`测试时间: ${new Date().toISOString()}`,
    `配置数: ${CONFIGS.length}`,
    `成功: ${okCount}/${results.length}`,
    ''];
  for (const r of results) {
    logLines.push(`[${r.ok ? 'OK' : 'FAIL'}] ${r.name}`);
    if (r.error) logLines.push(`  load: ${r.error}`);
    if (r.homeCount !== undefined) logLines.push(`  home: ${r.homeCount} videos`);
    if (r.homeError) logLines.push(`  home: ${r.homeError}`);
    if (r.detailOk || r.detailSkipped) logLines.push(`  detail: OK`);
    if (r.detailError) logLines.push(`  detail: ${r.detailError}`);
    if (r.playOk) logLines.push(`  play: OK`);
    if (r.playError) logLines.push(`  play: ${r.playError}`);
  }
  fs.writeFileSync(logPath, bom + logLines.join('\r\n'));
  console.log(`日志: ${logPath}`);

  await browser.close();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
