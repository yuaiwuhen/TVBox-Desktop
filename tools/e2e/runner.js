/**
 * E2E Test Runner - 端到端测试执行器
 *
 * 使用 POM (Page Object Model) 设计模式，对 TVBox Desktop 应用进行完整测试。
 *
 * 测试范围:
 * 1. 所有内容源的首页功能验证（homeContent）
 * 2. 所有内容源的详情页功能测试（detailContent）
 * 3. 所有播放链接可用性验证（playerContent）
 * 4. 网盘源专项测试（夸克/百度/UC/阿里/B站）
 *
 * 测试要求:
 * - 覆盖所有内容源（不遗漏）
 * - 每个源至少测试3个视频的详情页
 * - 每个详情页的所有播放源都要测试
 *
 * 用法:
 *   node tools/e2e/runner.js [--quick] [--source=xxx]
 *
 * 参数:
 *   --quick          快速模式：每源仅测1个视频，仅测前3个播放源
 *   --source=KEY     只测试指定源
 *   --no-pan         跳过网盘专项测试
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HomePage = require('./pages/HomePage');
const DetailPage = require('./pages/DetailPage');
const { SOURCES, PAN_TESTS } = require('./data/sources');
const Reporter = require('./reporter');

const CDP_URL = 'http://127.0.0.1:9222';
const QUICK_MODE = process.argv.includes('--quick');
const SOURCE_FILTER = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1];
const SKIP_PAN = process.argv.includes('--no-pan');

// 测试配置
const CONFIG = {
  // 每个源测试的视频数量
  videosPerSource: QUICK_MODE ? 1 : 3,
  // 每个详情页测试的播放源数量上限（0表示全部）
  maxPlaySourcesPerDetail: QUICK_MODE ? 3 : 0,
  // 每个播放源测试的剧集数量
  episodesPerSource: QUICK_MODE ? 1 : 1,
  // 单次操作超时(ms)
  timeout: 45000,
};

/**
 * 格式化耗时
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 主测试函数
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      TVBox Desktop - E2E 测试套件 (POM 设计)             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n模式: ${QUICK_MODE ? '快速' : '完整'}`);
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`配置: 每源 ${CONFIG.videosPerSource} 视频, 每详情 ${CONFIG.maxPlaySourcesPerDetail || '全部'} 播放源\n`);

  // ========== 连接 Electron ==========
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error('❌ 无法连接到 Electron 应用。请确保应用已启动并启用 9222 调试端口。');
    console.error('   启动命令: pnpm dev');
    console.error('   错误详情:', e.message);
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

  const homePage = new HomePage(page);
  const detailPage = new DetailPage(page);
  const reporter = new Reporter();
  reporter.start();

  // ========== Phase 1: 前置条件 - 加载 JAR ==========
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1: 前置条件 - 加载全局 JAR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const jarResult = await homePage.loadJar();
  if (!jarResult.success) {
    console.error('❌ JAR 加载失败:', jarResult.error);
    await browser.close();
    process.exit(1);
  }
  console.log('✓ JAR 加载成功\n');

  // ========== 同步网盘 cookie 到 JVM ==========
  // E2E 测试直接调用 jar:callMethod IPC，绕过了 JarSpider.callMethod()，
  // 后者会自动从 localStorage 读取 pan cookie。这里通过 pan:syncAllCookies
  // IPC 把 localStorage 的 cookie 同步到 spider 的 SharedPreferences，
  // 同时 getPlayerContent 也会直接传 extraCookies 给 IPC。
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1.5: 同步网盘 cookie 到 JVM');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  try {
    const syncResult = await homePage.syncPanCookiesToJVM();
    if (syncResult.synced.length > 0) {
      console.log(`✓ 已同步 ${syncResult.synced.length} 个网盘: ${syncResult.synced.join(', ')}\n`);
    } else {
      console.log('⚠ 未检测到任何网盘登录信息（localStorage 无 pan_login_*）\n');
    }
  } catch (e) {
    console.log(`⚠ 同步 cookie 失败: ${e.message}\n`);
  }

  // ========== Phase 2: 所有源首页测试 ==========
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 2: 所有源首页功能验证');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const sourcesToTest = SOURCE_FILTER
    ? SOURCES.filter((s) => s.key === SOURCE_FILTER)
    : SOURCES;

  console.log(`共 ${sourcesToTest.length} 个源待测试\n`);

  const homeOkSources = [];

  for (let i = 0; i < sourcesToTest.length; i++) {
    const source = sourcesToTest[i];
    const t0 = Date.now();

    const result = {
      sourceKey: source.key,
      sourceName: source.name,
      category: source.category,
      success: false,
      videoCount: 0,
      classCount: 0,
      firstVideoName: '',
      firstVideoId: '',
      allVideos: [],
      allClasses: [],
      error: '',
      duration: 0,
    };

    try {
      console.log(`[${String(i + 1).padStart(2)}/${sourcesToTest.length}] 测试首页: ${source.key} (${source.name})`);

      const home = await homePage.testHomeContent(source.key, source.api, source.ext);

      result.success = home.success;
      result.videoCount = home.videoCount;
      result.classCount = home.classCount;
      result.allVideos = home.allVideos || [];
      result.allClasses = home.allClasses || [];
      result.error = home.error || '';

      if (home.firstVideo) {
        result.firstVideoName = home.firstVideo.vod_name || '';
        result.firstVideoId = home.firstVideo.vod_id || '';
      }

      result.duration = (Date.now() - t0) / 1000;

      const icon = result.success ? '✓' : '✗';
      console.log(`  ${icon} ${result.success ? 'PASS' : 'FAIL'} - 视频数=${result.videoCount}, 分类数=${result.classCount}, 耗时=${formatDuration(Date.now() - t0)}`);
      if (result.error) console.log(`    错误: ${result.error.substring(0, 100)}`);

      if (result.success) homeOkSources.push({ source, videos: result.allVideos });
    } catch (e) {
      result.error = (e.message || String(e)).substring(0, 200);
      result.duration = (Date.now() - t0) / 1000;
      console.log(`  ✗ ERROR - ${result.error}`);
    }

    reporter.addHomeResult(result);
  }

  console.log(`\n首页测试完成: ✓ ${reporter.results.summary.homeOk}  ✗ ${reporter.results.summary.homeFailed}\n`);

  // ========== Phase 3: 详情页 + 播放源测试 ==========
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 3: 详情页功能 + 所有播放链接测试');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (let si = 0; si < homeOkSources.length; si++) {
    const { source, videos } = homeOkSources[si];
    console.log(`\n[${String(si + 1).padStart(2)}/${homeOkSources.length}] 源: ${source.key} (${source.name})`);
    console.log(`  可用视频数: ${videos.length}`);

    // 测试前 N 个视频
    const videosToTest = videos.slice(0, CONFIG.videosPerSource);
    for (let vi = 0; vi < videosToTest.length; vi++) {
      const video = videosToTest[vi];
      const t0 = Date.now();

      const detailResult = {
        sourceKey: source.key,
        vodId: video.vod_id,
        vodName: video.vod_name,
        success: false,
        detailItems: 0,
        playSourceCount: 0,
        playableCount: 0,
        error: '',
        duration: 0,
      };

      try {
        console.log(`\n  [视频 ${vi + 1}/${videosToTest.length}] ${video.vod_name} (vod_id=${video.vod_id})`);

        // 获取详情
        const detail = await detailPage.testDetailContent(source.key, video.vod_id);
        detailResult.detailItems = detail.detailItems;
        detailResult.success = detail.success;
        detailResult.error = detail.error || '';

        if (!detail.success) {
          console.log(`    ✗ 详情获取失败: ${detailResult.error}`);
          detailResult.duration = (Date.now() - t0) / 1000;
          reporter.addDetailResult(detailResult);
          continue;
        }

        console.log(`    ✓ 详情获取成功: ${detailResult.detailItems} 项, ${detail.playSources.length} 个播放源`);

        // 测试每个播放源
        const playSourcesToTest =
          CONFIG.maxPlaySourcesPerDetail > 0
            ? detail.playSources.slice(0, CONFIG.maxPlaySourcesPerDetail)
            : detail.playSources;

        detailResult.playSourceCount = playSourcesToTest.length;

        for (let pi = 0; pi < playSourcesToTest.length; pi++) {
          const ps = playSourcesToTest[pi];
          const playResult = {
            sourceKey: source.key,
            vodName: video.vod_name,
            flag: ps.flag,
            episodeName: ps.episodes[0]?.name || '',
            success: false,
            url: '',
            msg: '',
            error: '',
          };

          try {
            const play = await detailPage.testPlaySource(source.key, ps);
            playResult.success = play.success;
            playResult.url = play.url;
            playResult.msg = play.msg;
            playResult.error = play.error || '';

            if (play.success) {
              detailResult.playableCount++;
              console.log(`      ✓ [${pi + 1}/${playSourcesToTest.length}] ${ps.flag} - URL: ${play.url.substring(0, 80)}`);
            } else {
              const needsLogin = /登录|login|未登录|auth|cookie/i.test(play.msg || '');
              console.log(`      ${needsLogin ? '🔑' : '✗'} [${pi + 1}/${playSourcesToTest.length}] ${ps.flag} - ${play.msg || 'No URL'}`);
            }
          } catch (e) {
            playResult.error = (e.message || String(e)).substring(0, 100);
            console.log(`      ✗ [${pi + 1}/${playSourcesToTest.length}] ${ps.flag} - ${playResult.error}`);
          }

          reporter.addPlayResult(playResult);
        }

        detailResult.duration = (Date.now() - t0) / 1000;
        console.log(`    耗时: ${formatDuration(Date.now() - t0)}`);
      } catch (e) {
        detailResult.error = (e.message || String(e)).substring(0, 200);
        detailResult.duration = (Date.now() - t0) / 1000;
        console.log(`    ✗ 异常: ${detailResult.error}`);
      }

      reporter.addDetailResult(detailResult);
    }
  }

  console.log(`\n详情页测试完成: ✓ ${reporter.results.summary.detailOk}  ✗ ${reporter.results.summary.detailFailed}`);
  console.log(`播放源测试完成: ✓ ${reporter.results.summary.playOk}  ✗ ${reporter.results.summary.playFailed}\n`);

  // ========== Phase 4: 网盘源专项测试 ==========
  if (!SKIP_PAN) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 4: 网盘源专项测试 (夸克/百度/UC/阿里/B站)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const panTest of PAN_TESTS) {
      const t0 = Date.now();
      const result = {
        label: panTest.label,
        panType: panTest.panType,
        status: 'unknown',
        success: false,
        panSourcesFound: 0,
        panSourcesPlayable: 0,
        details: [],
        error: '',
        duration: 0,
      };

      try {
        console.log(`测试: ${panTest.label}`);

        // 获取 spider
        const spiderResult = await homePage.getSpider(panTest.siteKey, panTest.api, panTest.ext);
        if (!spiderResult.success) {
          result.status = 'ERROR';
          result.error = `getSpider: ${spiderResult.error}`;
          result.duration = (Date.now() - t0) / 1000;
          console.log(`  ✗ ${result.error}\n`);
          reporter.addPanResult(result);
          continue;
        }
        await homePage.initSpider(panTest.siteKey, panTest.ext);

        // 获取视频列表
        const home = await homePage.getHomeContent(panTest.siteKey);
        let videos = home.list;
        if (videos.length === 0 && home.classes.length > 0) {
          const cat = await homePage.getCategoryContent(panTest.siteKey, String(home.classes[0].type_id), '1');
          videos = cat.list;
        }

        if (videos.length === 0) {
          result.status = 'NO_VIDEOS';
          result.error = 'No videos found';
          result.duration = (Date.now() - t0) / 1000;
          console.log(`  ✗ 无视频\n`);
          reporter.addPanResult(result);
          continue;
        }

        // 遍历视频，寻找匹配的网盘源
        for (let vi = 0; vi < Math.min(videos.length, 3); vi++) {
          const vod = videos[vi];
          const detail = await detailPage.getDetailContent(panTest.siteKey, vod.vod_id);
          if (detail.list.length === 0) continue;

          const vodDetail = detail.list[0];
          const playSources = detailPage.parsePlaySources(vodDetail);

          for (const ps of playSources) {
            // 检查 flag 是否匹配目标网盘
            const flagLower = ps.flag.toLowerCase();
            const isTarget = panTest.flagKeywords.some((kw) => {
              const kwLower = kw.toLowerCase();
              return flagLower.includes(kwLower) || kwLower.includes(flagLower);
            });

            if (!isTarget) continue;

            result.panSourcesFound++;
            const play = await detailPage.testPlaySource(panTest.siteKey, ps);

            result.details.push({
              vodName: vod.vod_name,
              flag: ps.flag,
              hasUrl: play.success,
              url: play.url ? play.url.substring(0, 80) : '',
              msg: play.msg,
            });

            if (play.success) {
              result.panSourcesPlayable++;
            }
          }
        }

        if (result.panSourcesFound === 0) {
          result.status = 'NO_PAN_SOURCE';
        } else if (result.panSourcesPlayable > 0) {
          result.status = 'OK';
          result.success = true;
        } else {
          result.status = 'NO_PLAY';
          // 检查是否需要登录
          const needsLogin = result.details.some((d) =>
            d.msg && /登录|login|未登录|auth|cookie/i.test(d.msg),
          );
          if (needsLogin) result.status = 'NEEDS_LOGIN';
        }

        result.duration = (Date.now() - t0) / 1000;
        const icon = result.success ? '✓' : result.status === 'NEEDS_LOGIN' ? '🔑' : '✗';
        console.log(`  ${icon} ${result.status} - 找到 ${result.panSourcesFound} 个源, ${result.panSourcesPlayable} 可播放`);
        if (result.details.length > 0) {
          result.details.forEach((d) => {
            console.log(`    ${d.hasUrl ? '✓' : '✗'} ${d.vodName} [${d.flag}]: ${d.msg || (d.hasUrl ? 'OK' : 'FAIL')}`);
          });
        }
        console.log('');
      } catch (e) {
        result.status = 'ERROR';
        result.error = (e.message || String(e)).substring(0, 200);
        result.duration = (Date.now() - t0) / 1000;
        console.log(`  ✗ 异常: ${result.error}\n`);
      }

      reporter.addPanResult(result);
    }

    console.log(`网盘源测试完成: ✓ ${reporter.results.summary.panOk}  ✗ ${reporter.results.summary.panFailed}\n`);
  }

  // ========== 生成报告 ==========
  reporter.end();
  reporter.printSummary();

  const reportDir = path.join(os.tmpdir(), 'tvbox_e2e_reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `report_${timestamp}.json`);
  const htmlPath = path.join(reportDir, `report_${timestamp}.html`);

  reporter.saveJson(jsonPath);
  reporter.saveHtml(htmlPath);

  await browser.close();
  console.log('测试完成。');

  // Exit code: 0 if all passed, 1 if any failed
  const totalFailed =
    reporter.results.summary.homeFailed +
    reporter.results.summary.detailFailed +
    reporter.results.summary.playFailed +
    reporter.results.summary.panFailed;
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(2);
});
