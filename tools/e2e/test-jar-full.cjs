/**
 * Full JAR Spider E2E Test — tests ALL JAR sources in dc6.json
 *
 * Tests every JAR site (1528 total) across 29 sub-configs.
 * Serial execution per site (store state is shared, can't parallelize).
 * Resume support: skips already-tested (configUrl, api, site) tuples.
 *
 * Usage:
 *   node tools/e2e/test-jar-full.cjs                  # resume
 *   node tools/e2e/test-jar-full.cjs --restart        # ignore prior results
 *   node tools/e2e/test-jar-full.cjs --only=11,12,13  # only specific sub-config indexes
 *   node tools/e2e/test-jar-full.cjs --filter=Guard   # only sites whose api matches
 */
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const CONFIG_URL = 'https://d.kstore.dev/download/12441/dc6.json';
const PROGRESS_FILE = path.join(__dirname, 'test-jar-full-progress.json');
const RESULT_FILE = path.join(__dirname, 'test-jar-full-result.json');

const args = process.argv.slice(2);
let restart = false;
let onlySubs = null;
let filter = '';
for (const a of args) {
  if (a === '--restart') restart = true;
  else if (a.startsWith('--only='))
    onlySubs = a
      .split('=')[1]
      .split(',')
      .map((x) => parseInt(x, 10));
  else if (a.startsWith('--filter=')) filter = a.split('=')[1];
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve(d));
      })
      .on('error', reject);
  });
}

let msgId = 1;
// 120s CDP timeout — most failures finish in <15s; homeContent (3×30s retries)
// + homeVideoContent (30s) + loadCategory (30s) fits in 120s. 240s was too
// slow for the full 1528-site sweep.
function cdpSend(ws, method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`CDP ${method} timeout`));
    }, 120000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expr) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    const desc =
      r.exceptionDetails.exception?.description ||
      r.exceptionDetails.text ||
      'eval error';
    throw new Error(desc.substring(0, 800));
  }
  return r.result?.value;
}

function jsStr(s) {
  return JSON.stringify(s);
}

function classifyReason(reason) {
  if (!reason) return 'empty';
  const r = reason.toLowerCase();
  if (r.includes('spider class not found') || r.includes('class not found'))
    return 'class_not_found';
  if (r.includes('jar load failed') || r.includes('download failed'))
    return 'jar_download_fail';
  if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('no classes')) return 'no_classes';
  if (r.includes('empty list') || r.includes('empty')) return 'empty_list';
  if (
    r.includes('403') ||
    r.includes('401') ||
    r.includes('404') ||
    r.includes('500')
  )
    return 'http_error';
  if (
    r.includes('network') ||
    r.includes('econnreset') ||
    r.includes('socket') ||
    r.includes('enetunreach')
  )
    return 'network_error';
  if (r.includes('null') || r.includes('undefined')) return 'null_result';
  return 'other';
}

async function testSite(ws, sub, site) {
  const t0 = Date.now();
  try {
    const r = await evaluate(
      ws,
      `
      (async () => {
        try {
          const { useAppStore } = await import('/src/store/app.ts');
          const store = useAppStore();
          store.setActiveSite(${jsStr(site.key)});
          const errors = [];
          const origError = console.error;
          console.error = (...args) => {
            try { errors.push(args.map(a => typeof a === 'object' ? (a?.message || JSON.stringify(a)) : String(a)).join(' ').substring(0, 400)); } catch {}
            origError.apply(console, args);
          };
          try {
            await store.loadHome(true);
          } finally {
            console.error = origError;
          }
          let count = store.homeVodList.length;
          let classes = store.classes.length;
          let categoryTried = false;
          if (count === 0 && classes > 0) {
            const cls = store.classes.find(c => c.type_id !== '__recommend__') || store.classes[0];
            if (cls) {
              try { await store.loadCategory(cls.type_id, '1'); count = store.categoryVodList.length; categoryTried = true; } catch(e) { errors.push('cat:' + (e.message||'').substring(0,100)); }
            }
          }
          const ok = count > 0;
          const reason = ok ? '' : (errors.length > 0 ? errors[0] : (classes === 0 ? 'no classes' : 'empty list'));
          return { ok, count, classes, error: reason, categoryTried };
        } catch(e) { return { ok: false, error: (e.message||'').substring(0, 400) }; }
      })()
    `,
    );
    const elapsed = Date.now() - t0;
    return {
      config: sub.name,
      configUrl: sub.url,
      site: site.name,
      api: site.api,
      jar: site.jar || '',
      ok: !!r.ok,
      count: r.count || 0,
      classes: r.classes || 0,
      error: r.error || '',
      category: r.ok ? 'ok' : classifyReason(r.error),
      elapsedMs: elapsed,
    };
  } catch (e) {
    const elapsed = Date.now() - t0;
    const msg = (e.message || '').substring(0, 400);
    return {
      config: sub.name,
      configUrl: sub.url,
      site: site.name,
      api: site.api,
      jar: site.jar || '',
      ok: false,
      count: 0,
      classes: 0,
      error: msg,
      category: classifyReason(msg),
      elapsedMs: elapsed,
    };
  }
}

