/**
 * Cross-platform JRE downloader.
 *
 * Downloads a pre-built JRE from the Tsinghua mirror of Adoptium (Eclipse
 * Temurin) for the specified target platform and extracts it to the project's
 * jre/ directory. Falls back to the official GitHub releases URL if the
 * mirror is unavailable.
 *
 * Usage:
 *   node scripts/download-jre.mjs                    # current platform
 *   node scripts/download-jre.mjs --target=linux     # Linux x64
 *   node scripts/download-jre.mjs --target=mac       # Mac (host arch)
 *   node scripts/download-jre.mjs --target=win --arch=arm64
 *
 * Environment:
 *   FORCE_JRE_DOWNLOAD=1   Re-download even if jre/ already has the target JRE
 *
 * The resulting jre/ directory is consumed by electron-builder extraResources
 * and bundled into the packaged app's resources/jre/.
 */

import https from 'https';
import fs from 'fs';
import { createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const jreDir = path.join(projectRoot, 'jre');

const JAVA_VERSION = 21;

const osMap = { win: 'windows', linux: 'linux', mac: 'mac' };
const archMap = { x64: 'x64', arm64: 'aarch64' };

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { target: null, arch: null };
  for (const arg of args) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (m) opts[m[1]] = m[2];
  }
  if (!opts.target) {
    opts.target =
      process.platform === 'win32'
        ? 'win'
        : process.platform === 'darwin'
          ? 'mac'
          : 'linux';
  }
  if (!opts.arch) {
    opts.arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  }
  return opts;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'tvbox-pc-jre-downloader',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`API HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`Failed to parse API JSON: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('API timeout (30s)')));
  });
}

function downloadOnce(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    const file = createWriteStream(dest);
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'tvbox-pc-jre-downloader' } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          fs.unlinkSync(dest);
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          downloadOnce(next, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {}
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = ((received / total) * 100).toFixed(1);
            const mb = (received / 1024 / 1024).toFixed(1);
            const totalMb = (total / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r  ${mb}/${totalMb} MB (${pct}%)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      },
    );
    req.on('error', (e) => {
      file.close();
      try {
        fs.unlinkSync(dest);
      } catch {}
      reject(e);
    });
    req.setTimeout(600000, () => {
      req.destroy(new Error('Download timeout (10 min idle)'));
    });
  });
}

