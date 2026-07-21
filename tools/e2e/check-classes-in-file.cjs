/**
 * Direct search for class names in binary file (handles corrupted ZIP)
 */
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(process.cwd(), 'classes.dex');

const TARGET_CLASSES = [
  'ManJuHongGuo',
  'ManJuXiFan',
  'AnimeHuazi',
  'ManJuHuoLong',
  'AnimeXiFan',
  'NewBiLiYS',
  'WexGuaZi',
];

function main() {
  console.log('=== Direct Binary Search in Decrypted File ===\n');

  if (!fs.existsSync(FILE_PATH)) {
    console.error('❌ File not found:', FILE_PATH);
    process.exit(1);
  }

  const stats = fs.statSync(FILE_PATH);
  console.log(`File: ${FILE_PATH}`);
  console.log(`Size: ${stats.size} bytes\n`);

  // Read file
  const buffer = fs.readFileSync(FILE_PATH);
  const content = buffer.toString('binary');

  // Check magic bytes
  console.log('Magic bytes:');
  const magic = buffer.slice(0, 16);
  console.log(
    '  ' +
      magic
        .toString('hex')
        .replace(/(.{2})/g, '$1 ')
        .trim(),
  );

  // Check if ZIP (PK..)
  if (magic[0] === 0x50 && magic[1] === 0x4b) {
    console.log('  Format: ZIP\n');
  } else if (magic[0] === 0x64 && magic[1] === 0x65 && magic[2] === 0x78) {
    console.log('  Format: DEX\n');
  } else {
    console.log('  Format: UNKNOWN\n');
  }

  // Search for class names
  console.log('Class name search:');
  const results = {};

  for (const target of TARGET_CLASSES) {
    const found = content.includes(target);
    results[target] = found;

    if (found) {
      console.log(`  ✅ ${target} FOUND`);
    } else {
      console.log(`  ❌ ${target} NOT FOUND`);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  const newClasses = ['ManJuHongGuo', 'ManJuXiFan', 'AnimeHuazi'];
  const existingClasses = [
    'ManJuHuoLong',
    'AnimeXiFan',
    'NewBiLiYS',
    'WexGuaZi',
  ];

  const newFound = newClasses.filter((c) => results[c]).length;
  const existingFound = existingClasses.filter((c) => results[c]).length;

  console.log(`New classes: ${newFound}/${newClasses.length} found`);
  console.log(
    `Existing classes: ${existingFound}/${existingClasses.length} found`,
  );

  if (newFound === newClasses.length) {
    console.log('\n✅ SUCCESS: Decrypted file contains all new classes');
    console.log('   wexguard_v8.so CAN decrypt these classes');
  } else if (existingFound > 0) {
    console.log(
      '\n⚠️  PARTIAL: Decryption works for existing classes, but new classes missing',
    );
    console.log('   wexguard_v8.so does NOT contain new class implementations');
    console.log('   This confirms .so is outdated');
  } else {
    console.log('\n❌ FAIL: Decryption produced no recognizable classes');
    console.log('   File may be corrupted or decryption failed');
  }

  process.exit(newFound === newClasses.length ? 0 : 1);
}

main();
