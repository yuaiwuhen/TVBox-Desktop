/**
 * Reporter - 测试报告生成器
 *
 * 生成 JSON 和 HTML 两种格式的测试报告：
 * - JSON: 详细数据，便于程序化分析
 * - HTML: 可视化报告，便于人工查看
 */
const fs = require('fs');
const path = require('path');

class Reporter {
  constructor() {
    this.results = {
      startTime: null,
      endTime: null,
      summary: {
        totalSources: 0,
        homeOk: 0,
        homeFailed: 0,
        detailOk: 0,
        detailFailed: 0,
        playOk: 0,
        playFailed: 0,
        panOk: 0,
        panFailed: 0,
      },
      homeResults: [],
      detailResults: [],
      playResults: [],
      panResults: [],
    };
  }

  start() {
    this.results.startTime = new Date().toISOString();
  }

  end() {
    this.results.endTime = new Date().toISOString();
    const start = new Date(this.results.startTime);
    const end = new Date(this.results.endTime);
    this.results.summary.duration = (end - start) / 1000;
  }

  addHomeResult(result) {
    this.results.homeResults.push(result);
    if (result.success) this.results.summary.homeOk++;
    else this.results.summary.homeFailed++;
  }

  addDetailResult(result) {
    this.results.detailResults.push(result);
    if (result.success) this.results.summary.detailOk++;
    else this.results.summary.detailFailed++;
  }

  addPlayResult(result) {
    this.results.playResults.push(result);
    if (result.success) this.results.summary.playOk++;
    else this.results.summary.playFailed++;
  }

  addPanResult(result) {
    this.results.panResults.push(result);
    if (result.success) this.results.summary.panOk++;
    else this.results.summary.panFailed++;
  }

  /**
   * 生成 JSON 报告
   * @param {string} outputPath
   */
  /** UTF-8 BOM for Windows file associations */
  static get BOM() { return '\uFEFF'; }

  saveJson(outputPath) {
    fs.writeFileSync(outputPath, Reporter.BOM + JSON.stringify(this.results, null, 2));
    console.log(`JSON report saved: ${outputPath}`);
  }

  /**
   * 生成 HTML 报告
   * @param {string} outputPath
   */
  saveHtml(outputPath) {
    const html = this.generateHtml();
    fs.writeFileSync(outputPath, Reporter.BOM + html);
    console.log(`HTML report saved: ${outputPath}`);
  }

