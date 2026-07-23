/**
 * DexConverter - DEX to JAR conversion module
 *
 * Converts Android DEX files to standard JAR format.
 *
 * Strategy:
 *   1. enjarify (preferred) — Google's Python DEX→JAR translator. More
 *      accurate than dex2jar: does NOT produce the "new AbstractSelf" bug
 *      in merge classes' <clinit> that breaks InstantiationError on Guard
 *      spiders. Requires Python 3 on PATH (dev) or bundled with the app.
 *   2. dex2jar (fallback) — used when Python is unavailable (e.g. fresh
 *      production install without Python). Has known conversion bugs but
 *      covers the majority of non-Guard spider JARs.
 *
 * The converter probes Python availability at initialize() time and picks
 * the strategy. convertDexToJar() always tries enjarify first when Python
 * is available, then falls back to dex2jar with 3 retries on failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MIN_VALID_JAR_SIZE = 1024; // 1KB threshold — empty ZIP is 22 bytes

export class DexConverter {
  private toolsDir: string = '';
  private initialized: boolean = false;
  private pythonExe: string | null = null;
  private enjarifyDir: string | null = null;
  private dex2jarLibDir: string | null = null;

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
      if (!root) continue;
      const candidate = path.join(root, 'tools');
      const enjarifyMain = path.join(
        candidate,
        'enjarify',
        'enjarify',
        'main.py',
      );
      const dexToolsLib = path.join(candidate, 'dex-tools-v2.4', 'lib');
      if (fs.existsSync(enjarifyMain) || fs.existsSync(dexToolsLib)) {
        this.toolsDir = candidate;
        break;
      }
    }

    if (!this.toolsDir) {
      this.toolsDir = path.join(appRoot, 'tools');
    }

    console.log('[DexConverter] Tools directory:', this.toolsDir);
  }

  /**
   * Initialize converter: probe for enjarify (Python) and dex2jar.
   * Returns true if at least one strategy is available.
   */
  async initialize(): Promise<boolean> {
    // 1. Probe enjarify (Python)
    const enjarifyMain = path.join(
      this.toolsDir,
      'enjarify',
      'enjarify',
      'main.py',
    );
    if (fs.existsSync(enjarifyMain)) {
      const python = await this.findPython();
      if (python) {
        this.pythonExe = python;
        this.enjarifyDir = path.join(this.toolsDir, 'enjarify');
        console.log('[DexConverter] enjarify available (Python:', python, ')');
      } else {
        console.warn(
          '[DexConverter] enjarify found but Python 3 not available on PATH',
        );
      }
    }

    // 2. Probe dex2jar (always available in bundled tools/)
    const dexToolsLib = path.join(this.toolsDir, 'dex-tools-v2.4', 'lib');
    if (fs.existsSync(dexToolsLib)) {
      this.dex2jarLibDir = dexToolsLib;
      console.log('[DexConverter] dex2jar available at:', dexToolsLib);
    }

    if (this.pythonExe && this.enjarifyDir) {
      this.initialized = true;
      console.log('[DexConverter] Primary strategy: enjarify');
    } else if (this.dex2jarLibDir) {
      this.initialized = true;
      console.log('[DexConverter] Primary strategy: dex2jar (fallback)');
    } else {
      this.initialized = false;
      console.error(
        '[DexConverter] No DEX→JAR converter available. Expected tools/enjarify/ or tools/dex-tools-v2.4/',
      );
    }

    return this.initialized;
  }

  /**
   * Find a Python 3 interpreter on PATH.
   * Tries python, python3, py (Windows) / python3, python, pypy3 (Unix).
   */
  private async findPython(): Promise<string | null> {
    const candidates =
      process.platform === 'win32'
        ? ['python.exe', 'python3.exe', 'py.exe']
        : ['python3', 'python', 'pypy3'];

    for (const cmd of candidates) {
      try {
        // Use `--version` — Python 3 prints "Python 3.x.y" to stdout
        const { stdout, stderr } = await execAsync(`"${cmd}" --version`);
        const out = (stdout + stderr).trim();
        if (/Python 3\./.test(out)) {
          return cmd;
        }
      } catch {
        // not found or wrong version — try next
      }
    }
    return null;
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
      return bundledJava;
    }
    return exeName;
  }

  /**
   * Convert DEX to JAR using enjarify (Python).
   * Sets PYTHONPATH so `python -m enjarify.main` resolves the package.
   */
  private convertWithEnjarify(dexPath: string, jarPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-O', '-m', 'enjarify.main', dexPath, '-o', jarPath];
      const env = { ...process.env, PYTHONPATH: this.enjarifyDir! };

      const proc = spawn(this.pythonExe!, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(jarPath)) {
          const stats = fs.statSync(jarPath);
          if (stats.size >= MIN_VALID_JAR_SIZE) {
            console.log(
              '[DexConverter] enjarify output:',
              jarPath,
              `(${stats.size} bytes)`,
            );
            resolve();
          } else {
            reject(
              new Error(
                `enjarify produced too-small JAR (${stats.size} bytes). stderr: ${stderr}`,
              ),
            );
          }
        } else {
          reject(
            new Error(`enjarify exited with code ${code}. stderr: ${stderr}`),
          );
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn enjarify: ${err.message}`));
      });
    });
  }

  /**
   * Convert DEX to JAR using dex2jar (Java).
   */
  private async convertWithDex2jar(
    dexPath: string,
    jarPath: string,
  ): Promise<void> {
    const javaExe = this.resolveJavaExe();
    const cmd = `"${javaExe}" -Xms512m -Xmx2048m -cp "${this.dex2jarLibDir}/*" com.googlecode.dex2jar.tools.Dex2jarCmd "${dexPath}" -o "${jarPath}"`;
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
  }

  /**
   * Convert DEX file to JAR.
   * Tries enjarify first (preferred, no conversion bugs), then falls back
   * to dex2jar with up to 3 retries on transient failures.
   */
  async convertDexToJar(dexPath: string, jarPath: string): Promise<string> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        throw new Error(
          'No DEX→JAR converter available. Ensure tools/enjarify/ (with Python 3) or tools/dex-tools-v2.4/ exists.',
        );
      }
    }

    // Reuse existing valid JAR
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
        `[DexConverter] Existing JAR too small (${stats.size} bytes), re-converting...`,
      );
      try {
        fs.unlinkSync(jarPath);
      } catch {
        /* ignore */
      }
    }

    console.log('[DexConverter] Converting DEX to JAR...');
    console.log('[DexConverter] Input:', dexPath);
    console.log('[DexConverter] Output:', jarPath);

    // Try enjarify first
    if (this.pythonExe && this.enjarifyDir) {
      try {
        console.log('[DexConverter] Trying enjarify...');
        await this.convertWithEnjarify(dexPath, jarPath);
        return jarPath;
      } catch (e: any) {
        console.warn(
          '[DexConverter] enjarify failed:',
          e.message,
          '— falling back to dex2jar',
        );
        // Clean partial output
        if (fs.existsSync(jarPath)) {
          try {
            fs.unlinkSync(jarPath);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Fall back to dex2jar with retries
    if (!this.dex2jarLibDir) {
      throw new Error(
        'enjarify failed and dex2jar not available. Cannot convert DEX to JAR.',
      );
    }

    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (fs.existsSync(jarPath)) {
        try {
          fs.unlinkSync(jarPath);
        } catch {
          /* ignore */
        }
      }
      try {
        console.log(
          `[DexConverter] Running dex2jar (attempt ${attempt}/${maxAttempts})...`,
        );
        await this.convertWithDex2jar(dexPath, jarPath);
        if (fs.existsSync(jarPath)) {
          const stats = fs.statSync(jarPath);
          if (stats.size >= MIN_VALID_JAR_SIZE) {
            console.log(
              '[DexConverter] dex2jar output:',
              jarPath,
              `(${stats.size} bytes)`,
            );
            return jarPath;
          }
          lastError = new Error(
            `dex2jar produced too-small JAR (${stats.size} bytes)`,
          );
        } else {
          lastError = new Error('dex2jar did not produce a JAR file');
        }
      } catch (e: any) {
        console.warn(
          `[DexConverter] dex2jar attempt ${attempt} failed:`,
          e.message,
        );
        lastError = e;
      }

      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt; // 1s, 2s
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw (
      lastError ||
      new Error(`DEX to JAR conversion failed after ${maxAttempts} attempts`)
    );
  }

  /**
   * Convert DEX to JAR using dex2jar ONLY (no enjarify).
   *
   * Use this for DEX files that contain Gson TypeToken subclasses,
   * because enjarify does NOT preserve generic Signature attributes,
   * causing "TypeToken must be created with a type argument" at runtime.
   * dex2jar preserves Signature attributes correctly.
   */
  async convertDexToJarWithDex2jar(
    dexPath: string,
    jarPath: string,
  ): Promise<string> {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        throw new Error(
          'DexConverter not available. Ensure tools/dex-tools-v2.4/ exists.',
        );
      }
    }

    if (!this.dex2jarLibDir) {
      throw new Error(
        'dex2jar not available. Cannot convert DEX with signature preservation.',
      );
    }

    // Reuse existing valid JAR
    if (fs.existsSync(jarPath)) {
      const stats = fs.statSync(jarPath);
      if (stats.size >= MIN_VALID_JAR_SIZE) {
        console.log(
          '[DexConverter] JAR already exists (dex2jar):',
          jarPath,
          `(${stats.size} bytes)`,
        );
        return jarPath;
      }
      try {
        fs.unlinkSync(jarPath);
      } catch {
        /* ignore */
      }
    }

    console.log(
      '[DexConverter] Converting DEX to JAR (dex2jar, preserves signatures)...',
    );
    console.log('[DexConverter] Input:', dexPath);
    console.log('[DexConverter] Output:', jarPath);

    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (fs.existsSync(jarPath)) {
        try {
          fs.unlinkSync(jarPath);
        } catch {
          /* ignore */
        }
      }
      try {
        await this.convertWithDex2jar(dexPath, jarPath);
        if (fs.existsSync(jarPath)) {
          const stats = fs.statSync(jarPath);
          if (stats.size >= MIN_VALID_JAR_SIZE) {
            console.log(
              '[DexConverter] dex2jar output:',
              jarPath,
              `(${stats.size} bytes)`,
            );
            return jarPath;
          }
          lastError = new Error(
            `dex2jar produced too-small JAR (${stats.size} bytes)`,
          );
        } else {
          lastError = new Error('dex2jar did not produce a JAR file');
        }
      } catch (e: any) {
        console.warn(
          `[DexConverter] dex2jar attempt ${attempt} failed:`,
          e.message,
        );
        lastError = e;
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    throw (
      lastError ||
      new Error(`dex2jar conversion failed after ${maxAttempts} attempts`)
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
