/**
 * Simplified verification: Check if decrypted DEX contains target classes
 * 
 * Prerequisites:
 * - NetEase JAR already downloaded (guard_decrypt_test/netease.jar)
 * - .so and .guard files already extracted (guard_decrypt_test/extracted/)
 * - classes.dex already decrypted (guard_decrypt_test/classes.dex)
 * 
 * This script:
 * 1. Extracts classes.dex from ZIP wrapper
 * 2. Uses strings command to find target class names in DEX
 * 3. Reports whether new classes exist
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORK_DIR = path.join(__dirname, 'guard_decrypt_test');
const ZIP_WRAPPER = path.join(WORK_DIR, 'classes.dex');
const EXTRACTED_DEX = path.join(WORK_DIR, 'classes_real.dex');

const TARGET_CLASSES = [
  'ManJuHongGuo',
  'ManJuXiFan',
  'AnimeHuazi',
  // Existing classes for comparison
  'ManJuHuoLong',
  'AnimeXiFan',
  'NewBiLiYS',
  'WexGuaZi',
];

function main() {
  console.log('=== Guard DEX Content Verification ===\n');

  // Check if ZIP wrapper exists
  if (!fs.existsSync(ZIP_WRAPPER)) {
    console.error('❌ ZIP wrapper not found:', ZIP_WRAPPER);
    console.error('Run test-guard-decrypt.cjs first to generate it');
    process.exit(1);
  }

  console.log('[Step 1] Extracting real DEX from ZIP wrapper...');
  
  // Extract classes.dex from ZIP
  try {
    execSync(`jar xf "${ZIP_WRAPPER}" classes.dex`, { cwd: WORK_DIR });
    
    if (fs.existsSync(path.join(WORK_DIR, 'classes.dex'))) {
      // Rename to avoid confusion
      if (fs.existsSync(EXTRACTED_DEX)) {
        fs.unlinkSync(EXTRACTED_DEX);
      }
      fs.renameSync(path.join(WORK_DIR, 'classes.dex'), EXTRACTED_DEX);
      
      const stats = fs.statSync(EXTRACTED_DEX);
      console.log(`  ✅ Extracted DEX: ${EXTRACTED_DEX} (${stats.size} bytes)`);
    } else {
      console.error('  ❌ DEX file not found after extraction');
      process.exit(1);
    }
  } catch (e) {
    console.error(`  ❌ Failed to extract: ${e.message}`);
    process.exit(1);
  }

  console.log('\n[Step 2] Searching for target classes in DEX...');
  
  // Read DEX file and search for class names
  const dexBuffer = fs.readFileSync(EXTRACTED_DEX);
  const dexString = dexBuffer.toString('binary');
  
  const results = {};
  for (const target of TARGET_CLASSES) {
    // Search for class name in DEX
    const found = dexString.includes(target);
    results[target] = found;
    
    if (found) {
      console.log(`  ✅ ${target} FOUND`);
    } else {
      console.log(`  ❌ ${target} NOT FOUND`);
    }
  }
  
  // Summary
  console.log('\n[Step 3] Summary...');
  
  const newClasses = ['ManJuHongGuo', 'ManJuXiFan', 'AnimeHuazi'];
  const existingClasses = ['ManJuHuoLong', 'AnimeXiFan', 'NewBiLiYS', 'WexGuaZi'];
  
  const newFound = newClasses.filter(c => results[c]).length;
  const existingFound = existingClasses.filter(c => results[c]).length;
  
  console.log(`  New classes: ${newFound}/${newClasses.length} found`);
  console.log(`  Existing classes: ${existingFound}/${existingClasses.length} found`);
  
  console.log('\n[Conclusion]');
  if (newFound === newClasses.length) {
    console.log('✅ SUCCESS: All new classes exist in decrypted DEX');
    console.log('   This means wexguard_v8.so CAN decrypt these classes');
    console.log('   The issue is NOT with the .so file itself');
  } else {
    console.log('❌ FAIL: New classes missing in decrypted DEX');
    console.log('   This confirms wexguard_v8.so does NOT contain these classes');
    console.log('   Need to get updated .so from NetEase or implement runtime decryption');
  }
  
  process.exit(newFound === newClasses.length ? 0 : 1);
}

main();