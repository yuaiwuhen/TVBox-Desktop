#!/usr/bin/env python3
"""Targeted decode: find all strings starting with 'com' or '(' (JNI sig) in libwexguard.so .data."""
import re

path = r'd:\Code\TVBox-Pc-Docker\aowu_jar_analysis\libwexguard.so'
data = open(path, 'rb').read()

# .data section: file offset 0xc000, size 0x5a8
section = data[0xc000:0xc5a8]

def decode_with_key(blob, key):
    return bytes([b ^ key for b in blob])

def is_readable(b):
    return 32 <= b < 127

# For each starting position, try each key, see if we get "com" or "(" prefix
print("=== Strings starting with 'com' (class names) ===")
for i in range(len(section)):
    for key in range(256):
        decoded = decode_with_key(section[i:i+3], key)
        if decoded == b'com':
            # Extend the string
            j = i + 3
            chars = list(decoded)
            while j < len(section):
                c = section[j] ^ key
                if c == 0 or not is_readable(c):
                    break
                chars.append(c)
                j += 1
            s = ''.join(chr(c) for c in chars)
            if len(s) >= 8:
                print(f"  0x{i+0xc000:05x} [key=0x{key:02x}] '{s}'")
            break

print("\n=== Strings starting with '(' (JNI signatures) ===")
for i in range(len(section)):
    for key in range(256):
        c = section[i] ^ key
        if c == ord('('):
            # Check if next few bytes decode to readable sig chars
            decoded = decode_with_key(section[i:i+5], key)
            if all(is_readable(b) for b in decoded) and b'Ljava' in decode_with_key(section[i:i+20], key) or b'[B' in decode_with_key(section[i:i+10], key) or b'()' in decode_with_key(section[i:i+10], key):
                j = i
                chars = []
                while j < len(section):
                    c = section[j] ^ key
                    if c == 0 or not is_readable(c):
                        break
                    chars.append(c)
                    j += 1
                s = ''.join(chr(c) for c in chars)
                if len(s) >= 4 and ('(' in s and ')' in s):
                    print(f"  0x{i+0xc000:05x} [key=0x{key:02x}] '{s}'")
            break

print("\n=== Raw hex at 0x0c450 (InitOrigin area) ===")
off = 0xc450 - 0xc000
print(' '.join(f'{b:02x}' for b in section[off:off+50]))
print("Decoded key=0x80:", ''.join(chr(b^0x80) if 32<=(b^0x80)<127 else '.' for b in section[off:off+50]))

print("\n=== Raw hex at 0x0c0c0 (ProxyOrigin area) ===")
off = 0xc0c0 - 0xc000
print(' '.join(f'{b:02x}' for b in section[off:off+50]))
print("Decoded key=0x3c:", ''.join(chr(b^0x3c) if 32<=(b^0x3c)<127 else '.' for b in section[off:off+50]))

# Look for method names: short strings (3-15 chars) that might be method names
print("\n=== Candidate method names (short alphanumeric strings) ===")
seen = set()
for i in range(len(section)):
    for key in range(256):
        # Try to decode 3-15 char string starting here
        j = i
        chars = []
        while j < len(section) and j < i + 20:
            c = section[j] ^ key
            if c == 0:
                break
            if not is_readable(c):
                break
            chars.append(c)
            j += 1
        s = ''.join(chr(c) for c in chars)
        if 3 <= len(s) <= 15 and s not in seen:
            # Check if it looks like a method name (alphanumeric, starts with letter)
            if re.match(r'^[a-zA-Z][a-zA-Z0-9_]+$', s):
                # Check if previous byte decodes to null (string start)
                if i > 0:
                    prev = section[i-1] ^ key
                    if prev == 0 or i == 0:
                        seen.add(s)
                        print(f"  0x{i+0xc000:05x} [key=0x{key:02x}] '{s}'")
