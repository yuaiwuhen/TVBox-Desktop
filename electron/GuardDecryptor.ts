/**
 * GuardDecryptor - Runtime decryption of Guard spider classes
 *
 * Decrypts Guard spider implementations from NetEase JAR using:
 * 1. Extract top-level classes.dex, wexguard_v8.so and wexshinidie.guard from JAR
 * 2. Run WexguardDecryptor (unidbg) to decrypt wexshinidie.guard → decrypted DEX
 * 3. Convert top-level DEX to JAR (contains *Guard spider class stubs)
 * 4. Convert decrypted DEX to JAR (contains merge/ obfuscated helper classes)
 * 5. Merge both JARs into wexguard-decrypted.jar
 *
 * The NetEase JAR has TWO DEX sources:
 *   - /classes.dex (top-level, ~55KB): contains *Guard spider class stubs
 *     (e.g. WexV6DaShiXiongGuard, AnimeFanShuGuard, ManJuHongGuoGuard)
 *     that delegate to merge/ classes at runtime.
 *   - /assets/wexshinidie.guard (encrypted): decrypted to a 2.5MB DEX containing
 *     the merge/ obfuscated helper classes and base spider implementations.
 *
 * Both DEX sources must be merged into the output JAR, otherwise the JVM
 * cannot resolve *Guard spider classes (ClassNotFoundException).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { dexConverter } from './DexConverter';

export interface DecryptProgress {
  stage:
    | 'download'
    | 'extract'
    | 'decrypt'
    | 'convert'
    | 'merge'
    | 'verify'
    | 'complete'
    | 'error';
  message: string;
  percent?: number; // 0-100
}

export class GuardDecryptor {
  private toolsDir: string;

  constructor() {
    this.toolsDir = path.join(process.cwd(), 'tools');
  }

  /**
   * Decrypt Guard spider classes from NetEase JAR
   *
   * @param neteaseJarPath Path to NetEase JAR file
   * @param cacheDir Directory to store decrypted output
   * @param onProgress Progress callback
   * @returns Path to decrypted JAR file
   */
  async decrypt(
    neteaseJarPath: string,
    cacheDir: string,
    onProgress?: (progress: DecryptProgress) => void,
  ): Promise<string> {
    const workDir = path.join(cacheDir, 'wexguard');

    // Use a versioned output path (includes NetEase JAR MD5) so that
    // re-decryption writes to a NEW file instead of overwriting the JAR
    // that an existing URLClassLoader may still have open. On Windows,
    // overwriting an in-use JAR causes `jar uf` to fail with
    // FileSystemException "另一个程序正在使用此文件" and leaves a corrupt
    // (truncated) JAR that throws ZipException "invalid LOC header" on
    // class load.
    const neteaseMd5 = await this.getFileMd5(neteaseJarPath);
    const versionedName = `wexguard-decrypted-${neteaseMd5}.jar`;
    const outputPath = path.join(workDir, versionedName);

    // Check if already decrypted and up-to-date
    if (await this.isCacheValid(neteaseJarPath, outputPath)) {
      onProgress?.({
        stage: 'complete',
        message: 'Using cached decrypted JAR',
      });
      return outputPath;
    }

    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    try {
      // Step 1: Extract top-level classes.dex, .so and .guard files
      onProgress?.({
        stage: 'extract',
        message:
          'Extracting classes.dex, wexguard_v8.so and wexshinidie.guard...',
        percent: 10,
      });

      const { topLevelDexPath, soPath, guardPath } = await this.extractFiles(
        neteaseJarPath,
        workDir,
      );

      // Step 2: Run WexguardDecryptor
      onProgress?.({
        stage: 'decrypt',
        message: 'Running WexguardDecryptor (1-2 minutes)...',
        percent: 30,
      });

      const decryptedZipPath = path.join(workDir, 'decrypted.zip');
      await this.runDecryptor(soPath, guardPath, decryptedZipPath);

      // Step 3: Extract decrypted classes.dex from ZIP
      onProgress?.({
        stage: 'convert',
        message: 'Extracting decrypted classes.dex from ZIP...',
        percent: 60,
      });

      const decryptedDexPath = await this.extractDex(decryptedZipPath, workDir);

      // Step 4: Convert both DEX files to JARs
      // Both top-level and decrypted DEX use enjarify (preferred).
      // - enjarify avoids the dex2jar ArrayStoreException bug in obfuscated
      //   merge/ class <clinit> (causes ExceptionInInitializerError → NPE
      //   in homeContent → returns empty {}).
      // - TypeToken generic Signature is NOT preserved by enjarify, but the
      //   pre-loaded type-compat.jar in JarLoader handles that at runtime
      //   by falling back to Object.class when no type argument is found.
      onProgress?.({
        stage: 'convert',
        message: 'Converting DEX files to JARs...',
        percent: 75,
      });

      const topLevelJarPath = path.join(workDir, 'toplevel.jar');
      const decryptedJarPath = path.join(workDir, 'decrypted.jar');
      await this.convertDexToJar(topLevelDexPath, topLevelJarPath);
      await this.convertDexToJar(decryptedDexPath, decryptedJarPath);

      // Step 4.5: Patch TypeToken raw-type fallback in decrypted.jar.
      // enjarify strips generic Signature attributes, so the obfuscated
      // Gson TypeToken subclass throws IllegalStateException when its
      // constructor calls getGenericSuperclass() and gets a raw type.
      // The patch rewrites the constructor to fall back to LinkedHashMap
      // (matching spider casts) instead of throwing.
      try {
        await this.patchTypeTokenClass(decryptedJarPath);
      } catch (patchErr: any) {
        console.warn(
          '[GuardDecryptor] TypeToken patch failed (non-fatal):',
          patchErr.message,
        );
      }

      // Step 5: Merge JARs (top-level adds *Guard spider stubs to decrypted)
      onProgress?.({
        stage: 'merge',
        message: 'Merging JARs...',
        percent: 85,
      });

      await this.mergeJars(decryptedJarPath, topLevelJarPath, outputPath);

      // Step 6: Verify output
      onProgress?.({
        stage: 'verify',
        message: 'Verifying decrypted JAR...',
        percent: 95,
      });

      const verified = await this.verifyJar(outputPath);
      if (!verified) {
        throw new Error('Decrypted JAR verification failed');
      }

      // Step 7: Save version info (non-fatal — JAR is already created)
      try {
        await this.saveVersionInfo(neteaseJarPath, outputPath);
      } catch (versionErr: any) {
        console.warn(
          '[GuardDecryptor] Failed to save version info (non-fatal):',
          versionErr.message,
        );
      }

      onProgress?.({
        stage: 'complete',
        message: 'Guard spider JAR decrypted successfully',
        percent: 100,
      });

      return outputPath;
    } catch (e: any) {
      onProgress?.({
        stage: 'error',
        message: `Decryption failed: ${e.message}`,
      });
      throw e;
    }
  }

  /**
   * Extract top-level classes.dex, .so and .guard files from NetEase JAR.
   * The top-level classes.dex contains *Guard spider class stubs; the
   * .guard file (encrypted) contains the merge/ obfuscated helper classes.
   *
   * Files are extracted to a temp directory first, then moved to their
   * final locations. This avoids naming conflicts with the decrypted
   * classes.dex (which is also named "classes.dex" inside decrypted.zip)
   * and ensures `topLevelDexPath` actually points to the extracted file.
   */
  private async extractFiles(
    neteaseJarPath: string,
    workDir: string,
  ): Promise<{
    topLevelDexPath: string;
    soPath: string;
    guardPath: string;
  }> {
    const assetsDir = path.join(workDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const topLevelDexPath = path.join(workDir, 'toplevel_classes.dex');
    const soPath = path.join(assetsDir, 'wexguard_v8.so');
    const guardPath = path.join(assetsDir, 'wexshinidie.guard');

    // Extract if not already present
    if (
      !fs.existsSync(topLevelDexPath) ||
      !fs.existsSync(soPath) ||
      !fs.existsSync(guardPath)
    ) {
      console.log('[GuardDecryptor] Extracting files from:', neteaseJarPath);

      // Use a temp directory so the top-level classes.dex doesn't conflict
      // with the decrypted classes.dex (both named "classes.dex")
      const tempDir = path.join(workDir, '_extract_temp');
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        execSync(
          `jar xf "${neteaseJarPath}" classes.dex assets/wexguard_v8.so assets/wexshinidie.guard`,
          {
            cwd: tempDir,
            stdio: 'pipe',
          },
        );

        // Move files to their expected final locations
        const extractedDex = path.join(tempDir, 'classes.dex');
        const extractedSo = path.join(tempDir, 'assets', 'wexguard_v8.so');
        const extractedGuard = path.join(
          tempDir,
          'assets',
          'wexshinidie.guard',
        );

        if (fs.existsSync(extractedDex)) {
          fs.copyFileSync(extractedDex, topLevelDexPath);
        }
        if (fs.existsSync(extractedSo)) {
          fs.copyFileSync(extractedSo, soPath);
        }
        if (fs.existsSync(extractedGuard)) {
          fs.copyFileSync(extractedGuard, guardPath);
        }
      } catch (e: any) {
        throw new Error(`Failed to extract files: ${e.message}`);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }

    // Verify extraction
    if (!fs.existsSync(topLevelDexPath)) {
      throw new Error(`Top-level classes.dex not found at ${topLevelDexPath}`);
    }
    if (!fs.existsSync(soPath)) {
      throw new Error(`wexguard_v8.so not found at ${soPath}`);
    }
    if (!fs.existsSync(guardPath)) {
      throw new Error(`wexshinidie.guard not found at ${guardPath}`);
    }

    console.log(
      '[GuardDecryptor] Extracted:',
      topLevelDexPath,
      soPath,
      guardPath,
    );
    return { topLevelDexPath, soPath, guardPath };
  }

  /**
   * Run WexguardDecryptor to decrypt guard file
   */
  private async runDecryptor(
    soPath: string,
    guardPath: string,
    outputPath: string,
  ): Promise<void> {
    // Find unidbg-loader JAR
    const unidbgJar = path.join(
      this.toolsDir,
      'runtime',
      'unidbg-loader-1.0.0.jar',
    );
    if (!fs.existsSync(unidbgJar)) {
      throw new Error(`unidbg-loader JAR not found: ${unidbgJar}`);
    }

    console.log('[GuardDecryptor] Running WexguardDecryptor...');

    return new Promise((resolve, reject) => {
      const proc = spawn(
        'java',
        ['-jar', unidbgJar, soPath, guardPath, outputPath],
        {
          stdio: 'inherit',
        },
      );

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          console.log('[GuardDecryptor] Decryption successful:', outputPath);
          resolve();
        } else {
          reject(new Error(`WexguardDecryptor failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run WexguardDecryptor: ${err.message}`));
      });
    });
  }

  /**
   * Extract classes.dex from ZIP wrapper.
   *
   * The decrypted DEX is extracted to `decrypted_classes.dex` (NOT
   * `classes.dex`) to avoid overwriting the top-level classes.dex that
   * was extracted by extractFiles() and is needed for the *Guard stub
   * classes.
   */
  private async extractDex(zipPath: string, workDir: string): Promise<string> {
    const dexPath = path.join(workDir, 'decrypted_classes.dex');

    if (!fs.existsSync(dexPath)) {
      console.log('[GuardDecryptor] Extracting classes.dex from ZIP...');

      const tempDir = path.join(workDir, '_dex_temp');
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        execSync(`jar xf "${zipPath}" classes.dex`, {
          cwd: tempDir,
          stdio: 'pipe',
        });

        const extractedDex = path.join(tempDir, 'classes.dex');
        if (fs.existsSync(extractedDex)) {
          fs.copyFileSync(extractedDex, dexPath);
        }
      } catch (e: any) {
        throw new Error(`Failed to extract DEX: ${e.message}`);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }

    if (!fs.existsSync(dexPath)) {
      throw new Error('classes.dex not found in decrypted ZIP');
    }

    // Verify DEX magic
    const fd = fs.openSync(dexPath, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);

    if (magic[0] !== 0x64 || magic[1] !== 0x65 || magic[2] !== 0x78) {
      throw new Error(`Invalid DEX magic: ${magic.toString('hex')}`);
    }

    console.log('[GuardDecryptor] DEX extracted:', dexPath);
    return dexPath;
  }

  /**
   * Convert DEX to JAR via DexConverter (enjarify preferred, dex2jar fallback).
   * For the top-level DEX (stub classes only, no TypeToken), enjarify is fine.
   */
  private async convertDexToJar(
    dexPath: string,
    jarPath: string,
  ): Promise<void> {
    if (!dexConverter.isInitialized()) {
      const ok = await dexConverter.initialize();
      if (!ok) {
        throw new Error(
          'DEX→JAR converter not available. Ensure tools/enjarify/ (with Python 3) or tools/dex-tools-v2.4/ exists.',
        );
      }
    }

    console.log('[GuardDecryptor] Converting DEX to JAR (enjarify)...');
    await dexConverter.convertDexToJar(dexPath, jarPath);

    if (!fs.existsSync(jarPath)) {
      throw new Error('JAR file not created after conversion');
    }

    console.log('[GuardDecryptor] JAR created:', jarPath);
  }

  /**
   * Convert DEX to JAR using dex2jar ONLY (preserves Signature attributes).
   *
   * The decrypted DEX contains merge/ obfuscated classes that use Gson
   * TypeToken with generic type parameters. enjarify strips Signature
   * attributes, causing "TypeToken must be created with a type argument"
   * at runtime. dex2jar preserves these attributes correctly.
   */
  private async convertDexToJarWithDex2jar(
    dexPath: string,
    jarPath: string,
  ): Promise<void> {
    if (!dexConverter.isInitialized()) {
      const ok = await dexConverter.initialize();
      if (!ok) {
        throw new Error(
          'DEX→JAR converter not available. Ensure tools/dex-tools-v2.4/ exists.',
        );
      }
    }

    console.log(
      '[GuardDecryptor] Converting DEX to JAR (dex2jar, preserves signatures)...',
    );
    await dexConverter.convertDexToJarWithDex2jar(dexPath, jarPath);

    if (!fs.existsSync(jarPath)) {
      throw new Error('JAR file not created after dex2jar conversion');
    }

    console.log('[GuardDecryptor] JAR created (dex2jar):', jarPath);
  }

  /**
   * Patch the obfuscated Gson TypeToken subclass in the decrypted JAR so
   * it doesn't throw IllegalStateException when enjarify has stripped the
   * generic Signature attribute.
   *
   * Delegates to tools/patch_typetoken_in_jar.cjs (Node script using ASM
   * via java-bridge) to rewrite the constructor with a raw-type fallback.
   */
  private async patchTypeTokenClass(jarPath: string): Promise<void> {
    const scriptPath = path.join(this.toolsDir, 'patch_typetoken_in_jar.cjs');
    if (!fs.existsSync(scriptPath)) {
      console.warn(
        '[GuardDecryptor] patch_typetoken_in_jar.cjs not found at',
        scriptPath,
        '— skipping TypeToken patch',
      );
      return;
    }

    console.log('[GuardDecryptor] Patching TypeToken class in:', jarPath);
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, [scriptPath, jarPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.status !== 0) {
      throw new Error(
        `patch_typetoken_in_jar.cjs exited with code ${result.status}: ${result.stderr || result.stdout}`,
      );
    }
    console.log('[GuardDecryptor] TypeToken patch applied');
  }

  /**
   * Merge two JARs into one. The primary JAR's entries take precedence;
   * entries from the secondary JAR are added only if not already present
   * in the primary JAR (so we don't overwrite merge/ classes from the
   * decrypted DEX with stubs from the top-level DEX).
   *
   * Uses `jar uf` to update the primary JAR with files from the secondary
   * JAR's extracted directory.
   */
  private async mergeJars(
    primaryJar: string,
    secondaryJar: string,
    outputJar: string,
  ): Promise<void> {
    console.log(
      '[GuardDecryptor] Merging JARs:',
      primaryJar,
      '+',
      secondaryJar,
      '→',
      outputJar,
    );

    // Copy primary JAR to output
    fs.copyFileSync(primaryJar, outputJar);

    // Extract secondary JAR to temp dir
    const tempDir = path.join(path.dirname(outputJar), '_merge_temp');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      execSync(`jar xf "${secondaryJar}"`, {
        cwd: tempDir,
        stdio: 'pipe',
      });

      // Get list of entries already in primary JAR
      const primaryEntries = execSync(`jar tf "${outputJar}"`, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
        .split(/\r?\n/)
        .filter((l) => l.trim());

      // Remove entries from tempDir that already exist in primary JAR
      // so we don't overwrite them
      for (const entry of primaryEntries) {
        const entryPath = path.join(tempDir, entry.replace(/\//g, path.sep));
        if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile()) {
          try {
            fs.unlinkSync(entryPath);
          } catch {
            /* ignore */
          }
        }
      }

      // Add remaining files from tempDir to output JAR
      execSync(`jar uf "${outputJar}" -C "${tempDir}" .`, {
        stdio: 'pipe',
      });
    } finally {
      // Clean up temp dir
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    if (!fs.existsSync(outputJar)) {
      throw new Error('Merged JAR not created');
    }

    console.log(
      '[GuardDecryptor] Merged JAR created:',
      outputJar,
      `(${fs.statSync(outputJar).size} bytes)`,
    );
  }

  /**
   * Verify JAR contains expected classes
   */
  private async verifyJar(jarPath: string): Promise<boolean> {
    try {
      const output = execSync(`jar tf "${jarPath}"`, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });

      const classes = output.split(/\r?\n/).filter((l) => l.trim());

      // Check for at least some Guard spider classes
      const guardClasses = classes.filter(
        (c) => c.includes('com/github/catvod/spider/') && c.endsWith('.class'),
      );

      if (guardClasses.length < 100) {
        console.error(
          '[GuardDecryptor] Too few classes in JAR:',
          guardClasses.length,
        );
        return false;
      }

      // Check for at least one *Guard stub class (from top-level DEX)
      const stubClasses = classes.filter((c) =>
        /com\/github\/catvod\/spider\/\w+Guard\.class$/.test(c),
      );
      if (stubClasses.length < 10) {
        console.error(
          '[GuardDecryptor] Too few *Guard stub classes:',
          stubClasses.length,
        );
        return false;
      }

      console.log(
        '[GuardDecryptor] JAR verified:',
        guardClasses.length,
        'spider classes,',
        stubClasses.length,
        'Guard stubs',
      );
      return true;
    } catch (e: any) {
      console.error('[GuardDecryptor] Verification failed:', e.message);
      return false;
    }
  }

  /**
   * Check if cached JAR is valid and up-to-date.
   * Checks the versioned version-<md5>.json first, then falls back to
   * legacy version.json.
   */
  private async isCacheValid(
    neteaseJarPath: string,
    outputPath: string,
  ): Promise<boolean> {
    if (!fs.existsSync(outputPath)) {
      return false;
    }

    const dir = path.dirname(outputPath);
    const currentMd5 = await this.getFileMd5(neteaseJarPath);

    // Prefer versioned version-<md5>.json
    const versionedVersionFile = path.join(dir, `version-${currentMd5}.json`);
    if (fs.existsSync(versionedVersionFile)) {
      return true;
    }

    // Fall back to legacy version.json with MD5 comparison
    const versionFile = path.join(dir, 'version.json');
    if (!fs.existsSync(versionFile)) {
      return false;
    }

    try {
      const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return versionInfo.neteaseJarMd5 === currentMd5;
    } catch {
      return false;
    }
  }

  /**
   * Save version info for cache validation.
   * Writes BOTH a legacy version.json (for back-compat) and a versioned
   * version-<md5>.json (so shouldRedecryptGuardJar can match the versioned
   * JAR without parsing the legacy file).
   */
  private async saveVersionInfo(
    neteaseJarPath: string,
    outputPath: string,
  ): Promise<void> {
    const dir = path.dirname(outputPath);
    const md5 = await this.getFileMd5(neteaseJarPath);

    const versionInfo = {
      neteaseJarMd5: md5,
      decryptedAt: new Date().toISOString(),
      outputPath: path.basename(outputPath),
    };

    // Legacy version.json (back-compat)
    const versionFile = path.join(dir, 'version.json');
    fs.writeFileSync(versionFile, JSON.stringify(versionInfo, null, 2));
    console.log('[GuardDecryptor] Version info saved:', versionFile);

    // Versioned version-<md5>.json (matches the versioned JAR name)
    const versionedVersionFile = path.join(dir, `version-${md5}.json`);
    fs.writeFileSync(
      versionedVersionFile,
      JSON.stringify(versionInfo, null, 2),
    );
    console.log('[GuardDecryptor] Versioned version info saved:', versionedVersionFile);
  }

  /**
   * Calculate MD5 hash of file
   */
  private async getFileMd5(filePath: string): Promise<string> {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buffer).digest('hex');
  }
}
