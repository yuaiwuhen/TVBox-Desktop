#!/usr/bin/env python3
"""Brute-force XOR decode each Datadiv string in libwexguard.so .data section."""
import re

path = r'd:\Code\TVBox-Pc-Docker\aowu_jar_analysis\libwexguard.so'
data = open(path, 'rb').read()

# .data section: file offset 0xc000, size 0x5a8
section = data[0xc000:0xc5a8]

def score(decoded_bytes):
    """Score how readable a decoded string is."""
    s = 0
    for b in decoded_bytes:
        if 32 <= b < 127:
            s += 1
        elif b == 0:
            s += 0  # null is ok as terminator
        else:
            s -= 2  # penalize non-printable
    return s

def try_decode(blob, key):
    return bytes([b ^ key for b in blob])

# Split section into candidate strings by finding runs between likely terminators
# Datadiv strings are stored sequentially. Let me find string boundaries.
# Strategy: scan and split on bytes that decode to null (0x00) for SOME key,
# but simpler: try to find maximal runs that decode well with a single key.

results = []
i = 0
while i < len(section):
    # Skip zero bytes (padding)
    if section[i] == 0:
        i += 1
        continue
    # Find a string starting here: try all keys, find the longest readable run
    best_key = None
    best_len = 0
    best_str = ""
    for key in range(256):
        # Decode forward until we hit a byte that decodes to 0x00 or non-printable
        j = i
        decoded = []
        while j < len(section):
            c = section[j] ^ key
            if c == 0:
                break  # null terminator
            if c < 32 or c >= 127:
                break  # non-printable
            decoded.append(c)
            j += 1
        if len(decoded) > best_len and len(decoded) >= 4:
            best_len = len(decoded)
            best_key = key
            best_str = ''.join(chr(c) for c in decoded)
    if best_len >= 4:
        results.append((i + 0xc000, best_key, best_str))
        i += best_len + 1  # skip past the string + terminator
    else:
        i += 1

print(f"Found {len(results)} decoded strings:")
print("=" * 70)
for offset, key, s in results:
    print(f"  0x{offset:05x} [key=0x{key:02x}] {s}")
