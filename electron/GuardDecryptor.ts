/**
 * GuardDecryptor - Runtime decryption of Guard spider classes
 *
 * Decrypts Guard spider implementations from NetEase JAR using:
 * 1. Extract wexguard_v8.so and wexshinidie.guard from JAR
 * 2. Run WexguardDecryptor (unidbg) to decrypt
 * 3. Extract classes.dex from ZIP wrapper
 * 4. Convert DEX to JAR using dex2jar
 *
 * Usage:
 *   const decryptor = new GuardDecryptor();
 *   const jarPath = await decryptor.decrypt(neteaseJarPath, cacheDir, onProgress);
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

export interface DecryptProgress {
  stage:
    | 'download'
    | 'extract'
    | 'decrypt'
    | 'convert'
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
    const outputPath = path.join(workDir, 'wexguard-decrypted.jar');

    // Check if already decrypted and up-to-date
    if (await this.isCacheValid(neteaseJarPath, outputPath)) {
      onProgress?.({
        stage: 'complete',
        message: 'Using cached decrypted JAR',
      });
      return outputPath;
    }

    // Ensure work directory exists
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    try {
      // Step 1: Extract .so and .guard files
      onProgress?.({
        stage: 'extract',
        message: 'Extracting wexguard_v8.so and wexshinidie.guard...',
        percent: 10,
      });

      const { soPath, guardPath } = await this.extractFiles(
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

      // Step 3: Extract classes.dex from ZIP
      onProgress?.({
        stage: 'convert',
        message: 'Extracting classes.dex from ZIP...',
        percent: 70,
      });

      const dexPath = await this.extractDex(decryptedZipPath, workDir);

      // Step 4: Convert DEX to JAR
      onProgress?.({
        stage: 'convert',
        message: 'Converting DEX to JAR...',
        percent: 80,
      });

      await this.convertDexToJar(dexPath, outputPath);

      // Step 5: Verify output
      onProgress?.({
        stage: 'verify',
        message: 'Verifying decrypted JAR...',
        percent: 90,
      });

      const verified = await this.verifyJar(outputPath);
      if (!verified) {
        throw new Error('Decrypted JAR verification failed');
      }

      // Step 6: Save version info
      await this.saveVersionInfo(neteaseJarPath, outputPath);

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
   * Extract .so and .guard files from NetEase JAR
   */
  private async extractFiles(
    neteaseJarPath: string,
    workDir: string,
  ): Promise<{ soPath: string; guardPath: string }> {
    const assetsDir = path.join(workDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    const soPath = path.join(assetsDir, 'wexguard_v8.so');
    const guardPath = path.join(assetsDir, 'wexshinidie.guard');

    // Extract if not already present
    if (!fs.existsSync(soPath) || !fs.existsSync(guardPath)) {
      console.log('[GuardDecryptor] Extracting files from:', neteaseJarPath);

      try {
        execSync(
          `jar xf "${neteaseJarPath}" assets/wexguard_v8.so assets/wexshinidie.guard`,
          {
            cwd: workDir,
            stdio: 'pipe',
          },
        );
      } catch (e: any) {
        throw new Error(`Failed to extract files: ${e.message}`);
      }
    }

    // Verify extraction
    if (!fs.existsSync(soPath)) {
      throw new Error('wexguard_v8.so not found in NetEase JAR');
    }
    if (!fs.existsSync(guardPath)) {
      throw new Error('wexshinidie.guard not found in NetEase JAR');
    }

    console.log('[GuardDecryptor] Extracted:', soPath, guardPath);
    return { soPath, guardPath };
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
   * Extract classes.dex from ZIP wrapper
   */
  private async extractDex(zipPath: string, workDir: string): Promise<string> {
    const dexPath = path.join(workDir, 'classes.dex');

    if (!fs.existsSync(dexPath)) {
      console.log('[GuardDecryptor] Extracting classes.dex from ZIP...');

      try {
        execSync(`jar xf "${zipPath}" classes.dex`, {
          cwd: workDir,
          stdio: 'pipe',
        });
      } catch (e: any) {
        throw new Error(`Failed to extract DEX: ${e.message}`);
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
   * Convert DEX to JAR using dex2jar
   */
  private async convertDexToJar(
    dexPath: string,
    jarPath: string,
  ): Promise<void> {
    const dexToolsLib = path.join(this.toolsDir, 'dex-tools-v2.4', 'lib');

    if (!fs.existsSync(dexToolsLib)) {
      throw new Error(`dex-tools not found: ${dexToolsLib}`);
    }

    console.log('[GuardDecryptor] Converting DEX to JAR...');

    try {
      // Build classpath
      const jars = fs
        .readdirSync(dexToolsLib)
        .filter((f) => f.endsWith('.jar'));
      const classpath = jars.map((j) => path.join(dexToolsLib, j)).join(';');

      const cmd = `java -Xms512m -Xmx2048m -cp "${classpath}" com.googlecode.dex2jar.tools.Dex2jarCmd "${dexPath}" -o "${jarPath}" -f`;

      execSync(cmd, { stdio: 'inherit' });

      if (!fs.existsSync(jarPath)) {
        throw new Error('JAR file not created');
      }

      console.log('[GuardDecryptor] JAR created:', jarPath);
    } catch (e: any) {
      throw new Error(`Failed to convert DEX to JAR: ${e.message}`);
    }
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

      const classes = output.split('\n').filter((l) => l.trim());

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

      console.log(
        '[GuardDecryptor] JAR verified:',
        guardClasses.length,
        'classes',
      );
      return true;
    } catch (e: any) {
      console.error('[GuardDecryptor] Verification failed:', e.message);
      return false;
    }
  }

  /**
   * Check if cached JAR is valid and up-to-date
   */
  private async isCacheValid(
    neteaseJarPath: string,
    outputPath: string,
  ): Promise<boolean> {
    if (!fs.existsSync(outputPath)) {
      return false;
    }

    const versionFile = path.join(path.dirname(outputPath), 'version.json');
    if (!fs.existsSync(versionFile)) {
      return false;
    }

    try {
      const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      const currentMd5 = await this.getFileMd5(neteaseJarPath);
      return versionInfo.neteaseJarMd5 === currentMd5;
    } catch {
      return false;
    }
  }

  /**
   * Save version info for cache validation
   */
  private async saveVersionInfo(
    neteaseJarPath: string,
    outputPath: string,
  ): Promise<void> {
    const versionFile = path.join(path.dirname(outputPath), 'version.json');
    const md5 = await this.getFileMd5(neteaseJarPath);

    const versionInfo = {
      neteaseJarMd5: md5,
      decryptedAt: new Date().toISOString(),
      outputPath: path.basename(outputPath),
    };

    fs.writeFileSync(versionFile, JSON.stringify(versionInfo, null, 2));
    console.log('[GuardDecryptor] Version info saved:', versionFile);
  }

  /**
   * Calculate MD5 hash of file
   */
  private async getFileMd5(filePath: string): Promise<string> {
    const crypto = require('crypto');
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buffer).digest('hex');
  }
}
