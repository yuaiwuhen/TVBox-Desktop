// Quick check: print the running doSearch source to verify HMR loaded new code.
const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    const t = JSON.parse(d).find((x) => x.type === 'page');
    if (!t) { console.error('no page'); process.exit(1); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(async () => {
            const { useAppStore } = await import('/src/store/app.ts');
            const s = useAppStore();
            return s.doSearch.toString();
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    ws.on('message', (m) => {
      const r = JSON.parse(m.toString());
      if (r.id === 1) {
        const v = r.result?.result?.value || JSON.stringify(r.error || r.result, null, 2);
        console.log(v);
        ws.close();
        process.exit(0);
      }
    });
  });
});
