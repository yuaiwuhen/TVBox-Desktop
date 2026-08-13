#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Decompile AowuShinidie class from aowu JAR's classes.dex."""

import sys
import os
import logging

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# Suppress androguard debug logs
try:
    from loguru import logger
    logger.remove()
    logger.add(sys.stderr, level="ERROR")
except:
    pass
logging.disable(logging.CRITICAL)

from androguard.core.dex import DEX

DEX_PATH = r"d:\Code\TVBox-Pc-Docker\aowu-extract\classes.dex"
OUT_PATH = r"d:\Code\TVBox-Pc-Docker\aowu-shinidie-decompile.txt"

output = []
def log(msg):
    print(msg)
    output.append(str(msg))

with open(DEX_PATH, 'rb') as f:
    dex_data = f.read()

dex = DEX(dex_data)

# Get AowuShinidie class
target_class = 'Lcom/github/catvod/spider/AowuShinidie;'
log(f"=== Analyzing class: {target_class} ===")
cls = dex.get_class(target_class)
if cls is None:
    log("Class not found!")
    sys.exit(1)

log(f"Class type: {type(cls).__name__}")
log(f"Class methods/attrs: {[x for x in dir(cls) if not x.startswith('_')]}")

# Get superclass
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

# Get source file
try:
    source = cls.get_source()
    log(f"Source file: {source}")
except Exception as e:
    log(f"get_source error: {e}")

# Get access flags
try:
    access = cls.get_access_flags()
    log(f"Access flags: {access} (0x{access:x})")
except Exception as e:
    log(f"get_access_flags error: {e}")

# Get fields
log("\n=== Fields ===")
try:
    fields = cls.get_fields()
    for f in fields:
        log(f"  Field: {f}")
        log(f"    Type: {type(f).__name__}")
        log(f"    Dir: {[x for x in dir(f) if not x.startswith('_')]}")
        try:
            log(f"    Name: {f.get_name()}")
        except:
            pass
        try:
            log(f"    Descriptor: {f.get_descriptor()}")
        except:
            pass
        try:
            log(f"    Access: {f.get_access_flags_string()}")
        except:
            pass
except Exception as e:
    log(f"get_fields error: {e}")
    import traceback
    log(traceback.format_exc())

# Get methods
log("\n=== Methods ===")
try:
    methods = cls.get_methods()
    log(f"Total methods: {len(methods)}")
    for m in methods:
        log(f"\n  --- Method ---")
        log(f"  Method: {m}")
        log(f"  Type: {type(m).__name__}")
        try:
            log(f"  Name: {m.get_name()}")
        except:
            pass
        try:
            log(f"  Descriptor: {m.get_descriptor()}")
        except:
            pass
        try:
            log(f"  Access: {m.get_access_flags_string()}")
        except:
            pass
        try:
            code = m.get_code()
            if code:
                log(f"  Code: {code}")
                log(f"  Code type: {type(code).__name__}")
                log(f"  Code dir: {[x for x in dir(code) if not x.startswith('_')]}")
                try:
                    log(f"  Code size: {code.get_length()}")
                except:
                    pass
                try:
                    log(f"  Registers: {code.get_registers_size()}")
                except:
                    pass
                try:
                    # Get bytecode
                    bc = code.get_bc()
                    log(f"  BC type: {type(bc).__name__}")
                    log(f"  BC dir: {[x for x in dir(bc) if not x.startswith('_')]}")
                    try:
                        instructions = list(bc.get_instructions())
                        log(f"  Instructions count: {len(instructions)}")
                        for idx, ins in enumerate(instructions):
                            try:
                                op = ins.get_op_value()
                                name = ins.get_name()
                                output_str = ins.get_output()
                                log(f"    [{idx:3d}] {name} {output_str}")
                            except Exception as e:
                                log(f"    [{idx:3d}] Error: {e}")
                    except Exception as e:
                        log(f"  get_instructions error: {e}")
                except Exception as e:
                    log(f"  get_bc error: {e}")
        except Exception as e:
            log(f"  get_code error: {e}")
            import traceback
            log(traceback.format_exc())
except Exception as e:
    log(f"get_methods error: {e}")
    import traceback
    log(traceback.format_exc())

# Save output
with open(OUT_PATH, 'w', encoding='utf-8') as f:
    f.write('\n'.join(output))

log(f"\n\nOutput saved to {OUT_PATH}")
