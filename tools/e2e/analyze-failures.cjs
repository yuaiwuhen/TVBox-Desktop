// Analyze test results to identify failing sources by category
const fs = require('fs');
const path = require('path');

const RESULT_FILE = path.join(
  'd:', 'Code', 'TVBOXDesktop', 'TVBox-PC', 'tools', 'e2e', 'test-3configs-result.json'
);

const results = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));

for (const [configUrl, cfg] of Object.entries(results)) {
  console.log(`\n========== ${cfg.name} (${configUrl}) ==========`);
  console.log(`Summary: total=${cfg.summary.total}, home=${cfg.summary.homeOk}, detail=${cfg.summary.detailOk}, play=${cfg.summary.playOk}`);

  const failed = [];
  const partial = [];

  for (const site of cfg.sites) {
    const homeOk = site.home?.ok;
    const detailOk = site.detail?.ok;
    const playOk = site.play?.ok;
    const isMsearch = site.detail?.na === true;

    if (isMsearch) continue; // skip msearch discover sources

    if (!homeOk) {
      failed.push({ site: site.name, key: site.key, api: site.api, type: 'HOME', err: site.home?.err || `count=${site.home?.count||0}/classes=${site.home?.classes||0}` });
    } else if (homeOk && !detailOk) {
      partial.push({ site: site.name, key: site.key, api: site.api, type: 'DETAIL', err: site.detail?.err || `eps=${site.detail?.eps||0}`, homeCount: site.home?.count });
    } else if (homeOk && detailOk && !playOk) {
      partial.push({ site: site.name, key: site.key, api: site.api, type: 'PLAY', err: site.play?.err || '', detailEps: site.detail?.eps });
    }
  }

  console.log(`\n--- Failed HOME (${failed.filter(f=>f.type==='HOME').length}) ---`);
  for (const f of failed.filter(f => f.type === 'HOME')) {
    console.log(`  [${f.api || f.key}] ${f.site} - ${f.err}`);
  }

  console.log(`\n--- Partial: HOME OK but DETAIL failed (${partial.filter(p=>p.type==='DETAIL').length}) ---`);
  for (const p of partial.filter(p => p.type === 'DETAIL')) {
    console.log(`  [${p.api || p.key}] ${p.site} (homeCount=${p.homeCount}) - ${p.err}`);
  }

  console.log(`\n--- Partial: HOME+DETAIL OK but PLAY failed (${partial.filter(p=>p.type==='PLAY').length}) ---`);
  for (const p of partial.filter(p => p.type === 'PLAY')) {
    console.log(`  [${p.api || p.key}] ${p.site} (detailEps=${p.detailEps}) - ${p.err.substring(0, 100)}`);
  }
}
