#!/usr/bin/env python3
"""Decode Datadiv-encoded strings from libwexguard.so .data section."""
import re
import sys

path = r'd:\Code\TVBox-Pc-Docker\aowu_jar_analysis\libwexguard.so'
data = open(path, 'rb').read()

# .data section: offset 0xc000, size ~0x5a7 (from readelf: Address 0xd000, Offset 0xc000)
# BSS starts at 0xd5a8 (offset 0xc5a8 in file). So .data is 0xc000..0xc5a8
section = data[0xc000:0xc5a8]

print(f"Section size: {len(section)} bytes")
print("=" * 70)

# Try multiple XOR keys
keys = [0x3c, 0x25, 0x3a, 0x2b, 0x55, 0xff, 0x7f, 0x12, 0xda, 0xa5, 0x5a, 0x69, 0x96]

for key in keys:
    decoded = bytes([b ^ key for b in section])
    # Find runs of printable ASCII (potential strings)
    s = ''.join(chr(c) if 32 <= c < 127 else '\n' for c in decoded)
    # Extract strings of length >= 4
    strings = [x for x in s.split('\n') if len(x) >= 4]
    # Filter for strings that look like JNI names/sigs
    interesting = [x for x in strings if re.search(r'[a-zA-Z]{3,}', x) and
                   any(kw in x.lower() for kw in ['com.', 'github', 'catvod', 'spider', 'mycrypto',
                    'getspider', 'getloader', 'proxy', 'sign', 'v7e', 'hxq', 'awsign', 'extde',
                    'fsdec', 'awdm', 'java/', '([b', '()[b', 'java/lang', 'register',
                    'dexnative', 'init', 'load', 'amns', 'aowu', 'wexguard', 'decjni', 'awenc',
                    'native', 'method', '([i', '(i[b'])]
    if interesting:
        print(f"\nKEY=0x{key:02x}:")
        for s in interesting[:40]:
            print(f"  {s}")

print("\n" + "=" * 70)
print("Full XOR 0x3c decode (all readable strings >= 5 chars):")
print("=" * 70)
decoded = bytes([b ^ 0x3c for b in section])
s = ''.join(chr(c) if 32 <= c < 127 else '\n' for c in decoded)
strings = [x.strip() for x in s.split('\n') if len(x.strip()) >= 5]
for s in strings:
    print(f"  {s}")
