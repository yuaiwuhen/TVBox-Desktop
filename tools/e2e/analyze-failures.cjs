/**
 * Analyze failures by category and find patterns
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

const failures = results.filter((r) => !r.ok);

// Group by category
const byCategory = {};
for (const f of failures) {
  if (!byCategory[f.category]) byCategory[f.category] = [];
  byCategory[f.category].push(f);
}

// Print class_not_found details (most likely code bug)
console.log('=== class_not_found failures (first 30) ===');
const cnf = byCategory.class_not_found || [];
console.log(`Total: ${cnf.length}`);
for (const f of cnf.slice(0, 30)) {
  console.log(`  ${f.api} [${f.config}]: ${f.error.substring(0, 120)}`);
}

console.log('\n=== jar_download_fail (all) ===');
const jdf = byCategory.jar_download_fail || [];
console.log(`Total: ${jdf.length}`);
for (const f of jdf) {
  console.log(`  ${f.api} [${f.config}]: ${f.error.substring(0, 150)}`);
}

console.log('\n=== timeout (all) ===');
const to = byCategory.timeout || [];
console.log(`Total: ${to.length}`);
for (const f of to) {
  console.log(`  ${f.api} [${f.config}]: ${f.error.substring(0, 150)}`);
}

// Check for patterns in class_not_found
console.log('\n=== class_not_found pattern analysis ===');
const cnfApis = cnf.map((f) =>
  f.api.replace(/^csp_/, '').replace(/Guard$/, ''),
);
const cnfCounts = {};
for (const a of cnfApis) {
  cnfCounts[a] = (cnfCounts[a] || 0) + 1;
}
const sorted = Object.entries(cnfCounts).sort((a, b) => b[1] - a[1]);
console.log('Top class_not_found APIs:');
for (const [api, count] of sorted.slice(0, 30)) {
  console.log(`  ${api}: ${count}`);
}
