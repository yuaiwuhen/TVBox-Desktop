/**
 * Compile com.wexfnw.libso.LoadNiMa stub and add to tvbox-spider-stubs.jar.
 *
 * The real LoadNiMa class loads libLoadNiMa.so (ARM native) in its static
 * initializer and exposes native methods. On Windows JVM the .so cannot
 * load, so we provide a stub that returns false (no filtering) for
 * contains() and no-ops the other methods. Stub takes precedence over
 * the spider JAR because stubs are on the JVM system classpath while
 * spider JARs are appended later.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const TOOLS_DIR = __dirname;
const STUBS_DIR = path.join(TOOLS_DIR, 'stubs');
const STUBS_JAR = path.join(TOOLS_DIR, 'tvbox-spider-stubs.jar');
// Runtime JAR is the one actually loaded by Electron (collectStubPaths prefers tools/runtime/).
// Keep both in sync to avoid stale stubs at runtime.
const STUBS_JAR_RUNTIME = path.join(
  TOOLS_DIR,
  'runtime',
  'tvbox-spider-stubs-complete.jar',
);
const STUBS_JAR_COMPLETE = path.join(
  TOOLS_DIR,
  'tvbox-spider-stubs-complete.jar',
);
const LOADNIMA_JAVA = path.join(
  STUBS_DIR,
  'com',
  'wexfnw',
  'libso',
  'LoadNiMa.java',
);
const BUILD_DIR = path.join(TOOLS_DIR, 'stubs_build_loadnima');

function main() {
  if (!fs.existsSync(LOADNIMA_JAVA)) {
    console.error('LoadNiMa.java not found:', LOADNIMA_JAVA);
    process.exit(1);
  }
  if (!fs.existsSync(STUBS_JAR)) {
    console.error('tvbox-spider-stubs.jar not found:', STUBS_JAR);
    process.exit(1);
  }

  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  console.log('Compiling LoadNiMa.java stub...');
  execSync(
    `javac -d "${BUILD_DIR}" -sourcepath "${STUBS_DIR}" -source 11 -target 11 -Xlint:none "${LOADNIMA_JAVA}"`,
    { stdio: 'inherit', cwd: TOOLS_DIR },
  );

  const classFileRel = 'com/wexfnw/libso/LoadNiMa.class';
  const classFileAbs = path.join(BUILD_DIR, classFileRel);
  if (!fs.existsSync(classFileAbs)) {
    console.error('Compilation failed: LoadNiMa.class not produced');
    process.exit(1);
  }
  console.log('  Compiled:', classFileAbs);

  console.log('Adding LoadNiMa.class to stubs JARs...');
  // Update all three JARs that may be loaded at runtime:
  // - tvbox-spider-stubs.jar (legacy, used by some test scripts)
  // - tvbox-spider-stubs-complete.jar (dev fallback)
  // - runtime/tvbox-spider-stubs-complete.jar (preferred by collectStubPaths)
  for (const jarPath of [STUBS_JAR, STUBS_JAR_COMPLETE, STUBS_JAR_RUNTIME]) {
    if (!fs.existsSync(jarPath)) {
      console.log(`  Skipping (not found): ${jarPath}`);
      continue;
    }
    execSync(`jar uf "${jarPath}" -C "${BUILD_DIR}" ${classFileRel}`, {
      stdio: 'inherit',
      cwd: TOOLS_DIR,
    });
    console.log(`  Updated: ${jarPath}`);
  }

  console.log('\nVerifying...');
  const verifyJar = fs.existsSync(STUBS_JAR_RUNTIME)
    ? STUBS_JAR_RUNTIME
    : STUBS_JAR;
  const output = execSync(
    `javap -p -classpath "${verifyJar}" com.wexfnw.libso.LoadNiMa`,
  ).toString();
  console.log(output);

  if (output.includes('public static boolean contains(java.lang.String)')) {
    console.log('SUCCESS: LoadNiMa stub installed');
  } else {
    console.log('FAILURE: contains() missing');
    process.exit(1);
  }

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

main();
