#!/usr/bin/env python3
"""Connect to CDP and inspect the renderer state of our TVBox-Pc-Docker app."""
import sys
import io
import json
import time
import requests
import websocket

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

CDP_PORT = 9223

def get_page_target():
    """Get the page target (not DevTools)."""
    resp = requests.get(f'http://127.0.0.1:{CDP_PORT}/json')
    targets = resp.json()
    for t in targets:
        if t.get('type') == 'page' and 'devtools' not in t.get('url', ''):
            return t
    return None

class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self.msg_id = 0

    def send(self, method, params=None):
        self.msg_id += 1
        msg = {'id': self.msg_id, 'method': method}
        if params:
            msg['params'] = params
        self.ws.send(json.dumps(msg))
        # Wait for response with matching id
        while True:
            result = json.loads(self.ws.recv())
            if result.get('id') == self.msg_id:
                return result
            # Otherwise it's an event, ignore for now

    def recv_until(self, timeout=5):
        """Receive messages until timeout."""
        self.ws.settimeout(0.5)
        msgs = []
        end_time = time.time() + timeout
        while time.time() < end_time:
            try:
                msg = json.loads(self.ws.recv())
                msgs.append(msg)
            except Exception:
                pass
        self.ws.settimeout(10)
        return msgs

def main():
    target = get_page_target()
    if not target:
        print('No page target found')
        sys.exit(1)

    print(f'Page: {target["title"]} | {target["url"]}')
    print(f'WS URL: {target["webSocketDebuggerUrl"]}')

    client = CDPClient(target['webSocketDebuggerUrl'])

    # Enable Runtime to capture console logs and errors
    client.send('Runtime.enable')
    client.send('Log.enable')

    # Collect console/log entries that were already captured
    time.sleep(1)
    logs = client.recv_until(timeout=2)

    print('\n=== Recent Console Messages ===')
    for log in logs:
        if log.get('method') == 'Runtime.consoleAPICalled':
            args = log['params'].get('args', [])
            text = ' '.join(a.get('value', a.get('description', '')) for a in args)
            print(f'[{log["params"].get("type", "log")}] {text}')
        elif log.get('method') == 'Runtime.exceptionThrown':
            exc = log['params']['exceptionDetails']
            print(f'[EXCEPTION] {exc.get("text", "")}')
            if 'exception' in exc:
                print(f'  Detail: {exc["exception"].get("description", "")}')

    # Evaluate JS to get app state
    print('\n=== App State ===')
    checks = [
        ('document.title', 'document.title'),
        ('document.body innerText (first 500 chars)', 'document.body.innerText.substring(0, 500)'),
        ('localStorage configUrl', 'localStorage.getItem("tvbox_config_url")'),
        ('Vue app mounted?', '!!document.querySelector("#app")'),
        ('Loading visible?', '!!document.querySelector(".el-loading-mask")'),
        ('Vod list items', 'document.querySelectorAll(".vod-item, .video-card, [class*=\"card\"]").length'),
        ('Pinia state', '''
            (function() {
                try {
                    var app = document.querySelector("#app");
                    if (!app || !app.__vue_app__) return "Vue app not found";
                    var pinia = app.__vue_app__.config.globalProperties.$pinia;
                    if (!pinia) return "Pinia not found";
                    var result = {};
                    for (var key in pinia.state.value) {
                        var state = pinia.state.value[key];
                        result[key] = {};
                        if (state.configUrl !== undefined) result[key].configUrl = state.configUrl;
                        if (state.sites !== undefined) result[key].sitesCount = (state.sites || []).length;
                        if (state.activeSiteKey !== undefined) result[key].activeSiteKey = state.activeSiteKey;
                        if (state.homeVodList !== undefined) result[key].homeVodListCount = (state.homeVodList || []).length;
                        if (state.classes !== undefined) result[key].classesCount = (state.classes || []).length;
                        if (state.loading !== undefined) result[key].loading = state.loading;
                    }
                    return JSON.stringify(result, null, 2);
                } catch (e) {
                    return "Error: " + e.message;
                }
            })()
        '''),
    ]

    for label, expr in checks:
        result = client.send('Runtime.evaluate', {
            'expression': expr,
            'returnByValue': True,
        })
        value = result.get('result', {}).get('result', {}).get('value', '')
        exception = result.get('result', {}).get('exceptionDetails')
        if exception:
            print(f'{label}: [ERROR] {exception.get("exception", {}).get("description", exception.get("text", ""))}')
        else:
            print(f'{label}: {value}')

    # Get all console logs from main process via debug IPC
    print('\n=== Renderer Console Log (via Page.captureConsoleMessages) ===')
    # Try to get console messages via different approach
    result = client.send('Runtime.evaluate', {
        'expression': '''
            (function() {
                var oldLog = console.log;
                var oldError = console.error;
                var oldWarn = console.warn;
                return "Check console manually";
            })()
        ''',
        'returnByValue': True,
    })

    client.ws.close()

if __name__ == '__main__':
    main()
