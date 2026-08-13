#!/usr/bin/env python3
"""Inspect config sites by type."""
import json
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

config_path = r'd:\Code\TVBox-Pc-Docker\scripts\newwex-config.json'
with open(config_path, encoding='utf-8') as f:
    c = json.load(f)

sites = c.get('sites', [])
print(f'Total sites: {len(sites)}')

types = {}
for s in sites:
    t = s.get('type', 0)
    types.setdefault(t, []).append(s)

print('\nType distribution:')
for t in sorted(types.keys()):
    print(f'  type {t}: {len(types[t])} sites')

print('\nType 0/1/4 sites (non-spider, can be called directly):')
for t in (0, 1, 4):
    if t in types:
        for s in types[t][:10]:
            api = s.get('api', '')
            print(f'  [type{t}] key={s.get("key")} | name={s.get("name")[:30]} | api={api[:80]}')

print('\nFirst 5 type-3 sites:')
for s in types.get(3, [])[:5]:
    api = s.get('api', '')
    ext = s.get('ext', '')
    print(f'  key={s.get("key")}')
    print(f'    name={s.get("name")[:50]}')
    print(f'    api={api[:80]}')
    print(f'    ext={ext[:80] if isinstance(ext, str) else str(ext)[:80]}')
    print(f'    searchable={s.get("searchable")} filterable={s.get("filterable")}')
    print()
