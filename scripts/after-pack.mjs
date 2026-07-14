/**
 * electron-builder afterPack hook.
 *
 * 1. Fixes file permissions for the bundled JRE on Linux/macOS.
 * 2. Verifies jvm.dll / libjvm.so exists — fail the pack if JRE is missing
 *    so installers never ship without a Java runtime.
 */

import fs from 'fs';
import path from 'path';

function findJreDir(startDir, maxDepth = 6) {
  if (maxDepth <= 0 || !fs.existsSync(startDir)) return null;
  if (fs.existsSync(path.join(startDir, 'jre', 'bin'))) {
    return path.join(startDir, 'jre');
  }
  // Also check resources/jre (extraResources destination for electron-builder)
  if (fs.existsSync(path.join(startDir, 'resources', 'jre', 'bin'))) {
    return path.join(startDir, 'resources', 'jre');
  }
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findJreDir(path.join(startDir, entry.name), maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function chmodRecursive(dir) {
  if (!fs.existsSync(dir)) return 0;
  let fixed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile()) {
      try {
        fs.chmodSync(p, 0o755);
        fixed++;
      } catch {}
    } else if (entry.isDirectory()) {
      fixed += chmodRecursive(p);
    }
  }
  return fixed;
}

function verifyJvmLib(jreDir) {
  const candidates = [
    path.join(jreDir, 'bin', 'server', 'jvm.dll'),
    path.join(jreDir, 'lib', 'server', 'libjvm.so'),
    path.join(jreDir, 'lib', 'server', 'libjvm.dylib'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `[afterPack] Bundled JRE is incomplete — no jvm library under ${jreDir}. ` +
        `Run "pnpm build:jre" before packaging.`,
    );
  }
  console.log(`[afterPack] Verified JVM library: ${found}`);
  return found;
}

export default async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;

  const jreDir = findJreDir(appOutDir);
  if (!jreDir) {
    throw new Error(
      `[afterPack] No jre/ directory found in ${appOutDir}. ` +
        `Run "pnpm build:jre" before packaging.`,
    );
  }

  verifyJvmLib(jreDir);

  if (platform === 'linux' || platform === 'darwin') {
    let fixed = 0;
    for (const sub of ['bin', 'lib']) {
      fixed += chmodRecursive(path.join(jreDir, sub));
    }
    console.log(
      `[afterPack] chmod +x on ${fixed} files under ${jreDir} (${platform})`,
    );
  } else {
    console.log(`[afterPack] Windows: JRE verified at ${jreDir}`);
  }
}
