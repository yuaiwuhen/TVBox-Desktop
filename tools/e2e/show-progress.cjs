/**
 * Show progress of full JAR test
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

console.log(
  `Total: ${data.total}, OK: ${data.okCount}, Fail: ${data.total - data.okCount}`,
);
console.log(`Updated: ${data.updatedAt}`);
console.log(`\nBy category:`);

const byCat = {};
const byConfig = {};
const byApi = {};
for (const r of results) {
  if (r.ok) {
    byCat['ok'] = (byCat['ok'] || 0) + 1;
  } else {
    const cat = r.category || 'unknown';
    byCat[cat] = (byCat[cat] || 0) + 1;
    byConfig[r.config] = (byConfig[r.config] || 0) + 1;
    const apiShort = (r.api || '').replace(/^csp_/, '').substring(0, 30);
    byApi[apiShort] = (byApi[apiShort] || 0) + 1;
  }
}

for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count}`);
}

console.log(`\nFailures by config:`);
const topConfigs = Object.entries(byConfig).sort((a, b) => b[1] - a[1]);
for (const [cfg, count] of topConfigs) {
  console.log(`  ${cfg}: ${count}`);
}

console.log(`\nTop 20 failing APIs:`);
const topApis = Object.entries(byApi)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);
for (const [api, count] of topApis) {
  console.log(`  ${api}: ${count}`);
}
