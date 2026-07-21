/**
 * Analyze no_classes failures to find potential code bugs
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

const noClasses = results.filter((r) => !r.ok && r.category === 'no_classes');
const emptyList = results.filter((r) => !r.ok && r.category === 'empty_list');

console.log(`=== no_classes failures: ${noClasses.length} ===`);
console.log('Sample (first 30):');
for (const f of noClasses.slice(0, 30)) {
  console.log(`  ${f.api} [${f.config.substring(0, 20)}]: ${(f.error || '').substring(0, 100)}`);
}

console.log(`\n=== empty_list failures: ${emptyList.length} ===`);
console.log('Sample (first 30):');
for (const f of emptyList.slice(0, 30)) {
  console.log(`  ${f.api} [${f.config.substring(0, 20)}]: ${(f.error || '').substring(0, 100)}`);
}

// Check if same APIs fail across multiple configs (indicates JAR issue, not config issue)
console.log('\n=== API failure pattern (same API failing across configs) ===');
const apiFailures = {};
for (const f of [...noClasses, ...emptyList]) {
  const api = f.api;
  if (!apiFailures[api]) apiFailures[api] = [];
  apiFailures[api].push(f.config.substring(0, 15));
}
const sorted = Object.entries(apiFailures)
  .filter(([_, configs]) => configs.length >= 2)
  .sort((a, b) => b[1].length - a[1].length);
console.log('APIs failing in 2+ configs:');
for (const [api, configs] of sorted.slice(0, 20)) {
  console.log(`  ${api}: ${configs.length} configs`);
}
