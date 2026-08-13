#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Decompile DexNative and DMcycAmns classes."""

import sys
import os
import logging

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

try:
    from loguru import logger
    logger.remove()
    logger.add(sys.stderr, level="ERROR")
except:
    pass
logging.disable(logging.CRITICAL)

from androguard.core.dex import DEX

DEX_PATH = r"d:\Code\TVBox-Pc-Docker\aowu-extract\classes.dex"
OUT_PATH = r"d:\Code\TVBox-Pc-Docker\dexnative-amns-decompile.txt"

output = []
def log(msg):
    print(msg)
    output.append(str(msg))

with open(DEX_PATH, 'rb') as f:
    dex_data = f.read()

dex = DEX(dex_data)

# Analyze DexNative, DMcycAmns, DMfansAmns, DMaowuAmns, DMmoduAmns
target_classes = [
    'Lcom/github/catvod/spider/DexNative;',
    'Lcom/github/catvod/spider/DMcycAmns;',
    'Lcom/github/catvod/spider/DMfansAmns;',
    'Lcom/github/catvod/spider/DMaowuAmns;',
    'Lcom/github/catvod/spider/DMmoduAmns;',
]

for target_class in target_classes:
    log(f"\n{'='*60}")
    log(f"=== Analyzing class: {target_class} ===")
    log(f"{'='*60}")
    cls = dex.get_class(target_class)
    if cls is None:
        log("Class not found!")
        continue

    try:
        superclass = cls.get_superclassname()
        log(f"Superclass: {superclass}")
    except Exception as e:
        log(f"get_superclassname error: {e}")

    try:
        interfaces = cls.get_interfaces()
        log(f"Interfaces: {interfaces}")
    except Exception as e:
        log(f"get_interfaces error: {e}")

    try:
        access = cls.get_access_flags()
        log(f"Access flags: 0x{access:x} ({cls.get_access_flags_string()})")
    except Exception as e:
        log(f"get_access_flags error: {e}")

    # Get fields
    log("\n--- Fields ---")
    try:
        fields = cls.get_fields()
        field_list = list(fields)
        log(f"Total fields: {len(field_list)}")
        for f in field_list:
            try:
                name = f.get_name()
                desc = f.get_descriptor()
                access_str = f.get_access_flags_string()
                log(f"  Field: {name} : {desc}  [{access_str}]")
            except Exception as e:
                log(f"  Field error: {e}")
    except Exception as e:
        log(f"get_fields error: {e}")

    # Get methods
    log("\n--- Methods ---")
    try:
        methods = cls.get_methods()
        method_list = list(methods)
        log(f"Total methods: {len(method_list)}")
        for m in method_list:
            log(f"\n  --- Method ---")
            try:
                name = m.get_name()
                desc = m.get_descriptor()
                access_str = m.get_access_flags_string()
                log(f"  {name}{desc}  [{access_str}]")
            except Exception as e:
                log(f"  Method name error: {e}")
                continue
            try:
                code = m.get_code()
                if code:
                    try:
                        log(f"  Registers: {code.get_registers_size()}")
                    except:
                        pass
                    try:
                        bc = code.get_bc()
                        instructions = list(bc.get_instructions())
                        log(f"  Instructions: {len(instructions)}")
                        for idx, ins in enumerate(instructions):
                            try:
                                name_i = ins.get_name()
                                output_str = ins.get_output()
                                log(f"    [{idx:3d}] {name_i} {output_str}")
                            except Exception as e:
                                log(f"    [{idx:3d}] Error: {e}")
                    except Exception as e:
                        log(f"  BC error: {e}")
            except Exception as e:
                log(f"  get_code error: {e}")
    except Exception as e:
        log(f"get_methods error: {e}")
        import traceback
        log(traceback.format_exc())

# Save output
with open(OUT_PATH, 'w', encoding='utf-8') as f:
    f.write('\n'.join(output))

log(f"\n\nOutput saved to {OUT_PATH}")
