// Reload the renderer page (to pick up new Pinia store code that doesn't HMR),
// then run the search streaming test.
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const KEYWORD = process.argv[2] || '斗罗大陆';
const MAX_WAIT_SEC = parseInt(process.argv[3] || '120', 10);

let msgId = 1;

function cdpSend(ws, method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`CDP ${method} timeout`));
    }, 60000);
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
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
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
  try { return JSON.parse(r?.result?.value || '{}'); } catch { return {}; }
}

async function main() {
  let wsUrl = await getWsUrl();
  if (!wsUrl) {
    console.error(`No Electron page at http://127.0.0.1:${CDP_PORT}/json. Is pnpm dev running?`);
    process.exit(1);
  }

  console.log('=== Reload + Search streaming test ===\n');

  // 1. Reload the page to ensure new Pinia store code is loaded (HMR may not
  //    fully replace Pinia actions).
  console.log('1. Reloading renderer page...');
  let ws = new WebSocket(wsUrl);
  ws.setMaxListeners(50);
  await new Promise((r) => ws.on('open', r));
  await cdpSend(ws, 'Page.reload');
  ws.close();
  console.log('   (waiting 8s for reload + auto-config load)');
  await new Promise((r) => setTimeout(r, 8000));

  // 2. Reconnect (URL may have changed after reload)
  wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  ws.setMaxListeners(50);
  await new Promise((r) => ws.on('open', r));

  // 3. Wait for sites to be ready
  console.log('2. Waiting for sites to load...');
  let state = await getStoreState(ws);
  for (let i = 0; i < 30 && (state.siteCount || 0) === 0; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await getStoreState(ws);
  }
  console.log(`   sites: ${state.siteCount}, searchable: ${state.searchableCount}, config: ${state.configUrl}`);

  if ((state.searchableCount || 0) === 0) {
    console.error('No searchable sites. Aborting.');
    ws.close();
    process.exit(1);
  }

  // 4. Trigger search
  console.log(`\n3. Triggering doSearch('${KEYWORD}', all, quick=true)...`);
  await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const { useAppStore } = await import('/src/store/app.ts');
      const store = useAppStore();
      store.doSearch(${JSON.stringify(KEYWORD)}, undefined, true);
      return 'started';
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  // 5. Poll state every 500ms (finer than before, to catch streaming)
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
    if (!s.searchLoading && snapshots.length > 1) break;
  }

  // 6. Print every 5th snapshot to keep output manageable
  console.log('\n4. Streaming snapshots (every 2.5s):');
  for (let i = 0; i < snapshots.length; i += 5) {
    const s = snapshots[i];
    console.log(
      `   +${(s.t / 1000).toFixed(1).padStart(6)}s  loading=${s.loading}  groups=${s.groups}  total=${s.total}`,
    );
  }
  // Always print the last
  const last = snapshots[snapshots.length - 1];
  if (snapshots.length % 5 !== 1) {
    console.log(
      `   +${(last.t / 1000).toFixed(1).padStart(6)}s  loading=${last.loading}  groups=${last.groups}  total=${last.total}  (final)`,
    );
  }

  // 7. Final state
  const after = await getStoreState(ws);
  console.log('\n5. Final state:');
  console.log('   searchLoading:', after.searchLoading);
  console.log('   result groups:', after.searchResultGroups);
  console.log('   total results:', after.searchResultTotal);

  // 8. Streaming check: did groups grow incrementally?
  const streamingConfirmed = snapshots.some((s, i) =>
    i > 0 && snapshots[i - 1].groups < s.groups && s.loading,
  );
  const gotResults = after.searchResultTotal > 0;

  console.log('\n=== Result ===');
  console.log('  streaming confirmed  :', streamingConfirmed ? 'PASS' : 'FAIL');
  console.log('  got any results      :', gotResults ? 'PASS' : 'FAIL');

  ws.close();
  process.exit(streamingConfirmed ? 0 : 1);
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
