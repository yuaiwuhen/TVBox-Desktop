/**
 * Unit test for Guard JAR decryption flow
 *
 * Test steps:
 * 1. Download NetEase JAR (bd630429...jar)
 * 2. List JAR contents to find .so and .guard files
 * 3. Extract wexguard_v8.so and wexshinidie.guard
 * 4. Run WexguardDecryptor to decrypt classes.dex
 * 5. Run enjarify to convert to JAR
 * 6. Check if JAR contains new Guard classes (ManJuHongGuo/ManJuXiFan/AnimeHuazi)
 *
 * Usage:
 *   node tools/e2e/test-guard-decrypt.cjs
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const axios = require('axios');

const NETEASE_JAR_URL =
  'https://nos.netease.com/ysf/bd630429a515df48ad3573ea1d4e7426.jar';
const WORK_DIR = path.join(__dirname, 'guard_decrypt_test');
const JAR_PATH = path.join(WORK_DIR, 'netease.jar');
const EXTRACT_DIR = path.join(WORK_DIR, 'extracted');
const SO_PATH = path.join(EXTRACT_DIR, 'assets', 'wexguard_v8.so');
const GUARD_PATH = path.join(EXTRACT_DIR, 'assets', 'wexshinidie.guard');
const DEX_PATH = path.join(WORK_DIR, 'classes.dex');
const OUTPUT_JAR_PATH = path.join(WORK_DIR, 'wexguard-decrypted.jar');

// Target classes that should exist in decrypted JAR
const TARGET_CLASSES = [
  'ManJuHongGuo',
  'ManJuXiFan',
  'AnimeHuazi',
  // Existing classes for verification
  'ManJuHuoLong',
  'AnimeXiFan',
  'NewBiLiYS',
  'WexGuaZi',
];

async function downloadJar() {
  console.log('[Step 1] Downloading NetEase JAR...');

  if (fs.existsSync(JAR_PATH)) {
    const stats = fs.statSync(JAR_PATH);
    console.log(`  JAR already exists (${stats.size} bytes)`);
    return;
  }

  console.log(`  Downloading from: ${NETEASE_JAR_URL}`);

  // Use axios to download
  const response = await axios.get(NETEASE_JAR_URL, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  fs.writeFileSync(JAR_PATH, response.data);
  console.log(`  Downloaded to: ${JAR_PATH} (${response.data.length} bytes)`);
}

function listJarContents() {
  console.log('\n[Step 2] Listing JAR contents...');

  const output = execSync(`jar tf "${JAR_PATH}"`, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10, // 10MB buffer
  });
  const lines = output.split('\n').filter((l) => l.trim());

  console.log(`  Total entries: ${lines.length}`);

  // Find .so and .guard files
  const soFiles = lines.filter((l) => l.endsWith('.so'));
  const guardFiles = lines.filter((l) => l.endsWith('.guard'));

  console.log(`  .so files: ${soFiles.length}`);
  soFiles.forEach((f) => console.log(`    - ${f}`));
  console.log(`  .guard files: ${guardFiles.length}`);
  guardFiles.forEach((f) => console.log(`    - ${f}`));

  // Also show classes.dex
  const dexFiles = lines.filter((l) => l.includes('.dex'));
  console.log(`  .dex files: ${dexFiles.length}`);
  dexFiles.forEach((f) => console.log(`    - ${f}`));

  return { soFiles, guardFiles };
}

function extractFiles(soFiles, guardFiles) {
  console.log('\n[Step 3] Extracting .so and .guard files...');

  if (!fs.existsSync(EXTRACT_DIR)) {
    fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  }

  // Known file paths in NetEase JAR (from manual inspection)
  const knownFiles = [
    'assets/wexguard_v7.so',
    'assets/wexguard_v8.so',
    'assets/wexshinidie.guard',
  ];

  const filesToExtract = [
    ...new Set([...soFiles, ...guardFiles, ...knownFiles]),
  ];

  // Extract files
  for (const file of filesToExtract) {
    console.log(`  Extracting: ${file}`);
    try {
      execSync(`jar xf "${JAR_PATH}" "${file}"`, { cwd: EXTRACT_DIR });
    } catch (e) {
      console.error(`  Failed to extract ${file}: ${e.message}`);
    }
  }

  // Verify extraction
  if (fs.existsSync(SO_PATH)) {
    const stats = fs.statSync(SO_PATH);
    console.log(`  ✅ wexguard_v8.so extracted (${stats.size} bytes)`);
  } else {
    console.error('  ❌ wexguard_v8.so not found after extraction');
    return false;
  }

  if (fs.existsSync(GUARD_PATH)) {
    const stats = fs.statSync(GUARD_PATH);
    console.log(`  ✅ wexshinidie.guard extracted (${stats.size} bytes)`);
  } else {
    console.error('  ❌ wexshinidie.guard not found after extraction');
    return false;
  }

  return true;
}

async function runWexguardDecryptor() {
  console.log('\n[Step 4] Running WexguardDecryptor...');

  // Check if classes.dex already exists
  if (fs.existsSync(DEX_PATH)) {
    const stats = fs.statSync(DEX_PATH);
    console.log(`  classes.dex already exists (${stats.size} bytes)`);
    return true;
  }

  // Find unidbg-loader JAR
  const unidbgJar = path.join(
    __dirname,
    '..',
    'runtime',
    'unidbg-loader-1.0.0.jar',
  );
  if (!fs.existsSync(unidbgJar)) {
    console.error(`  ❌ unidbg-loader JAR not found: ${unidbgJar}`);
    return false;
  }

  // Run WexguardDecryptor
  console.log(`  Running: java -jar ${unidbgJar}`);
  console.log(`    SO: ${SO_PATH}`);
  console.log(`    Guard: ${GUARD_PATH}`);
  console.log(`    Output: ${DEX_PATH}`);

  try {
    const result = spawn(
      'java',
      ['-jar', unidbgJar, SO_PATH, GUARD_PATH, DEX_PATH],
      {
        stdio: 'inherit',
      },
    );

    return new Promise((resolve) => {
      result.on('close', (code) => {
        if (code === 0 && fs.existsSync(DEX_PATH)) {
          const stats = fs.statSync(DEX_PATH);
          console.log(`  ✅ classes.dex generated (${stats.size} bytes)`);
          resolve(true);
        } else {
          console.error(`  ❌ WexguardDecryptor failed with code ${code}`);
          resolve(false);
        }
      });

      result.on('error', (err) => {
        console.error(`  ❌ Failed to run WexguardDecryptor: ${err.message}`);
        resolve(false);
      });
    });
  } catch (e) {
    console.error(`  ❌ Exception: ${e.message}`);
    return false;
  }
}

function runEnjarify() {
  console.log('\n[Step 5] Running enjarify...');

  if (!fs.existsSync(DEX_PATH)) {
    console.error('  ❌ classes.dex not found, cannot run enjarify');
    return false;
  }

  if (fs.existsSync(OUTPUT_JAR_PATH)) {
    const stats = fs.statSync(OUTPUT_JAR_PATH);
    console.log(`  Output JAR already exists (${stats.size} bytes)`);
    return true;
  }

  // Find enjarify script
  const enjarifyPy = path.join(__dirname, '..', 'enjarify', 'enjarify.sh');
  const enjarifyBat = path.join(__dirname, '..', 'enjarify', 'enjarify.bat');

  let enjarifyCmd;
  if (process.platform === 'win32' && fs.existsSync(enjarifyBat)) {
    enjarifyCmd = enjarifyBat;
  } else if (fs.existsSync(enjarifyPy)) {
    enjarifyCmd = `python3 ${enjarifyPy}`;
  } else {
    // Try Python directly
    enjarifyCmd = `python -m enjarify`;
  }

  console.log(`  Running: ${enjarifyCmd} ${DEX_PATH} -o ${OUTPUT_JAR_PATH}`);

  try {
    execSync(`${enjarifyCmd} "${DEX_PATH}" -o "${OUTPUT_JAR_PATH}"`, {
      stdio: 'inherit',
      cwd: WORK_DIR,
    });

    if (fs.existsSync(OUTPUT_JAR_PATH)) {
      const stats = fs.statSync(OUTPUT_JAR_PATH);
      console.log(`  ✅ Output JAR generated (${stats.size} bytes)`);
      return true;
    } else {
      console.error('  ❌ Output JAR not found');
      return false;
    }
  } catch (e) {
    console.error(`  ❌ Failed to run enjarify: ${e.message}`);
    return false;
  }
}

function verifyTargetClasses() {
  console.log('\n[Step 6] Verifying target classes...');

  if (!fs.existsSync(OUTPUT_JAR_PATH)) {
    console.error('  ❌ Output JAR not found');
    return;
  }

  // List JAR contents
  const output = execSync(`jar tf "${OUTPUT_JAR_PATH}"`, { encoding: 'utf8' });
  const lines = output.split('\n').filter((l) => l.trim());

  console.log(`  Total classes: ${lines.length}`);

  // Check for target classes
  const results = {};
  for (const target of TARGET_CLASSES) {
    // Spider classes are in com/github/catvod/spider/
    const pattern = `com/github/catvod/spider/${target}.class`;
    const found = lines.some((l) => l === pattern);
    results[target] = found;

    if (found) {
      console.log(`  ✅ ${target} found`);
    } else {
      console.log(`  ❌ ${target} NOT FOUND`);
    }
  }

  // Summary
  const found = Object.values(results).filter((v) => v).length;
  const total = Object.keys(results).length;
  console.log(`\n  Summary: ${found}/${total} classes found`);

  // Check critical new classes
  const newClasses = ['ManJuHongGuo', 'ManJuXiFan', 'AnimeHuazi'];
  const newClassesFound = newClasses.filter((c) => results[c]).length;

  if (newClassesFound === newClasses.length) {
    console.log(
      `  ✅ All ${newClasses.length} new classes found - decryption successful!`,
    );
    return true;
  } else {
    console.log(
      `  ❌ Only ${newClassesFound}/${newClasses.length} new classes found - decryption incomplete`,
    );
    return false;
  }
}

async function main() {
  console.log('=== Guard JAR Decryption Unit Test ===\n');

  // Create work directory
  if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
  }

  try {
    // Step 1: Download JAR
    await downloadJar();

    // Step 2: List contents (may fail on some JARs due to Node.js buffer limits)
    const { soFiles, guardFiles } = listJarContents();

    if (soFiles.length === 0 || guardFiles.length === 0) {
      console.warn(
        '\n⚠️  jar tf output may be truncated, but we will still try to extract known files',
      );
      // Don't exit - we'll try to extract known files anyway
    }

    // Step 3: Extract files
    const extracted = extractFiles(soFiles, guardFiles);
    if (!extracted) {
      process.exit(1);
    }

    // Step 4: Run WexguardDecryptor
    const decrypted = await runWexguardDecryptor();
    if (!decrypted) {
      process.exit(1);
    }

    // Step 5: Run enjarify
    const converted = runEnjarify();
    if (!converted) {
      process.exit(1);
    }

    // Step 6: Verify classes
    const verified = verifyTargetClasses();

    console.log('\n=== Test Result ===');
    if (verified) {
      console.log('✅ PASS: Guard JAR decryption flow works correctly');
      console.log(
        '   New classes (ManJuHongGuo/ManJuXiFan/AnimeHuazi) are present in decrypted JAR',
      );
    } else {
      console.log('❌ FAIL: Decryption flow incomplete - new classes missing');
      console.log(
        '   This confirms the hypothesis that wexguard_v8.so is outdated',
      );
    }

    process.exit(verified ? 0 : 1);
  } catch (e) {
    console.error('\n❌ Test failed with exception:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
