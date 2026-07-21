/**
 * Guard Spider Decryption Test Tool
 *
 * Tests the complete flow of extracting and decrypting Guard spider classes from NetEase JAR.
 *
 * Flow:
 * 1. Download NetEase JAR (if not cached)
 * 2. Extract wexguard_v8.so and wexshinidie.guard
 * 3. Run WexguardDecryptor to decrypt
 * 4. Extract classes.dex from ZIP wrapper
 * 5. Convert DEX to JAR using dex2jar
 * 6. Verify JAR contains target classes
 *
 * Usage:
 *   node tools/test-guard-decrypt-flow.cjs [--force]
 *
 * Options:
 *   --force    Re-run all steps even if cached files exist
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const axios = require('axios');

// Configuration
const CONFIG = {
  NETEASE_JAR_URL:
    'https://nos.netease.com/ysf/bd630429a515df48ad3573ea1d4e7426.jar',
  WORK_DIR: path.join(__dirname, 'guard_decrypt_work'),
  TARGET_CLASSES: [
    'ManJuHongGuo',
    'ManJuXiFan',
    'AnimeHuazi',
    'ManJuHuoLong',
    'AnimeXiFan',
    'NewBiLiYS',
    'WexGuaZi',
  ],
};

// File paths
const FILES = {
  NETEASE_JAR: path.join(CONFIG.WORK_DIR, 'netease.jar'),
  SO_FILE: path.join(CONFIG.WORK_DIR, 'assets', 'wexguard_v8.so'),
  GUARD_FILE: path.join(CONFIG.WORK_DIR, 'assets', 'wexshinidie.guard'),
  DECRYPTED_ZIP: path.join(CONFIG.WORK_DIR, 'decrypted.zip'),
  DECRYPTED_DEX: path.join(CONFIG.WORK_DIR, 'classes.dex'),
  OUTPUT_JAR: path.join(CONFIG.WORK_DIR, 'wexguard-decrypted.jar'),
};

// Parse command line args
const args = process.argv.slice(2);
const forceRerun = args.includes('--force');
const skipDecrypt = args.includes('--skip-decrypt');

// Utility functions
function log(step, message) {
  console.log(`\n[Step ${step}] ${message}`);
}

function logSuccess(message) {
  console.log(`  ✅ ${message}`);
}

function logError(message) {
  console.error(`  ❌ ${message}`);
}

function logInfo(message) {
  console.log(`  ℹ️  ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getFileSize(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.statSync(filePath).size;
  }
  return 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Step 1: Download NetEase JAR
async function downloadNetEaseJar() {
  log(1, 'Downloading NetEase JAR...');

  if (fs.existsSync(FILES.NETEASE_JAR) && !forceRerun) {
    const size = getFileSize(FILES.NETEASE_JAR);
    logInfo(`Already cached: ${FILES.NETEASE_JAR} (${formatBytes(size)})`);
    return true;
  }

  try {
    logInfo(`Downloading from: ${CONFIG.NETEASE_JAR_URL}`);
    const response = await axios.get(CONFIG.NETEASE_JAR_URL, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });

    ensureDir(CONFIG.WORK_DIR);
    fs.writeFileSync(FILES.NETEASE_JAR, response.data);

    logSuccess(`Downloaded: ${formatBytes(response.data.length)}`);
    return true;
  } catch (e) {
    logError(`Failed to download: ${e.message}`);
    return false;
  }
}

// Step 2: Extract .so and .guard files
function extractFiles() {
  log(2, 'Extracting .so and .guard files...');

  const assetsDir = path.join(CONFIG.WORK_DIR, 'assets');
  ensureDir(assetsDir);

  const filesToExtract = ['assets/wexguard_v8.so', 'assets/wexshinidie.guard'];

  let allExtracted = true;
  for (const file of filesToExtract) {
    try {
      logInfo(`Extracting: ${file}`);
      execSync(`jar xf "${FILES.NETEASE_JAR}" "${file}"`, {
        cwd: CONFIG.WORK_DIR,
        stdio: 'pipe',
      });

      const extractedPath = path.join(CONFIG.WORK_DIR, file);
      if (fs.existsSync(extractedPath)) {
        const size = getFileSize(extractedPath);
        logSuccess(`${path.basename(file)}: ${formatBytes(size)}`);
      } else {
        logError(`${file} not found after extraction`);
        allExtracted = false;
      }
    } catch (e) {
      logError(`Failed to extract ${file}: ${e.message}`);
      allExtracted = false;
    }
  }

  return allExtracted;
}

// Step 3: Run WexguardDecryptor
async function runDecryptor() {
  log(3, 'Running WexguardDecryptor (this may take 1-2 minutes)...');

  if (fs.existsSync(FILES.DECRYPTED_ZIP) && !forceRerun) {
    const size = getFileSize(FILES.DECRYPTED_ZIP);
    logInfo(`Already cached: ${FILES.DECRYPTED_ZIP} (${formatBytes(size)})`);
    return true;
  }

  // Find unidbg-loader JAR
  const unidbgJar = path.join(__dirname, 'runtime', 'unidbg-loader-1.0.0.jar');
  if (!fs.existsSync(unidbgJar)) {
    logError(`unidbg-loader JAR not found: ${unidbgJar}`);
    return false;
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(
        'java',
        [
          '-jar',
          unidbgJar,
          FILES.SO_FILE,
          FILES.GUARD_FILE,
          FILES.DECRYPTED_ZIP,
        ],
        { stdio: 'inherit' },
      );

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(FILES.DECRYPTED_ZIP)) {
          const size = getFileSize(FILES.DECRYPTED_ZIP);
          logSuccess(`Decrypted: ${formatBytes(size)}`);
          resolve(true);
        } else {
          logError(`Decryptor failed with code ${code}`);
          resolve(false);
        }
      });

      proc.on('error', (err) => {
        logError(`Failed to run decryptor: ${err.message}`);
        resolve(false);
      });
    } catch (e) {
      logError(`Exception: ${e.message}`);
      resolve(false);
    }
  });
}

// Step 4: Extract classes.dex from ZIP
function extractDex() {
  log(4, 'Extracting classes.dex from ZIP...');

  if (fs.existsSync(FILES.DECRYPTED_DEX) && !forceRerun) {
    const size = getFileSize(FILES.DECRYPTED_DEX);
    logInfo(`Already cached: ${FILES.DECRYPTED_DEX} (${formatBytes(size)})`);
    return true;
  }

  try {
    // Extract classes.dex from ZIP
    execSync(`jar xf "${FILES.DECRYPTED_ZIP}" classes.dex`, {
      cwd: CONFIG.WORK_DIR,
      stdio: 'pipe',
    });

    const extractedPath = path.join(CONFIG.WORK_DIR, 'classes.dex');
    if (fs.existsSync(extractedPath)) {
      const size = getFileSize(extractedPath);
      logSuccess(`Extracted: ${formatBytes(size)}`);

      // Verify DEX magic
      const fd = fs.openSync(extractedPath, 'r');
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);

      if (magic[0] === 0x64 && magic[1] === 0x65 && magic[2] === 0x78) {
        logSuccess('DEX magic verified: dex\\n');
        return true;
      } else {
        logError(`Invalid DEX magic: ${magic.toString('hex')}`);
        return false;
      }
    } else {
      logError('classes.dex not found in ZIP');
      return false;
    }
  } catch (e) {
    logError(`Failed to extract: ${e.message}`);
    return false;
  }
}

// Step 5: Convert DEX to JAR
function convertDexToJar() {
  log(5, 'Converting DEX to JAR using dex2jar...');

  if (fs.existsSync(FILES.OUTPUT_JAR) && !forceRerun) {
    const size = getFileSize(FILES.OUTPUT_JAR);
    logInfo(`Already cached: ${FILES.OUTPUT_JAR} (${formatBytes(size)})`);
    return true;
  }

  // Find dex-tools
  const dexToolsDir = path.join(__dirname, 'dex-tools-v2.4');
  const dexToolsLib = path.join(dexToolsDir, 'lib');

  if (!fs.existsSync(dexToolsLib)) {
    logError(`dex-tools not found: ${dexToolsLib}`);
    return false;
  }

  try {
    // Build classpath
    const jars = fs.readdirSync(dexToolsLib).filter((f) => f.endsWith('.jar'));
    const classpath = jars.map((j) => path.join(dexToolsLib, j)).join(';');

    // Run dex2jar
    const cmd = `java -Xms512m -Xmx2048m -cp "${classpath}" com.googlecode.dex2jar.tools.Dex2jarCmd "${FILES.DECRYPTED_DEX}" -o "${FILES.OUTPUT_JAR}" -f`;
    logInfo('Running dex2jar...');

    execSync(cmd, { stdio: 'inherit', cwd: CONFIG.WORK_DIR });

    if (fs.existsSync(FILES.OUTPUT_JAR)) {
      const size = getFileSize(FILES.OUTPUT_JAR);
      logSuccess(`Generated: ${formatBytes(size)}`);
      return true;
    } else {
      logError('JAR file not created');
      return false;
    }
  } catch (e) {
    logError(`Failed to convert: ${e.message}`);
    return false;
  }
}

// Step 6: Verify target classes
function verifyClasses() {
  log(6, 'Verifying target classes in JAR...');

  if (!fs.existsSync(FILES.OUTPUT_JAR)) {
    logError('JAR file not found');
    return false;
  }

  try {
    // List JAR contents
    const output = execSync(`jar tf "${FILES.OUTPUT_JAR}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });

    const lines = output.split('\n').filter((l) => l.trim());
    logInfo(`Total classes: ${lines.length}`);

    // Check for target classes
    const results = {};
    for (const target of CONFIG.TARGET_CLASSES) {
      const pattern = `com/github/catvod/spider/${target}.class`;
      const found = lines.some((l) => l.trim() === pattern);
      results[target] = found;

      if (found) {
        logSuccess(`${target} found`);
      } else {
        logError(`${target} NOT FOUND`);
      }
    }

    // Summary
    const found = Object.values(results).filter((v) => v).length;
    const total = Object.keys(results).length;

    console.log(`\n  Summary: ${found}/${total} classes found`);

    return found === total;
  } catch (e) {
    logError(`Failed to verify: ${e.message}`);
    return false;
  }
}

// Main
async function main() {
  console.log('='.repeat(60));
  console.log('Guard Spider Decryption Test Tool');
  console.log('='.repeat(60));

  if (forceRerun) {
    console.log('\n⚠️  Force mode: Re-running all steps\n');
  }

  ensureDir(CONFIG.WORK_DIR);

  try {
    // Step 1
    if (!(await downloadNetEaseJar())) {
      process.exit(1);
    }

    // Step 2
    if (!extractFiles()) {
      process.exit(1);
    }

    // Step 3
    if (!(await runDecryptor())) {
      process.exit(1);
    }

    // Step 4
    if (!extractDex()) {
      process.exit(1);
    }

    // Step 5
    if (!convertDexToJar()) {
      process.exit(1);
    }

    // Step 6
    const verified = verifyClasses();

    // Final result
    console.log('\n' + '='.repeat(60));
    if (verified) {
      console.log('✅ SUCCESS: Complete flow validated');
      console.log('');
      console.log('Output files:');
      console.log(`  JAR: ${FILES.OUTPUT_JAR}`);
      console.log(`  Size: ${formatBytes(getFileSize(FILES.OUTPUT_JAR))}`);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Copy wexguard-decrypted.jar to tools/wexguard_work/');
      console.log('  2. Or integrate runtime decryption into JarLoader');
    } else {
      console.log('❌ FAILED: Some classes missing');
      console.log('');
      console.log('Troubleshooting:');
      console.log('  - Check if WexguardDecryptor ran successfully');
      console.log('  - Verify dex2jar conversion completed');
      console.log('  - Run with --force to re-process all steps');
    }
    console.log('='.repeat(60));

    process.exit(verified ? 0 : 1);
  } catch (e) {
    console.error('\n❌ Unexpected error:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
