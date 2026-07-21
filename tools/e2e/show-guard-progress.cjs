/**
 * Show Guard spider test results
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

const guardResults = results.filter((r) => r.api.includes('Guard'));
const guardOk = guardResults.filter((r) => r.ok);
const guardFail = guardResults.filter((r) => !r.ok);

console.log(`Guard spiders: ${guardResults.length} tested, ${guardOk.length} OK, ${guardFail.length} FAIL`);
console.log(`\nOK Guard spiders (${guardOk.length}):`);
for (const r of guardOk) {
  console.log(`  ${r.api} (${r.config}): ${r.count} videos`);
}

console.log(`\nFailed Guard spiders (${guardFail.length}):`);
for (const r of guardFail) {
  console.log(`  ${r.api} (${r.config}): [${r.category}] ${r.error.substring(0, 100)}`);
}