async function downloadWithRetry(url, dest, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\n[Attempt ${attempt}/${maxRetries}]`);
      await downloadOnce(url, dest);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`\nFailed: ${e.message}`);
      if (attempt < maxRetries) {
        console.log('Retrying in 10s...');
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }
  throw lastErr;
}

function extractZip(zipPath, destDir) {
  console.log(`Extracting (zip): ${zipPath} -> ${destDir}`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ ships tar.exe (supports .zip), Linux/macOS have native tar.
  // Using tar uniformly avoids the PowerShell Expand-Archive dependency.
  execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { stdio: 'inherit' });
}

function extractTarGz(tarPath, destDir) {
  console.log(`Extracting (tar.gz): ${tarPath} -> ${destDir}`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'inherit' });
}

function flattenJre(extractDir, target) {
  const entries = fs.readdirSync(extractDir);
  const jdkRoot = entries.find((e) => e.startsWith('jdk-'));
  if (!jdkRoot) {
    console.warn(
      `No jdk-* directory found in extracted archive. Entries: ${entries.join(', ')}`,
    );
    return false;
  }
  let srcDir = path.join(extractDir, jdkRoot);

  // macOS JRE has a special structure: Contents/Home/ contains the actual JRE
  if (target === 'mac') {
    const contentsHome = path.join(srcDir, 'Contents', 'Home');
    if (fs.existsSync(contentsHome)) {
      console.log(`macOS: Using Contents/Home/ subdirectory`);
      srcDir = contentsHome;
    }
  }

  console.log(`Flattening: ${srcDir} -> ${jreDir}`);

  // Debug: list source directory structure
  console.log(`Source directory entries: ${fs.readdirSync(srcDir).join(', ')}`);
  const srcLib = path.join(srcDir, 'lib');
  if (fs.existsSync(srcLib)) {
    const srcServer = path.join(srcLib, 'server');
    if (fs.existsSync(srcServer)) {
      console.log(
        `Source lib/server entries: ${fs.readdirSync(srcServer).join(', ')}`,
      );
    } else {
      console.log(`Source lib/ entries: ${fs.readdirSync(srcLib).join(', ')}`);
    }
  } else {
    console.log(`Source has no lib/ directory`);
  }

  if (fs.existsSync(jreDir)) {
    fs.rmSync(jreDir, { recursive: true, force: true });
  }
  // Use cpSync instead of renameSync — renameSync fails with EPERM on Windows
  // when a file in srcDir is locked (e.g. jvm.dll loaded by a lingering
  // previous Electron process). cpSync reads+writes file-by-file, which works
  // even when the source is locked (the new copy in jreDir is a fresh file).
  try {
    fs.cpSync(srcDir, jreDir, { recursive: true, force: true });
  } catch (e) {
    console.error(`cpSync failed: ${e.message}`);
    return false;
  }

  // Debug: verify copy succeeded
  console.log(`Target jre/ entries: ${fs.readdirSync(jreDir).join(', ')}`);
  const targetLib = path.join(jreDir, 'lib');
  if (fs.existsSync(targetLib)) {
    const targetServer = path.join(targetLib, 'server');
    if (fs.existsSync(targetServer)) {
      console.log(
        `Target lib/server entries: ${fs.readdirSync(targetServer).join(', ')}`,
      );
    } else {
      console.log(
        `Target lib/ entries (no server): ${fs.readdirSync(targetLib).join(', ')}`,
      );
    }
  } else {
    console.log(`Target has no lib/ directory`);
  }

  return true;
}

function verifyJre(target) {
  const candidates = {
    win: path.join(jreDir, 'bin', 'server', 'jvm.dll'),
    linux: path.join(jreDir, 'lib', 'server', 'libjvm.so'),
    mac: path.join(jreDir, 'lib', 'server', 'libjvm.dylib'),
  };
  const jvmLib = candidates[target];
  if (!fs.existsSync(jvmLib)) {
    throw new Error(`Verification failed: JVM library not found at ${jvmLib}`);
  }
  console.log(
    `✓ Verified JVM library: ${jvmLib} (${(fs.statSync(jvmLib).size / 1024 / 1024).toFixed(1)} MB)`,
  );

  const javaExe = path.join(
    jreDir,
    'bin',
    target === 'win' ? 'java.exe' : 'java',
  );
  if (!fs.existsSync(javaExe)) {
    throw new Error(
      `Verification failed: java executable not found at ${javaExe}`,
    );
  }
  console.log(`✓ Verified java executable: ${javaExe}`);
}

function jreExistsForTarget(target) {
  const candidates = {
    win: path.join(jreDir, 'bin', 'server', 'jvm.dll'),
    linux: path.join(jreDir, 'lib', 'server', 'libjvm.so'),
    mac: path.join(jreDir, 'lib', 'server', 'libjvm.dylib'),
  };
  return fs.existsSync(candidates[target]);
}

async function main() {
  const opts = parseArgs();
  const osName = osMap[opts.target];
  const archName = archMap[opts.arch];
  if (!osName)
    throw new Error(`Unknown target: ${opts.target}. Use win/linux/mac`);
  if (!archName) throw new Error(`Unknown arch: ${opts.arch}. Use x64/arm64`);

  // Skip if JRE already exists (unless forced)
  if (jreExistsForTarget(opts.target) && !process.env.FORCE_JRE_DOWNLOAD) {
    console.log(
      `JRE for ${opts.target}-${opts.arch} already exists at ${jreDir}. Set FORCE_JRE_DOWNLOAD=1 to re-download.`,
    );
    return;
  }

  console.log(`=== Downloading JRE for ${opts.target}-${opts.arch} ===`);

  // 1. Query Adoptium API for latest release info (small JSON response)
  const apiUrl = `https://api.adoptium.net/v3/assets/feature_releases/${JAVA_VERSION}/ga?heap_size=normal&image_type=jre&jvm_impl=hotspot&os=${osName}&architecture=${archName}&vendor=eclipse`;
  console.log(`Querying API: ${apiUrl}`);
  const releaseInfo = await fetchJson(apiUrl);
  if (!Array.isArray(releaseInfo) || releaseInfo.length === 0) {
    throw new Error('Adoptium API returned no releases');
  }
  const pkg = releaseInfo[0].binaries[0].package;
  if (!pkg || !pkg.name) {
    throw new Error('Adoptium API returned unexpected structure');
  }
  console.log(`Latest version: ${releaseInfo[0].version_data.semver}`);
  console.log(`Package name: ${pkg.name}`);

  // 2. Construct Tsinghua mirror URL
  const mirrorUrl = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${JAVA_VERSION}/jre/${archName}/${osName}/${pkg.name}`;
  const officialUrl = pkg.link;

  const isZip = opts.target === 'win';
  const archiveExt = isZip ? '.zip' : '.tar.gz';
  const archivePath = path.join(projectRoot, `jre-download${archiveExt}`);
  const extractDir = path.join(projectRoot, 'jre-extract');

  // 3. Try mirror first, fall back to official URL
  try {
    console.log('\n--- Trying Tsinghua mirror ---');
    await downloadWithRetry(mirrorUrl, archivePath, 3);
  } catch (mirrorErr) {
    console.log(`\nMirror failed: ${mirrorErr.message}`);
    console.log('\n--- Falling back to official GitHub releases ---');
    await downloadWithRetry(officialUrl, archivePath, 3);
  }

  console.log(
    `Downloaded: ${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB`,
  );

  // 4. Extract
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });
  if (isZip) {
    extractZip(archivePath, extractDir);
  } else {
    extractTarGz(archivePath, extractDir);
  }

  // 5. Flatten to jre/
  const ok = flattenJre(extractDir, opts.target);
  if (!ok) throw new Error('Failed to flatten JRE directory');

  // 6. Verify
  verifyJre(opts.target);

  // 7. Clean up
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  const totalSize = (() => {
    let total = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(jreDir);
    return total;
  })();
  console.log(`\n=== JRE ready ===`);
  console.log(`  Location: ${jreDir}`);
  console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Target: ${opts.target}-${opts.arch}`);
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