async function main() {
  console.log(`=== Full JAR Spider E2E Test ===`);
  console.log(`Resume: ${!restart}, Filter: ${filter || '(none)'}\n`);

  const listJson = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const pages = JSON.parse(listJson);
  const page = pages.find(
    (p) => p.url.includes('localhost') || p.url.includes('index.html'),
  );
  if (!page) {
    console.error('No page found');
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 15000);
  });
  await cdpSend(ws, 'Runtime.enable');
  console.log('CDP connected\n');

  await evaluate(
    ws,
    `
    (async () => {
      const { useAppStore } = await import('/src/store/app.ts');
      const { configParser } = await import('/src/core/ConfigParser.ts');
      const store = useAppStore();
      if (store.configUrl !== ${jsStr(CONFIG_URL)}) {
        store.setConfigUrl(${jsStr(CONFIG_URL)});
        await configParser.load(${jsStr(CONFIG_URL)});
        await store.loadConfig();
      }
      return { subs: store.subConfigs.length };
    })()
  `,
  );

  const subs = await evaluate(
    ws,
    `
    (async () => {
      const { useAppStore } = await import('/src/store/app.ts');
      const store = useAppStore();
      return store.subConfigs.map(s => ({ name: s.name, url: s.url }));
    })()
  `,
  );
  console.log(`Found ${subs.length} sub-configs\n`);

  const subsToTest = onlySubs
    ? subs.filter((_, i) => onlySubs.includes(i + 1))
    : subs;

  let priorResults = [];
  if (!restart && fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      priorResults = data.results || [];
      console.log(`Loaded ${priorResults.length} prior results for resume`);
    } catch (e) {
      console.log(`Failed to load prior results: ${e.message}`);
    }
  }
  const testedKeys = new Set(
    priorResults.map((r) => `${r.configUrl}::${r.api}::${r.site}`),
  );

  const allResults = [...priorResults];
  let totalTested = priorResults.length;
  let totalOk = priorResults.filter((r) => r.ok).length;

  for (let i = 0; i < subsToTest.length; i++) {
    const sub = subsToTest[i];
    console.log(`\n[${i + 1}/${subsToTest.length}] ${sub.name}`);

    // Clear cache + switch config
    try {
      await evaluate(
        ws,
        `
        (async () => {
          try {
            const { spiderEngine } = await import('/src/core/SpiderEngine.ts');
            spiderEngine.clearAll && spiderEngine.clearAll();
          } catch(e) {}
          try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('jar:clear');
          } catch(e) {}
          const { useAppStore } = await import('/src/store/app.ts');
          const store = useAppStore();
          const idx = store.subConfigs.findIndex(s => s.url === ${jsStr(sub.url)});
          if (idx === -1) return false;
          await store.loadSubConfig(idx);
          return true;
        })()
      `,
      );
    } catch (e) {
      console.log(`  Switch FAILED: ${(e.message || '').substring(0, 100)}`);
      continue;
    }

    let sites;
    try {
      sites = await evaluate(
        ws,
        `
        (async () => {
          const { useAppStore } = await import('/src/store/app.ts');
          const store = useAppStore();
          return store.sites
            .filter(s => s.hide !== 1 && s.api && (s.api.includes('.jar') || s.api.startsWith('csp_')))
            .map(s => ({ key: s.key, name: s.name, api: s.api, jar: s.jar || '' }));
        })()
      `,
      );
    } catch (e) {
      console.log(
        `  Sites load FAILED: ${(e.message || '').substring(0, 100)}`,
      );
      continue;
    }
    if (!sites || sites.length === 0) {
      console.log(`  No JAR sites`);
      continue;
    }

    // Apply filter
    if (filter) {
      sites = sites.filter(
        (s) => s.api.includes(filter) || s.name.includes(filter),
      );
    }

    console.log(`  ${sites.length} JAR sites to test`);

    let subOk = 0;
    let subFail = 0;
    for (let j = 0; j < sites.length; j++) {
      const site = sites[j];
      const key = `${sub.url}::${site.api}::${site.name}`;
      if (testedKeys.has(key)) {
        continue;
      }

      process.stdout.write(
        `  [${j + 1}/${sites.length}] ${site.name} [${site.api.substring(0, 30)}]: `,
      );
      const result = await testSite(ws, sub, site);
      allResults.push(result);
      testedKeys.add(key);
      totalTested++;
      if (result.ok) {
        totalOk++;
        subOk++;
        console.log(
          `OK(${result.count}, ${result.classes}c, ${result.elapsedMs}ms)`,
        );
      } else {
        subFail++;
        console.log(
          `FAIL[${result.category}] ${result.error.substring(0, 80)} (${result.elapsedMs}ms)`,
        );
      }

      // Flush every 5 sites
      if (totalTested % 5 === 0) {
        fs.writeFileSync(
          PROGRESS_FILE,
          JSON.stringify(
            {
              results: allResults,
              total: allResults.length,
              okCount: allResults.filter((r) => r.ok).length,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      }
    }
    console.log(`  Sub total: ${subOk} OK, ${subFail} FAIL`);

    // Flush after each sub-config
    fs.writeFileSync(
      PROGRESS_FILE,
      JSON.stringify(
        {
          results: allResults,
          total: allResults.length,
          okCount: allResults.filter((r) => r.ok).length,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  // Final summary
  const okTotal = allResults.filter((r) => r.ok).length;
  const failTotal = allResults.length - okTotal;
  const failByCategory = {};
  const failByConfig = {};
  const failByApi = {};
  for (const r of allResults) {
    if (!r.ok) {
      const cat = r.category || 'unknown';
      failByCategory[cat] = (failByCategory[cat] || 0) + 1;
      failByConfig[r.config] = (failByConfig[r.config] || 0) + 1;
      const apiShort = r.api.replace(/^csp_/, '').substring(0, 30);
      failByApi[apiShort] = (failByApi[apiShort] || 0) + 1;
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(
    `SUMMARY: ${okTotal}/${allResults.length} sources OK (${failTotal} failures)`,
  );
  console.log(`${'═'.repeat(70)}`);
  console.log(`\nFailures by category:`);
  for (const [cat, count] of Object.entries(failByCategory).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`\nFailures by api (top 15):`);
  const topApis = Object.entries(failByApi)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [api, count] of topApis) {
    console.log(`  ${api}: ${count} failures`);
  }
  console.log(`\nFailures by config (top 10):`);
  const topConfigs = Object.entries(failByConfig)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [cfg, count] of topConfigs) {
    console.log(`  ${cfg}: ${count} failures`);
  }

  fs.writeFileSync(
    RESULT_FILE,
    JSON.stringify(
      {
        okCount: okTotal,
        totalCount: allResults.length,
        failByCategory,
        failByConfig,
        failByApi,
        results: allResults,
        time: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to: ${RESULT_FILE}`);
  ws.close();
}

main().catch((e) => {
  console.error('Fatal:', (e.message || '').substring(0, 500));
  process.exit(1);
});
