/**
 * Final analysis: classify failures as code bug vs source-end issue
 */
const fs = require('fs');
const path = require('path');

const PROGRESS_FILE = path.join(__dirname, 'test-jar-full-progress.json');

if (!fs.existsSync(PROGRESS_FILE)) {
  console.log('No progress file yet');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
const results = data.results || [];

const total = results.length;
const ok = results.filter((r) => r.ok);
const fail = results.filter((r) => !r.ok);

console.log(`=== Final Test Results ===`);
console.log(`Total: ${total}`);
console.log(`OK: ${ok.length} (${((ok.length / total) * 100).toFixed(1)}%)`);
console.log(`Fail: ${fail.length} (${((fail.length / total) * 100).toFixed(1)}%)`);

// Failure categories
const categories = {};
for (const f of fail) {
  const c = f.category || 'unknown';
  categories[c] = (categories[c] || 0) + 1;
}
console.log(`\nFailures by category:`);
for (const [c, n] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c}: ${n} (${((n / fail.length) * 100).toFixed(1)}%)`);
}

// Classify failures as code bug vs source-end
const codeBugs = [];
const sourceEnd = [];

for (const f of fail) {
  const api = f.api;
  const err = (f.error || '').toLowerCase();

  // Search/push/file spiders legitimately have no home content
  const isSearchSpider =
    /Ss$|Sou$|Search$|So$/.test(api) ||
    api.includes('PanSou') ||
    api.includes('PanSearch') ||
    api.includes('YingSo') ||
    api.includes('YunSo') ||
    api.includes('PikaSo') ||
    api.includes('MiaoSou') ||
    api.includes('Qianfan') ||
    api.includes('YunPanOne') ||
    api.includes('HunHePan') ||
    api.includes('DaPanSo') ||
    api.includes('Funletu') ||
    api.includes('UpYun') ||
    api.includes('MIPanSo') ||
    api.includes('AliPS') ||
    api.includes('Upyunso') ||
    api.includes('Yisou') ||
    api.includes('Zhaozy') ||
    api.includes('Panyq');

  const isPushSpider =
    api === 'csp_Push' ||
    api === 'csp_PushShare' ||
    api === 'csp_PushAgent' ||
    api.includes('Push');

  const isFileSpider =
    api.includes('MyAli') ||
    api.includes('MyQuark') ||
    api.includes('MyUc') ||
    api.includes('MyBaiDu') ||
    api.includes('LocalFile') ||
    api.includes('Samba') ||
    api.includes('AliShare') ||
    api.includes('QuarkShare') ||
    api.includes('UCShare') ||
    api.includes('P115Share') ||
    api.includes('ThunderShare') ||
    api.includes('PikPakShare') ||
    api.includes('MyUC');

  const isMarketSpider = api === 'csp_Market' || api.includes('Market');

  if (f.category === 'class_not_found') {
    // Config references class not in JAR — source-end issue
    sourceEnd.push({ ...f, reason: 'config_references_missing_class' });
  } else if (f.category === 'jar_download_fail') {
    // JAR URL returns 403/404 — source-end issue
    sourceEnd.push({ ...f, reason: 'jar_url_unavailable' });
  } else if (f.category === 'no_classes' && (isSearchSpider || isPushSpider || isFileSpider)) {
    // Search/push/file spiders legitimately have no home content
    sourceEnd.push({ ...f, reason: 'spider_has_no_home_content' });
  } else if (f.category === 'empty_list' && isFileSpider) {
    // File spiders need login
    sourceEnd.push({ ...f, reason: 'file_spider_needs_login' });
  } else if (f.category === 'empty_list' && isPushSpider) {
    sourceEnd.push({ ...f, reason: 'push_spider_no_content' });
  } else if (f.category === 'timeout') {
    // Timeouts could be code bugs if retry logic is too aggressive
    codeBugs.push({ ...f, reason: 'timeout_might_be_retries_too_aggressive' });
  } else if (f.category === 'other') {
    // Misc errors - investigate
    codeBugs.push({ ...f, reason: 'other_error_investigate' });
  } else {
    // no_classes or empty_list for normal spiders - likely source-end (dead site, login required)
    sourceEnd.push({ ...f, reason: 'source_site_dead_or_login_required' });
  }
}

console.log(`\n=== Classification ===`);
console.log(`Code bugs (investigate): ${codeBugs.length}`);
console.log(`Source-end issues: ${sourceEnd.length}`);

console.log(`\n=== Code Bugs (timeout + other) ===`);
const codeBugCategories = {};
for (const f of codeBugs) {
  const key = f.reason;
  if (!codeBugCategories[key]) codeBugCategories[key] = [];
  codeBugCategories[key].push(f);
}
for (const [reason, items] of Object.entries(codeBugCategories)) {
  console.log(`\n${reason}: ${items.length}`);
  // Show unique APIs
  const apis = {};
  for (const f of items) {
    apis[f.api] = (apis[f.api] || 0) + 1;
  }
  const sorted = Object.entries(apis).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [api, count] of sorted) {
    console.log(`  ${api}: ${count}`);
  }
}

// "Other" errors - show details
console.log(`\n=== 'other' error details ===`);
const others = codeBugs.filter((f) => f.category === 'other');
for (const f of others) {
  console.log(`  ${f.api} [${f.config.substring(0, 20)}]: ${(f.error || '').substring(0, 200)}`);
}

// Source-end issues by reason
console.log(`\n=== Source-end issues by reason ===`);
const sourceReasons = {};
for (const f of sourceEnd) {
  const r = f.reason;
  if (!sourceReasons[r]) sourceReasons[r] = 0;
  sourceReasons[r]++;
}
for (const [r, n] of Object.entries(sourceReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r}: ${n}`);
}

// Save classification
fs.writeFileSync(
  path.join(__dirname, 'test-classification.json'),
  JSON.stringify({
    total,
    ok: ok.length,
    fail: fail.length,
    codeBugs,
    sourceEnd,
    analyzedAt: new Date().toISOString(),
  }, null, 2),
);
console.log(`\nClassification saved to test-classification.json`);
