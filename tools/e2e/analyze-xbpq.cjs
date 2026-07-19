/**
 * Investigate csp_XBPQ failures across multiple configs
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

const xbpqResults = results.filter((r) => r.api === 'csp_XBPQ');

console.log(`=== csp_XBPQ results: ${xbpqResults.length} ===`);
const ok = xbpqResults.filter((r) => r.ok);
const fail = xbpqResults.filter((r) => !r.ok);
console.log(`OK: ${ok.length}, FAIL: ${fail.length}\n`);

console.log('OK results:');
for (const r of ok.slice(0, 5)) {
  console.log(`  [${r.config.substring(0, 30)}]: ${r.count} videos, ${r.classes} classes, jar=${r.jar.substring(0, 80)}`);
}

console.log('\nFAIL results:');
for (const r of fail) {
  console.log(`  [${r.config.substring(0, 30)}]: [${r.category}] ${(r.error || '').substring(0, 100)}, jar=${r.jar.substring(0, 80)}`);
}

// Compare OK jar vs FAIL jar to see if they use different JARs
console.log('\nJAR URLs (OK):');
const okJars = new Set(ok.map((r) => r.jar));
for (const j of okJars) {
  console.log(`  ${j.substring(0, 100)}`);
}

console.log('\nJAR URLs (FAIL):');
const failJars = new Set(fail.map((r) => r.jar));
for (const j of failJars) {
  console.log(`  ${j.substring(0, 100)}`);
}
