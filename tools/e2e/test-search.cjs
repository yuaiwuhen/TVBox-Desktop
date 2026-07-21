// PC Search functional test - verifies PC search now mirrors Android:
//  - quick flag is plumbed through to spider.searchContent(wd, quick)
//  - results stream in (searchResults updates progressively while loading)
//
// Usage: node tools/e2e/test-search.cjs [keyword] [maxWaitSec]
//
// Requires Electron running with --remote-debugging-port=9222 (pnpm dev)

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const KEYWORD = process.argv[2] || '斗罗大陆';
const MAX_WAIT_SEC = parseInt(process.argv[3] || '90', 10);

let msgId = 1;

function cdpSend(ws, method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`CDP ${method} timeout`));
    }, 30000);
    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {}
    }
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function getWsUrl() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find((t) => t.type === 'page');
          resolve(page?.webSocketDebuggerUrl);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function getStoreState(ws) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const { useAppStore } = await import('/src/store/app.ts');
      const store = useAppStore();
      return JSON.stringify({
        configUrl: store.configUrl,
        siteCount: store.sites.length,
        searchableCount: store.sites.filter(s => s.searchable !== 0).length,
        searchLoading: store.searchLoading,
        searchResultGroups: (store.searchResults || []).length,
        searchResultTotal: (store.searchResults || []).reduce((s,g)=>s+g.list.length,0),
      });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  try {
    return JSON.parse(r?.result?.value || '{}');
  } catch {
    return {};
  }
}

function checkSourceHasQuickFlag() {
  // Static check: confirm store/app.ts has the new quick param + streaming logic.
  const storeFile = path.join(__dirname, '..', '..', 'src', 'store', 'app.ts');
  const src = fs.readFileSync(storeFile, 'utf8');
  return {
    hasQuickParam: /quick\s*:\s*boolean\s*=\s*false/.test(src),
    hasStreamingPush:
      /searchResults\.value\s*=\s*\[\s*\.\.\.searchResults\.value/.test(src),
    hasConcurrency: /CONCURRENCY\s*=\s*5/.test(src),
    passesQuick: /spider\.searchContent\(keyword,\s*quick\)/.test(src),
  };
}

async function main() {
  const wsUrl = await getWsUrl();
  if (!wsUrl) {
    console.error(
      `No Electron page at http://127.0.0.1:${CDP_PORT}/json. Is pnpm dev running?`,
    );
    process.exit(1);
  }
  const ws = new WebSocket(wsUrl);
  ws.setMaxListeners(50);
  await new Promise((r) => ws.on('open', r));

  console.log('=== PC Search functional test ===\n');

  // 1. Static source check (verifies the new code is in place)
  const src = checkSourceHasQuickFlag();
  console.log('1. Source code checks (src/store/app.ts):');
  console.log('   has quick param        :', src.hasQuickParam ? 'YES' : 'NO');
  console.log('   passes quick to spider :', src.passesQuick ? 'YES' : 'NO');
  console.log(
    '   has streaming push     :',
    src.hasStreamingPush ? 'YES' : 'NO',
  );
  console.log('   has CONCURRENCY=5      :', src.hasConcurrency ? 'YES' : 'NO');

  // 2. Pre-search state
  const before = await getStoreState(ws);
  console.log('\n2. Pre-search state:');
  console.log('   configUrl:', before.configUrl);
  console.log('   total sites:', before.siteCount);
  console.log('   searchable sites:', before.searchableCount);

  if (before.searchableCount === 0) {
    console.error('\nNo searchable sites loaded. Aborting.');
    ws.close();
    process.exit(1);
  }

  // 3. Trigger quick search with a small subset of sites (10) to avoid
  //    overwhelming the renderer with 1600+ concurrent searches.
  console.log(
    `\n3. Triggering doSearch('${KEYWORD}', first 10 searchable sites, quick=true)...`,
  );
  console.log(
    `   (observing for ${MAX_WAIT_SEC}s, doesn't wait for full completion)\n`,
  );

  // Fire doSearch without awaiting — we want to poll state while it runs.
  await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const { useAppStore } = await import('/src/store/app.ts');
      const store = useAppStore();
      // Pick first 10 searchable sites to keep the test fast.
      const siteKeys = store.sites
        .filter(s => s.searchable !== 0)
        .slice(0, 10)
        .map(s => s.key + '-' + s.name);
      store.doSearch(${JSON.stringify(KEYWORD)}, siteKeys, true);
      return JSON.stringify({ started: true, siteCount: siteKeys.length });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  // 4. Poll state every 500ms for MAX_WAIT_SEC (finer polling to catch streaming)
  const startTs = Date.now();
  const snapshots = [];
  while (Date.now() - startTs < MAX_WAIT_SEC * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await getStoreState(ws);
    snapshots.push({
      t: Date.now() - startTs,
      loading: s.searchLoading,
      groups: s.searchResultGroups,
      total: s.searchResultTotal,
    });
    // Stop early if search finished
    if (!s.searchLoading && snapshots.length > 1) break;
  }

  console.log('4. Streaming snapshots (showing only changes):');
  let prevGroups = -1;
  for (const s of snapshots) {
    if (s.groups !== prevGroups || !s.loading) {
      console.log(
        `   +${(s.t / 1000).toFixed(1).padStart(5)}s  loading=${s.loading}  groups=${s.groups}  total=${s.total}`,
      );
      prevGroups = s.groups;
    }
  }

  // 5. Final state
  const after = await getStoreState(ws);
  console.log('\n5. Final state:');
  console.log('   searchLoading:', after.searchLoading);
  console.log('   result groups:', after.searchResultGroups);
  console.log('   total results:', after.searchResultTotal);

  // 6. Pass/Fail
  // Streaming = at least one snapshot where groups increased while loading=true
  const streamingConfirmed = snapshots.some(
    (s, i) => i > 0 && snapshots[i - 1].groups < s.groups && s.loading,
  );
  const gotResults = after.searchResultTotal > 0;
  const sourceConfirmed =
    src.hasQuickParam && src.passesQuick && src.hasStreamingPush;

  console.log('\n=== Result ===');
  console.log(
    '  source has quick+streaming  :',
    sourceConfirmed ? 'PASS' : 'FAIL',
  );
  console.log(
    '  streaming confirmed         :',
    streamingConfirmed ? 'PASS' : 'FAIL',
  );
  console.log('  got any results             :', gotResults ? 'PASS' : 'FAIL');

  ws.close();
  process.exit(sourceConfirmed && streamingConfirmed ? 0 : 1);
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
