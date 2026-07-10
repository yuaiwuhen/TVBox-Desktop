/**
 * 直接测试 WexGuaZi spider 加载和调用
 */
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');

// 简化的测试（不启动 Electron）
async function testWexGuaZiSpider() {
  console.log('=' .repeat(60));
  console.log('测试 WexGuaZi spider');
  console.log('=' .repeat(60));

  const jarCacheDir = path.join(__dirname, 'jar_cache');
  const guaziDir = path.join(jarCacheDir, 'WexGuaZiGuard');
  const libPath = path.join(guaziDir, 'libLoadNiMa.so');

  // 检查目录结构
  console.log('\n[1] 检查目录结构:');
  console.log(`  jar_cache: ${jarCacheDir} - ${fs.existsSync(jarCacheDir) ? '✓存在' : '✗不存在'}`);
  console.log(`  WexGuaZiGuard: ${guaziDir} - ${fs.existsSync(guaziDir) ? '✓存在' : '✗不存在'}`);
  console.log(`  libLoadNiMa.so: ${libPath} - ${fs.existsSync(libPath) ? '✓存在' : '✗不存在'}`);

  // 检查 stub JAR
  const stubJar = path.join(__dirname, 'tools', 'tvbox-spider-stubs-complete.jar');
  console.log(`  stub JAR: ${stubJar} - ${fs.existsSync(stubJar) ? '✓存在' : '✗不存在'}`);

  // 检查 stub JAR 中是否有 LoadNiMa.class
  if (fs.existsSync(stubJar)) {
    console.log('\n[2] 检查 stub JAR 内容:');
    try {
      const jarList = execSync(`jar tf "${stubJar}"`, { encoding: 'utf8' });
      const hasLoadNiMa = jarList.includes('com/wexfnw/libso/LoadNiMa.class');
      console.log(`  LoadNiMa.class: ${hasLoadNiMa ? '✓存在' : '✗不存在'}`);
      if (hasLoadNiMa) {
        const match = jarList.match(/com\/wexfnw\/libso\/LoadNiMa\.class/);
        if (match) {
          console.log(`    文件路径: ${match[0]}`);
        }
      }
    } catch (e) {
      console.log(`  ✗ 无法列出 JAR 内容: ${e.message}`);
    }
  }

  // 检查 wexguard JAR
  const wexguardJar = path.join(__dirname, 'tools', 'wexguard_work', 'wexguard-spider-enjarify.jar');
  console.log(`  wexguard JAR: ${wexguardJar} - ${fs.existsSync(wexguardJar) ? '✓存在' : '✗不存在'}`);

  if (fs.existsSync(wexguardJar)) {
    console.log('\n[3] 检查 wexguard JAR 内容:');
    try {
      const jarList = execSync(`jar tf "${wexguardJar}"`, { encoding: 'utf8' });

      // 检查关键类
      const classesToCheck = [
        'com/wexfnw/libso/LoadNiMa.class',
        'com/github/catvod/spider/WexGuaZi.class',
        'com/github/catvod/spider/WexGuaZiGuard.class',
        'com/github/catvod/spider/InitOrigin.class'
      ];

      for (const cls of classesToCheck) {
        const exists = jarList.includes(cls);
        console.log(`  ${cls}: ${exists ? '✓存在' : '✗不存在'}`);
      }
    } catch (e) {
      console.log(`  ✗ 无法列出 JAR 内容: ${e.message}`);
    }
  }

  // 测试结论
  console.log('\n[测试结论]');
  console.log('当前状态:');
  console.log('  1. libLoadNiMa.so 不存在（需要下载或提取）');
  console.log('  2. stub JAR 应包含 LoadNiMa.class（替代 native library调用）');
  console.log('  3. wexguard JAR 包含 WexGuaZi和LoadNiMa.class');
  console.log('\n问题:');
  console.log('  如果 stub JAR 的 LoadNiMa.class被加载，它会替代wexguard中的原始类');
  console.log('  但 stub 需要 libLoadNiMa.so 来调用unidbg解密');
  console.log('\n解决方案:');
  console.log('  方案1: 实现libLoadNiMa.so下载逻辑（从InitOrigin代码提取URL）');
  console.log('  方案2: 修改stub，在没有native library时返回mock数据');
  console.log('  方案3: 直接调用WexGuaZi的API，绕过解密步骤（如果可能）');
}

testWexGuaZiSpider().catch(console.error);