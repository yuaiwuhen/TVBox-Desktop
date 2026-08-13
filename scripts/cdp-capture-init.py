#!/usr/bin/env python3
"""Reload the page and capture all console messages during initialization."""
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
    resp = requests.get(f'http://127.0.0.1:{CDP_PORT}/json')
    targets = resp.json()
    for t in targets:
        if t.get('type') == 'page' and 'devtools' not in t.get('url', ''):
            return t
    return None

class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.msg_id = 0
        self.events = []

    def send(self, method, params=None):
        self.msg_id += 1
        msg = {'id': self.msg_id, 'method': method}
        if params:
            msg['params'] = params
        self.ws.send(json.dumps(msg))
        # Read messages until we get the matching response
        while True:
            result = json.loads(self.ws.recv())
            if result.get('id') == self.msg_id:
                # Store events that came in
                if 'method' in result and result.get('id') is None:
                    self.events.append(result)
                return result
            elif 'method' in result:
                self.events.append(result)

    def drain_events(self, timeout=10):
        """Drain all pending events for a while."""
        self.ws.settimeout(0.3)
        end_time = time.time() + timeout
        while time.time() < end_time:
            try:
                msg = json.loads(self.ws.recv())
                if 'method' in msg:
                    self.events.append(msg)
            except Exception:
                pass
        self.ws.settimeout(30)

def main():
    target = get_page_target()
    if not target:
        print('No page target found')
        sys.exit(1)

    print(f'Page: {target["title"]} | {target["url"]}')
    client = CDPClient(target['webSocketDebuggerUrl'])

    # Enable Runtime to capture console logs
    client.send('Runtime.enable')
    client.send('Log.enable')
    client.send('Page.enable')

    # Clear existing events
    client.events.clear()

    # Reload the page
    print('\n=== Reloading page... ===')
    client.send('Page.reload')

    # Wait for page to load and capture events
    print('Waiting 15 seconds for initialization...')
    client.drain_events(timeout=15)

    # Print all console messages and exceptions in order
    print('\n=== Console Messages (in order) ===')
    for evt in client.events:
        method = evt.get('method')
        params = evt.get('params', {})
        if method == 'Runtime.consoleAPICalled':
            args = params.get('args', [])
            parts = []
            for a in args:
                v = a.get('value')
                if v is None:
                    v = a.get('description', a.get('unserializableValue', ''))
                parts.append(str(v))
            text = ' '.join(parts)
            ts = params.get('timestamp', 0)
            print(f'[{params.get("type", "log")}] {text}')
        elif method == 'Runtime.exceptionThrown':
            exc = params.get('exceptionDetails', {})
            text = exc.get('text', '')
            desc = ''
            if 'exception' in exc:
                desc = exc['exception'].get('description', '')
            print(f'[EXCEPTION] {text}')
            if desc:
                print(f'  {desc}')
        elif method == 'Log.entryAdded':
            entry = params.get('entry', {})
            print(f'[LOG-{entry.get("level", "?")}] [{entry.get("source", "?")}] {entry.get("text", "")}')

    # Final app state check
    print('\n=== Final App State ===')
    result = client.send('Runtime.evaluate', {
        'expression': '''
            (function() {
                try {
                    var app = document.querySelector("#app");
                    if (!app || !app.__vue_app__) return "Vue app not found";
                    var pinia = app.__vue_app__.config.globalProperties.$pinia;
                    if (!pinia) return "Pinia not found";
                    var state = pinia.state.value.app || {};
                    return JSON.stringify({
                        configUrl: state.configUrl,
                        sitesCount: (state.sites || []).length,
                        activeSiteKey: state.activeSiteKey,
                        homeVodListCount: (state.homeVodList || []).length,
                        classesCount: (state.classes || []).length,
                        homeLoading: state.homeLoading,
                        categoryLoading: state.categoryLoading,
                    }, null, 2);
                } catch (e) {
                    return "Error: " + e.message + "\\n" + e.stack;
                }
            })()
        ''',
        'returnByValue': True,
    })
    value = result.get('result', {}).get('result', {}).get('value', '')
    exception = result.get('result', {}).get('exceptionDetails')
    if exception:
        print(f'[ERROR] {exception}')
    else:
        print(value)

    # Also print body text
    print('\n=== Body Text (first 1000 chars) ===')
    result = client.send('Runtime.evaluate', {
        'expression': 'document.body.innerText.substring(0, 1000)',
        'returnByValue': True,
    })
    value = result.get('result', {}).get('result', {}).get('value', '')
    print(value)

    client.ws.close()

if __name__ == '__main__':
    main()
