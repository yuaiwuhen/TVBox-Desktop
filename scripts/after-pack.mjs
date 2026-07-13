/**
 * electron-builder afterPack hook.
 *
 * Fixes file permissions for the bundled JRE on Linux and macOS. When the JRE
 * is downloaded/extracted on Windows (or when electron-builder copies files
 * from a Windows filesystem), the executable bit on Unix binaries is lost.
 * Without this, jre/bin/java cannot be executed on Linux/macOS and the
 * spider loader fails silently.
 *
 * Also chmods jre/lib/ recursively because jspawnhelper (used by JVM's
 * ProcessBuilder to spawn child processes) lives there and must be executable.
 * Without +x on jspawnhelper, spiders calling Runtime.exec() fail with
 * "Cannot run program" IOException.
 *
 * On Windows, this hook is a no-op (Windows has no executable bit concept).
 */

import fs from 'fs';
import path from 'path';

function findJreDir(startDir, maxDepth = 6) {
  if (maxDepth <= 0 || !fs.existsSync(startDir)) return null;
  if (fs.existsSync(path.join(startDir, 'jre', 'bin'))) {
    return path.join(startDir, 'jre');
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
      fs.chmodSync(p, 0o755);
      fixed++;
    } else if (entry.isDirectory()) {
      fixed += chmodRecursive(p);
    }
  }
  return fixed;
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'linux' && platform !== 'darwin') return;

  const jreDir = findJreDir(context.appOutDir);
  if (!jreDir) {
    console.log('[afterPack] JRE directory not found, skipping');
    return;
  }

  console.log(`[afterPack] Fixing permissions under ${jreDir}`);
  let fixed = 0;
  // chmod jre/bin/ (java executable), jre/lib/ (jspawnhelper, jexec),
  // jre/lib/server/ (libjvm.so / libjvm.dylib).
  for (const sub of ['bin', 'lib']) {
    fixed += chmodRecursive(path.join(jreDir, sub));
  }
  console.log(`[afterPack] Fixed ${fixed} files to 0755`);
}