  generateHtml() {
    const s = this.results.summary;
    const duration = s.duration ? `${s.duration.toFixed(1)}s` : 'N/A';

    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>TVBox Desktop E2E 测试报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { color: #f8fafc; margin-bottom: 8px; font-size: 24px; }
  .meta { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
  .stat-card.ok { border-color: #10b981; }
  .stat-card.fail { border-color: #ef4444; }
  .stat-card.warn { border-color: #f59e0b; }
  .stat-label { font-size: 12px; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .stat-value.ok { color: #10b981; }
  .stat-value.fail { color: #ef4444; }
  .stat-value.warn { color: #f59e0b; }
  section { background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; }
  h2 { color: #f8fafc; font-size: 18px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #334155; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #334155; }
  th { color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  tr:hover { background: #334155; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: rgba(16, 185, 129, 0.15); color: #10b981; }
  .badge.fail { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
  .badge.warn { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
  .badge.info { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
  .error-msg { color: #fca5a5; font-size: 12px; word-break: break-all; max-width: 300px; }
  .progress-bar { height: 8px; background: #334155; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #10b981, #34d399); }
  .collapsible { cursor: pointer; user-select: none; }
  .collapsible:hover { color: #60a5fa; }
  .hidden { display: none; }
  .duration { color: #64748b; font-size: 11px; }
</style>
</head>
<body>
<div class="container">
  <h1>TVBox Desktop E2E 测试报告</h1>
  <div class="meta">
    开始时间: ${this.results.startTime}<br>
    结束时间: ${this.results.endTime}<br>
    总耗时: ${duration}
  </div>

  <div class="summary-grid">
    <div class="stat-card ok">
      <div class="stat-label">首页测试通过</div>
      <div class="stat-value ok">${s.homeOk}</div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${(s.homeOk / (s.homeOk + s.homeFailed || 1)) * 100}%"></div></div>
    </div>
    <div class="stat-card fail">
      <div class="stat-label">首页测试失败</div>
      <div class="stat-value fail">${s.homeFailed}</div>
    </div>
    <div class="stat-card ok">
      <div class="stat-label">详情页测试通过</div>
      <div class="stat-value ok">${s.detailOk}</div>
    </div>
    <div class="stat-card fail">
      <div class="stat-label">详情页测试失败</div>
      <div class="stat-value fail">${s.detailFailed}</div>
    </div>
    <div class="stat-card ok">
      <div class="stat-label">播放源测试通过</div>
      <div class="stat-value ok">${s.playOk}</div>
    </div>
    <div class="stat-card fail">
      <div class="stat-label">播放源测试失败</div>
      <div class="stat-value fail">${s.playFailed}</div>
    </div>
    <div class="stat-card ok">
      <div class="stat-label">网盘源测试通过</div>
      <div class="stat-value ok">${s.panOk}</div>
    </div>
    <div class="stat-card fail">
      <div class="stat-label">网盘源测试失败</div>
      <div class="stat-value fail">${s.panFailed}</div>
    </div>
  </div>

  ${this.generateHomeSection()}
  ${this.generateDetailSection()}
  ${this.generatePlaySection()}
  ${this.generatePanSection()}
</div>
</body>
</html>`;
    return html;
  }

  generateHomeSection() {
    const rows = this.results.homeResults
      .map(
        (r) => `
      <tr>
        <td>${r.sourceKey}</td>
        <td>${r.sourceName}</td>
        <td><span class="badge ${r.success ? 'ok' : 'fail'}">${r.success ? 'PASS' : 'FAIL'}</span></td>
        <td>${r.videoCount}</td>
        <td>${r.classCount}</td>
        <td>${r.firstVideoName || '-'}</td>
        <td class="error-msg">${r.error || '-'}</td>
        <td class="duration">${r.duration ? r.duration.toFixed(1) + 's' : '-'}</td>
      </tr>`,
      )
      .join('');

    return `
    <section>
      <h2>首页测试结果 (${this.results.homeResults.length})</h2>
      <table>
        <thead>
          <tr><th>源 Key</th><th>源名称</th><th>状态</th><th>视频数</th><th>分类数</th><th>首个视频</th><th>错误信息</th><th>耗时</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  generateDetailSection() {
    const rows = this.results.detailResults
      .map(
        (r) => `
      <tr>
        <td>${r.sourceKey}</td>
        <td>${r.vodName || r.vodId}</td>
        <td><span class="badge ${r.success ? 'ok' : 'fail'}">${r.success ? 'PASS' : 'FAIL'}</span></td>
        <td>${r.detailItems}</td>
        <td>${r.playSourceCount}</td>
        <td>${r.playableCount}</td>
        <td class="error-msg">${r.error || '-'}</td>
        <td class="duration">${r.duration ? r.duration.toFixed(1) + 's' : '-'}</td>
      </tr>`,
      )
      .join('');

    return `
    <section>
      <h2>详情页测试结果 (${this.results.detailResults.length})</h2>
      <table>
        <thead>
          <tr><th>源 Key</th><th>视频名称</th><th>状态</th><th>详情项数</th><th>播放源数</th><th>可播放数</th><th>错误信息</th><th>耗时</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  generatePlaySection() {
    // Only show failures in the play section for brevity
    const failed = this.results.playResults.filter((r) => !r.success);
    const rows = failed
      .map(
        (r) => `
      <tr>
        <td>${r.sourceKey}</td>
        <td>${r.vodName || '-'}</td>
        <td>${r.flag}</td>
        <td>${r.episodeName || '-'}</td>
        <td><span class="badge fail">FAIL</span></td>
        <td class="error-msg">${r.msg || r.error || 'No URL'}</td>
      </tr>`,
      )
      .join('');

    const passCount = this.results.playResults.filter((r) => r.success).length;
    return `
    <section>
      <h2>播放源测试 - 失败用例 (${failed.length}/${this.results.playResults.length} 总计, ${passCount} 通过)</h2>
      ${failed.length === 0 ? '<p style="color: #10b981; padding: 12px;">✓ 所有播放源测试通过</p>' : ''}
      <table>
        <thead>
          <tr><th>源 Key</th><th>视频名称</th><th>播放源</th><th>剧集</th><th>状态</th><th>错误信息</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  generatePanSection() {
    const rows = this.results.panResults
      .map(
        (r) => `
      <tr>
        <td>${r.label}</td>
        <td><span class="badge ${r.success ? 'ok' : r.status === 'NEEDS_LOGIN' ? 'warn' : 'fail'}">${r.status}</span></td>
        <td>${r.panSourcesFound}</td>
        <td>${r.panSourcesPlayable}</td>
        <td class="error-msg">${r.error || (r.details && r.details.map((d) => `${d.flag}: ${d.msg || (d.hasUrl ? 'OK' : 'FAIL')}`).join('; ')) || '-'}</td>
      </tr>`,
      )
      .join('');

    return `
    <section>
      <h2>网盘源专项测试 (${this.results.panResults.length})</h2>
      <table>
        <thead>
          <tr><th>网盘类型</th><th>状态</th><th>找到源数</th><th>可播放数</th><th>详情</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  /**
   * 打印控制台摘要
   */
  printSummary() {
    const s = this.results.summary;
    console.log('\n========================================');
    console.log('         E2E 测试最终摘要');
    console.log('========================================');
    console.log(`首页测试:   ✓ ${s.homeOk}  ✗ ${s.homeFailed}`);
    console.log(`详情页测试: ✓ ${s.detailOk}  ✗ ${s.detailFailed}`);
    console.log(`播放源测试: ✓ ${s.playOk}  ✗ ${s.playFailed}`);
    console.log(`网盘源测试: ✓ ${s.panOk}  ✗ ${s.panFailed}`);
    if (s.duration) console.log(`总耗时: ${s.duration.toFixed(1)}s`);
    console.log('========================================\n');
  }
}

module.exports = Reporter;
