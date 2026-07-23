import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

// 多仓配置 URL
const MULTI_CONFIG_URL = 'https://d.kstore.dev/download/12441/dc6.json';

// 测试超时设置（毫秒）
const CONFIG_LOAD_TIMEOUT = 30000;
const HOME_LOAD_TIMEOUT = 60000;
const DETAIL_LOAD_TIMEOUT = 30000;
const PLAY_TIMEOUT = 30000;

// 测试结果接口
interface TestResult {
  configName: string;
  siteName: string;
  siteKey: string;
  homeSuccess: boolean;
  homeCount: number;
  detailSuccess: boolean;
  detailEpisodes: number;
  playSuccess: boolean;
  playUrl: string;
  error?: string;
}

// 全局测试结果数组
const testResults: TestResult[] = [];

test.describe.serial('多仓配置 E2E 测试', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    // 启动 Electron 应用
    electronApp = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
    });

    // 获取主窗口
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    
    // 等待应用完全加载
    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    // 生成测试报告
    console.log('\n=== 测试报告 ===');
    console.log(`总测试数: ${testResults.length}`);
    
    const successCount = testResults.filter(r => r.homeSuccess && r.detailSuccess && r.playSuccess).length;
    const homeSuccessCount = testResults.filter(r => r.homeSuccess).length;
    const detailSuccessCount = testResults.filter(r => r.detailSuccess).length;
    const playSuccessCount = testResults.filter(r => r.playSuccess).length;
    
    console.log(`完全成功: ${successCount} (${((successCount / testResults.length) * 100).toFixed(2)}%)`);
    console.log(`首页成功: ${homeSuccessCount} (${((homeSuccessCount / testResults.length) * 100).toFixed(2)}%)`);
    console.log(`详情成功: ${detailSuccessCount} (${((detailSuccessCount / testResults.length) * 100).toFixed(2)}%)`);
    console.log(`播放成功: ${playSuccessCount} (${((playSuccessCount / testResults.length) * 100).toFixed(2)}%)`);
    
    // 输出失败的源
    const failedTests = testResults.filter(r => !r.homeSuccess || !r.detailSuccess || !r.playSuccess);
    if (failedTests.length > 0) {
      console.log('\n=== 失败的源 ===');
      failedTests.forEach(r => {
        console.log(`${r.configName} - ${r.siteName}: ${r.error || '未知错误'}`);
      });
    }
    
    // 保存详细报告到文件
    const fs = await import('fs');
    const reportPath = `test-report-${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2));
    console.log(`\n详细报告已保存到: ${reportPath}`);
    
    await electronApp.close();
  });

  test('加载多仓配置并测试所有源', async () => {
    // 1. 导航到设置页面
    console.log('\n=== 导航到设置页面 ===');
    await page.click('a[href="/settings"]');
    await page.waitForTimeout(1000);
    
    // 2. 加载多仓配置
    console.log(`\n=== 加载配置: ${MULTI_CONFIG_URL} ===`);
    await page.fill('input[placeholder*="配置订阅地址"]', MULTI_CONFIG_URL);
    await page.click('button:has-text("加载")');
    console.log('已点击加载按钮，等待配置加载...');
    
    // 等待配置加载完成（出现配置选择器）
    await page.waitForSelector('.el-select', { timeout: CONFIG_LOAD_TIMEOUT });
    console.log('配置加载完成');
    
    // 3. 获取所有子配置
    const subConfigs = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('.el-select .el-option'));
      return options.map((opt, idx) => ({
        name: opt.getAttribute('label') || opt.textContent?.trim() || '',
        index: idx
      }));
    });
    
    console.log(`\n发现 ${subConfigs.length} 个子配置:`);
    subConfigs.forEach((cfg, idx) => {
      console.log(`  ${idx + 1}. ${cfg.name}`);
    });
    
    // 4. 遍历每个子配置
    for (let i = 0; i < subConfigs.length; i++) {
      const config = subConfigs[i];
      console.log(`\n${'='.repeat(60)}`);
      console.log(`测试配置 ${i + 1}/${subConfigs.length}: ${config.name}`);
      console.log('='.repeat(60));
      
      // 选择配置
      await page.click('.el-select');
      await page.waitForTimeout(500);
      await page.click(`.el-select-dropdown__item:has-text("${config.name}")`);
      await page.waitForTimeout(3000); // 等待配置加载
      
      // 获取当前配置的所有源（从设置页面的源列表标签）
      const sources = await page.evaluate(() => {
        const siteTags = Array.from(document.querySelectorAll('.el-tag'));
        return siteTags.map(tag => ({
          name: tag.textContent?.trim() || ''
        }));
      });
      
      console.log(`发现 ${sources.length} 个源`);
      
      // 5. 测试每个源
      for (let j = 0; j < sources.length; j++) {
        const source = sources[j];
        const result: TestResult = {
          configName: config.name,
          siteName: source.name,
          siteKey: source.name,
          homeSuccess: false,
          homeCount: 0,
          detailSuccess: false,
          detailEpisodes: 0,
          playSuccess: false,
          playUrl: ''
        };
        
        try {
          console.log(`\n  [${j + 1}/${sources.length}] 测试源: ${source.name}`);
          
          // 选择源（点击源标签）
          await page.click(`.el-tag:has-text("${source.name}")`);
          await page.waitForTimeout(2000);
          
          // 导航到首页
          await page.click('a[href="/"]');
          await page.waitForTimeout(1000);
          
          // 测试首页
          console.log('    测试首页...');
          await page.waitForTimeout(3000); // 等待首页数据加载
          
          const homeResult = await page.evaluate(() => {
            const vodCards = document.querySelectorAll('.vod-card');
            return vodCards.length;
          });
          
          result.homeCount = homeResult;
          result.homeSuccess = homeResult > 0;
          console.log(`    首页视频数: ${homeResult}`);
          
          if (!result.homeSuccess) {
            result.error = '首页无内容';
            testResults.push(result);
            console.log('    ✗ 首页测试失败');
            continue;
          }
          
          // 点击第一个视频进入详情页
          console.log('    测试详情页...');
          await page.click('.vod-card:first-child');
          await page.waitForTimeout(3000);
          
          // 检查详情页是否加载成功（检查是否有播放源标签或按钮）
          const detailResult = await page.evaluate(() => {
            // 检查是否有视频卡片或播放源信息
            const hasContent = document.querySelector('.el-tag, .el-button, [class*="episode"], [class*="play"]');
            return hasContent !== null;
          });
          
          result.detailSuccess = detailResult;
          result.detailEpisodes = detailResult ? 1 : 0;
          console.log(`    详情页加载: ${detailResult ? '成功' : '失败'}`);
          
          if (!result.detailSuccess) {
            result.error = '详情页加载失败';
            await page.click('button:has-text("返回"), a[href="/"]');
            await page.waitForTimeout(1000);
            testResults.push(result);
            console.log('    ✗ 详情页测试失败');
            continue;
          }
          
          // 尝试播放第一个剧集
          console.log('    测试播放...');
          
          // 查找播放按钮或剧集按钮
          const playButtonSelector = await page.evaluate(() => {
            const selectors = [
              '.el-button:has-text("播放")',
              '.el-button:has-text("第1集")',
              'button:has-text("播放")',
              'button:has-text("第1集")',
              '.el-tag:has-text("播放")',
              '[class*="play"] button',
              '[class*="episode"] button'
            ];
            
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (el) return selector;
            }
            return null;
          });
          
          if (playButtonSelector) {
            await page.click(playButtonSelector);
            await page.waitForTimeout(5000); // 等待播放器加载
            
            // 检查是否有视频元素
            const playResult = await page.evaluate(() => {
              const video = document.querySelector('video');
              if (!video) return { success: false, url: '' };
              
              const hasVideo = video.readyState >= 2;
              const playUrl = video.src || (video.querySelector('source') as HTMLSourceElement)?.src || '';
              return { success: hasVideo, url: playUrl };
            });
            
            result.playSuccess = playResult.success;
            result.playUrl = playResult.url;
            console.log(`    播放状态: ${playResult.success ? '成功' : '失败'}`);
            if (playResult.url) {
              console.log(`    播放URL: ${playResult.url.substring(0, 80)}...`);
            }
            
            if (!result.playSuccess) {
              result.error = '视频无法播放';
            }
          } else {
            result.error = '未找到播放按钮';
            console.log('    ✗ 未找到播放按钮');
          }
          
          // 返回首页
          await page.click('a[href="/"]');
          await page.waitForTimeout(1000);
          
          console.log(`    结果: 首页=${result.homeCount}, 详情=${result.detailSuccess ? '✓' : '✗'}, 播放=${result.playSuccess ? '✓' : '✗'}`);
          
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          console.error(`    ✗ 测试异常: ${result.error}`);
        }
        
        testResults.push(result);
      }
    }
    
    // 输出统计
    const successCount = testResults.filter(r => r.homeSuccess && r.detailSuccess && r.playSuccess).length;
    console.log(`\n完全成功的源: ${successCount}/${testResults.length}`);
    
    // 不强制要求全部通过，因为有些源可能本身就是无效的
  }, { timeout: 60 * 60 * 1000 }); // 60 分钟超时
});
