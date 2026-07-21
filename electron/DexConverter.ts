/**
 * DexConverter - DEX to JAR conversion module
 *
 * Converts Android DEX files to standard JAR format using dex2jar tool.
 * The tool is bundled in the project's tools/ directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export class DexConverter {
  private toolsDir: string;
  private dex2jarPath: string = '';
  private initialized: boolean = false;

  constructor() {
    // Look for tools directory relative to app root
    // In dev: process.cwd() is the project root
    // In production: resources/tools/
    const appRoot = process.cwd();
    const possibleRoots = [
      appRoot,
      path.join(appRoot, 'resources'),
      path.dirname(appRoot),
      path.join(path.dirname(appRoot), 'resources'),
      process.resourcesPath || '',
    ];

    this.toolsDir = '';
    for (const root of possibleRoots) {
      const candidate = path.join(root, 'tools', 'dex-tools-v2.4', 'lib');
      if (fs.existsSync(candidate)) {
        this.toolsDir = path.join(root, 'tools');
        break;
      }
    }

    // Fallback: use default
    if (!this.toolsDir) {
      this.toolsDir = path.join(appRoot, 'tools');
    }

    console.log('[DexConverter] Tools directory:', this.toolsDir);
  }

  /**
   * Initialize dex2jar tool
   * Finds the bundled dex2jar jar file
   */
  async initialize(): Promise<boolean> {
    // Check bundled tool paths
    const possiblePaths = [
      path.join(this.toolsDir, 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar'),
      path.join(
        this.toolsDir,
        'dex-tools-v2.4',
        'lib',
        'dex-translator-v2.4.jar',
      ),
      path.join(this.toolsDir, 'dex-tools', 'lib', 'dex-tools-v2.4.jar'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.dex2jarPath = p;
        this.initialized = true;
        console.log('[DexConverter] Found bundled dex2jar:', p);
        return true;
      }
    }

    // Not found
    this.initialized = false;
    console.error('[DexConverter] dex2jar tool not found in:', this.toolsDir);
    console.error(
      '[DexConverter] Expected: tools/dex-tools-v2.4/lib/dex-tools-v2.4.jar',
    );
    return false;
  }

  /**
   * Resolve java executable path.
   * Prefer bundled JRE (packaged mode), fall back to system java (dev mode).
   */
  private resolveJavaExe(): string {
    const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
    const bundledJava = path.join(
      process.resourcesPath || '',
      'jre',
      'bin',
      exeName,
    );
    if (fs.existsSync(bundledJava)) {
      console.log('[DexConverter] Using bundled JRE:', bundledJava);
      return bundledJava;
    }
    console.log('[DexConverter] Using system java (bundled JRE not found)');
    return exeName;
  }

  /**
   * Execute shell command
   */
  private execCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Convert DEX file to JAR
   * Uses d2j-dex2jar.sh/bat or falls back to java -jar
   */
  async convertDexToJar(dexPath: string, jarPath: string): Promise<string> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        throw new Error(
          'dex2jar tool not found. Ensure tools/dex-tools-v2.4/ exists in the project.',
        );
      }
    }

    // Check if already converted - validate it's a real JAR (not an empty
    // 22-byte stub from a previously failed conversion). An empty ZIP file
    // is exactly 22 bytes (End of Central Directory record only).
    const MIN_VALID_JAR_SIZE = 1024; // 1KB threshold
    if (fs.existsSync(jarPath)) {
      const stats = fs.statSync(jarPath);
      if (stats.size >= MIN_VALID_JAR_SIZE) {
        console.log(
          '[DexConverter] JAR already exists:',
          jarPath,
          `(${stats.size} bytes)`,
        );
        return jarPath;
      }
      console.warn(
        `[DexConverter] Existing converted JAR is too small (${stats.size} bytes), likely a failed conversion. Re-converting...`,
      );
      try {
        fs.unlinkSync(jarPath);
      } catch (unlinkErr: any) {
        console.warn(
          '[DexConverter] Failed to delete stale JAR:',
          unlinkErr.message,
        );
      }
    }

    console.log('[DexConverter] Converting DEX to JAR...');
    console.log('[DexConverter] Input:', dexPath);
    console.log('[DexConverter] Output:', jarPath);

    // Use bundled JRE's java.exe directly (bypass d2j-dex2jar.bat which
    // depends on system PATH for java). Falls back to system java in dev.
    const javaExe = this.resolveJavaExe();
    const libDir = path.join(this.toolsDir, 'dex-tools-v2.4', 'lib');
    const cmd = `"${javaExe}" -Xms512m -Xmx2048m -cp "${libDir}/*" com.googlecode.dex2jar.tools.Dex2jarCmd "${dexPath}" -o "${jarPath}"`;

    // Retry conversion up to 3 times. The dex2jar process occasionally exits
    // cleanly without producing output (transient Windows file-lock / antivirus
    // interference during JVM startup or DEX parsing). Empirically, a second
    // or third attempt succeeds. Without retry, the first spider of a fresh
    // config fails permanently with "JAR file not created after conversion"
    // even though subsequent spiders using the same JAR convert fine.
    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Clean up any partial / empty output from a previous attempt so
      // execCommand starts from a clean slate.
      if (fs.existsSync(jarPath)) {
        try {
          fs.unlinkSync(jarPath);
        } catch {
          /* ignore — will be overwritten by dex2jar */
        }
      }

      try {
        console.log(
          `[DexConverter] Running (attempt ${attempt}/${maxAttempts}):`,
          cmd,
        );
        const output = await this.execCommand(cmd);
        console.log(
          `[DexConverter] Conversion output (attempt ${attempt}):`,
          output,
        );

        if (fs.existsSync(jarPath)) {
          const stats = fs.statSync(jarPath);
          console.log(
            '[DexConverter] Converted JAR size:',
            stats.size,
            'bytes',
          );
          if (stats.size >= MIN_VALID_JAR_SIZE) {
            return jarPath;
          }
          lastError = new Error(
            `Conversion produced an empty or too-small JAR (${stats.size} bytes). The DEX file may be corrupted or in an unsupported format.`,
          );
        } else {
          lastError = new Error('JAR file not created after conversion');
        }
      } catch (e: any) {
        console.error(
          `[DexConverter] Conversion command failed (attempt ${attempt}):`,
          e.message,
        );
        lastError = e;
      }

      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt; // 1s, 2s
        console.log(
          `[DexConverter] Conversion failed, retrying in ${delayMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    console.error(
      `[DexConverter] Conversion failed after ${maxAttempts} attempts:`,
      lastError?.message,
    );
    throw (
      lastError ||
      new Error(`JAR file not created after ${maxAttempts} conversion attempts`)
    );
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
export const dexConverter = new DexConverter();
