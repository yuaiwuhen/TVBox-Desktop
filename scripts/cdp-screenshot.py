#!/usr/bin/env python3
"""Take a screenshot of the TVBox Desktop Electron window via CDP."""
import sys
import io
import json
import base64
import requests
import websocket

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

CDP_PORT = 9223
OUTPUT_FILE = r'd:\Code\TVBox-Pc-Docker\screenshots\homepage.png'

def get_page_target():
    resp = requests.get(f'http://127.0.0.1:{CDP_PORT}/json')
    targets = resp.json()
    for t in targets:
        if t.get('type') == 'page' and 'devtools' not in t.get('url', ''):
            return t
    return None

def main():
    import os
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

    target = get_page_target()
    if not target:
        print('No page target found')
        sys.exit(1)

    print(f'Page: {target["title"]} | {target["url"]}')
    ws = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=30)

    # Capture screenshot
    msg = {
        'id': 1,
        'method': 'Page.captureScreenshot',
        'params': {
            'format': 'png',
            'captureBeyondViewport': False,
        },
    }
    ws.send(json.dumps(msg))
    while True:
        result = json.loads(ws.recv())
        if result.get('id') == 1:
            if 'result' in result:
                data = result['result'].get('data', '')
                with open(OUTPUT_FILE, 'wb') as f:
                    f.write(base64.b64decode(data))
                print(f'Screenshot saved to: {OUTPUT_FILE}')
                print(f'Size: {len(base64.b64decode(data))} bytes')
            else:
                print(f'Error: {result}')
            break

    ws.close()

if __name__ == '__main__':
    main()
