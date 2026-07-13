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

    // Check if already converted
    if (fs.existsSync(jarPath)) {
      console.log('[DexConverter] JAR already exists:', jarPath);
      return jarPath;
    }

    console.log('[DexConverter] Converting DEX to JAR...');
    console.log('[DexConverter] Input:', dexPath);
    console.log('[DexConverter] Output:', jarPath);

    // Use bundled JRE's java.exe directly (bypass d2j-dex2jar.bat which
    // depends on system PATH for java). Falls back to system java in dev.
    const javaExe = this.resolveJavaExe();
    const libDir = path.join(this.toolsDir, 'dex-tools-v2.4', 'lib');
    const cmd = `"${javaExe}" -Xms512m -Xmx2048m -cp "${libDir}/*" com.googlecode.dex2jar.tools.Dex2jarCmd "${dexPath}" -o "${jarPath}"`;

    try {
      console.log('[DexConverter] Running:', cmd);
      const output = await this.execCommand(cmd);
      console.log('[DexConverter] Conversion output:', output);

      // Verify output exists
      if (fs.existsSync(jarPath)) {
        const stats = fs.statSync(jarPath);
        console.log('[DexConverter] Converted JAR size:', stats.size, 'bytes');
        return jarPath;
      } else {
        throw new Error('JAR file not created after conversion');
      }
    } catch (e: any) {
      console.error('[DexConverter] Conversion failed:', e);
      throw e;
    }
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
