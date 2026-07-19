/**
 * Count total sites and JAR sites in the dc6.json multi-config
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;
const CONFIG_URL = 'https://d.kstore.dev/download/12441/dc6.json';

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
function cdpSend(ws, method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`CDP ${method} timeout (120s)`));
    }, 180000);
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
    throw new Error(desc.substring(0, 500));
  }
  return r.result?.value;
}

function jsStr(s) {
  return JSON.stringify(s);
}

async function main() {
  console.log('=== Counting sources in dc6.json ===\n');
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

  // Ensure config loaded
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
      return { subs: store.subConfigs.length, configUrl: store.configUrl };
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
  console.log(`Found ${subs.length} sub-configs`);

  let totalSites = 0;
  let totalJarSites = 0;
  let totalGuardSites = 0;
  const perConfigCounts = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    try {
      const sites = await evaluate(
        ws,
        `
        (async () => {
          const { useAppStore } = await import('/src/store/app.ts');
          const store = useAppStore();
          const idx = store.subConfigs.findIndex(s => s.url === ${jsStr(sub.url)});
          if (idx === -1) return null;
          await store.loadSubConfig(idx);
          return store.sites
            .filter(s => s.hide !== 1 && s.api && (s.api.includes('.jar') || s.api.startsWith('csp_')))
            .map(s => ({ key: s.key, name: s.name, api: s.api, jar: s.jar || '', isGuard: s.api.includes('Guard') }));
        })()
      `,
      );
      if (!sites) {
        perConfigCounts.push({ name: sub.name, total: 0, jar: 0, guard: 0 });
        continue;
      }
      const jarSites = sites.filter((s) => s.api.startsWith('csp_'));
      const guardSites = sites.filter((s) => s.api.includes('Guard'));
      totalSites += sites.length;
      totalJarSites += jarSites.length;
      totalGuardSites += guardSites.length;
      perConfigCounts.push({
        name: sub.name,
        total: sites.length,
        jar: jarSites.length,
        guard: guardSites.length,
      });
      console.log(
        `[${i + 1}/${subs.length}] ${sub.name}: ${sites.length} sites, ${jarSites.length} JAR (${guardSites.length} Guard)`,
      );
    } catch (e) {
      console.log(`[${i + 1}/${subs.length}] ${sub.name}: ERROR ${(e.message || '').substring(0, 100)}`);
      perConfigCounts.push({ name: sub.name, total: 0, jar: 0, guard: 0, error: (e.message || '').substring(0, 200) });
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total sub-configs: ${subs.length}`);
  console.log(`Total sites: ${totalSites}`);
  console.log(`Total JAR sites (csp_): ${totalJarSites}`);
  console.log(`Total Guard sites: ${totalGuardSites}`);

  // Save
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(
    path.join(__dirname, 'source-count.json'),
    JSON.stringify(
      {
        totalSubs: subs.length,
        totalSites,
        totalJarSites,
        totalGuardSites,
        perConfig: perConfigCounts,
      },
      null,
      2,
    ),
  );
  ws.close();
}

main().catch((e) => {
  console.error('Fatal:', (e.message || '').substring(0, 500));
  process.exit(1);
});
