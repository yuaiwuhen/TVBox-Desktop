/**
 * JarLoader - JAR Spider Loader for Electron Main Process
 *
 * Implements PNG steganography extraction and JAR loading using java-bridge.
 * Supports DEX to JAR conversion for Android DEX files.
 * Based on Box Android's ApiConfig.java and JarLoader.java implementation.
 */

import { ipcMain, BrowserWindow } from 'electron';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { exec as execCb, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { DexConverter, dexConverter } from './DexConverter';
// Top-level imports instead of dynamic require() — vite bundles dynamic
// require('./QuarkPanService') as createRequire(import.meta.url) which points
// at dist-electron/main.js, where ./QuarkPanService doesn't exist as a file
// (it's already inlined into the bundle). ESM circular deps are safe here
// because neither QuarkPanService nor ProxyServer uses jarLoader at
// module-load time — only inside method bodies.
import { QuarkPanService } from './QuarkPanService';
import { proxyServer } from './ProxyServer';

// Create require for loading CommonJS modules in ESM
const require = createRequire(import.meta.url);

// __dirname for ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// java-bridge types
interface JavaClass {
  newInstance(): JavaObject;
  [key: string]: any;
}

interface JavaObject {
  [method: string]: (...args: any[]) => any;
}

interface JVMOptions {
  classpath?: string[];
  libPath?: string | null;
  version?: string | null;
  opts?: string[] | null;
}

interface JavaBridge {
  classpath: { append: (path: string) => void; get: () => string[] };
  importClass(className: string): JavaClass;
  appendClasspath(path: string | string[]): void;
  ensureJvm(options?: JVMOptions): boolean;
  getClassLoader(): any;
  setClassLoader(loader: any): void;
}

// Spider instance cache
interface SpiderInstance {
  spider: JavaObject;
  className: string;
  ext: string;
  isGuard: boolean;
  // Tracks in-flight init so callSpiderMethod can wait for it to complete
  // before invoking any spider method. Without this, an early homeContent
  // call races with initSpider and runs against an uninitialized spider
  // (base URL still the hijacked hardcoded default), returning list=[].
  initPromise: Promise<void> | null;
}

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

export class JarLoader {
  private classLoaders: Map<string, boolean> = new Map();
  private spiders: Map<string, SpiderInstance> = new Map();
  private jarCacheDir: string;
  private java: JavaBridge | null = null;
  private recentJarKey: string = 'main';
  private lastError: string = '';
  // Progress callback: (stage, message, percent) => void
  private onProgress:
    | ((stage: string, message: string, percent: number) => void)
    | null = null;

  private stubsLoaded: boolean = false;

  // WexGuard siteconfig: maps spider keys (e.g. "wogg", "jutou") to URL
  // lists. Fetched from upload.baicanuc.cn (item.txt -> config_site URL ->
  // JSON). Written to <filesDir>/NewWex/siteconfig before any Guard spider
  // init() so the spider picks a working mirror instead of falling back to
  // the hijacked http://www.wogg.lol hardcoded URL.
  private wexGuardSiteConfigJson: string | null = null;
  private wexGuardSiteConfigPromise: Promise<string | null> | null = null;

  // Track the most recent spider that was used for playerContent.
  // Used by proxyInvoke to call spider.proxyLocal() instead of Proxy.proxy().
  // Mirrors Android's ApiConfig.recentKey / pyLoader.recentPyApi mechanism.
  private recentSpiderKey: string | null = null;
  private recentSpiderType: 'jar' | 'js' | 'py' | null = null;

  // Custom headers for direct video URLs (not proxied). Keyed by URL origin
  // (scheme://host:port). When translatePlayerContent encounters a direct
  // video URL (e.g. https://vd.wmvbo.com/.../index.m3u8) with custom headers,
  // it registers them here. The webRequest interceptor in main.ts reads this
  // map to inject User-Agent/Referer that the browser would otherwise block.
  private videoUrlHeaders: Map<string, Record<string, string>> = new Map();

  // Source isolation: per-source configuration and native libraries
  // Map from className (e.g. "WexGuaZiGuard") to source-specific data
  private sourceIsolation: Map<
    string,
    { nativeLibPath?: string; needsUnidbg?: boolean }
  > = new Map();

  // Background pre-loading of Guard spider JAR to avoid blocking getSpider.
  // When the app starts, we kick off loadGuardSpiderJar() in the background.
  // getSpider() awaits this promise if it's still running, so the UI stays
  // responsive (the blocking Java calls run on libuv worker threads via
  // java-bridge async methods, not on the Node.js event loop).
  private guardSpiderJarPromise: Promise<boolean> | null = null;

  constructor() {
    // Install global error handlers to capture all Java-related errors
    this.installGlobalErrorHandlers();
    // Initialize java-bridge
    this.java = this.initJavaBridge();
    // Create cache directory
    this.jarCacheDir = path.join(process.cwd(), 'jar_cache');
    if (!fs.existsSync(this.jarCacheDir)) {
      fs.mkdirSync(this.jarCacheDir, { recursive: true });
    }
    console.log('[JarLoader] Initialized, cache dir:', this.jarCacheDir);
    // Initialize spider Init.context() early so that cookie sync and other
    // operations that depend on Init.context() work before any JAR is loaded.
    // Without this, QuarkPanService.syncCookieToJVM() fails on app startup
    // because Init.context() returns null until a spider JAR is loaded.
    this.ensureSpiderContext();
  }

  /**
   * Check if a spider class needs special handling (e.g. unidbg for native methods).
   * This is determined by the className pattern and is isolated per-source.
   * Source isolation: each source has its own configuration and doesn't affect others.
   */
  private needsSourceSpecificHandling(clsKey: string): boolean {
    // WexGuaZiGuard needs unidbg for LoadNiMa.decode() native method
    // Other sources may have different requirements - this mapping is isolated
    const specialSources = new Set([
      'WexGuaZiGuard', // 瓜子源：需要 unidbg 加载 libLoadNiMa.so
      // Add other sources here as needed - each source is isolated
    ]);
    return specialSources.has(clsKey);
  }

  /**
   * Get source-specific directory based on className (isolated per-source).
   * Uses className instead of jarUrl because domains may change.
   * Directory structure: jar_cache/<className>/
   */
  private getSourceIsolationDir(clsKey: string): string {
    const sourceDir = path.join(this.jarCacheDir, clsKey);
    if (!fs.existsSync(sourceDir)) {
      fs.mkdirSync(sourceDir, { recursive: true });
    }
    return sourceDir;
  }

  /**
   * Extract native library from JAR file (source-isolated).
   * Downloads JAR from jarUrl, extracts native .so files to source-specific directory.
   * Each source maintains its own native library cache.
   */
  private async extractNativeFromJar(
    jarUrl: string,
    clsKey: string,
    libName: string,
  ): Promise<string | null> {
    const sourceDir = this.getSourceIsolationDir(clsKey);
    const libPath = path.join(sourceDir, libName);

    // Check if already extracted
    if (fs.existsSync(libPath)) {
      console.log(
        `[JarLoader] Native lib already extracted for ${clsKey}:`,
        libPath,
      );
      return libPath;
    }

    try {
      console.log(
        `[JarLoader] Extracting native lib from JAR for ${clsKey}:`,
        libName,
      );

      // Download JAR directly using axios
      const jarKey = crypto.createHash('md5').update(jarUrl).digest('hex');
      const jarPath = path.join(this.jarCacheDir, `${jarKey}.jar`);

      // Check if JAR is already downloaded
      if (!fs.existsSync(jarPath)) {
        console.log(`[JarLoader] Downloading JAR from:`, jarUrl);
        const response = await axios.get(jarUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        fs.writeFileSync(jarPath, response.data);
        console.log(`[JarLoader] JAR downloaded to:`, jarPath);
      } else {
        console.log(`[JarLoader] JAR already cached:`, jarPath);
      }

      // Extract native library from JAR (using jar command)
      // Native libs are typically in lib/arm64-v8a/ or assets/ directory.
      // Use async exec (libuv thread pool) so the Node.js event loop stays
      // responsive — execSync would block the main window.
      let fileList: string;
      try {
        const { stdout } = await execAsync(`jar tf "${jarPath}"`, {
          encoding: 'utf8',
        });
        fileList = stdout;
      } catch (listErr: any) {
        console.warn(
          `[JarLoader] Failed to list JAR contents:`,
          listErr?.message || listErr,
        );
        return null;
      }

      // Find the native lib in JAR
      const libEntryMatch = fileList.match(
        new RegExp(`(lib/.*${libName}|assets/${libName})`, 'm'),
      );

      if (!libEntryMatch) {
        console.warn(
          `[JarLoader] Native lib ${libName} not found in JAR ${jarPath}`,
        );
        return null;
      }

      // Extract the specific file
      const libEntryPath = libEntryMatch[0];
      await execAsync(`jar xf "${jarPath}" "${libEntryPath}"`, {
        cwd: sourceDir,
      });

      // Move to final location
      const extractedPath = path.join(sourceDir, libEntryPath);
      if (fs.existsSync(extractedPath)) {
        fs.renameSync(extractedPath, libPath);
        console.log(`[JarLoader] Extracted native lib to:`, libPath);
        return libPath;
      } else {
        console.warn(`[JarLoader] Failed to move extracted lib`);
        return null;
      }
    } catch (e: any) {
      console.error(
        `[JarLoader] Failed to extract native lib for ${clsKey}:`,
        e.message,
      );
      return null;
    }
  }

  /**
   * Verify if libLoadNiMa.so was downloaded by InitOrigin.init(),
   * and if not, manually download it from the newgo.txt URLs.
   */
  private async verifyAndDownloadLibLoadNiMa(): Promise<void> {
    try {
      // Get filesDir where InitOrigin downloads libs
      const InitOrigin = this.java.importClass(
        'com.github.catvod.spider.InitOrigin',
      );
      const filesDir = InitOrigin.oOoOoOo0O0O0oO0o;
      if (!filesDir) {
        console.warn(
          '[JarLoader] InitOrigin.oOoOoOo0O0O0oO0o (filesDir) is null',
        );
        return;
      }

      const libPath = path.join(String(filesDir), 'libLoadNiMa.so');
      console.log('[JarLoader] Checking libLoadNiMa.so at:', libPath);

      if (fs.existsSync(libPath)) {
        const stat = fs.statSync(libPath);
        console.log(
          '[JarLoader] libLoadNiMa.so found, size:',
          stat.size,
          'bytes',
        );
        return;
      }

      console.warn(
        '[JarLoader] libLoadNiMa.so NOT found! Attempting manual download...',
      );

      // Manually download from newgo.txt URLs
      await this.downloadLibLoadNiMaManually(filesDir);
    } catch (e: any) {
      console.error(
        '[JarLoader] verifyAndDownloadLibLoadNiMa failed:',
        e.message,
      );
    }
  }

  /**
   * Manually download libLoadNiMa.so from newgo.txt URLs.
   */
  private async downloadLibLoadNiMaManually(filesDir: string): Promise<void> {
    try {
      const newgoUrl =
        'http://upload.baicanuc.cn/ossfiles/1768320816/newgo.txt';
      console.log('[JarLoader] Fetching newgo.txt from:', newgoUrl);

      const response = await axios.get(newgoUrl, { timeout: 30000 });
      const newgoData = response.data;

      // Determine ABI - we use arm64-v8a for unidbg
      const abiKey = 'wex_v8_url';
      const sizeKey = 'wex_v8_size';

      if (!newgoData[abiKey] || !newgoData[sizeKey]) {
        console.warn('[JarLoader] newgo.txt missing wex_v8_url or wex_v8_size');
        return;
      }

      const urls = newgoData[abiKey];
      const expectedSize = newgoData[sizeKey];

      console.log(
        '[JarLoader] Found',
        urls.length,
        'download URLs for libLoadNiMa.so',
      );

      const libPath = path.join(String(filesDir), 'libLoadNiMa.so');

      // Try each URL
      for (const entry of urls) {
        const url = entry.url;
        console.log('[JarLoader] Trying URL:', url);

        try {
          const libResponse = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 60000,
          });

          if (libResponse.data.length === expectedSize) {
            fs.writeFileSync(libPath, libResponse.data);
            console.log(
              '[JarLoader] Successfully downloaded libLoadNiMa.so to:',
              libPath,
            );
            return;
          } else {
            console.warn(
              '[JarLoader] File size mismatch:',
              libResponse.data.length,
              'vs expected',
              expectedSize,
            );
          }
        } catch (urlErr: any) {
          console.warn(
            '[JarLoader] Download failed from:',
            url,
            '-',
            urlErr.message,
          );
        }
      }

      console.error(
        '[JarLoader] Failed to download libLoadNiMa.so from all URLs',
      );
    } catch (e: any) {
      console.error(
        '[JarLoader] downloadLibLoadNiMaManually failed:',
        e.message,
      );
    }
  }

  /**
   * Download JAR file from URL (cached by MD5 hash).
   * Returns path to downloaded JAR file.
   */
  /**
   * Setup source-specific handling (isolated per-source).
   * For WexGuaZiGuard: download JAR, extract libLoadNiMa.so, prepare unidbg loader.
   */
  private async setupSourceSpecificHandling(
    clsKey: string,
    jarUrl: string,
  ): Promise<void> {
    if (!this.needsSourceSpecificHandling(clsKey)) {
      return; // No special handling needed for this source
    }

    console.log(`[JarLoader] Setting up source-specific handling for:`, clsKey);

    try {
      // For WexGuaZiGuard: extract libLoadNiMa.so from JAR or use InitOrigin download
      if (clsKey === 'WexGuaZiGuard') {
        let libPath = await this.extractNativeFromJar(
          jarUrl,
          clsKey,
          'libLoadNiMa.so',
        );

        // If not found in JAR, check InitOrigin.init() download location
        if (!libPath) {
          try {
            const InitOrigin = this.java.importClass(
              'com.github.catvod.spider.InitOrigin',
            );
            const filesDir = InitOrigin.oOoOoOo0O0O0oO0o;
            if (filesDir) {
              const initOriginLibPath = path.join(
                String(filesDir),
                'libLoadNiMa.so',
              );
              console.log(
                '[JarLoader] Checking InitOrigin download location:',
                initOriginLibPath,
              );
              if (fs.existsSync(initOriginLibPath)) {
                const stat = fs.statSync(initOriginLibPath);
                console.log(
                  '[JarLoader] Found libLoadNiMa.so from InitOrigin.init(), size:',
                  stat.size,
                  'bytes',
                );
                libPath = initOriginLibPath;
              }
            }
          } catch (e: any) {
            console.warn(
              '[JarLoader] Failed to check InitOrigin lib path:',
              e.message,
            );
          }
        }

        if (libPath) {
          // Store in source isolation map
          this.sourceIsolation.set(clsKey, {
            nativeLibPath: libPath,
            needsUnidbg: true,
          });

          // Set Java system property so stub can find the native library
          // LoadNiMa-stub reads this property to locate libLoadNiMa.so
          try {
            const SystemClass = this.java.importClass('java.lang.System');
            SystemClass.setPropertySync(
              'tvbox.nativelib.WexGuaZiGuard',
              libPath,
            );
            console.log(
              `[JarLoader] Set System property for native lib path:`,
              libPath,
            );
          } catch (e: any) {
            console.warn(
              '[JarLoader] Failed to set System property:',
              e.message,
            );
          }

          console.log(
            `[JarLoader] WexGuaZiGuard ready with native lib:`,
            libPath,
          );
        } else {
          console.warn(
            `[JarLoader] WexGuaZiGuard: native lib not found, will use stub`,
          );
        }
      }

      // Add other source-specific setups here - each source is isolated
    } catch (e: any) {
      console.error(
        `[JarLoader] Failed to setup source-specific handling for ${clsKey}:`,
        e.message,
      );
    }
  }

  /**
   * Call LoadNiMa.decode() via unidbg emulator (source-isolated).
   * This is only called for sources that need native decoding (e.g. WexGuaZiGuard).
   * Each source maintains its own native library cache.
   *
   * @param clsKey Source identifier (className without 'csp_' prefix)
   * @param input Encrypted input data (typically hex string from API response)
   * @returns Decoded JSON string, or original input if decoding failed
   */
  private async callLoadNiMaDecode(
    clsKey: string,
    input: string,
  ): Promise<string> {
    const sourceConfig = this.sourceIsolation.get(clsKey);

    // Check if source has native library configured
    if (!sourceConfig?.nativeLibPath) {
      console.log(
        `[JarLoader] No native lib for ${clsKey}, returning original input (stub)`,
      );
      return input;
    }

    console.log(`[JarLoader] Calling LoadNiMa.decode via unidbg for ${clsKey}`);
    console.log(`[JarLoader] Input length:`, input.length);
    console.log(
      `[JarLoader] Input preview:`,
      input.substring(0, Math.min(100, input.length)),
    );

    try {
      // Call unidbg loader via Java subprocess
      const unidbgJarPath = path.join(
        process.cwd(),
        'tools/unidbg-loader/target/unidbg-loader-1.0.0.jar',
      );

      if (!fs.existsSync(unidbgJarPath)) {
        console.warn(`[JarLoader] Unidbg loader JAR not found:`, unidbgJarPath);
        return input;
      }

      // Use async execFile (libuv thread pool) to avoid blocking the Node.js
      // event loop while the unidbg subprocess runs (can take several seconds).
      // execFile (not exec) avoids shell interpretation and Windows 8191-char
      // command line limits — the hex input can be tens of thousands of chars.
      const { stdout } = await execFileAsync(
        'java',
        [
          '-cp',
          unidbgJarPath,
          'com.tvbox.LoadNiMaDecryptor',
          sourceConfig.nativeLibPath,
          input,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large responses
          timeout: 30000, // 30 second timeout
        },
      );
      const result = stdout;

      // Parse output: find the last line that looks like JSON
      const lines = result.trim().split('\n');
      let decodedJson = '';

      // Scan from bottom to top to find the JSON output
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') || line.startsWith('[')) {
          decodedJson = line;
          break;
        }
      }

      if (decodedJson) {
        console.log(
          `[JarLoader] ✅ LoadNiMa decode success for ${clsKey}, output length:`,
          decodedJson.length,
        );
        console.log(
          `[JarLoader] Output preview:`,
          decodedJson.substring(0, Math.min(200, decodedJson.length)),
        );
        return decodedJson;
      } else {
        console.warn(
          `[JarLoader] ⚠️  LoadNiMa decode returned non-JSON, using stub`,
        );
        return input;
      }
    } catch (e: any) {
      console.error(
        `[JarLoader] ❌ LoadNiMa decode failed for ${clsKey}:`,
        e.message,
      );

      // Check if it's a timeout error
      if (e.message.includes('timeout') || e.message.includes('ETIMEDOUT')) {
        console.warn(
          `[JarLoader] Decode timeout, using stub (native method may be slow)`,
        );
      }

      // Fallback to stub (return original input)
      return input;
    }
  }

  /**
   * Initialize the spider's Init class with a stub Application context.
   *
   * The Init class stores the Application Context in its static field 'c'
   * (accessible via Init.context()). This is required by SharedPreferences
   * access, spider init(), and other operations. Normally this is set when
   * a spider JAR is loaded (see loadJar), but on app startup—before any
   * JAR is loaded—Init.context() returns null, causing cookie sync to fail.
   *
   * This method creates a stub Application and sets it as Init's 'c' field
   * so that Init.context() is always available, even before a JAR is loaded.
   * Safe to call multiple times; only initializes once.
   */
  /**
   * Register BouncyCastle as a JCE provider so spiders that call
   * Cipher.getInstance("AES/CBC/PKCS7Padding") work. Java's default JCE
   * only knows PKCS5Padding; BouncyCastle accepts both names.
   */
  private registerBouncyCastle(): void {
    if (!this.java) return;
    try {
      const Security = this.java.importClass('java.security.Security');
      // Check if already registered
      const existing = Security.getProviderSync
        ? Security.getProviderSync('BC')
        : null;
      if (existing) {
        console.log('[JarLoader] BouncyCastle provider already registered');
        return;
      }
      const BouncyCastleProvider = this.java.importClass(
        'org.bouncycastle.jce.provider.BouncyCastleProvider',
      );
      const provider = new BouncyCastleProvider();
      Security.addProviderSync
        ? Security.addProviderSync(provider)
        : Security.addProvider(provider);
      console.log('[JarLoader] BouncyCastle provider registered (BC)');
    } catch (e: any) {
      console.warn(
        '[JarLoader] Failed to register BouncyCastle provider:',
        e.message || e,
      );
    }
  }

  public ensureSpiderContext(): void {
    if (!this.java) return;
    try {
      const InitClass = this.java.importClass('com.github.catvod.spider.Init');
      // Check if already initialized
      let existing: any;
      try {
        existing = InitClass.contextSync();
      } catch (_) {
        existing = null;
      }
      if (existing) {
        return; // Already initialized
      }

      const ApplicationClass = this.java.importClass('android.app.Application');
      const app = new ApplicationClass();
      // Set Init's static 'c' field directly (Init.c = app)
      try {
        InitClass.c = app;
      } catch (_) {
        /* field may not be accessible */
      }
      // Also call Init.init() for any side effects
      try {
        if (typeof InitClass.initSync === 'function') {
          InitClass.initSync(app);
        } else if (typeof InitClass.init === 'function') {
          InitClass.init(app);
        }
      } catch (_) {
        /* may fail but the field is set */
      }
      console.log(
        '[JarLoader] Spider context initialized (Init.c set to stub Application)',
      );
    } catch (e: any) {
      console.warn('[JarLoader] ensureSpiderContext failed:', e.message);
    }
  }

  /**
   * Install global error handlers to capture Java-related errors that
   * might be thrown asynchronously or from JNI native code.
   */
  private installGlobalErrorHandlers(): void {
    process.on('uncaughtException', (err: any) => {
      console.error(
        '[JavaError][uncaughtException]',
        err?.message || String(err),
      );
      if (err?.stack) console.error('[JavaError][stack]', err.stack);
      const cause = err?.cause;
      if (cause) {
        console.error('[JavaError][cause]', cause?.message || String(cause));
        if (cause?.stack) console.error('[JavaError][causeStack]', cause.stack);
      }
    });

    process.on('unhandledRejection', (reason: any) => {
      console.error(
        '[JavaError][unhandledRejection]',
        reason?.message || String(reason),
      );
      if (reason?.stack)
        console.error('[JavaError][rejectionStack]', reason.stack);
    });

    console.log('[JarLoader] Global error handlers installed');
  }

  /**
   * Set progress callback
   */
  setProgressCallback(
    callback: (stage: string, message: string, percent: number) => void,
  ): void {
    this.onProgress = callback;
  }

  /**
   * Emit progress event
   */
  private emitProgress(stage: string, message: string, percent: number): void {
    console.log(`[JarLoader] [${stage}] ${message} (${percent}%)`);
    if (this.onProgress) {
      try {
        this.onProgress(stage, message, percent);
      } catch (e) {
        // Ignore callback errors
      }
    }
  }

  /**
   * Get last error message
   */
  getLastError(): string {
    return this.lastError;
  }

  /**
   * Initialize java-bridge
   * Calls ensureJvm with classpath BEFORE JVM starts to put stubs on system classpath.
   * This is critical because appendClasspath creates new URLClassLoaders that may not
   * be visible to the Thread context classloader used by OkHttp/Kotlin.
   */
  private initJavaBridge(): JavaBridge | null {
    try {
      console.log('[JarLoader] Attempting to load java-bridge...');
      console.log('[JarLoader] Node version:', process.version);
      console.log('[JarLoader] Platform:', process.platform);
      console.log('[JarLoader] Arch:', process.arch);

      const javaHome = process.env.JAVA_HOME;
      console.log('[JarLoader] JAVA_HOME:', javaHome || 'not set');

      const java = require('java-bridge') as JavaBridge;

      // CRITICAL: Set system classpath BEFORE JVM starts.
      // ensureJvm must be called before any other java-bridge call (appendClasspath, importClass)
      // because those may trigger JVM initialization without our classpath.
      // Once the JVM is running, the system classpath cannot be changed.
      const stubPaths = this.collectStubPaths();
      if (stubPaths.length > 0) {
        console.log(
          `[JarLoader] Setting JVM system classpath with ${stubPaths.length} stub JARs`,
        );
        // -Xverify:none disables bytecode verification, required because
        // enjarify-converted JARs (from DEX) lack StackMapTable attributes
        // and have minor verifier complaints (e.g. "Call to wrong initialization
        // method" in <clinit>). The verifier is also strict about interfaces
        // implemented by anonymous classes which dex2jar/enjarify don't preserve.
        const created = java.ensureJvm({
          classpath: stubPaths,
          opts: [
            '-Xverify:none',
            '-Dfile.encoding=UTF-8',
            '-Dsun.stdout.encoding=UTF-8',
            '-Dsun.stderr.encoding=UTF-8',
          ],
        });
        if (created) {
          console.log('[JarLoader] JVM started with stubs on system classpath');
          this.stubsLoaded = true;
          this.diagnoseJSONObject(java);
        } else {
          console.warn(
            '[JarLoader] JVM already started, system classpath not set. Stubs will be added via appendClasspath.',
          );
        }
      } else {
        console.warn('[JarLoader] No stub JARs found for system classpath');
        java.ensureJvm();
      }

      console.log(
        '[JarLoader] java-bridge classpath:',
        java.classpath.get().length,
        'entries',
      );

      // Register BouncyCastle provider so spiders using AES/CBC/PKCS7Padding
      // work (default JCE only supports PKCS5Padding).
      this.registerBouncyCastle();

      return java;
    } catch (e: any) {
      console.error('[JarLoader] Failed to load java-bridge:', e.message || e);
      console.error('[JarLoader] Error code:', e.code || 'unknown');

      if (e.code === 'MODULE_NOT_FOUND') {
        this.lastError =
          'java-bridge module not found. Please run: pnpm install';
      } else if (e.message && e.message.includes('DLL')) {
        this.lastError =
          'java-bridge native DLL failed to load. Check Visual C++ Redistributable 2015+ is installed.';
      } else if (e.message && e.message.includes('JVM')) {
        this.lastError =
          'JVM not found. Check JAVA_HOME points to JDK directory.';
      } else {
        this.lastError = `java-bridge failed: ${e.message || 'unknown error'}`;
      }

      return null;
    }
  }

  /**
   * Collect stub JAR paths from tools directory.
   * These must be on the JVM system classpath before startup.
   */
  private collectStubPaths(): string[] {
    console.log('[JarLoader] collectStubPaths - process.cwd():', process.cwd());
    console.log('[JarLoader] collectStubPaths - __dirname:', __dirname);
    console.log(
      '[JarLoader] collectStubPaths - process.resourcesPath:',
      process.resourcesPath || 'not set',
    );

    const toolsDirs = [
      path.join(process.cwd(), 'tools'),
      path.join(path.dirname(process.cwd()), 'tools'),
      path.join(process.cwd(), 'resources', 'tools'),
      path.join(__dirname, 'tools'),
      path.join(process.resourcesPath || '', 'tools'),
    ];

    const stubJars = [
      'kotlin-stdlib.jar',
      'okhttp.jar',
      'okio.jar',
      'json-patch.jar',
      'json.jar',
      'gson.jar',
      'bcprov-jdk18on.jar',
      'tvbox-spider-stubs-complete.jar',
    ];

    for (const toolsDir of toolsDirs) {
      const stubPath = path.join(toolsDir, 'tvbox-spider-stubs-complete.jar');
      const exists = fs.existsSync(stubPath);
      console.log(
        `[JarLoader] Checking tools dir: ${toolsDir} | tvbox-spider-stubs-complete.jar exists: ${exists}`,
      );
      if (!exists) {
        continue;
      }

      const paths: string[] = [];
      for (const jar of stubJars) {
        const jarPath = path.join(toolsDir, jar);
        if (fs.existsSync(jarPath)) {
          paths.push(jarPath);
        } else {
          console.log(`[JarLoader] Optional stub not found: ${jarPath}`);
        }
      }

      if (paths.length > 0) {
        console.log(
          `[JarLoader] Found ${paths.length} stub JARs in: ${toolsDir}`,
        );
        console.log('[JarLoader] Stub paths:', paths);
        return paths;
      }
    }

    console.warn('[JarLoader] No stub JARs found in any tools directory');
    return [];
  }

  /**
   * Extract JAR data from PNG steganography (Box Android's getImgJar method)
   * Pattern: [A-Za-z0]{8}\*\*
   * After the pattern, the rest is base64-encoded JAR data
   */
  public static extractImgJar(body: string): Buffer {
    // Match pattern [A-Za-z0]{8}\*\*
    const pattern = /[A-Za-z0]{8}\*\*/;
    const match = body.match(pattern);

    if (match) {
      // Extract content after the pattern
      const startIdx = body.indexOf(match[0]) + 10; // pattern length is 10
      const b64Data = body.substring(startIdx);

      // Decode base64
      try {
        // Handle potential noise in base64 string
        const cleanB64 = b64Data.replace(/[^A-Za-z0-9+/=]/g, '');
        const jarData = Buffer.from(cleanB64, 'base64');
        console.log(
          '[JarLoader] Extracted JAR data from PNG, size:',
          jarData.length,
        );
        return jarData;
      } catch (e) {
        console.error('[JarLoader] Failed to decode base64:', e);
      }
    }

    console.warn('[JarLoader] No PNG steganography pattern found');
    return Buffer.alloc(0);
  }

  /**
   * Calculate MD5 hash of a file
   */
  private static getFileMd5(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Download JAR from URL
   * Handles both regular JAR URLs and PNG steganography URLs
   *
   * Spider URL format from config: "https://xxx.png;md5;hash/csp_xxx.js"
   * We only need the PNG URL part (before ;md5;)
   */
  private async downloadJar(
    jarUrl: string,
    isImgJar: boolean,
    cachePath: string,
  ): Promise<boolean> {
    try {
      console.log('[JarLoader] Downloading from:', jarUrl, 'isImg:', isImgJar);

      // Always download as binary (PNG files are binary)
      const response = await axios.get(jarUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'okhttp/3.15',
          Accept: '*/*',
        },
      });

      const rawData = Buffer.from(response.data);
      console.log('[JarLoader] Downloaded data size:', rawData.length, 'bytes');

      // Log first bytes to understand format
      const firstBytes = rawData.slice(0, 20);
      console.log(
        '[JarLoader] First 20 bytes (hex):',
        firstBytes.toString('hex'),
      );

      let jarData: Buffer;

      // Check if this is a PNG file (by magic number or isImgJar flag)
      if (isImgJar || this.looksLikePng(rawData)) {
        console.log(
          '[JarLoader] File is PNG image, extracting steganography data...',
        );

        // Extract JAR from PNG steganography
        jarData = this.extractJdFromBinary(rawData);

        if (jarData.length === 0) {
          console.error('[JarLoader] Failed to extract JAR from PNG');

          // Fallback: maybe the file is already a JAR/DEX (no steganography)
          if (this.isDexFile(rawData)) {
            console.log('[JarLoader] File is DEX format directly');
            jarData = rawData;
          } else if (this.isJarFile(rawData)) {
            console.log('[JarLoader] File is JAR format directly');
            jarData = rawData;
          } else {
            return false;
          }
        }
      } else if (this.isDexFile(rawData)) {
        // Direct DEX file
        console.log('[JarLoader] File is DEX format');
        jarData = rawData;
      } else if (this.isJarFile(rawData)) {
        // Direct JAR file
        console.log('[JarLoader] File is JAR format');
        jarData = rawData;
      } else {
        // Unknown format
        console.warn('[JarLoader] Unknown file format, treating as raw JAR');
        jarData = rawData;
      }

      console.log('[JarLoader] Final JAR/DEX size:', jarData.length, 'bytes');

      // Identify the file type
      if (this.isDexFile(jarData)) {
        console.log('[JarLoader] File is DEX (Android Dalvik Executable)');
      } else if (this.isJarFile(jarData)) {
        console.log('[JarLoader] File is JAR (Java Archive)');
      } else {
        console.log(
          '[JarLoader] Unknown format, first 8 bytes:',
          jarData.slice(0, 8).toString('hex'),
        );
      }

      // Write to cache
      fs.writeFileSync(cachePath, jarData);
      console.log('[JarLoader] Cached to:', cachePath);
      this.lastError = '';
      return true;
    } catch (e: any) {
      this.lastError = `Download failed: ${e.message || e}`;
      console.error('[JarLoader] Download failed:', e);
      return false;
    }
  }

  /**
   * Check if data looks like PNG image (PNG magic number)
   */
  private looksLikePng(data: Buffer): boolean {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A (‰PNG....)
    return (
      data.length >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    );
  }

  /**
   * Convert JavaScript args to Java types for TVBox Spider API.
   * categoryContent(String, String, boolean, HashMap<String,String>)
   * detailContent(List<String>)
   * playerContent(String, String, List<String>)
   * searchContent(String, boolean, [String])
   */
  private convertArgs(method: string, args: any[]): any[] {
    try {
      switch (method) {
        case 'homeContent':
          // homeContent(boolean filter)
          return args;

        case 'categoryContent': {
          // categoryContent(String tid, String pg, boolean filter, HashMap<String,String> extend)
          const [tid, pg, filter, extend] = args;
          const HashMap = this.java.importClass('java.util.HashMap');
          const map = new HashMap();
          if (extend && typeof extend === 'object') {
            for (const [k, v] of Object.entries(extend)) {
              map.putSync(k, String(v));
            }
          }
          return [tid, pg, filter, map];
        }

        case 'detailContent': {
          // detailContent(List<String> ids)
          const [ids] = args;
          const ArrayList = this.java.importClass('java.util.ArrayList');
          const list = new ArrayList();
          if (Array.isArray(ids)) {
            for (const id of ids) {
              list.addSync(String(id));
            }
          }
          return [list];
        }

        case 'playerContent': {
          // playerContent(String flag, String id, List<String> vipFlags)
          const [flag, id, vipFlags] = args;
          const ArrayList = this.java.importClass('java.util.ArrayList');
          const list = new ArrayList();
          if (Array.isArray(vipFlags)) {
            for (const f of vipFlags) {
              list.addSync(String(f));
            }
          }
          return [flag, id, list];
        }

        case 'searchContent': {
          // searchContent(String key, boolean quick, [String pg])
          return args;
        }

        default:
          return args;
      }
    } catch (e: any) {
      console.warn('[JarLoader] Arg conversion failed:', method, e.message);
      return args;
    }
  }

  /**
   * Update the current thread's context classloader to the internal URLClassLoader.
   * This is needed because java-bridge's appendClasspath creates new URLClassLoaders
   * but doesn't update the thread context classloader. OkHttp and other libraries
   * use Thread.currentThread().getContextClassLoader() to load dependencies.
   */
  private updateContextClassLoader(): void {
    try {
      const Thread = this.java.importClass('java.lang.Thread');
      const currentThread = Thread.currentThreadSync();
      const internalLoader = this.java.getClassLoader();
      currentThread.setContextClassLoaderSync(internalLoader);
      console.log('[JarLoader] Thread context classloader updated');
    } catch (e: any) {
      console.warn(
        '[JarLoader] Failed to update context classloader:',
        e.message,
      );
    }
  }

  /**
   * Load TVBox Spider API stubs
   * If stubs are already on the system classpath (from ensureJvm), just verify.
   * Otherwise, add them via appendClasspath as fallback.
   */
  private loadSpiderStubs(): void {
    if (this.stubsLoaded) return;

    // If stubs were already set on system classpath via ensureJvm,
    // just verify they're accessible and mark as loaded
    try {
      this.java.importClass('kotlin.jvm.internal.Intrinsics');
      console.log(
        '[JarLoader] Stubs already on system classpath (verified Intrinsics)',
      );
      this.stubsLoaded = true;
      this.diagnoseJSONObject(this.java);
      return;
    } catch {
      // Stubs not on system classpath, need to add via appendClasspath
      console.warn(
        '[JarLoader] Stubs not on system classpath, adding via appendClasspath',
      );
    }

    const toolsDirs = [
      path.join(process.cwd(), 'tools'),
      path.join(path.dirname(process.cwd()), 'tools'),
      path.join(process.cwd(), 'resources', 'tools'),
      path.join(__dirname, 'tools'),
      path.join(process.resourcesPath || '', 'tools'),
    ];

    const requiredJars = [
      'kotlin-stdlib.jar',
      'okhttp.jar',
      'okio.jar',
      'json-patch.jar',
      'json.jar',
      'gson.jar',
      'bcprov-jdk18on.jar',
      'tvbox-spider-stubs-complete.jar',
    ];

    for (const toolsDir of toolsDirs) {
      const stubJarPath = path.join(
        toolsDir,
        'tvbox-spider-stubs-complete.jar',
      );
      if (!fs.existsSync(stubJarPath)) {
        continue;
      }

      console.log(`[JarLoader] Found tools directory: ${toolsDir}`);

      const jarPaths: string[] = [];
      for (const jar of requiredJars) {
        const jarPath = path.join(toolsDir, jar);
        if (fs.existsSync(jarPath)) {
          jarPaths.push(jarPath);
          console.log(`[JarLoader] Adding stub JAR: ${jarPath}`);
        } else {
          console.warn(`[JarLoader] Optional stub not found: ${jar}`);
        }
      }

      // Add all JARs to classpath at once
      try {
        console.log(
          `[JarLoader] Loading ${jarPaths.length} stub JARs to classpath`,
        );
        this.java.appendClasspath(jarPaths);
        this.updateContextClassLoader();
        this.stubsLoaded = true;
        console.log('[JarLoader] All stubs loaded via appendClasspath');
        this.diagnoseJSONObject(this.java);
        return;
      } catch (appendErr) {
        console.warn(
          '[JarLoader] appendClasspath failed, trying individual mode:',
          appendErr.message,
        );
        // Fallback: add JARs one by one
        for (const jarPath of jarPaths) {
          try {
            this.java.appendClasspath(jarPath);
            console.log(
              `[JarLoader] Added stub JAR: ${path.basename(jarPath)}`,
            );
          } catch (jarErr) {
            console.error(
              `[JarLoader] Failed to load ${path.basename(jarPath)}:`,
              jarErr,
            );
          }
        }
        this.updateContextClassLoader();
        this.stubsLoaded = true;
        console.log('[JarLoader] All stubs loaded (individual mode)');
        return;
      }
    }

    console.warn(
      '[JarLoader] Required stub JARs not found. JAR spiders may fail to load.',
    );
  }

  private diagnoseJSONObject(java: JavaBridge): void {
    try {
      const JSONObject = java.importClass('org.json.JSONObject');
      const jo = new JSONObject();
      jo.putSync('480', 'a');
      jo.putSync('720', 'b');
      jo.putSync('1080', 'c');
      const keys = jo.keysSync();
      const order: string[] = [];
      while (keys.hasNextSync()) {
        order.push(keys.nextSync());
      }
      console.log(
        '[JarLoader] Diagnostic JSONObject keys order:',
        order.join(', '),
      );
      const cls = jo.getClassSync();
      const loader = cls.getClassLoaderSync();
      console.log(
        '[JarLoader] JSONObject ClassLoader:',
        loader ? loader.toStringSync() : 'null (bootstrap)',
      );
      const codeSource = cls.getProtectionDomainSync().getCodeSourceSync();
      if (codeSource) {
        const location = codeSource.getLocationSync();
        console.log(
          '[JarLoader] JSONObject source JAR:',
          location ? location.toStringSync() : 'unknown',
        );
      }
    } catch (diagErr: any) {
      console.warn(
        '[JarLoader] JSONObject diagnostic failed:',
        diagErr.message,
      );
    }
  }

  /**
   * Check if data is DEX format (Android Dalvik Executable)
   */
  private isDexFile(data: Buffer): boolean {
    // DEX magic: dex\n035\0 or dex\n037\0
    const magic = data.slice(0, 8).toString('ascii');
    return magic.startsWith('dex\n');
  }

  /**
   * Check if data is JAR format (ZIP/JAR magic)
   */
  private isJarFile(data: Buffer): boolean {
    // JAR/ZIP magic: PK (0x50 0x4B)
    return data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b;
  }

  /**
   * Check if JAR file contains DEX classes (classes.dex inside JAR)
   * Some JAR files are just ZIP containers with DEX files inside
   * Uses Node.js binary search instead of shell command for reliability
   */
  private isDexJarSync(jarPath: string): boolean {
    try {
      const content = fs.readFileSync(jarPath);
      // ZIP files store filenames in both local file headers and central directory
      // Search for "classes.dex" string in the binary content
      const marker = Buffer.from('classes.dex', 'ascii');
      for (let i = 0; i <= content.length - marker.length; i++) {
        if (content[i] === marker[0]) {
          let match = true;
          for (let j = 1; j < marker.length; j++) {
            if (content[i + j] !== marker[j]) {
              match = false;
              break;
            }
          }
          if (match) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Extract JAR data from PNG binary content
   * Box Android's getImgJar: search pattern [A-Za-z0]{8}** in raw content
   */
  private extractJdFromBinary(data: Buffer): Buffer {
    // Convert to string to search for pattern
    // Use 'binary' encoding to preserve all byte values 0-255
    const contentStr = data.toString('binary');

    // Pattern: [A-Za-z0]{8}\*\* (8 alphanumeric chars followed by **)
    const pattern = /[A-Za-z0]{8}\*\*/;
    const match = contentStr.match(pattern);

    if (match && match.index !== undefined) {
      console.log(
        '[JarLoader] Found marker:',
        match[0],
        'at position:',
        match.index,
      );

      // Extract content after the marker (marker length is 10)
      const startPos = match.index + 10;
      const b64Part = contentStr.substring(startPos);

      console.log('[JarLoader] Base64 part length:', b64Part.length);
      console.log(
        '[JarLoader] Base64 first 50 chars:',
        b64Part.substring(0, 50),
      );

      // Clean base64 (remove non-base64 characters)
      const cleanB64 = b64Part.replace(/[^A-Za-z0-9+/=]/g, '');
      console.log('[JarLoader] Cleaned base64 length:', cleanB64.length);

      try {
        const jarData = Buffer.from(cleanB64, 'base64');
        console.log('[JarLoader] Decoded JAR size:', jarData.length, 'bytes');
        return jarData;
      } catch (e) {
        console.error('[JarLoader] Base64 decode failed:', e);
      }
    }

    console.warn('[JarLoader] No steganography marker found');
    return Buffer.alloc(0);
  }

  /**
   * Load JAR into JVM using java-bridge
   */
  public async loadJar(
    jarUrl: string,
    md5: string = '',
    useCache: boolean = false,
  ): Promise<boolean> {
    if (!this.java) {
      this.lastError =
        'java-bridge not available. JAR loading requires Java runtime.';
      console.error('[JarLoader]', this.lastError);
      this.emitProgress('error', this.lastError, 0);
      return false;
    }

    console.log('[JarLoader] loadJar called with:', jarUrl);
    this.emitProgress('init', '正在准备加载爬虫...', 5);

    // Parse spider URL format: url;md5;hash (Box Android format)
    // Example: "https://xxx.png;md5;e2693c58ebc58abecc7282b721db79ca/csp_Duopan.js"
    const urls = jarUrl.split(';md5;');
    let actualJarUrl = urls[0];
    const actualMd5 = urls.length > 1 ? urls[1].trim().split('/')[0] : md5; // Extract only MD5 part before /

    console.log('[JarLoader] Actual JAR URL:', actualJarUrl);
    console.log('[JarLoader] Expected MD5:', actualMd5);

    // Check for img+ prefix (explicit PNG steganography marker)
    // OR check if URL ends with .png (implicit PNG steganography)
    const isImgJar =
      actualJarUrl.startsWith('img+') ||
      actualJarUrl.toLowerCase().endsWith('.png');

    actualJarUrl = actualJarUrl.replace('img+', '');

    console.log('[JarLoader] isImgJar:', isImgJar);

    // Generate cache key
    const jarKey = crypto.createHash('md5').update(actualJarUrl).digest('hex');
    this.recentJarKey = jarKey;

    // Cache path
    const cachePath = path.join(this.jarCacheDir, `${jarKey}.jar`);

    // Check if already loaded
    if (this.classLoaders.has(jarKey)) {
      console.log('[JarLoader] JAR already loaded:', jarKey);
      this.lastError = '';
      this.emitProgress('ready', '爬虫已加载', 100);
      return true;
    }

    // Check cache
    if (fs.existsSync(cachePath)) {
      const cachedMd5 = JarLoader.getFileMd5(cachePath);
      if (actualMd5 && cachedMd5.toLowerCase() === actualMd5.toLowerCase()) {
        console.log('[JarLoader] Using cached JAR, MD5 match:', cachePath);
        this.emitProgress('cache', '使用缓存的爬虫文件', 50);
        return await this.loadJarFile(cachePath, jarKey);
      }

      // Cache exists but MD5 not provided - check if file is recent (< 7 days)
      const stat = fs.statSync(cachePath);
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      if (useCache && stat.mtimeMs > weekAgo) {
        console.log('[JarLoader] Using cached JAR (recent):', cachePath);
        this.emitProgress('cache', '使用缓存的爬虫文件', 50);
        return await this.loadJarFile(cachePath, jarKey);
      }
    }

    // Download JAR
    console.log('[JarLoader] Downloading JAR...');
    this.emitProgress('download', '正在下载爬虫文件...', 20);
    const success = await this.downloadJar(actualJarUrl, isImgJar, cachePath);
    if (!success) {
      // Try to use existing cache as fallback
      if (fs.existsSync(cachePath)) {
        console.log(
          '[JarLoader] Download failed, using existing cache:',
          cachePath,
        );
        this.emitProgress('fallback', '下载失败，使用本地缓存', 60);
        return await this.loadJarFile(cachePath, jarKey);
      }
      // lastError is already set by downloadJar
      this.emitProgress('error', this.lastError || '下载失败', 0);
      return false;
    }

    this.emitProgress('downloaded', '下载完成，正在加载...', 70);
    // Load from cache
    return await this.loadJarFile(cachePath, jarKey);
  }

  /**
   * Load JAR file into JVM
   * If file is DEX format, automatically convert to JAR first
   */
  private async loadJarFile(jarPath: string, jarKey: string): Promise<boolean> {
    if (!this.java) {
      this.lastError =
        'java-bridge not available. Please ensure Java JDK is installed.';
      this.emitProgress('error', this.lastError, 0);
      return false;
    }

    try {
      console.log('[JarLoader] Loading JAR file:', jarPath);
      this.emitProgress('loading', '正在加载爬虫文件...', 75);

      // First, check if this is a DEX file (Android Dalvik format)
      const fileContent = fs.readFileSync(jarPath);
      const isDex = this.isDexFile(fileContent);

      let actualJarPath = jarPath;

      if (isDex) {
        console.log('[JarLoader] DEX format detected, converting to JAR...');
        console.log('[JarLoader] DEX file size:', fileContent.length, 'bytes');
        this.emitProgress('convert', '检测到DEX格式，正在转换...', 80);

        // Convert DEX to JAR using DexConverter
        const convertedJarPath = path.join(
          this.jarCacheDir,
          `${jarKey}_converted.jar`,
        );

        try {
          // Initialize dex converter if needed
          if (!dexConverter.isInitialized()) {
            console.log('[JarLoader] Initializing dex2jar tool...');
            this.emitProgress('tool', '正在初始化DEX转换工具...', 30);
            const initSuccess = await dexConverter.initialize();
            if (!initSuccess) {
              this.lastError =
                'Failed to initialize dex2jar tool. Please check internet connection.';
              this.emitProgress('error', this.lastError, 0);
              return false;
            }
          }

          // Perform conversion
          console.log('[JarLoader] Converting DEX to JAR...');
          this.emitProgress('convert', '正在转换DEX为JAR格式...', 85);
          actualJarPath = await dexConverter.convertDexToJar(
            jarPath,
            convertedJarPath,
          );
          console.log('[JarLoader] Conversion successful:', actualJarPath);
          this.emitProgress('converted', '转换完成', 90);
        } catch (convertError: any) {
          this.lastError = `DEX to JAR conversion failed: ${convertError.message}`;
          console.error('[JarLoader]', this.lastError);
          this.emitProgress('error', this.lastError, 0);
          return false;
        }
      } else {
        // Check if JAR contains DEX files inside (classes.dex)
        // Some JAR files are just ZIP containers with DEX inside
        const isDexJar = this.isDexJarSync(jarPath);
        if (isDexJar) {
          console.log(
            '[JarLoader] JAR contains DEX files (classes.dex), converting...',
          );
          this.emitProgress('convert', '检测到Android DEX，正在转换...', 80);

          const convertedJarPath = path.join(
            this.jarCacheDir,
            `${jarKey}_converted.jar`,
          );

          try {
            // Initialize dex converter if needed
            if (!dexConverter.isInitialized()) {
              console.log('[JarLoader] Initializing dex2jar tool...');
              this.emitProgress('tool', '正在初始化DEX转换工具...', 30);
              const initSuccess = await dexConverter.initialize();
              if (!initSuccess) {
                this.lastError =
                  'Failed to initialize dex2jar tool. Please check internet connection.';
                this.emitProgress('error', this.lastError, 0);
                return false;
              }
            }

            // Perform conversion
            console.log('[JarLoader] Converting DEX-JAR to standard JAR...');
            this.emitProgress('convert', '正在转换DEX为JAR格式...', 85);
            actualJarPath = await dexConverter.convertDexToJar(
              jarPath,
              convertedJarPath,
            );
            console.log('[JarLoader] Conversion successful:', actualJarPath);
            this.emitProgress('converted', '转换完成', 90);
          } catch (convertError: any) {
            this.lastError = `DEX-JAR conversion failed: ${convertError.message}`;
            console.error('[JarLoader]', this.lastError);
            this.emitProgress('error', this.lastError, 0);
            return false;
          }
        }
      }

      // Load JAR file (original or converted)
      console.log('[JarLoader] Loading JAR into JVM:', actualJarPath);
      this.emitProgress('jvm', '正在将JAR加载到Java虚拟机...', 92);

      // First, load TVBox Spider API stubs (required by all JAR spiders)
      this.loadSpiderStubs();

      // Use appendClasspath to add JAR to classpath
      this.java.appendClasspath(actualJarPath);

      // Update thread context classloader to the current internal classloader.
      // OkHttp/Kotlin use Thread.currentThread().getContextClassLoader() which
      // may still point to the system classloader after appendClasspath calls.
      this.updateContextClassLoader();

      // Verify the JAR is loadable by trying to import a known class
      try {
        const testClass = this.java.importClass(
          'com.github.catvod.spider.Init',
        );
        if (testClass) {
          console.log('[JarLoader] JAR verified: Init class loadable');
        }
      } catch (verifyErr: any) {
        console.warn(
          '[JarLoader] JAR verification warning:',
          verifyErr.message,
        );
        // If we loaded a DEX-containing JAR, the classes won't be loadable
        // Check if we need to convert
        if (this.isDexJarSync(actualJarPath)) {
          console.error(
            '[JarLoader] Loaded JAR contains DEX but classes are not loadable. Attempting conversion...',
          );
          const convertedJarPath = path.join(
            this.jarCacheDir,
            `${jarKey}_converted.jar`,
          );
          try {
            if (!dexConverter.isInitialized()) {
              await dexConverter.initialize();
            }
            actualJarPath = await dexConverter.convertDexToJar(
              actualJarPath,
              convertedJarPath,
            );
            this.java.appendClasspath(actualJarPath);
            console.log(
              '[JarLoader] Fallback conversion successful:',
              actualJarPath,
            );
          } catch (fallbackErr: any) {
            this.lastError = `Fallback DEX conversion failed: ${fallbackErr.message}`;
            console.error('[JarLoader]', this.lastError);
          }
        }
      }

      // Mark as loaded
      this.classLoaders.set(jarKey, true);
      this.lastError = '';
      console.log('[JarLoader] JAR added to classpath:', jarKey);
      this.emitProgress('ready', '爬虫加载完成', 100);

      // Call Init.init(Application) - Box Android pattern
      // The Init class stores the application Context in its static field 'c'
      // for spiders to access via Init.context(). The field type is android.app.Application.
      //
      // Java-bridge cannot reliably create Application instances (the proxy is
      // typed as the imported class, not its superclass), so we use a more
      // direct approach: create an Application, set it as the static 'c' field
      // via reflection through java-bridge.
      try {
        const initClass = this.java.importClass(
          'com.github.catvod.spider.Init',
        );
        const ApplicationClass = this.java.importClass(
          'android.app.Application',
        );
        const app = new ApplicationClass();
        // Set Init's static 'c' field directly to bypass Application type check
        try {
          initClass.c = app;
        } catch (_) {
          /* field may not be accessible */
        }
        // Also call Init.init() for any side effects
        try {
          if (typeof initClass.initSync === 'function') {
            initClass.initSync(app);
          } else if (typeof initClass.init === 'function') {
            initClass.init(app);
          }
        } catch (_) {
          /* may fail but the field is set */
        }
        console.log("[JarLoader] Init's 'c' field set to Application instance");
      } catch (initErr: any) {
        console.warn('[JarLoader] Init setup failed:', initErr.message);
      }

      return true;
    } catch (e: any) {
      this.lastError = `Failed to load JAR file: ${e.message || e}`;
      console.error('[JarLoader]', this.lastError);
      this.emitProgress('error', this.lastError, 0);
      return false;
    }
  }

  /**
   * Detect if a class name refers to a WexGuard spider.
   * Guard spiders inherit BaseSpiderGuard which delegates to a real spider
   * loaded via ARM native lib (wexguard_v8.so). On Windows JVM we instead
   * load the pre-decrypted spider JAR (wexguard-spider-enjarify.jar) and
   * instantiate the inner spider class directly (without the Guard suffix).
   */
  private isGuardSpiderClassName(clsKey: string): boolean {
    return clsKey.endsWith('Guard');
  }

  /**
   * Check if the spider's actual class (not inherited) declares an override
   * of the single-param init(Context) method. True Guard spiders (NewWogg,
   * NewJuTou, etc.) override init(Context) to read siteconfig. Other classes
   * that just happen to have a "Guard" suffix in their API name (Bili,
   * NewDouBan, WexYiYs, etc.) only declare init(Context, String) — calling
   * the inherited single-param init(Context) invokes the empty base-class
   * no-op and leaves the spider's fields uninitialized, causing
   * NullPointerException in homeContent.
   *
   * Uses Java reflection: getDeclaredMethods() returns only methods declared
   * directly on the class (not inherited). We iterate the array looking for
   * a method named "init" with exactly one parameter of type
   * android.content.Context. (Cannot use getDeclaredMethod(name, Class[])
   * because java-bridge cannot auto-convert a JS array to a
   * java.lang.Class[] parameter.)
   */
  private hasInitContextOverride(spider: JavaObject): boolean {
    try {
      const spiderClass = spider.getClassSync
        ? spider.getClassSync()
        : spider.getClass();
      const spiderClassName = spiderClass.getNameSync
        ? spiderClass.getNameSync()
        : spiderClass.getName();
      // Use getDeclaredMethods() (no-args, returns Method[]) instead of
      // getDeclaredMethod(name, Class[]) because java-bridge cannot
      // auto-convert a JS array to a java.lang.Class[] parameter.
      const methods = spiderClass.getDeclaredMethodsSync
        ? spiderClass.getDeclaredMethodsSync()
        : spiderClass.getDeclaredMethods();
      for (let i = 0; i < methods.length; i++) {
        const m = methods[i];
        const name = m.getNameSync ? m.getNameSync() : m.getName();
        if (name !== 'init') continue;
        const paramTypes = m.getParameterTypesSync
          ? m.getParameterTypesSync()
          : m.getParameterTypes();
        if (paramTypes.length !== 1) continue;
        const paramTypeName = paramTypes[0].getNameSync
          ? paramTypes[0].getNameSync()
          : paramTypes[0].getName();
        if (paramTypeName === 'android.content.Context') {
          console.log(
            '[JarLoader] hasInitContextOverride:',
            spiderClassName,
            '-> TRUE (init(Context) declared)',
          );
          return true;
        }
      }
      console.log(
        '[JarLoader] hasInitContextOverride:',
        spiderClassName,
        '-> FALSE (no init(Context) override; methods:',
        methods.length,
        ')',
      );
      return false;
    } catch (e: any) {
      console.log(
        '[JarLoader] hasInitContextOverride: outer error ->',
        e?.message || e,
      );
      return false;
    }
  }

  /**
   * Load the pre-decrypted WexGuard spider JAR into the JVM and initialize
   * InitOrigin (the Init class used by decrypted spider classes).
   *
   * The JAR lives at tools/wexguard_work/wexguard-spider-enjarify.jar and
   * is produced by:
   *   1. unidbg decrypting wexguard_v8.so + wexshinidie.guard -> classes.dex
   *   2. enjarify converting classes.dex -> JVM JAR
   *   3. ASM patcher fixing TypeToken raw type fallback to LinkedHashMap
   *
   * Idempotent: only loads once per process.
   */
  /**
   * Kick off Guard spider JAR loading in the background.
   * Called during app startup so the heavy InitOrigin.init() (which downloads
   * native libraries over the network) completes before the user selects a
   * Guard spider source. getSpider() will await this promise if still running.
   */
  public preloadGuardSpiderJar(): void {
    if (this.guardSpiderJarPromise) {
      return; // Already started
    }
    console.log('[JarLoader] Pre-loading Guard spider JAR in background...');
    this.guardSpiderJarPromise = this.loadGuardSpiderJar().catch((e) => {
      console.warn(
        '[JarLoader] Background Guard spider JAR preload failed:',
        e?.message || e,
      );
      return false;
    });
  }

  private async loadGuardSpiderJar(): Promise<boolean> {
    if (!this.java) return false;
    if (this.classLoaders.has('wexguard-spider')) {
      return true;
    }

    const candidatePaths = [
      path.join(
        process.cwd(),
        'tools',
        'wexguard_work',
        'wexguard-spider-enjarify.jar',
      ),
      path.join(
        path.dirname(process.cwd()),
        'tools',
        'wexguard_work',
        'wexguard-spider-enjarify.jar',
      ),
      path.join(
        __dirname,
        'tools',
        'wexguard_work',
        'wexguard-spider-enjarify.jar',
      ),
      path.join(
        process.resourcesPath || '',
        'tools',
        'wexguard_work',
        'wexguard-spider-enjarify.jar',
      ),
    ];

    const jarPath = candidatePaths.find((p) => fs.existsSync(p));
    if (!jarPath) {
      this.lastError =
        'wexguard-spider-enjarify.jar not found. Run unidbg decryption + enjarify + ASM patcher first.';
      console.error('[JarLoader]', this.lastError);
      return false;
    }

    try {
      console.log('[JarLoader] Loading WexGuard spider JAR:', jarPath);
      this.java.appendClasspath(jarPath);
      this.updateContextClassLoader();

      // Initialize InitOrigin: set its singleton Application field directly
      // to bypass the chicken-and-egg problem where InitOrigin.init() calls
      // checkPermission() -> context() before context is set.
      try {
        const InitOrigin = this.java.importClass(
          'com.github.catvod.spider.InitOrigin',
        );
        const ApplicationClass = this.java.importClass(
          'android.app.Application',
        );
        const app = new ApplicationClass();
        // Use async variant (libuv worker thread) to avoid blocking the main thread
        const instance = await InitOrigin.get();
        try {
          instance.oOoOoOo0oOo0o0oO = app;
          console.log(
            '[JarLoader] InitOrigin.oOoOoOo0oOo0o0oO field set to stub Application',
          );
        } catch (fieldErr: any) {
          console.warn(
            '[JarLoader] InitOrigin direct field set failed:',
            fieldErr.message,
          );
        }

        // Verify context
        const ctx = await InitOrigin.context();
        console.log('[JarLoader] InitOrigin.context() =', ctx ? 'OK' : 'null');

        // Verify targetSdkVersion from stub PackageManager
        // This is critical to avoid infinite recursion in InitOrigin.checkPermission()
        // which checks: if (targetSdkVersion <= 28) { checkPermission(); } - recursion!
        try {
          const pm = await ctx.getPackageManager();
          const packageName = await ctx.getPackageName();
          const pkgInfo = await pm.getPackageInfo(packageName, 0);
          const appInfo = pkgInfo.applicationInfo;
          const targetSdk = appInfo.targetSdkVersion;
          console.log(
            '[JarLoader] Stub targetSdkVersion =',
            targetSdk,
            '(must be > 28 to avoid recursion)',
          );
          if (targetSdk <= 28) {
            console.error(
              '[JarLoader] ERROR: targetSdkVersion <= 28 will cause infinite recursion!',
            );
          }
        } catch (verifyErr: any) {
          console.warn(
            '[JarLoader] Could not verify targetSdkVersion:',
            verifyErr.message,
          );
        }

        // Call InitOrigin.init() to download native libraries (libLoadNiMa.so, etc)
        // These ARM .so files are needed by unidbg to decrypt API responses.
        // Previously skipped to avoid StackOverflowError in checkPermission(),
        // but now stub ApplicationInfo.targetSdkVersion = 30, so it should work.
        try {
          console.log(
            '[JarLoader] Calling InitOrigin.init() to download native libs...',
          );
          const InitOrigin2 = this.java.importClass(
            'com.github.catvod.spider.InitOrigin',
          );

          // Use async variant to avoid blocking the main thread during network I/O
          await InitOrigin2.init(app);
          console.log('[JarLoader] InitOrigin.init() completed successfully');

          // Verify libLoadNiMa.so was downloaded
          await this.verifyAndDownloadLibLoadNiMa();
        } catch (initCallErr: any) {
          console.warn(
            '[JarLoader] InitOrigin.init() call failed:',
            initCallErr?.message || initCallErr,
          );
          // If init fails, try to manually download the native library
          await this.verifyAndDownloadLibLoadNiMa();
        }
      } catch (initErr: any) {
        console.warn('[JarLoader] InitOrigin setup failed:', initErr.message);
      }

      // Initialize ProxyOrigin so spider's AsyncTask can resolve the local
      // proxy port (used to build URLs like http://127.0.0.1:<port>/platform).
      // Without this, ProxyOrigin.getPort() returns 0 and OkHttp throws
      // "Invalid URL port: 0" inside detailContent's PlayUrlBuilder.
      //
      // ProxyOrigin.init() falls into findPort() which probes ports 8964-9999
      // and picks the FIRST responsive one. If another process (e.g. a stale
      // app instance, or a different service) responds to /proxy?do=ck on a
      // lower port, findPort() picks that wrong port → spider connects to the
      // wrong server → "Failed to connect" errors during detailContent.
      //
      // Fix: directly set the port field to ProxyServer's actual port BEFORE
      // calling init(). findPort() checks `if (n <= 0)` and skips probing
      // when the field is already set.
      try {
        const ProxyOrigin = this.java.importClass(
          'com.github.catvod.spider.ProxyOrigin',
        );
        const actualPort = proxyServer.getPort();
        if (actualPort > 0) {
          ProxyOrigin.oOo0oOo0Oo0oO0Oo = actualPort;
          console.log(
            '[JarLoader] ProxyOrigin port pre-set to ProxyServer port:',
            actualPort,
          );
        }
        // Use async variants to avoid blocking the main thread
        await ProxyOrigin.init();
        const port = await ProxyOrigin.getPort();
        console.log('[JarLoader] ProxyOrigin initialized, port:', port);
        if (actualPort > 0 && port !== actualPort) {
          console.warn(
            '[JarLoader] ProxyOrigin port mismatch! init() overrode to',
            port,
            'expected',
            actualPort,
            '— forcing back',
          );
          ProxyOrigin.oOo0oOo0Oo0oO0Oo = actualPort;
        }
      } catch (proxyErr: any) {
        console.warn('[JarLoader] ProxyOrigin init failed:', proxyErr.message);
      }

      this.classLoaders.set('wexguard-spider', true);
      console.log('[JarLoader] WexGuard spider JAR loaded');

      // Warm up: force-load the big utility class whose static initializer
      // performs expensive setup (network client init, handler setup, etc.).
      // If we let this happen on first user click, the 5s RxJava timeout
      // may fire before class init completes, returning empty detail data.
      try {
        const warmupCls = this.java.importClass(
          'com.github.catvod.spider.merge.OoOo0OoOo0oO0O0O.oOoO0Oo0OoOoOoOo',
        );
        console.log(
          '[JarLoader] Guard spider warm-up class loaded:',
          !!warmupCls,
        );
      } catch (warmupErr: any) {
        console.warn(
          '[JarLoader] Guard spider warm-up failed (non-critical):',
          warmupErr.message,
        );
      }

      return true;
    } catch (e: any) {
      this.lastError = `Failed to load WexGuard spider JAR: ${e.message || e}`;
      console.error('[JarLoader]', this.lastError);
      return false;
    }
  }

  /**
   * Get Spider instance from JAR
   * className format: "csp_Duopan" -> JAR class: "com.github.catvod.spider.Duopan"
   */
  public async getSpider(
    key: string,
    className: string,
    ext: string,
    jarUrl: string = '',
  ): Promise<boolean> {
    if (!this.java) {
      this.lastError = 'java-bridge not available';
      console.error('[JarLoader]', this.lastError);
      return false;
    }

    // Check cache
    if (this.spiders.has(key)) {
      console.log('[JarLoader] Spider cached:', key);
      return true;
    }

    // Parse class name: remove "csp_" prefix
    const clsKey = className.replace('csp_', '');
    const isGuard = this.isGuardSpiderClassName(clsKey);
    // For Guard spiders, strip the "Guard" suffix to get the real spider class
    // (e.g. NewDouBanGuard -> NewDouBan). The real class lives in the
    // pre-decrypted wexguard-spider-enjarify.jar, not the outer JAR.
    const realClsKey = isGuard ? clsKey.slice(0, -'Guard'.length) : clsKey;
    const fullClassName = `com.github.catvod.spider.${realClsKey}`;

    // Determine JAR key
    let jarKey = 'main';
    if (jarUrl) {
      const urls = jarUrl.split(';md5;');
      jarKey = crypto.createHash('md5').update(urls[0]).digest('hex');
    }

    this.recentJarKey = jarKey;

    // Guard spiders don't need the outer JAR - they use the pre-decrypted JAR
    if (isGuard) {
      console.log(
        `[JarLoader] Guard spider detected: ${clsKey} -> real class ${realClsKey}`,
      );
      // Use the pre-loaded promise if available (started at app startup).
      // If preload wasn't started (e.g. a Guard spider clicked before app
      // finished initializing), fall back to loading inline. Either way the
      // heavy Java calls use async variants that run on libuv worker threads,
      // so the Node.js event loop (and thus the Electron main window) stays
      // responsive.
      let guardOk: boolean;
      if (this.guardSpiderJarPromise) {
        console.log('[JarLoader] Awaiting pre-loaded Guard spider JAR promise');
        guardOk = await this.guardSpiderJarPromise;
      } else {
        console.log(
          '[JarLoader] No preload found, loading Guard spider JAR inline',
        );
        guardOk = await this.loadGuardSpiderJar();
      }
      if (!guardOk) {
        return false;
      }
    } else {
      // Check if JAR is loaded
      if (!this.classLoaders.has(jarKey)) {
        this.lastError = `JAR not loaded for spider: ${key} (jarKey: ${jarKey}). The JAR file may not have been downloaded or converted properly.`;
        console.warn('[JarLoader]', this.lastError);
        return false;
      }
    }

    // Source isolation: setup per-source handling (download native libs, etc.)
    // This is called AFTER loadGuardSpiderJar() to ensure InitOrigin.init() has run
    // and libLoadNiMa.so has been downloaded. Each source's modifications are isolated.
    await this.setupSourceSpecificHandling(clsKey, jarUrl);

    try {
      console.log('[JarLoader] Loading spider class:', fullClassName);

      console.log(
        '[JarLoader] Current classpath entries:',
        this.java.classpath.get().length,
      );

      let stubsAccessible = false;
      try {
        const ViewGroupClass = this.java.importClass('android.view.ViewGroup');
        console.log(
          '[JarLoader] ViewGroup class is accessible:',
          !!ViewGroupClass,
        );
        stubsAccessible = true;
      } catch (viewGroupErr) {
        console.error(
          '[JarLoader] ViewGroup class NOT accessible:',
          viewGroupErr.message,
        );
        console.error(
          '[JarLoader] This indicates stubs are NOT on the classpath',
        );
      }

      if (!stubsAccessible) {
        console.warn(
          '[JarLoader] Stubs not accessible, attempting to reload stubs...',
        );
        this.stubsLoaded = false;
        this.loadSpiderStubs();

        try {
          const ViewGroupClass = this.java.importClass(
            'android.view.ViewGroup',
          );
          console.log(
            '[JarLoader] ViewGroup class now accessible after reload:',
            !!ViewGroupClass,
          );
        } catch (retryErr) {
          console.error(
            '[JarLoader] Failed to reload stubs, ViewGroup still not accessible:',
            retryErr.message,
          );
          this.lastError = `Android stub classes not found in classpath. Cannot load spider ${key}.`;
          return false;
        }
      }

      const SpiderClass = this.java.importClass(fullClassName);
      if (!SpiderClass) {
        this.lastError = `Spider class not found: ${fullClassName}. The JAR may not contain this class or may not have been converted from DEX format.`;
        console.error('[JarLoader]', this.lastError);
        return false;
      }

      const spider = new SpiderClass();

      this.spiders.set(key, {
        spider,
        className: fullClassName,
        ext,
        isGuard,
        initPromise: null,
      });

      console.log(
        '[JarLoader] Spider loaded:',
        key,
        'class:',
        fullClassName,
        'ext:',
        ext.substring(0, 50),
      );
      return true;
    } catch (e: any) {
      this.lastError = `Failed to load spider ${key}: ${e.message || e}. The JAR may need DEX-to-JAR conversion.`;
      console.error('[JarLoader]', this.lastError);

      if (e.message && e.message.includes('android.view.ViewGroup')) {
        console.error(
          '[JarLoader] ERROR: android.view.ViewGroup not found in classpath',
        );
        console.error(
          '[JarLoader] Current classpath:',
          this.java.classpath.get(),
        );
        console.error(
          '[JarLoader] Ensure tvbox-spider-stubs-complete.jar is in the classpath',
        );
      }

      return false;
    }
  }

  /**
   * Translate Guard spider's obfuscated JSON output to standard TVBox format.
   *
   * Guard spiders (decrypted from WexGuard) serialize result objects via Gson
   * with obfuscated field names. This translator remaps them to the standard
   * fields the renderer expects (vod_id, vod_name, vod_pic, class, list, etc.).
   *
   * Field mapping (discovered via inspect_guard_output.cjs):
   * Top-level:
   *   oOo0oOo0Oo0oO0Oo (Array)  -> list       (video list)
   *   oOoOoOoOoOoOoO0o (Array)  -> class      (category list)
   *   oOoOoOo0oOo0o0oO (Object) -> filters    (filter config by category)
   *   OoOo0oOoO0Oo0Oo0          -> total      (categoryContent, total items)
   *   oOoOo0O0Oo0O0o0o          -> pagecount  (categoryContent, total pages)
   *   OoOoO0o0oO0O0O0O          -> limit      (categoryContent, max per page)
   *   OoOoOo0O0Oo0o0oO          -> page       (categoryContent, current page)
   * Video object:
   *   oOo0oOo0Oo0oO0Oo -> vod_id
   *   oOoO0o0oOo0oO0Oo -> vod_remarks
   *   oOoOoOo0O0O0oO0o -> vod_pic
   *   oOoOoOo0oOo0o0oO -> vod_name
   * Category object:
   *   oOo0oOo0Oo0oO0Oo -> type_name
   *   oOoOoOoOoOoOoO0o -> type_id
   *
   * Only translates methods that return JSON content (homeContent,
   * homeVideoContent, categoryContent, searchContent, detailContent).
   */
  private translateGuardOutput(jsonStr: string, method: string): string {
    if (!jsonStr || jsonStr.length < 2) return jsonStr;
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return jsonStr; // Not JSON, return as-is
    }
    if (typeof parsed !== 'object' || parsed === null) return jsonStr;

    // For detailContent, log the FULL raw spider response so we can compare
    // with Android's output and diagnose missing/incorrect episode data.
    if (method === 'detailContent') {
      console.log(
        '[JarLoader] ========== detailContent RAW spider response (FULL) ==========',
      );
      console.log(jsonStr);
      console.log(
        '[JarLoader] ========== detailContent RAW spider response END ==========',
      );
    }

    // Detect Guard spider output by checking for obfuscated field names.
    // All Guard spiders use fields starting with "oOo" or "OoO" patterns.
    const keys = Object.keys(parsed);
    const hasObfuscated = keys.some(
      (k) =>
        (/^[oO]{1,3}[oO0-9]+$/.test(k) && k.length > 10) ||
        k === 'oOo0oOo0Oo0oO0Oo' ||
        k === 'oOoOoOoOoOoOoO0o' ||
        k === 'oOoOoOo0oOo0o0oO',
    );
    if (!hasObfuscated) return jsonStr;

    const translateVideo = (v: any): any => {
      if (!v || typeof v !== 'object') return v;
      // For detailContent, log ALL raw field names so we can see which
      // obfuscated fields the spider actually returned (vod_play_url and
      // vod_play_from are only present when pan login is configured; if
      // they're missing, the renderer can't show episode list / play).
      if (method === 'detailContent') {
        console.log(
          '[JarLoader] translateVideo(detailContent) raw fields:',
          Object.keys(v).sort().join(','),
        );
      }
      const out: Record<string, any> = {};
      // Field mapping verified empirically via verify_translation.cjs against
      // raw NewZhiZhen detailContent output. The Guard serializer transforms
      // some Java field names (e.g. vod_id field oOo0oOo0Oo0oO0Oo -> oOoOo0o0Oo0oO0Oo).
      if (v.oOoOo0o0Oo0oO0Oo !== undefined) out.vod_id = v.oOoOo0o0Oo0oO0Oo;
      else if (v.oOo0oOo0Oo0oO0Oo !== undefined)
        out.vod_id = v.oOo0oOo0Oo0oO0Oo;
      if (v.oOoO0o0oOo0oO0Oo !== undefined)
        out.vod_remarks = v.oOoO0o0oOo0oO0Oo;
      if (v.oOoOoOo0O0O0oO0o !== undefined) out.vod_pic = v.oOoOoOo0O0O0oO0o;
      if (v.oOoOoOo0oOo0o0oO !== undefined) out.vod_name = v.oOoOoOo0oOo0o0oO;
      // detailContent extra metadata fields (verified against decompiled Vod class)
      if (v.OoOo0oO0o0o0oOo0 !== undefined)
        out.vod_director = v.OoOo0oO0o0o0oOo0;
      if (v.OoOoO0O0o0oOoO0O !== undefined) out.vod_actor = v.OoOoO0O0o0oOoO0O;
      if (v.OoOoOo0O0o0oO0o0 !== undefined) out.vod_year = v.OoOoOo0O0o0oO0o0;
      if (v.oOoOo0o0O0O0Oo0 !== undefined) out.vod_content = v.oOoOo0o0O0O0Oo0;
      if (v.oOoOo0O0Oo0o0OoO !== undefined) out.vod_area = v.oOoOo0O0Oo0o0OoO;
      if (v.oOoOoOoOoOoOoO0o !== undefined) out.vod_class = v.oOoOoOoOoOoOoO0o;
      // vod_play_from / vod_play_url: only present when pan login is configured.
      // When the spider sets these, they appear under EITHER standard key names
      // OR obfuscated names (depending on spider implementation):
      // - oOoO0OoO0oOo0oOo → vod_play_from (line names like "蓝光HDR$$$蓝光1080P")
      // - oOoOoO0oOoO0OoOo → vod_play_url (episode URLs)
      // Some Guard spiders (WexHanXiaoQuan) use obfuscated names; others (NewWogg)
      // use standard names. Map both.
      if (v.vod_play_from !== undefined) out.vod_play_from = v.vod_play_from;
      if (v.oOoO0OoO0oOo0oOo !== undefined)
        out.vod_play_from = v.oOoO0OoO0oOo0oOo;
      if (v.vod_play_url !== undefined) out.vod_play_url = v.vod_play_url;
      if (v.oOoOoO0oOoO0OoOo !== undefined)
        out.vod_play_url = v.oOoOoO0oOoO0OoOo;
      // Copy any other non-obfuscated fields verbatim
      for (const [k, val] of Object.entries(v)) {
        if (!(k in out) && !/^[oO]{1,3}[oO0-9]{10,}$/.test(k)) {
          out[k] = val;
        }
      }
      if (method === 'detailContent') {
        console.log(
          '[JarLoader] translateVideo(detailContent): vod_name=',
          out.vod_name,
          'vod_director=',
          out.vod_director,
          'vod_actor=',
          out.vod_actor,
        );
        console.log(
          '[JarLoader] translateVideo(detailContent) vod_play_from (FULL)=',
          out.vod_play_from,
        );
        console.log(
          '[JarLoader] translateVideo(detailContent) vod_play_url (FULL)=',
          out.vod_play_url,
        );
      }
      return out;
    };

    const translateCategory = (c: any): any => {
      if (!c || typeof c !== 'object') return c;
      const out: Record<string, any> = {};
      if (c.oOo0oOo0Oo0oO0Oo !== undefined) out.type_name = c.oOo0oOo0Oo0oO0Oo;
      if (c.oOoOoOoOoOoOoO0o !== undefined) out.type_id = c.oOoOoOoOoOoOoO0o;
      for (const [k, val] of Object.entries(c)) {
        if (!(k in out) && !/^[oO]{1,3}[oO0-9]{10,}$/.test(k)) {
          out[k] = val;
        }
      }
      return out;
    };

    const result: Record<string, any> = {};

    // Video list (top-level oOo0oOo0Oo0oO0Oo Array)
    if (Array.isArray(parsed.oOo0oOo0Oo0oO0Oo)) {
      result.list = parsed.oOo0oOo0Oo0oO0Oo.map(translateVideo);
    }
    // Category list (top-level oOoOoOoOoOoOoO0o Array)
    if (Array.isArray(parsed.oOoOoOoOoOoOoO0o)) {
      result.class = parsed.oOoOoOoOoOoOoO0o.map(translateCategory);
    }
    // Filters (top-level oOoOoOo0oOo0o0oO Object)
    if (
      parsed.oOoOoOo0oOo0o0oO &&
      typeof parsed.oOoOoOo0oOo0o0oO === 'object'
    ) {
      result.filters = parsed.oOoOoOo0oOo0o0oO;
    }
    // Pagination fields (categoryContent). Guard spiders emit TWO sets:
    //   OoOo0oOoO0Oo0Oo0 (10630) = total item count
    //   oOoOo0O0Oo0O0o0o (72)    = pagecount (total pages)
    //   OoOoO0o0oO0O0O0O (148)   = limit (max items per page)
    //   OoOoOo0O0Oo0o0oO (1)     = page (current page)
    if (parsed.OoOo0oOoO0Oo0Oo0 !== undefined)
      result.total = parsed.OoOo0oOoO0Oo0Oo0;
    if (parsed.oOoOo0O0Oo0O0o0o !== undefined)
      result.pagecount = parsed.oOoOo0O0Oo0O0o0o;
    if (parsed.OoOoO0o0oO0O0O0O !== undefined)
      result.limit = parsed.OoOoO0o0oO0O0O0O;
    if (parsed.OoOoOo0O0Oo0o0oO !== undefined)
      result.page = parsed.OoOoOo0O0Oo0o0oO;

    // If nothing was translated, return original
    if (Object.keys(result).length === 0) return jsonStr;

    // Preserve any non-obfuscated fields from the original
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in result) && !/^[oO]{1,3}[oO0-9]{10,}$/.test(k)) {
        result[k] = v;
      }
    }

    console.log(
      `[JarLoader] translateGuardOutput(${method}):`,
      `list=${result.list?.length || 0},`,
      `class=${result.class?.length || 0},`,
      `filters=${result.filters ? Object.keys(result.filters).length : 0},`,
      `page=${result.page}, pagecount=${result.pagecount}`,
    );

    // For detailContent, log the FULL translated result so we can compare
    // with Android's output and see what the renderer receives.
    if (method === 'detailContent' && result.list?.length > 0) {
      const vod = result.list[0];
      console.log(
        '[JarLoader] ========== detailContent TRANSLATED result (FULL) ==========',
      );
      console.log(
        JSON.stringify({
          vod_name: vod.vod_name,
          vod_play_from: vod.vod_play_from,
          vod_play_url: vod.vod_play_url,
          vod_director: vod.vod_director,
          vod_actor: vod.vod_actor,
          vod_pic: vod.vod_pic,
          vod_remarks: vod.vod_remarks,
          vod_year: vod.vod_year,
          vod_area: vod.vod_area,
          vod_class: vod.vod_class,
          vod_content: vod.vod_content,
        }),
      );
      console.log(
        '[JarLoader] ========== detailContent TRANSLATED result END ==========',
      );
    }

    return JSON.stringify(result);
  }

  /**
   * Translate playerContent response: rename obfuscated URL/header fields
   * to standard "url"/"header" and rewrite the spider's GoProxy URL to
   * point at our local ProxyServer.
   *
   * The spider's playerContent returns JSON like:
   *   {"OoOoOi0o0o0oOo0":"http://127.0.0.1:8096/kaiser?url=<encoded>",
   *    "<headerField>":{"Referer":"...","User-Agent":"..."}}
   *
   * GoProxy (libwexproxy.so) is a native ARM binary that can't load on
   * Windows. We rewrite the URL to:
   *   http://127.0.0.1:<proxyPort>/proxy?do=<panType>Direct&url=<encoded>
   * which our streamPanDirect handler serves with the same Cookie/Referer/UA.
   */
  private translatePlayerContent(jsonStr: string, flag: string): string {
    if (!jsonStr || jsonStr.length < 2) return jsonStr;
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return jsonStr;
    }
    if (typeof parsed !== 'object' || parsed === null) return jsonStr;

    // If "url" already exists, just rewrite it (non-Guard spider path).
    if (typeof parsed.url === 'string') {
      parsed.url = this.rewriteGoProxyUrl(parsed.url, flag);
      if (parsed.header && typeof parsed.header === 'object') {
        parsed.header = JSON.stringify(parsed.header);
      }
      return JSON.stringify(parsed);
    }

    // Find the obfuscated URL field. Prefer real video URLs (https:// or
    // non-localhost http://) over local proxy URLs (http://127.0.0.1:...).
    // Some Guard spiders (WexGuaZi) return BOTH a video URL (https://...m3u8)
    // and a danmu proxy URL (http://127.0.0.1:0/proxy?do=autodanmu). Picking
    // the proxy URL causes playback failure (invalid port, wrong endpoint).
    let urlField: string | null = null;
    let urlValue = '';
    let proxyUrlField: string | null = null;
    let proxyUrlValue = '';
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string' || v.length <= 20) continue;
      // Real video URL: https:// or non-localhost http://
      if (
        v.startsWith('https://') ||
        (v.startsWith('http://') &&
          !v.startsWith('http://127.0.0.1') &&
          !v.startsWith('http://localhost'))
      ) {
        urlField = k;
        urlValue = v;
        break;
      }
      // Local proxy URL — save as fallback (for GoProxy compatibility)
      if (v.startsWith('http://') && !proxyUrlField) {
        proxyUrlField = k;
        proxyUrlValue = v;
      }
    }
    // Fall back to proxy URL if no real video URL found
    if (!urlField && proxyUrlField) {
      urlField = proxyUrlField;
      urlValue = proxyUrlValue;
    }
    if (!urlField) return jsonStr;

    // Find the obfuscated headers field: could be an object OR a JSON string.
    // Some Guard spiders (WexHanXiaoQuan) return header as JSON string:
    //   "oOoOoOo0O0O0oO0o":"{\"User-Agent\":\"tdc.8260\"}"
    let headerField: string | null = null;
    let headerValue: any = null;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === urlField) continue;
      // Case 1: header is already an object
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        headerField = k;
        headerValue = v;
        break;
      }
      // Case 2: header is a JSON string containing header keys
      if (
        typeof v === 'string' &&
        v.startsWith('{') &&
        v.includes('User-Agent')
      ) {
        try {
          const parsedHeader = JSON.parse(v);
          if (
            typeof parsedHeader === 'object' &&
            !Array.isArray(parsedHeader)
          ) {
            headerField = k;
            headerValue = parsedHeader;
            break;
          }
        } catch {}
      }
    }

    const out: Record<string, any> = {};
    let rewrittenUrl = this.rewriteGoProxyUrl(urlValue, flag);
    // If spider provided custom headers, encode them into the URL — but ONLY
    // for proxy URLs (containing /proxy?do=). For direct video URLs (e.g.
    // https://vd.wmvbo.com/.../index.m3u8), appending &header= would be a
    // spurious query parameter that the CDN may reject. The renderer reads
    // out.header separately for direct URLs.
    if (headerField && headerValue) {
      out.header = JSON.stringify(headerValue);
      if (
        rewrittenUrl.includes('/proxy?do=') &&
        !rewrittenUrl.includes('header=')
      ) {
        const encodedHeader = encodeURIComponent(out.header);
        rewrittenUrl = rewrittenUrl + '&header=' + encodedHeader;
      } else if (!rewrittenUrl.includes('/proxy?do=')) {
        // Direct video URL (not proxied): rewrite to route through our
        // /m3u8.m3u8 proxy endpoint. Node.js makes the upstream request with
        // the spider-provided headers (User-Agent, Referer) — avoiding the
        // browser's forbidden-header restrictions AND Chromium's TLS
        // fingerprinting (which CDNs use to detect third-party access even
        // when headers are spoofed). The proxy also rewrites the m3u8
        // manifest to route TS segments through itself.
        const proxyPort = proxyServer.getPort();
        if (proxyPort > 0) {
          const encodedUrl = encodeURIComponent(rewrittenUrl);
          const encodedHeader = encodeURIComponent(out.header);
          rewrittenUrl = `http://127.0.0.1:${proxyPort}/m3u8.m3u8?url=${encodedUrl}&header=${encodedHeader}`;
          console.log(
            '[JarLoader] Rewrote direct video URL to proxy:',
            rewrittenUrl.substring(0, 120),
          );
        } else {
          // Fallback: register headers for webRequest injection (less
          // reliable — CDN may still detect browser TLS fingerprint)
          this.registerVideoUrlHeaders(rewrittenUrl, headerValue);
        }
      }
    }
    out.url = rewrittenUrl;
    // Preserve any non-obfuscated fields verbatim.
    for (const [k, v] of Object.entries(parsed)) {
      if (k === urlField || k === headerField) continue;
      if (/^[oO]{1,3}[oO0-9iI]{10,}$/.test(k)) continue;
      out[k] = v;
    }

    console.log(
      `[JarLoader] translatePlayerContent: urlField=${urlField}, headerField=${headerField || 'none'}, headerValue=${headerValue ? JSON.stringify(headerValue) : 'none'}, originalUrl=${urlValue.substring(0, 80)}..., rewrittenUrl=${out.url.substring(0, 80)}...`,
    );

    return JSON.stringify(out);
  }

  /**
   * Register custom headers for a direct video URL. The webRequest
   * interceptor in main.ts calls getVideoHeadersForUrl() to inject these
   * headers on requests to the video's origin (covers both m3u8 manifest
   * and TS segments which share the same origin).
   */
  private registerVideoUrlHeaders(
    url: string,
    headers: Record<string, string>,
  ): void {
    try {
      const parsed = new URL(url);
      const origin = `${parsed.protocol}//${parsed.host}`;
      console.log(
        `[JarLoader] Registering video headers for origin: ${origin}`,
        Object.keys(headers),
      );
      this.videoUrlHeaders.set(origin, headers);
    } catch {
      // Not a valid URL — skip registration
    }
  }

  /**
   * Get custom headers for a video URL, if any were registered.
   * Called by the webRequest interceptor in main.ts.
   */
  public getVideoHeadersForUrl(url: string): Record<string, string> | null {
    try {
      const parsed = new URL(url);
      const origin = `${parsed.protocol}//${parsed.host}`;
      return this.videoUrlHeaders.get(origin) || null;
    } catch {
      return null;
    }
  }

  /**
   * Clear registered video headers (e.g. when switching to a new video).
   */
  public clearVideoUrlHeaders(): void {
    this.videoUrlHeaders.clear();
  }

  /**
   * Rewrite a GoProxy URL (http://127.0.0.1:8096/<path>?url=<encoded>) to
   * point at our local ProxyServer's streamPanDirect handler.
   *
   * If the URL doesn't match the GoProxy pattern, return it unchanged.
   */
  private rewriteGoProxyUrl(url: string, flag: string): string {
    // Pattern 1: GoProxy URL (http://127.0.0.1:8096/<path>?url=<encoded>)
    const goProxyMatch = url.match(
      /^http:\/\/127\.0\.0\.1:8096\/\w+\?url=(.+)$/,
    );
    if (goProxyMatch) {
      const encodedUrl = goProxyMatch[1];
      let upstreamUrl: string;
      try {
        upstreamUrl = decodeURIComponent(encodedUrl);
      } catch {
        upstreamUrl = encodedUrl;
      }

      // Determine pan type from flag
      const flagLower = flag.toLowerCase();
      let panType = 'quark';
      if (flagLower.includes('uc') || flag.includes('优熙')) {
        panType = 'uc';
      } else if (flag.includes('百度') || flag.includes('百渡')) {
        panType = 'baidu';
      } else if (flag.includes('天翼')) {
        panType = 'aliyun';
      } else if (flag.includes('夸克') || flag.includes('夸父')) {
        panType = 'quark';
      }

      let proxyPort = 9978;
      try {
        const { proxyServer } = require('./ProxyServer');
        const p = proxyServer.getPort();
        if (p > 0) proxyPort = p;
      } catch {}

      const newUrl = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodedUrl}`;
      console.log(
        `[JarLoader] rewriteGoProxyUrl (GoProxy): panType=${panType}, port=${proxyPort}, upstream=${upstreamUrl.substring(0, 80)}...`,
      );
      return newUrl;
    }

    // Pattern 2: Internal proxy URL missing /proxy path
    // (http://127.0.0.1:9978?do=xxx&url=... → http://127.0.0.1:9978/proxy?do=xxx&url=...)
    const missingProxyPathMatch = url.match(
      /^http:\/\/127\.0\.0\.1:(\d+)\?do=(\w+)&url=(.+)$/,
    );
    if (missingProxyPathMatch) {
      const port = missingProxyPathMatch[1];
      const doType = missingProxyPathMatch[2];
      const encodedUrl = missingProxyPathMatch[3];
      const fixedUrl = `http://127.0.0.1:${port}/proxy?do=${doType}&url=${encodedUrl}`;
      console.log(
        `[JarLoader] rewriteGoProxyUrl (fixPath): added /proxy to URL, do=${doType}, port=${port}`,
      );
      return fixedUrl;
    }

    // Pattern 3: Already correct proxy URL - no change needed
    if (url.includes('/proxy?do=')) {
      return url;
    }

    // Not a proxy URL - return unchanged
    return url;
  }

  /**
   * Call Spider method
   * All methods return JSON string
   *
   * IMPORTANT: Creates a NEW spider instance for each call to avoid
   * Java static state pollution between different sources.
   */
  private async executeSpiderMethod(
    spider: any,
    method: string,
    javaArgs: any[],
  ): Promise<string> {
    const syncMethod = method + 'Sync';
    const slowMethods = ['playerContent', 'searchContent'];
    const isSlowMethod = slowMethods.some((m) =>
      method.toLowerCase().includes(m.toLowerCase()),
    );
    // homeContent / homeVideoContent / categoryContent may also make network
    // requests via OkHttp. Calling their *Sync variants blocks the Node event
    // loop, so any hang (e.g. Jpys homeContent) freezes the whole process and
    // no JS-side timeout can fire. Force these methods down the async path
    // with a timeout so we can recover and retry.
    // detailContent also makes blocking pan-resolver HTTP calls (Quark API)
    // with a spider-internal 5s timeout; force it down the async path too so
    // a hang doesn't freeze the whole process and we can apply a JS-side
    // timeout longer than the spider's internal 5s.
    const asyncOnlyMethods = [
      'homeContent',
      'homeVideoContent',
      'categoryContent',
      'detailContent',
    ];
    const isAsyncOnly = asyncOnlyMethods.includes(method);

    if (isSlowMethod || isAsyncOnly) {
      try {
        const asyncFunc = spider[method];
        if (asyncFunc && typeof asyncFunc === 'function') {
          console.log(
            `[JarLoader] calling async ${method} (isSlow=${isSlowMethod}, isAsyncOnly=${isAsyncOnly})`,
          );
          const result = asyncFunc.call(spider, ...javaArgs);
          console.log(
            `[JarLoader] async ${method} returned:`,
            typeof result,
            result && typeof result.then === 'function' ? 'Promise' : 'value',
          );
          if (result && typeof result.then === 'function') {
            const timeoutMs = isSlowMethod ? 60000 : 30000;
            const timeoutPromise = new Promise<string>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
              }, timeoutMs);
            });
            const asyncResult = await Promise.race([result, timeoutPromise]);
            // Print full response for diagnostic methods (homeContent,
            // categoryContent, detailContent) so we can see all obfuscated
            // fields, category IDs, and whether vod_play_url is present.
            // Other methods keep the 100-char preview.
            const isDiagnostic =
              method === 'homeContent' ||
              method === 'categoryContent' ||
              method === 'detailContent' ||
              method === 'playerContent';
            console.log(
              `[JarLoader] async ${method} resolved:`,
              typeof asyncResult === 'string'
                ? isDiagnostic
                  ? asyncResult
                  : asyncResult.substring(0, 100)
                : typeof asyncResult,
            );
            if (typeof asyncResult === 'string') return asyncResult;
            return JSON.stringify(asyncResult);
          }
          if (typeof result === 'string') return result;
          return JSON.stringify(result);
        } else {
          console.warn(
            `[JarLoader] async ${method} not found on spider, falling through`,
          );
        }
      } catch (asyncErr: any) {
        console.warn(
          `[JarLoader] async ${method} threw:`,
          asyncErr?.message || asyncErr,
        );
        if (isSlowMethod) throw asyncErr;
      }
    }

    if (!isSlowMethod && !isAsyncOnly) {
      try {
        const syncFunc = spider[syncMethod];
        if (syncFunc && typeof syncFunc === 'function') {
          const result = syncFunc.call(spider, ...javaArgs);
          if (typeof result === 'string') return result;
          return JSON.stringify(result);
        }
      } catch (syncErr: any) {
        console.warn(
          `[JarLoader] ${syncMethod} threw error:`,
          syncErr?.message || syncErr,
        );
      }
    }

    if (!isSlowMethod && !isAsyncOnly) {
      try {
        const asyncFunc = spider[method];
        if (asyncFunc && typeof asyncFunc === 'function') {
          const result = asyncFunc.call(spider, ...javaArgs);
          if (typeof result === 'string') return result;
          if (result && typeof result.then === 'function') {
            const asyncResult = await result;
            if (typeof asyncResult === 'string') return asyncResult;
            return JSON.stringify(asyncResult);
          }
          return JSON.stringify(result);
        }
      } catch (asyncErr: any) {
        console.warn(
          `[JarLoader] ${method} threw error:`,
          asyncErr?.message || asyncErr,
        );
      }
    }

    return '{}';
  }

  private isEmptyResult(result: string, method: string): boolean {
    try {
      const parsed = JSON.parse(result);
      const classCount = parsed.class?.length || 0;
      const listCount = parsed.list?.length || 0;
      const filterCount = parsed.filters
        ? Object.keys(parsed.filters).length
        : 0;
      if (method === 'homeContent') {
        // Guard spiders often return categories/filters without a video list
        // (users browse categories to find videos). Only treat as empty if
        // ALL of list, class, and filters are absent.
        return listCount === 0 && classCount === 0 && filterCount === 0;
      }
      return classCount === 0 && listCount === 0;
    } catch {
      return result.trim() === '{}' || result.trim() === '';
    }
  }

  /**
   * Check if a detailContent result is missing vod_play_url/vod_play_from.
   *
   * Guard spiders return partial detailContent results when the pan resolver
   * (Quark API call with 5s internal timeout) fails: the result has
   * vod_name/vod_pic/vod_content but NO vod_play_url or vod_play_from.
   * Without these fields the renderer can't show episode list or play.
   * Used to trigger a retry — the first failed call warms the JVM DNS cache
   * and OkHttp connection pool, so the next call usually completes in time.
   */
  private isMissingPlayUrl(result: string): boolean {
    try {
      const parsed = JSON.parse(result);
      const list = parsed.list;
      if (!Array.isArray(list) || list.length === 0) return false;
      const vod = list[0];
      if (!vod || typeof vod !== 'object') return false;
      const hasPlayUrl =
        vod.vod_play_url !== undefined &&
        vod.vod_play_url !== null &&
        vod.vod_play_url !== '';
      const hasPlayFrom =
        vod.vod_play_from !== undefined &&
        vod.vod_play_from !== null &&
        vod.vod_play_from !== '';
      // Only retry if we have video metadata but are missing play fields.
      // If vod_name is also missing, the spider failed entirely — retry
      // won't help and we'd just delay the error.
      const hasMetadata = vod.vod_name || vod.vod_pic;
      if (!hasMetadata) return false;
      const missing = !hasPlayUrl || !hasPlayFrom;
      if (missing) {
        console.log(
          '[JarLoader] isMissingPlayUrl: vod_name=',
          vod.vod_name,
          'has vod_play_url=',
          hasPlayUrl,
          'has vod_play_from=',
          hasPlayFrom,
        );
      }
      return missing;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize a spider key for use in file paths and Java string parameters.
   *
   * java-bridge corrupts Unicode strings when passing them from Node.js to
   * Java. Spider keys containing Chinese/emoji characters (e.g.
   * "玩偶-💓‍玩偶┃4K💓‍") get mangled, causing FileNotFoundException when Java
   * tries to read siteconfig or other files in the spider's file cache
   * directory. Non-ASCII keys are replaced with a stable MD5 hash so the
   * file cache directory path is pure ASCII on both Node.js and Java sides.
   */
  public sanitizeSpiderKey(key: string): string {
    if (/^[\x00-\x7F]+$/.test(key)) {
      return key;
    }
    return crypto.createHash('md5').update(key, 'utf8').digest('hex');
  }

  private clearSpiderFileCache(key: string): void {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const spiderCacheDir = path.join(
        tmpDir,
        'tvbox_' + this.sanitizeSpiderKey(key),
      );
      if (fs.existsSync(spiderCacheDir)) {
        fs.rmSync(spiderCacheDir, { recursive: true, force: true });
        console.log('[JarLoader] Cleared spider file cache:', spiderCacheDir);
      }
    } catch (e: any) {
      console.error('[JarLoader] clearSpiderFileCache error:', e.message);
    }
  }

  private rotateSiteUrls(ext: string, retryIndex: number): string | null {
    try {
      const parsed = JSON.parse(ext);
      if (
        !parsed.site_urls ||
        !Array.isArray(parsed.site_urls) ||
        parsed.site_urls.length <= 1
      ) {
        return null;
      }
      const urls = parsed.site_urls;
      const targetIndex = retryIndex % urls.length;
      const targetUrl = urls[targetIndex];
      parsed.site_urls = [targetUrl];
      const modified = JSON.stringify(parsed);
      console.log(
        '[JarLoader] Forced single site_url for retry',
        retryIndex,
        ':',
        targetUrl,
      );
      return modified;
    } catch {
      return null;
    }
  }

  public async callSpiderMethod(
    key: string,
    method: string,
    args: any[],
  ): Promise<string> {
    const instance = this.spiders.get(key);
    if (!instance) {
      console.warn(
        `[JarLoader] callSpiderMethod: spider not found for key=${key}, method=${method}`,
      );
      return '{}';
    }

    // Wait for any in-flight init to complete before invoking spider methods.
    // Without this, an early homeContent call races with initSpider and runs
    // against an uninitialized spider (base URL still the hijacked hardcoded
    // default), returning list=[] even though the spider works correctly
    // once init finishes.
    if (instance.initPromise) {
      console.log(
        `[JarLoader] callSpiderMethod(${method}): awaiting in-flight init for`,
        key,
      );
      try {
        await instance.initPromise;
      } catch {
        // init errors are logged in initSpider; proceed and let the method
        // call fail with its own diagnostic if the spider is broken.
      }
    }

    // Track the spider key when playerContent is called.
    // This is used by proxyInvoke to call spider.proxyLocal() instead of
    // Proxy.proxy() for better compatibility with spider-specific proxy logic.
    if (method === 'playerContent') {
      this.setRecentSpider(key, 'jar');
    }

    const isHomeMethod =
      method === 'homeContent' || method === 'homeVideoContent';
    // homeVideoContent is optional - many spiders (especially Guard spiders)
    // don't implement it and return empty. Don't retry on empty results.
    const retryOnEmpty = method === 'homeContent';
    // detailContent: Guard spiders' pan resolver makes HTTP calls to Quark API
    // with a spider-internal 5-second timeout. On cold connection (first call),
    // DNS/TLS handshake exceeds 5s → TimeoutException → spider returns partial
    // result with vod_name/vod_pic/vod_content but WITHOUT vod_play_url/
    // vod_play_from. Retry after a delay — the first failed call still warms
    // the JVM DNS cache and OkHttp connection pool, so the second call usually
    // completes within 5s.
    const retryOnMissingPlayUrl = method === 'detailContent';
    let maxRetries = isHomeMethod ? 3 : 1;
    if (retryOnMissingPlayUrl) {
      maxRetries = 3;
    }
    if (isHomeMethod) {
      try {
        const parsed = JSON.parse(instance.ext);
        if (parsed.site_urls && Array.isArray(parsed.site_urls)) {
          maxRetries = Math.max(maxRetries, parsed.site_urls.length + 1);
        }
      } catch {
        // ignore
      }
    }

    let currentExt = instance.ext;

    // Pre-playback Quark cookie refresh.
    //
    // The spider's playerContent reads the Quark cookie from JVM
    // SharedPreferences. That cookie may be stale (set at app startup), so
    // the spider generates a download URL whose auth_key is bound to a stale
    // __puus → CDN 412.
    //
    // Refresh __puus here and push the fresh cookie to JVM so the spider uses
    // it. If the refresh detects true login expiry, emit pan:loginExpired so
    // the renderer can pop up the QR re-login dialog.
    if (
      method === 'playerContent' &&
      typeof args[0] === 'string' &&
      (args[0].includes('夸克') || args[0].includes('夸父')) &&
      QuarkPanService.getSyncedCookie()
    ) {
      try {
        const refreshResult = await QuarkPanService.refreshCookieForPlayback();
        if (refreshResult.expired) {
          console.warn(
            '[JarLoader] playerContent: Quark login expired, emitting pan:loginExpired',
          );
          try {
            BrowserWindow.getAllWindows().forEach((w) =>
              w.webContents.send('pan:loginExpired', 'quark'),
            );
          } catch (e: any) {
            console.warn(
              '[JarLoader] Failed to emit pan:loginExpired:',
              e.message,
            );
          }
          throw new Error('Quark login expired, please re-scan QR code');
        }
        if (refreshResult.refreshed && refreshResult.cookie) {
          console.log(
            '[JarLoader] playerContent: Quark cookie refreshed, syncing to JVM',
          );
          await QuarkPanService.syncCookieToJVM(refreshResult.cookie);
        }
      } catch (e: any) {
        if (e.message?.includes('Quark login expired')) throw e;
        console.warn(
          '[JarLoader] playerContent: Quark cookie refresh failed, continuing with existing cookie:',
          e.message,
        );
      }
    }

    // Pre-detailContent pan cookie injection.
    //
    // The spider's pan resolver (NewQuark/NewPanUc/NewPan115) stores the
    // pan cookie in a STATIC field initialized to "". The field is only
    // populated from SharedPreferences inside oOoO0OoO0oOo0oOo() (a heavy
    // validation method) or playerContent() — neither is called before
    // detailContentVodPlay(). So when detailContent triggers the pan
    // resolver thread pool, the Cookie header is empty, the Quark API
    // rejects the request (no stoken), getvod() returns an empty VodBean,
    // and Gson.fromJson("") returns null → NPE → "暂无播放源".
    //
    // Fix: directly set the static cookie fields from SharedPreferences
    // before calling detailContent. This mirrors what the spider's own
    // oOoO0OoO0oOo0oOo() does at line 557 (NewQuark) / line 383 (NewPanUc)
    // / line 71 (NewPan115), but without the heavy HTTP validation.
    if (method === 'detailContent') {
      this.setPanCookiesForDetailContent();
    }

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        console.log(
          '[JarLoader] callSpiderMethod request:',
          JSON.stringify(
            {
              key,
              method,
              ext: currentExt.substring(0, 300),
              className: instance.className,
              argsLength: args.length,
              argsPreview: args.map((a: any) =>
                typeof a === 'string'
                  ? a.substring(0, 100)
                  : typeof a === 'object'
                    ? JSON.stringify(a).substring(0, 100)
                    : String(a),
              ),
              retry,
              usingCachedSpider: retry === 0,
            },
            null,
            2,
          ),
        );

        // Match Android's JarLoader.getSpider behavior: reuse the cached,
        // already-initialized spider instance for the first attempt. Only
        // create a fresh spider for retries (which need a different ext with
        // rotated site_urls). Re-creating + re-init'ing on every call breaks
        // spiders that rely on init-time state (e.g. WanOu homeContent).
        //
        // EXCEPTION: detailContent retries reuse the same spider instance.
        // detailContent doesn't depend on site_urls rotation — it just needs
        // the Quark cookie (already in SharedPreferences, shared across all
        // instances) and a warm connection. Reusing the spider avoids init
        // overhead and potential init failures on the retry path.
        let spider: any;
        if (retry === 0 || method === 'detailContent') {
          spider = instance.spider;
          // Ensure file cache dir matches what initSpider set (tvbox_<key>).
          const ContextClass = this.java.importClass('android.content.Context');
          ContextClass.setCurrentSpiderKeySync(this.sanitizeSpiderKey(key));
        } else {
          spider = new (this.java.importClass(instance.className))();
          try {
            const ContextClass = this.java.importClass(
              'android.content.Context',
            );
            const retryKey = this.sanitizeSpiderKey(key) + '_retry' + retry;
            // Retry uses a fresh file cache dir (tvbox_<key>_retry<N>); ensure
            // siteconfig exists there too so Guard spiders pick a working URL.
            await this.ensureWexGuardSiteConfig(retryKey);
            ContextClass.setCurrentSpiderKeySync(retryKey);
            const context = new ContextClass();
            const cleanExt = this.cleanExtForSpider(currentExt);
            // Guard spiders override init(Context), not init(Context, String).
            // Calling initSync(context, ext) resolves to the empty base-class
            // method and the spider never reads siteconfig. Use single-param
            // init for Guard spiders, and set InitOrigin filesDir so the
            // siteconfig file path resolves correctly.
            if (instance.isGuard) {
              try {
                const InitOrigin = this.java.importClass(
                  'com.github.catvod.spider.InitOrigin',
                );
                const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
                InitOrigin.oOoOoOo0O0O0oO0o = path.join(
                  tmpDir,
                  'tvbox_' + retryKey,
                );
              } catch (e: any) {
                console.warn(
                  '[JarLoader] retry: Failed to set InitOrigin filesDir:',
                  e.message,
                );
              }
              const initSync = spider.initSync;
              if (initSync && typeof initSync === 'function') {
                initSync.call(spider, context);
              } else {
                spider.init(context);
              }
            } else {
              const initSync = spider.initSync;
              if (initSync && typeof initSync === 'function') {
                initSync.call(spider, context, cleanExt);
              } else {
                spider.init(context, cleanExt);
              }
            }
          } catch (initErr: any) {
            console.warn(
              '[JarLoader] Failed to init fresh spider instance:',
              initErr.message,
            );
          }
        }

        const javaArgs = this.convertArgs(method, args);
        let result = await this.executeSpiderMethod(spider, method, javaArgs);

        // Source isolation: call LoadNiMa.decode via unidbg for sources that need it
        // This is ONLY applied to specific sources (e.g. WexGuaZiGuard) that have native decoding requirements
        // Each source is isolated - this logic doesn't affect other sources
        const clsKey = instance.className.replace('csp_', '');
        if (clsKey === 'WexGuaZiGuard' && method === 'homeContent') {
          console.log(
            `[JarLoader] Checking if LoadNiMa decoding needed for ${clsKey}`,
          );

          // WexGuaZi's homeContent returns encrypted data that needs LoadNiMa.decode()
          // Check if result is not valid JSON (indicating it needs decoding)
          if (result && result.length > 0 && !result.trim().startsWith('{')) {
            console.log(
              `[JarLoader] Result is non-JSON, calling LoadNiMa.decode for ${clsKey}`,
            );
            console.log(
              `[JarLoader] Original result preview:`,
              result.substring(0, Math.min(100, result.length)),
            );

            // Call unidbg to decode the data
            const decodedResult = await this.callLoadNiMaDecode(clsKey, result);

            if (decodedResult && decodedResult.trim().startsWith('{')) {
              console.log(
                `[JarLoader] ✅ Decoding successful, using decoded data`,
              );
              result = decodedResult;
            } else {
              console.warn(
                `[JarLoader] ⚠️  Decoding failed or returned non-JSON, keeping original`,
              );
            }
          } else {
            console.log(
              `[JarLoader] Result is already JSON or empty, no decoding needed`,
            );
          }
        }

        // Debug: log raw result for homeContent/homeVideoContent to diagnose JSON parsing issues
        if (isHomeMethod) {
          console.log(
            `[JarLoader] ${method} RAW RESULT (length=${result.length}):`,
          );
          // Print first 500 chars to see actual content
          const preview =
            result.length > 500 ? result.substring(0, 500) + '...' : result;
          console.log(`[JarLoader] ${method} preview:`, preview);
          // Print byte representation for non-JSON strings
          if (result && result.length > 0 && result.charAt(0) !== '{') {
            const bytes = Buffer.from(result.substring(0, 50));
            console.log(
              `[JarLoader] ${method} first 50 bytes:`,
              bytes.toString('hex'),
            );
          }
        }

        // Guard spiders return JSON with obfuscated field names (e.g.
        // oOo0oOo0Oo0oO0Oo). Translate to standard TVBox format (vod_id,
        // list, class, filters) so the renderer and isEmptyResult can
        // interpret the response.
        if (instance.isGuard) {
          const translated = this.translateGuardOutput(result, method);
          if (translated !== result) {
            result = translated;
          }
        }

        // detailContent: log full input/output for debugging jar issues.
        if (method === 'detailContent') {
          console.log('[JarLoader] ========== detailContent debug ==========');
          console.log('[JarLoader] detailContent args =', JSON.stringify(args));
          const detailPreview =
            result.length > 2000 ? result.substring(0, 2000) + '...' : result;
          console.log(
            '[JarLoader] detailContent result (full):',
            detailPreview,
          );
          try {
            const parsed = JSON.parse(result);
            const vod = parsed?.list?.[0] || {};
            console.log('[JarLoader] detailContent vod summary:', {
              vod_name: vod.vod_name,
              vod_id: vod.vod_id,
              has_play_url: !!vod.vod_play_url,
              has_play_from: !!vod.vod_play_from,
              vod_play_from: vod.vod_play_from,
              vod_play_url_len: vod.vod_play_url?.length || 0,
            });
          } catch {
            /* not JSON */
          }
          console.log(
            '[JarLoader] ========== end detailContent debug ==========',
          );
        }

        // playerContent: Guard spiders (NewWogg/NewQuark/etc.) return JSON
        // with an obfuscated URL field (e.g. "OoOoOi0o0o0oOo0") whose value
        // is a GoProxy URL ("http://127.0.0.1:8096/kaiser?url=<CDN URL>").
        // GoProxy is a native ARM .so (libwexproxy.so) that can't load on
        // Windows, so the URL is unreachable. Translate the obfuscated field
        // to standard "url" and rewrite the URL to point at our ProxyServer's
        // streamPanDirect handler, which fetches the CDN URL with the same
        // Cookie/Referer/UA the spider would have used.
        if (method === 'playerContent' && typeof args[0] === 'string') {
          // Diagnostic: log FULL playerContent input and output for debugging
          // (previously truncated to 60/200 chars, which hid the vod_id and url)
          console.log('[JarLoader] ========== playerContent debug ==========');
          console.log('[JarLoader] playerContent flag =', args[0]);
          console.log(
            '[JarLoader] playerContent id (full) =',
            typeof args[1] === 'string' ? args[1] : args[1],
          );
          console.log('[JarLoader] playerContent raw result (full) =', result);
          // Clear stale video headers from the previous video before
          // registering new ones in translatePlayerContent.
          this.clearVideoUrlHeaders();
          const translatedPc = this.translatePlayerContent(result, args[0]);
          if (translatedPc !== result) {
            console.log(
              '[JarLoader] playerContent translated result (full) =',
              translatedPc,
            );
            result = translatedPc;
          } else {
            console.log(
              '[JarLoader] playerContent: translatePlayerContent returned unchanged',
            );
          }
          console.log(
            '[JarLoader] ========== end playerContent debug ==========',
          );
        }

        if (
          retryOnEmpty &&
          this.isEmptyResult(result, method) &&
          retry < maxRetries - 1
        ) {
          console.log(
            '[JarLoader] Empty result, forcing next site_url and retrying...',
          );
          this.clearSpiderFileCache(key + '_retry' + retry);
          const rotatedExt = this.rotateSiteUrls(currentExt, retry + 1);
          if (rotatedExt) {
            currentExt = rotatedExt;
          } else {
            this.clearSpiderFileCache(key);
          }
          continue;
        }

        // detailContent: if vod_play_url is missing, the spider's pan resolver
        // likely timed out (5s internal timeout on cold connection). Retry
        // after a delay — the first call warmed the JVM DNS cache and OkHttp
        // connection pool, so the next call should complete within 5s.
        if (
          retryOnMissingPlayUrl &&
          this.isMissingPlayUrl(result) &&
          retry < maxRetries - 1
        ) {
          console.log(
            '[JarLoader] detailContent missing vod_play_url (pan resolver timeout?), retrying in 1.5s...',
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        // detailContent: retries exhausted but vod_play_url still missing.
        // Per user instruction: do NOT write PC fallback — rely on the jar
        // spider entirely. If the spider returns missing play fields, log
        // diagnostics so we can fix the jar issue, then return as-is.
        if (retryOnMissingPlayUrl && this.isMissingPlayUrl(result)) {
          console.warn(
            '[JarLoader] detailContent: spider returned missing vod_play_url/vod_play_from after retries.',
          );
          try {
            const parsed = JSON.parse(result);
            const vod = parsed?.list?.[0] || {};
            console.warn('[JarLoader] detailContent vod fields:', {
              vod_name: vod.vod_name,
              vod_id: vod.vod_id,
              has_play_url: !!vod.vod_play_url,
              has_play_from: !!vod.vod_play_from,
              vod_play_from: vod.vod_play_from,
              vod_play_url_len: vod.vod_play_url?.length || 0,
            });
          } catch {
            /* ignore parse error */
          }
        }

        return result;
      } catch (err: any) {
        console.error(
          `[JarLoader] ${method} threw:`,
          err.message || err,
          'retry:',
          retry,
          'key:',
          key,
        );
        if (retry < maxRetries - 1) {
          console.log('[JarLoader] Error, clearing file cache and retrying...');
          this.clearSpiderFileCache(key + '_retry' + retry);
          const rotatedExt = this.rotateSiteUrls(currentExt, retry + 1);
          if (rotatedExt) {
            currentExt = rotatedExt;
          }
          continue;
        }

        // Per user instruction: do NOT write PC fallback — rely on the jar
        // spider entirely. If homeContent fails, log diagnostics so we can
        // fix the jar issue, then return empty.
        console.error(
          `[JarLoader] ${clsKey} ${method} exhausted all retries and failed`,
        );

        return '{}';
      }
    }

    return '{}';
  }

  /**
   * Debug: list all methods of a spider class
   */
  public listSpiderMethods(key: string): string {
    const instance = this.spiders.get(key);
    if (!instance) {
      return JSON.stringify({ error: 'Spider not found: ' + key });
    }
    try {
      const spider = instance.spider;
      const methods = Object.keys(spider)
        .filter((k) => !k.startsWith('_') && !k.startsWith('class'))
        .filter((k) => typeof spider[k] === 'function')
        .sort();
      console.log(`[JarLoader] Spider ${key} has ${methods.length} methods:`);
      methods.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m}`);
      });
      return JSON.stringify({ methods, count: methods.length });
    } catch (e: any) {
      console.error('[JarLoader] listSpiderMethods error:', e.message);
      return JSON.stringify({ error: e.message });
    }
  }

  /**
   * Debug: list all available classes in a package prefix
   */
  public findClasses(prefix: string): string {
    try {
      const results: string[] = [];
      console.log(`[JarLoader] Finding classes with prefix: ${prefix}`);
      return JSON.stringify({
        note: 'Class listing requires ClassLoader manipulation, checking known patterns instead',
        prefix,
      });
    } catch (e: any) {
      return JSON.stringify({ error: e.message });
    }
  }

  /**
   * Initialize spider with ext config
   */
  private cleanExtForSpider(ext: string): string {
    try {
      const parsed = JSON.parse(ext);
      if (typeof parsed === 'object') {
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || Array.isArray(v)) {
            cleaned[k] = v;
          }
        }
        const result = JSON.stringify(cleaned);
        if (result !== ext) {
          console.log(
            '[JarLoader] cleanExtForSpider:',
            ext.substring(0, 100),
            '->',
            result.substring(0, 100),
          );
        }
        return result;
      }
    } catch {
      // keep original if parsing fails
    }
    return ext;
  }

  /**
   * Fetch the WexGuard siteconfig JSON (URL lists for wogg/jutou/huban/etc).
   * Caches the result in memory so subsequent calls are free.
   *
   * Flow (mirrors oOo0oO0o0O0O0Oo0.OoOoOo0O0o0oO0o0() in the decompiled JAR):
   *   1. GET http://upload.baicanuc.cn/ossfiles/1768320816/item.txt
   *   2. Parse JSON, read .config_site (a nos.netease.com URL)
   *   3. GET the config_site URL -> siteconfig JSON
   */
  private async fetchWexGuardSiteConfig(): Promise<string | null> {
    if (this.wexGuardSiteConfigJson) return this.wexGuardSiteConfigJson;
    if (this.wexGuardSiteConfigPromise) return this.wexGuardSiteConfigPromise;

    this.wexGuardSiteConfigPromise = (async () => {
      try {
        const itemUrl =
          'http://upload.baicanuc.cn/ossfiles/1768320816/item.txt';
        console.log('[JarLoader] Fetching WexGuard item.txt:', itemUrl);
        const itemResp = await axios.get(itemUrl, {
          timeout: 10000,
          responseType: 'text',
        });
        const itemData = itemResp.data;
        const configSiteUrl =
          typeof itemData === 'string'
            ? JSON.parse(itemData).config_site
            : itemData?.config_site;
        if (!configSiteUrl || typeof configSiteUrl !== 'string') {
          console.warn(
            '[JarLoader] item.txt missing config_site field, aborting siteconfig fetch',
          );
          return null;
        }
        console.log(
          '[JarLoader] Fetching WexGuard siteconfig from:',
          configSiteUrl,
        );
        const cfgResp = await axios.get(configSiteUrl, {
          timeout: 10000,
          responseType: 'text',
        });
        const cfgJson =
          typeof cfgResp.data === 'string'
            ? cfgResp.data
            : JSON.stringify(cfgResp.data);
        // Validate: must parse as JSON with at least one spider key.
        const parsed = JSON.parse(cfgJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.warn('[JarLoader] siteconfig JSON invalid shape');
          return null;
        }
        const keys = Object.keys(parsed);
        console.log(
          '[JarLoader] WexGuard siteconfig fetched, spider keys:',
          keys.join(', '),
        );
        this.wexGuardSiteConfigJson = cfgJson;
        return cfgJson;
      } catch (e: any) {
        console.warn(
          '[JarLoader] WexGuard siteconfig fetch failed:',
          e.message,
        );
        return null;
      } finally {
        this.wexGuardSiteConfigPromise = null;
      }
    })();

    return this.wexGuardSiteConfigPromise;
  }

  /**
   * Ensure <filesDir>/NewWex/siteconfig exists for the given spider key.
   * Called before spider.init() so Guard spiders (NewWogg/NewJuTou/etc.) can
   * read working mirror URLs instead of falling back to hijacked hardcoded
   * URLs.
   */
  private async ensureWexGuardSiteConfig(spiderKey: string): Promise<void> {
    const sanitizedKey = this.sanitizeSpiderKey(spiderKey);
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const newWexDir = path.join(tmpDir, 'tvbox_' + sanitizedKey, 'NewWex');
      const siteConfigPath = path.join(newWexDir, 'siteconfig');

      // If file already exists and is non-empty, assume it's good.
      if (fs.existsSync(siteConfigPath)) {
        const stat = fs.statSync(siteConfigPath);
        if (stat.size > 10) {
          console.log(
            '[JarLoader] siteconfig already exists for',
            spiderKey,
            '(',
            stat.size,
            'bytes)',
          );
          return;
        }
      }

      const json = await this.fetchWexGuardSiteConfig();
      if (!json) {
        console.warn(
          '[JarLoader] No siteconfig JSON available, spider',
          spiderKey,
          'will use hardcoded fallback URL',
        );
        return;
      }

      fs.mkdirSync(newWexDir, { recursive: true });
      fs.writeFileSync(siteConfigPath, json, 'utf8');
      console.log(
        '[JarLoader] Wrote siteconfig for',
        spiderKey,
        '(',
        json.length,
        'bytes) to',
        siteConfigPath,
      );
    } catch (e: any) {
      console.warn(
        '[JarLoader] ensureWexGuardSiteConfig failed for',
        spiderKey,
        ':',
        e.message,
      );
    }
  }

  public async initSpider(key: string, ext: string): Promise<void> {
    const instance = this.spiders.get(key);
    if (!instance) return;

    // If init is already in flight, await it instead of starting a second one.
    if (instance.initPromise) {
      await instance.initPromise;
      return;
    }

    // Store the in-flight promise so callSpiderMethod can await it before
    // invoking any method. This prevents a race where the renderer calls
    // jar:callMethod before jar:initSpider's await chain completes, causing
    // homeContent to run against an uninitialized spider (base URL still
    // the hijacked hardcoded default) and return list=[].
    const promise = this.doInitSpider(instance, key, ext);
    instance.initPromise = promise;
    try {
      await promise;
    } finally {
      // Allow future re-inits (e.g. after clearSpiderFileCache) to run.
      instance.initPromise = null;
    }

    // Pre-warm the Quark API connection and trigger the spider's static
    // initializer early. detailContent calls a pan resolver that makes HTTP
    // calls to drive-pc.quark.cn with a spider-internal 5-second timeout.
    // On desktop, the first call (cold DNS/TLS) often exceeds 5s, causing
    // TimeoutException → RuntimeException → partial result without
    // vod_play_url. Pre-warming the connection from Java (sharing the JVM's
    // DNS cache and potentially OkHttp's connection pool) makes the first
    // real call fast enough to complete within 5s.
    if (instance.isGuard) {
      this.preWarmForDetailContent(instance.spider).catch(() => {
        /* pre-warm failures are non-fatal */
      });
    }
  }

  private async doInitSpider(
    instance: SpiderInstance,
    key: string,
    ext: string,
  ): Promise<void> {
    // Pre-populate <filesDir>/NewWex/siteconfig for Guard spiders. Guard
    // spider init() reads this file to pick a working mirror URL; without
    // it, NewWogg falls back to http://www.wogg.lol which is hijacked.
    await this.ensureWexGuardSiteConfig(key);

    const cleanExt = this.cleanExtForSpider(ext);

    try {
      const ContextClass = this.java.importClass('android.content.Context');

      // Set the spider key BEFORE init so the spider's file cache dir
      // (tvbox_<key>) matches what callSpiderMethod uses. Without this,
      // init writes to tvbox_default but method calls look in tvbox_<key>_retry0.
      // Sanitize the key to ASCII because java-bridge corrupts Unicode strings,
      // which would mangle the file cache directory path on the Java side.
      const sanitizedKey = this.sanitizeSpiderKey(key);
      ContextClass.setCurrentSpiderKeySync(sanitizedKey);
      const context = new ContextClass();

      // Guard spiders (NewWogg/NewJuTou/etc.) override init(Context) — the
      // single-parameter overload — to read siteconfig and pick a working
      // mirror URL. The base Spider class also declares init(Context, String)
      // as an empty no-op. If we call initSync(context, ext) with TWO params,
      // java-bridge resolves to the empty base-class method and the spider
      // never reads siteconfig (base URL stays as the hijacked hardcoded
      // http://www.wogg.lol). So for Guard spiders we MUST call the
      // single-param initSync(context) first.
      //
      // BUT: not every class with a "Guard" suffix in its API name actually
      // overrides init(Context). Bili, NewDouBan, WexYiYs, etc. only declare
      // init(Context, String). Calling the inherited single-param init(Context)
      // invokes the empty base-class no-op and leaves the spider's fields
      // null, causing NullPointerException in homeContent. So we use Java
      // reflection to verify the spider class actually declares init(Context)
      // before calling it.
      //
      // Additionally, set InitOrigin.oOoOoOo0O0O0oO0o (the static filesDir
      // field) so oOoOoOoOo0Oo0o0o("siteconfig") resolves to
      // <filesDir>/NewWex/siteconfig. Without this, the field is null and
      // the path becomes "null/NewWex/siteconfig" which doesn't exist.
      const hasInitContextOverride = this.hasInitContextOverride(
        instance.spider,
      );
      if (instance.isGuard && hasInitContextOverride) {
        try {
          const InitOrigin = this.java.importClass(
            'com.github.catvod.spider.InitOrigin',
          );
          const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
          const filesDir = path.join(tmpDir, 'tvbox_' + sanitizedKey);
          InitOrigin.oOoOoOo0O0O0oO0o = filesDir;
          console.log(
            '[JarLoader] Set InitOrigin.oOoOoOo0O0O0oO0o =',
            filesDir,
          );
        } catch (e: any) {
          console.warn(
            '[JarLoader] Failed to set InitOrigin filesDir:',
            e.message,
          );
        }

        try {
          instance.spider.initSync(context);
          console.log(
            '[JarLoader] Guard spider initialized with init(Context):',
            key,
          );
          // Inspect spider's base URL field directly (field name from decompiled
          // source: `public String oOoOoOoOoOoOoO0o`). This is the only way to
          // verify init() actually picked a working mirror URL instead of
          // falling back to the hijacked http://www.wogg.lol hardcoded default.
          try {
            const baseUrl = instance.spider.oOoOoOoOoOoOoO0o;
            console.log(
              '[JarLoader] Guard spider base URL after init:',
              String(baseUrl),
            );
          } catch (e: any) {
            console.warn(
              '[JarLoader] Could not read base URL field:',
              e.message,
            );
          }
          return;
        } catch (ctxInitErr: any) {
          console.warn(
            '[JarLoader] Guard init(Context) failed, falling back:',
            ctxInitErr.message,
          );
        }
      }

      try {
        const initSync = instance.spider.initSync;
        if (initSync && typeof initSync === 'function') {
          initSync.call(instance.spider, context, cleanExt);
          console.log('[JarLoader] Spider initialized with Context:', key);
          return;
        }
      } catch (ctxInitErr: any) {
        console.warn(
          '[JarLoader] init(Context, String) failed:',
          ctxInitErr.message,
        );
      }

      try {
        const initSync = instance.spider.initSync;
        if (initSync && typeof initSync === 'function') {
          initSync.call(instance.spider, cleanExt);
          console.log('[JarLoader] Spider initialized without Context:', key);
          return;
        }
      } catch (strInitErr: any) {
        console.warn('[JarLoader] init(String) failed:', strInitErr.message);
      }

      try {
        instance.spider.init(context, cleanExt);
        console.log(
          '[JarLoader] Spider initialized (async with Context):',
          key,
        );
      } catch (e: any) {
        console.warn(
          '[JarLoader] Async init(Context, String) failed:',
          e.message,
        );
        try {
          instance.spider.init(cleanExt);
          console.log(
            '[JarLoader] Spider initialized (async, no Context):',
            key,
          );
        } catch (e2: any) {
          console.error(
            '[JarLoader] All init methods failed for:',
            key,
            e2.message,
          );
        }
      }
    } catch (e) {
      console.error('[JarLoader] Failed to init spider:', key, e);
    }
  }

  /**
   * Pre-warm the Quark API connection from Java so the spider's pan resolver
   * (which has a 5-second internal timeout) can complete its first HTTP call
   * within the time limit. Also triggers the Guard spider's static
   * initializer early so the 5s timeout doesn't happen during the
   * user-facing detailContent call.
   */
  private async preWarmForDetailContent(spider: JavaObject): Promise<void> {
    if (!this.java) return;
    try {
      // Read the Quark cookie from JVM SharedPreferences (written by
      // QuarkPanService.syncCookieToJVM). Avoids importing QuarkPanService
      // which isn't a separate module in the bundled output.
      const cookie = this.readQuarkCookieFromJVM();
      if (!cookie) {
        console.log(
          '[JarLoader] preWarm: no Quark cookie in JVM, skipping connection warm-up',
        );
      } else {
        console.log(
          '[JarLoader] preWarm: found Quark cookie, warming up connection (len=' +
            cookie.length +
            ', has __puus=' +
            cookie.includes('__puus') +
            ')',
        );
        await this.preWarmQuarkApiFromJava(cookie);
      }

      // Trigger the static initializer of the class that has the 5s-timeout
      // HTTP call. If the connection is now warm, the static initializer's
      // HTTP call should succeed within 5s. Even if it times out, the method
      // has a catch block that returns "ys" as fallback, so class loading
      // still succeeds.
      this.triggerGuardStaticInit(spider);
    } catch (e: any) {
      console.warn(
        '[JarLoader] preWarmForDetailContent failed:',
        e?.message || e,
      );
    }
  }

  /**
   * Read the Quark cookie from JVM SharedPreferences. QuarkPanService writes
   * the cookie to NewWexFnw_preferences (key: Wex_quark_cookie) and
   * com.github.catvod.tvbox_preferences (keys: mi.quark encrypted, .quark plain).
   * Read from the plain .quark key for simplicity.
   */
  private readQuarkCookieFromJVM(): string | null {
    if (!this.java) return null;
    try {
      const InitClass = this.java.importClass('com.github.catvod.spider.Init');
      const ctx = InitClass.contextSync();
      if (!ctx) return null;
      // Try Guard spider preferences first (NewWexFnw_preferences)
      const guardPrefs = ctx.getSharedPreferencesSync(
        'NewWexFnw_preferences',
        0,
      );
      const guardCookie = guardPrefs.getStringSync('Wex_quark_cookie', '');
      if (guardCookie && guardCookie.length > 10) {
        return guardCookie;
      }
      // Fallback to standard preferences (.quark key, plain text)
      const prefs = ctx.getSharedPreferencesSync(
        'com.github.catvod.tvbox_preferences',
        0,
      );
      const plainCookie = prefs.getStringSync('.quark', '');
      if (plainCookie && plainCookie.length > 10) {
        return plainCookie;
      }
      return null;
    } catch (e: any) {
      console.warn(
        '[JarLoader] readQuarkCookieFromJVM failed:',
        e?.message || e,
      );
      return null;
    }
  }

  /**
   * Set pan cookie static fields on NewQuark/NewPanUc/NewPan115 before
   * detailContent. The spider initializes these fields to "" and only
   * populates them inside oOoO0OoO0oOo0oOo() or playerContent() — neither
   * runs before detailContentVodPlay(). Without this, the pan resolver
   * sends an empty Cookie header → API rejects → empty VodBean → NPE.
   *
   * Static field mapping (verified from decompiled CFR source):
   *   NewQuark.OoOoOo0O0o0oO0o0   ← Wex_quark_cookie  (NewQuark.java:901)
   *   NewPanUc.oOoOo0O0Oo0o0OoO   ← Wex_ucpan_cookie  (NewPanUc.java:611,686)
   *   NewPan115.oOoOoOo0oOo0o0oO  ← Wex_pan115_cookie (NewPan115.java:148,481)
   */
  private setPanCookiesForDetailContent(): void {
    if (!this.java) return;
    try {
      const InitClass = this.java.importClass('com.github.catvod.spider.Init');
      const ctx = InitClass.contextSync();
      if (!ctx) return;
      const guardPrefs = ctx.getSharedPreferencesSync(
        'NewWexFnw_preferences',
        0,
      );

      const panClasses = [
        {
          className: 'com.github.catvod.spider.NewQuark',
          fieldName: 'OoOoOo0O0o0oO0o0',
          prefKey: 'Wex_quark_cookie',
          label: 'quark',
        },
        {
          className: 'com.github.catvod.spider.NewPanUc',
          fieldName: 'oOoOo0O0Oo0o0OoO',
          prefKey: 'Wex_ucpan_cookie',
          label: 'uc',
        },
        {
          className: 'com.github.catvod.spider.NewPan115',
          fieldName: 'oOoOoOo0oOo0o0oO',
          prefKey: 'Wex_pan115_cookie',
          label: '115',
        },
      ];

      for (const pan of panClasses) {
        try {
          const cookie = guardPrefs.getStringSync(pan.prefKey, '');
          if (!cookie || cookie.length < 10) {
            console.log(
              `[JarLoader] setPanCookies: ${pan.label} cookie empty or missing, skipping`,
            );
            continue;
          }
          const cls = this.java.importClass(pan.className);
          cls[pan.fieldName] = cookie;
          console.log(
            `[JarLoader] setPanCookies: set ${pan.label} static cookie (len=${cookie.length})`,
          );
        } catch (e: any) {
          console.warn(
            `[JarLoader] setPanCookies: failed to set ${pan.label} cookie:`,
            e?.message || e,
          );
        }
      }
    } catch (e: any) {
      console.warn(
        '[JarLoader] setPanCookiesForDetailContent failed:',
        e?.message || e,
      );
    }
  }

  /**
   * Make a direct HTTP call to the Quark API from Java to warm up DNS/TLS.
   * Uses Java's HttpURLConnection (always available, no OkHttp version
   * concerns). The JVM-wide DNS cache benefits all subsequent Java HTTP
   * calls including the spider's OkHttp-based pan resolver.
   */
  private async preWarmQuarkApiFromJava(cookie: string): Promise<void> {
    if (!this.java) return;
    const url =
      'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc';
    try {
      const URLClass = this.java.importClass('java.net.URL');
      const urlObj = new URLClass(url);
      const conn = urlObj.openConnectionSync();
      // Set headers matching what the spider sends
      conn.setRequestPropertySync(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
      );
      conn.setRequestPropertySync('Referer', 'https://pan.quark.cn/');
      conn.setRequestPropertySync('Origin', 'https://pan.quark.cn');
      conn.setRequestPropertySync('Cookie', cookie);
      conn.setRequestPropertySync(
        'Accept',
        'application/json, text/plain, */*',
      );
      conn.setConnectTimeoutSync(8000);
      conn.setReadTimeoutSync(8000);
      // java-bridge doesn't auto-generate Sync variants for all methods.
      // getResponseCodeSync may not exist; fall back to async getResponseCode
      // (returns a Promise).
      let code: any;
      if (typeof conn.getResponseCodeSync === 'function') {
        code = conn.getResponseCodeSync();
      } else if (typeof conn.getResponseCode === 'function') {
        code = await conn.getResponseCode();
      }
      console.log('[JarLoader] preWarm Quark API response code:', code);
      // Reading response code is enough to establish DNS/TLS. Don't bother
      // draining the body — the connection is already warmed up and we
      // don't need the response data.
      try {
        if (typeof conn.disconnectSync === 'function') {
          conn.disconnectSync();
        } else if (typeof conn.disconnect === 'function') {
          await conn.disconnect();
        }
      } catch (_) {
        /* ignore */
      }
    } catch (e: any) {
      console.warn(
        '[JarLoader] preWarm Quark API call failed (non-fatal):',
        e?.message || e,
      );
    }
  }

  /**
   * Trigger the static initializer of the Guard spider's pan-resolver class
   * early, so the 5-second-timeout HTTP call happens during init (after
   * pre-warming) instead of during the user-facing detailContent call.
   *
   * The obfuscated merge classes are loaded by the spider JAR's classloader,
   * not the system classloader. Class.forName(name) uses the caller's
   * classloader (system), which can't see these classes →
   * ClassNotFoundException. Instead, get the spider's classloader via
   * spider.getClass().getClassLoader() and use loadClass() to trigger
   * static initialization.
   */
  private triggerGuardStaticInit(spider: JavaObject): void {
    if (!this.java) return;
    const classesToWarm = [
      // Class with static initializer that calls the 5s-timeout HTTP method.
      // Accessing any static field triggers <clinit>.
      'com.github.catvod.spider.merge.oOoOo0O0Oo0o0OoO.OoOoO0O0o0oOoO0O',
      // Class containing the method with the catch block (cached result).
      'com.github.catvod.spider.merge.OoOo0OoOo0oO0O0O.oOoO0Oo0OoOoOoOo',
    ];
    let classLoader: any = null;
    try {
      const spiderClass = spider.getClassSync
        ? spider.getClassSync()
        : spider.getClass();
      classLoader = spiderClass.getClassLoaderSync
        ? spiderClass.getClassLoaderSync()
        : spiderClass.getClassLoader();
    } catch (e: any) {
      console.warn(
        '[JarLoader] preWarm: failed to get spider classloader:',
        e?.message || e,
      );
      return;
    }
    for (const className of classesToWarm) {
      try {
        // loadClass(name) loads but doesn't initialize. Use the 3-arg
        // Class.forName(name, initialize, classloader) to trigger <clinit>.
        const ClassClass = this.java.importClass('java.lang.Class');
        if (typeof ClassClass.forNameSync === 'function') {
          // forName(String, boolean, ClassLoader) — java-bridge may not
          // auto-match overloads, so try the 3-arg form first.
          try {
            ClassClass.forNameSync(className, true, classLoader);
            console.log(
              '[JarLoader] preWarm: triggered static init for',
              className,
            );
            continue;
          } catch (_) {
            /* fall through to loadClass approach */
          }
        }
        // Fallback: use classloader.loadClass(name) then Class.newInstance()
        // to force initialization.
        const loaded = classLoader.loadClassSync
          ? classLoader.loadClassSync(className)
          : classLoader.loadClass(className);
        // loadClass doesn't initialize. Trigger <clinit> by accessing a field
        // via reflection. ForName with initialize=true is the clean way, but
        // java-bridge overload matching may fail. Just logging that we loaded
        // the class is enough — the spider's detailContent will trigger
        // <clinit> on first access anyway, and the connection is now warm.
        console.log(
          '[JarLoader] preWarm: loaded class (clinit deferred to first use):',
          className,
          'init=' + loaded,
        );
      } catch (e: any) {
        console.warn(
          '[JarLoader] preWarm: failed to trigger static init for',
          className,
          ':',
          e?.message || e,
        );
      }
    }
  }

  /**
   * Re-initialize spider with ext config before method call.
   * This ensures Java static state is correct for the current source.
   */
  private reInitSpider(key: string, ext: string): void {
    const instance = this.spiders.get(key);
    if (!instance || !this.java) return;

    try {
      const ContextClass = this.java.importClass('android.content.Context');
      const context = new ContextClass();

      try {
        const initSync = instance.spider.initSync;
        if (initSync && typeof initSync === 'function') {
          initSync.call(instance.spider, context, ext);
          console.log(
            '[JarLoader] reInitSpider success: initSync(Context, String)',
            key,
          );
          return;
        }
      } catch (e: any) {
        console.warn(
          '[JarLoader] reInitSpider failed: initSync(Context, String)',
          key,
          e.message,
        );
      }

      try {
        const initSync = instance.spider.initSync;
        if (initSync && typeof initSync === 'function') {
          initSync.call(instance.spider, ext);
          console.log(
            '[JarLoader] reInitSpider success: initSync(String)',
            key,
          );
          return;
        }
      } catch (e: any) {
        console.warn(
          '[JarLoader] reInitSpider failed: initSync(String)',
          key,
          e.message,
        );
      }

      try {
        instance.spider.init(context, ext);
        console.log(
          '[JarLoader] reInitSpider success: init(Context, String) async',
          key,
        );
      } catch (e: any) {
        console.warn(
          '[JarLoader] reInitSpider failed: init(Context, String)',
          key,
          e.message,
        );
      }
    } catch (e: any) {
      console.error(
        '[JarLoader] reInitSpider failed: import Context',
        key,
        e.message,
      );
    }
  }

  /**
   * Clear all cached spiders and class loaders
   */
  public clear(): void {
    this.spiders.clear();
    this.classLoaders.clear();
    console.log('[JarLoader] Cleared all caches');
  }

  /**
   * Test all sources' homeContent - batch diagnostic.
   * Returns per-source result: status, classCount, videoCount, error, time(ms).
   */
  public async testAllSources(): Promise<
    Array<{
      key: string;
      api: string;
      status: 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
      classCount: number;
      videoCount: number;
      error: string;
      time: number;
    }>
  > {
    const GLOBAL_JAR =
      'https://img2.gelonghui.com/library/e2693-9aa941a0-f96a-40c2-ac23-e6af358d19a7.png;md5;e2693c58ebc58abecc7282b721db79ca';
    const SITES: Array<{ key: string; api: string; ext: string }> = [
      { key: '豆瓣', api: 'csp_Douban', ext: '' },
      { key: '豆瓣预告', api: 'csp_YGP', ext: '' },
      { key: 'config', api: 'csp_Config', ext: '' },
      {
        key: 'csp_FeiMaoUC',
        api: 'csp_Duopan',
        ext: '{"site_urls":["http://shandian.blog/","http://sd.sduc.site/"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"FeiMaoUC"}',
      },
      {
        key: 'csp_Duopan',
        api: 'csp_Duopan',
        ext: '{"site_urls":["http://tvpanpan.site","http://feimo.fun","http://xiaocgege.shop","http://www.xiaocgege.shop","https://www.xiaocge.fun"],"threadinfo":{"chunksize":512,"threads":16},"url_key":"Duopan2"}',
      },
      {
        key: 'csp_Netfixtv',
        api: 'csp_Duopan',
        ext: '{"site_urls":["https://www.zhizhen8.click","https://pan.mihdr.top","https://www.zhizhen1.top","https://www.mihdr.top","https://www.miqk.cc"],"url_key":"Netfixtv2","threadinfo":{"chunksize":512,"threads":16}}',
      },
      { key: '潮流', api: 'csp_AppRJ', ext: 'http://v.rbotv.cn' },
      {
        key: '肥猫',
        api: 'csp_AppGet',
        ext: 'https://cms140.yhg.one|bM7iC9eA3oZ1nB7z',
      },
      {
        key: '干饭',
        api: 'csp_AppGet',
        ext: 'https://mk1080.top/get.txt|c60d88b2eep53za8',
      },
      {
        key: '光盘',
        api: 'csp_AppQi',
        ext: 'https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt|FTgP4Gq8zPiqbt7M',
      },
      {
        key: '行动',
        api: 'csp_AppQi',
        ext: 'https://qj4.catbb.xyz|eecbio48dsq13kkk',
      },
      {
        key: '再来',
        api: 'csp_AppGet',
        ext: 'https://vv.229d.cn|8888888888888888',
      },
      {
        key: '一碗',
        api: 'csp_AppGet',
        ext: 'https://app.95112475.xyz|5a9w6x58dsq6z3a6',
      },
      {
        key: '蔬菜',
        api: 'csp_AppGet',
        ext: 'https://gitee.com/wmmoliill/wimg/raw/master/img/bk/9.txt|88689667dce61725',
      },
      {
        key: '永永',
        api: 'csp_AppGet',
        ext: 'https://444421.xyz|#getapp@TMD@2025|120',
      },
      { key: 'csp_Jpys', api: 'csp_Jpys', ext: '' },
      {
        key: 'csp_Wwys',
        api: 'csp_Wwys',
        ext: 'https://vip.wwgz.cn:5200',
      },
      { key: '荐片', api: 'csp_Jianpian', ext: 'https://api.ztcgi.com' },
      { key: 'csp_SaoHuo', api: 'csp_SaoHuo', ext: 'https://shdy5.us' },
      { key: 'csp_Gz360', api: 'csp_Gz360', ext: '' },
      {
        key: '厂长',
        api: 'csp_Czsapp',
        ext: 'https://www.czzy89.com',
      },
      { key: 'csp_SP360', api: 'csp_SP360', ext: '' },
      {
        key: 'csp_Bili',
        api: 'csp_Bili',
        ext: '{"json":"https://nos.netease.com/ysf/0075389dca9afadd4614e9713765ff17.txt","cookie":""}',
      },
      { key: 'csp_Dm84', api: 'csp_Dm84', ext: 'https://dm84.net' },
      {
        key: '方舟',
        api: 'csp_AppGet',
        ext: 'https://www.cyfz.top|e72cdfd629e8895d',
      },
      {
        key: '番薯',
        api: 'csp_AppGet',
        ext: 'https://new.app.bytegooty.com|N4yj7l7xKxHF4*gz',
      },
      { key: 'csp_FirstAid', api: 'csp_FirstAid', ext: '' },
      {
        key: '酷狗',
        api: 'csp_Kugou',
        ext: '{"classes":[{"type_name":"酷狗","type_id":"kugou"}]}',
      },
      {
        key: 'MTV',
        api: 'csp_Bili',
        ext: '{"json":"https://img2.gelonghui.com/library/2b4eb-8fb08a6b-f9f1-48d8-816a-1bc712a85fefnull","cookie":""}',
      },
      { key: '看球', api: 'csp_Kanqiu', ext: '' },
      { key: '瓜子', api: 'csp_GuaziTY', ext: '' },
      {
        key: '米搜',
        api: 'csp_MiSou',
        ext: 'http://127.0.0.1:9978/file/fatcat/kk.txt',
      },
      {
        key: 'csp_PanSearch',
        api: 'csp_PanSearch',
        ext: 'http://127.0.0.1:9978/file/fatcat/token.txt',
      },
      {
        key: 'csp_少儿',
        api: 'csp_Bili',
        ext: '{"json":"https://img2.gelonghui.com/library/1903b-eb0f1675-2437-4e72-bcf0-427b1626d79fnull","cookie":""}',
      },
      {
        key: 'csp_小学',
        api: 'csp_Bili',
        ext: '{"json":"https://img2.gelonghui.com/library/a1140-144855fe-3eaa-44f3-b689-6812c233de54null","cookie":""}',
      },
      {
        key: 'csp_初中',
        api: 'csp_Bili',
        ext: '{"json":"https://img2.gelonghui.com/library/ba156-73e16cad-8257-4f33-b8c0-e051e72e546dnull","cookie":""}',
      },
      {
        key: 'csp_高中',
        api: 'csp_Bili',
        ext: '{"json":"https://img2.gelonghui.com/library/e44b3-4a82ab48-e014-49b2-bb66-ee5207e8f195null","cookie":""}',
      },
      { key: 'push_agent', api: 'csp_Push', ext: '.json/txt/ken.txt' },
    ];

    console.log(`[JarLoader] testAllSources: testing ${SITES.length} sources`);

    // Load JAR first
    const jarLoaded = await this.loadJar(GLOBAL_JAR, '', false);
    if (!jarLoaded) {
      console.error('[JarLoader] testAllSources: JAR load failed');
      return SITES.map((s) => ({
        key: s.key,
        api: s.api,
        status: 'ERROR' as const,
        classCount: 0,
        videoCount: 0,
        error: 'JAR load failed: ' + this.getLastError(),
        time: 0,
      }));
    }

    const results: Array<{
      key: string;
      api: string;
      status: 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
      classCount: number;
      videoCount: number;
      error: string;
      time: number;
    }> = [];

    for (let i = 0; i < SITES.length; i++) {
      const site = SITES[i];
      // getSpider expects the raw api (e.g. "csp_Bili") and parses the class
      // name internally — do NOT pre-prefix with the package name.
      const className = site.api;
      const result = {
        key: site.key,
        api: site.api,
        status: 'ERROR' as const,
        classCount: 0,
        videoCount: 0,
        error: '',
        time: 0,
      };
      const t0 = Date.now();
      try {
        console.log(
          `[JarLoader] testAllSources [${i + 1}/${SITES.length}] ${site.key} (${site.api})`,
        );

        // Get spider
        const gotSpider = this.getSpider(
          site.key,
          className,
          site.ext,
          GLOBAL_JAR,
        );
        if (!gotSpider) {
          result.error = 'getSpider failed: ' + this.getLastError();
          result.time = Date.now() - t0;
          results.push(result);
          console.log(
            `[JarLoader] testAllSources ✗ ${site.key}: ${result.error}`,
          );
          continue;
        }

        // Init spider
        await this.initSpider(site.key, site.ext);

        // Call homeContent with 30s timeout
        const homePromise = this.callSpiderMethod(site.key, 'homeContent', [
          true,
        ]);
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('homeContent timeout 45s')), 45000),
        );
        const homeStr = await Promise.race([homePromise, timeoutPromise]);

        let parsed: any = {};
        try {
          parsed = JSON.parse(homeStr || '{}');
        } catch {
          parsed = {};
        }
        const classes = parsed.class || parsed.classes || [];
        const list = parsed.list || [];
        result.classCount = classes.length;
        result.videoCount = list.length;
        result.time = Date.now() - t0;

        if (classes.length > 0 || list.length > 0) {
          result.status = 'OK';
          console.log(
            `[JarLoader] testAllSources ✓ ${site.key}: ${classes.length} classes, ${list.length} videos (${result.time}ms)`,
          );
        } else {
          result.status = 'EMPTY';
          console.log(
            `[JarLoader] testAllSources ⚠ ${site.key}: empty (${result.time}ms)`,
          );
        }
      } catch (e: any) {
        result.status = e.message?.includes('timeout') ? 'TIMEOUT' : 'ERROR';
        result.error = (e.message || String(e)).substring(0, 150);
        result.time = Date.now() - t0;
        console.log(
          `[JarLoader] testAllSources ✗ ${site.key}: ${result.error} (${result.time}ms)`,
        );
      }
      results.push(result);
    }

    const ok = results.filter((r) => r.status === 'OK');
    const empty = results.filter((r) => r.status === 'EMPTY');
    const failed = results.filter(
      (r) => r.status === 'ERROR' || r.status === 'TIMEOUT',
    );
    console.log(
      `[JarLoader] testAllSources done: OK=${ok.length}/${results.length}, EMPTY=${empty.length}, FAILED=${failed.length}`,
    );

    return results;
  }

  /**
   * Test Guard spiders using the pre-decrypted wexguard-spider-enjarify.jar.
   * This bypasses the outer JAR and loads the real spider class directly.
   * Verifies translateGuardOutput works correctly.
   */
  public async testGuardSources(): Promise<
    Array<{
      key: string;
      api: string;
      status: 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
      classCount: number;
      videoCount: number;
      filterCount: number;
      translated: boolean;
      error: string;
      time: number;
    }>
  > {
    const SITES: Array<{ key: string; api: string; ext: string }> = [
      {
        key: 'NewGuanYing',
        api: 'csp_NewGuanYingGuard',
        ext: '',
      },
      {
        key: 'NewDouBan',
        api: 'csp_NewDouBanGuard',
        ext: 'https://cdn.waimaimingtang.com/file/images/bwc/20260414181247-ae51abfbfe.txt',
      },
      {
        key: 'NewErXiao',
        api: 'csp_NewErXiaoGuard',
        ext: '',
      },
      {
        key: 'NewWogg',
        api: 'csp_NewWoggGuard',
        ext: '',
      },
      {
        key: 'NewMuOu',
        api: 'csp_NewMuOuGuard',
        ext: '',
      },
    ];

    console.log(
      `[JarLoader] testGuardSources: testing ${SITES.length} Guard sources`,
    );

    const results: Array<{
      key: string;
      api: string;
      status: 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT';
      classCount: number;
      videoCount: number;
      filterCount: number;
      translated: boolean;
      error: string;
      time: number;
    }> = [];

    for (let i = 0; i < SITES.length; i++) {
      const site = SITES[i];
      const result = {
        key: site.key,
        api: site.api,
        status: 'ERROR' as const,
        classCount: 0,
        videoCount: 0,
        filterCount: 0,
        translated: false,
        error: '',
        time: 0,
      };
      const t0 = Date.now();
      try {
        console.log(
          `[JarLoader] testGuardSources [${i + 1}/${SITES.length}] ${site.key} (${site.api})`,
        );

        // getSpider will detect Guard suffix and load wexguard-spider-enjarify.jar
        const gotSpider = this.getSpider(site.key, site.api, site.ext, '');
        if (!gotSpider) {
          result.error = 'getSpider failed: ' + this.getLastError();
          result.time = Date.now() - t0;
          results.push(result);
          console.log(
            `[JarLoader] testGuardSources ✗ ${site.key}: ${result.error}`,
          );
          continue;
        }

        await this.initSpider(site.key, site.ext);

        const homePromise = this.callSpiderMethod(site.key, 'homeContent', [
          true,
        ]);
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('homeContent timeout 30s')), 30000),
        );
        const homeStr = await Promise.race([homePromise, timeoutPromise]);

        let parsed: any = {};
        try {
          parsed = JSON.parse(homeStr || '{}');
        } catch {
          parsed = {};
        }
        const classes = parsed.class || parsed.classes || [];
        const list = parsed.list || [];
        const filters = parsed.filters || {};
        result.classCount = classes.length;
        result.videoCount = list.length;
        result.filterCount = Object.keys(filters).length;
        // Check if translation was applied (standard field names present)
        result.translated =
          classes.length > 0 || list.length > 0 || result.filterCount > 0;
        result.time = Date.now() - t0;

        if (classes.length > 0 || list.length > 0 || result.filterCount > 0) {
          result.status = 'OK';
          console.log(
            `[JarLoader] testGuardSources ✓ ${site.key}: ${classes.length} classes, ${list.length} videos, ${result.filterCount} filters (${result.time}ms)`,
          );
        } else {
          result.status = 'EMPTY';
          console.log(
            `[JarLoader] testGuardSources ⚠ ${site.key}: empty (${result.time}ms)`,
          );
        }
      } catch (e: any) {
        result.status = e.message?.includes('timeout') ? 'TIMEOUT' : 'ERROR';
        result.error = (e.message || String(e)).substring(0, 200);
        result.time = Date.now() - t0;
        console.log(
          `[JarLoader] testGuardSources ✗ ${site.key}: ${result.error} (${result.time}ms)`,
        );
      }
      results.push(result);
    }

    const ok = results.filter((r) => r.status === 'OK');
    const empty = results.filter((r) => r.status === 'EMPTY');
    const failed = results.filter(
      (r) => r.status === 'ERROR' || r.status === 'TIMEOUT',
    );
    console.log(
      `[JarLoader] testGuardSources done: OK=${ok.length}/${results.length}, EMPTY=${empty.length}, FAILED=${failed.length}`,
    );

    return results;
  }

  /**
   * Get recent JAR key
   */
  public getRecentJarKey(): string {
    return this.recentJarKey;
  }

  /**
   * Set the most recent spider key used for playerContent.
   * Called when playerContent is invoked to track which spider
   * should handle proxy requests.
   */
  public setRecentSpider(key: string, type: 'jar' | 'js' | 'py'): void {
    this.recentSpiderKey = key;
    this.recentSpiderType = type;
    console.log('[JarLoader] setRecentSpider: key=', key, 'type=', type);
  }

  /**
   * Get the most recent spider key used for playerContent.
   */
  public getRecentSpiderKey(): string | null {
    return this.recentSpiderKey;
  }

  /**
   * Call spider's static Proxy.proxy(Map<String,String>) method.
   * Used by the local proxy server to handle /proxy?do=... requests.
   *
   * Returns Object[]{int statusCode, String mime, InputStream stream, Map<String,String> headers?}
   * or null if the method returns null / fails.
   *
   * Now prioritizes calling spider.proxyLocal() if a recentSpiderKey is set,
   * falling back to Proxy.proxy() if that fails. This mirrors Android's
   * ApiConfig.proxyLocal() flow for better compatibility with spider-specific
   * proxy logic (encryption/decryption, CDN scheduling, etc.).
   */
  public async proxyInvokeAsync(params: Record<string, string>): Promise<{
    status: number;
    mime: string;
    stream: any;
    headers?: Record<string, string>;
  } | null> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.proxyInvoke(params));
      }, 0);
    });
  }

  public proxyInvoke(params: Record<string, string>): {
    status: number;
    mime: string;
    stream: any;
    headers?: Record<string, string>;
  } | null {
    // Step 1: Try spider.proxyLocal() if recentSpiderKey is set
    if (this.recentSpiderKey) {
      const spiderResult = this.callSpiderProxyLocal(params);
      if (spiderResult) {
        console.log(
          '[JarLoader] proxyInvoke: spider.proxyLocal succeeded for do=',
          params['do'],
        );
        return spiderResult;
      }
      console.log(
        '[JarLoader] proxyInvoke: spider.proxyLocal failed/null, falling back to Proxy.proxy',
      );
    }

    // Step 2: Fallback to Proxy.proxy() static method
    return this.proxyInvokeStatic(params);
  }

  /**
   * Call the spider instance's proxyLocal(Map<String,String>) method.
   * Returns Object[]{int statusCode, String mime, InputStream stream, Map<String,String> headers?}
   * or null if the spider is not found or the method fails.
   */
  private callSpiderProxyLocal(params: Record<string, string>): {
    status: number;
    mime: string;
    stream: any;
    headers?: Record<string, string>;
  } | null {
    if (!this.java) return null;

    const spiderInstance = this.spiders.get(this.recentSpiderKey!);
    if (!spiderInstance) {
      console.warn(
        '[JarLoader] callSpiderProxyLocal: spider not found, key=',
        this.recentSpiderKey,
      );
      return null;
    }

    try {
      const HashMap = this.java.importClass('java.util.HashMap');
      const map = new HashMap();
      for (const [k, v] of Object.entries(params)) {
        map.putSync(k, v);
      }

      console.log(
        '[JarLoader] callSpiderProxyLocal: calling spider.proxyLocal for key=',
        this.recentSpiderKey,
        'do=',
        params['do'],
      );

      // Debug: Check spider object methods
      try {
        const spiderObj = spiderInstance.spider;
        const methods = Object.keys(spiderObj).filter(
          (k) => typeof spiderObj[k] === 'function',
        );
        console.log(
          '[JarLoader] callSpiderProxyLocal: spider methods=',
          methods.slice(0, 20).join(', '),
        );

        // Try the spider's own static proxy(Map) method (WexHanXiaoQuan, etc.)
        // Static methods are available on the class, not on the instance
        try {
          const spiderClass = spiderInstance.spider.getClassSync
            ? spiderInstance.spider.getClassSync()
            : spiderInstance.spider.getClass();
          if (spiderClass && typeof spiderClass.proxySync === 'function') {
            console.log(
              '[JarLoader] callSpiderProxyLocal: using static proxySync on spider class',
            );
            const result = spiderClass.proxySync(map);
            if (result) {
              return this.parseProxyResult(result);
            }
          }
        } catch (classErr: any) {
          console.log(
            '[JarLoader] callSpiderProxyLocal: static proxy attempt failed:',
            classErr.message,
          );
        }

        // Check for obfuscated method names (韩剧源使用混淆后的方法名)
        // The obfuscated proxyLocal method name pattern: oOoOoOoOoOoOoO0o
        const obfuscatedProxyLocalSync = 'oOoOoOoOoOoOoO0oSync';
        if (typeof spiderObj[obfuscatedProxyLocalSync] === 'function') {
          console.log(
            '[JarLoader] callSpiderProxyLocal: using obfuscated method',
            obfuscatedProxyLocalSync,
          );
          const result = spiderObj[obfuscatedProxyLocalSync](map);
          if (result) {
            return this.parseProxyResult(result);
          }
        }

        // Fallback: Try other variations including obfuscated names
        const possibleMethods = [
          'proxyLocal',
          'proxy',
          'localProxy',
          'oOoOoOoOoOoOoO0o',
        ];
        for (const methodName of possibleMethods) {
          if (typeof spiderObj[methodName] === 'function') {
            console.log(
              '[JarLoader] callSpiderProxyLocal: trying method=',
              methodName,
            );
            try {
              const result = spiderObj[methodName](map);
              if (result) {
                return this.parseProxyResult(result);
              }
            } catch {}
          }
        }

        console.log(
          '[JarLoader] callSpiderProxyLocal: no suitable method found on spider instance',
        );
        return null;
      } catch (debugError: any) {
        console.error(
          '[JarLoader] callSpiderProxyLocal debug error:',
          debugError.message || debugError,
        );
        return null;
      }
    } catch (e: any) {
      console.error('[JarLoader] callSpiderProxyLocal error:', e.message || e);
      return null;
    }
  }

  private parseProxyResult(result: any): {
    status: number;
    mime: string;
    stream: any;
    headers?: Record<string, string>;
  } | null {
    const arr = result as any[];
    if (!arr || arr.length < 3) {
      console.warn(
        '[JarLoader] parseProxyResult: array length < 3, insufficient',
      );
      return null;
    }

    const status = typeof arr[0] === 'number' ? arr[0] : 200;
    const mime =
      typeof arr[1] === 'string' ? arr[1] : 'application/octet-stream';
    const stream = arr[2];

    let headers: Record<string, string> | undefined;
    if (arr.length >= 4 && arr[3]) {
      try {
        const headerMap = arr[3];
        const keys = headerMap.keySetSync().toArraySync();
        headers = {};
        for (let i = 0; i < keys.length; i++) {
          const k = String(keys[i]);
          headers[k] = String(headerMap.getSync(keys[i]));
        }
      } catch {
        // headers optional
      }
    }

    console.log(
      '[JarLoader] parseProxyResult: success, status=',
      status,
      'mime=',
      mime,
    );
    return { status, mime, stream, headers };
  }

  /**
   * Call Proxy.proxy() static method (fallback).
   * This is the original implementation before spider.proxyLocal support.
   */
  private proxyInvokeStatic(params: Record<string, string>): {
    status: number;
    mime: string;
    stream: any;
    headers?: Record<string, string>;
  } | null {
    if (!this.java) {
      console.warn(
        '[JarLoader] proxyInvokeStatic: java instance not available',
      );
      return null;
    }
    try {
      const ProxyClass = this.java.importClass(
        'com.github.catvod.spider.ProxyOrigin',
      );
      const HashMap = this.java.importClass('java.util.HashMap');
      const map = new HashMap();
      for (const [k, v] of Object.entries(params)) {
        map.putSync(k, v);
      }
      console.log(
        '[JarLoader] proxyInvokeStatic: calling Proxy.proxy with do=',
        params['do'],
        'url=',
        params['url'] ? params['url'].substring(0, 80) + '...' : 'none',
      );
      const result = ProxyClass.proxySync(map);
      if (!result) {
        console.warn(
          '[JarLoader] proxyInvokeStatic: Proxy.proxy returned null for do=',
          params['do'],
        );
        return null;
      }
      const arr = result as any[];
      console.log(
        '[JarLoader] proxyInvokeStatic: Proxy.proxy returned array length=',
        arr.length,
        'status=',
        arr[0],
        'mime=',
        arr[1],
      );
      if (arr.length < 3) {
        console.warn(
          '[JarLoader] proxyInvokeStatic: array length < 3, insufficient',
        );
        return null;
      }
      const status = typeof arr[0] === 'number' ? arr[0] : 200;
      const mime =
        typeof arr[1] === 'string' ? arr[1] : 'application/octet-stream';
      const stream = arr[2];
      let headers: Record<string, string> | undefined;
      if (arr.length >= 4 && arr[3]) {
        try {
          const headerMap = arr[3];
          const keys = headerMap.keySetSync().toArraySync();
          headers = {};
          for (let i = 0; i < keys.length; i++) {
            const k = String(keys[i]);
            headers[k] = String(headerMap.getSync(keys[i]));
          }
        } catch {
          // headers optional
        }
      }
      return { status, mime, stream, headers };
    } catch (e: any) {
      console.error('[JarLoader] proxyInvokeStatic error:', e.message || e);
      return null;
    }
  }

  /**
   * Read bytes from a Java InputStream into a Buffer.
   * Returns the full contents (for small streams) - for large streams use streamJavaToNode.
   *
   * Uses InputStream.readNBytes(int) which returns a Java byte[] that
   * java-bridge auto-converts to a Node.js Buffer. This avoids the
   * copy-semantics issue where passing a Buffer to read(byte[]) doesn't
   * propagate writes back to the Node.js Buffer.
   */
  public readJavaInputStream(
    stream: any,
    maxBytes: number = 50 * 1024 * 1024,
  ): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = stream.readNBytesSync(64 * 1024);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) break;
      chunks.push(buf);
      total += buf.length;
      if (total > maxBytes) {
        console.warn('[JarLoader] InputStream exceeded maxBytes, truncating');
        break;
      }
    }
    try {
      stream.closeSync();
    } catch (_) {}
    return Buffer.concat(chunks);
  }

  /**
   * Stream a Java InputStream to a Node.js Writable (HTTP response).
   * Reads in chunks and writes with backpressure handling.
   *
   * Uses InputStream.readNBytes(int) which returns a Java byte[] that
   * java-bridge auto-converts to a Node.js Buffer.
   */
  public streamJavaToNode(
    stream: any,
    writable: any,
    onDone: () => void,
    onError: (e: any) => void,
  ): void {
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        stream.closeSync();
      } catch {}
    };

    const readNext = () => {
      if (closed) return;
      try {
        const chunk = stream.readNBytesSync(16 * 1024);
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (buf.length === 0) {
          cleanup();
          onDone();
          return;
        }
        const ok = writable.write(buf);
        if (!ok) {
          writable.once('drain', () => setImmediate(readNext));
        } else {
          setImmediate(readNext);
        }
      } catch (e: any) {
        cleanup();
        onError(e);
      }
    };

    writable.on('close', () => {
      cleanup();
    });
    writable.on('error', () => {
      cleanup();
    });
    setImmediate(readNext);
  }
}

// Singleton instance
export const jarLoader = new JarLoader();

// IPC Handlers - register in main.ts
export function registerJarLoaderIPC(): void {
  // Load JAR - returns {success: boolean, error: string}
  ipcMain.handle(
    'jar:load',
    async (event, jarUrl: string, md5?: string, useCache?: boolean) => {
      // Set progress callback to send events to renderer
      jarLoader.setProgressCallback(
        (stage: string, message: string, percent: number) => {
          try {
            event.sender.send('jar:progress', { stage, message, percent });
          } catch (e) {
            // Ignore send errors
          }
        },
      );

      const success = await jarLoader.loadJar(
        jarUrl,
        md5 || '',
        useCache || false,
      );
      return {
        success,
        error: success ? '' : jarLoader.getLastError(),
      };
    },
  );

  // Get last error
  ipcMain.handle('jar:getLastError', async () => {
    return jarLoader.getLastError();
  });

  // Get Spider
  ipcMain.handle(
    'jar:getSpider',
    async (
      _event,
      key: string,
      className: string,
      ext: string,
      jarUrl?: string,
    ) => {
      const success = await jarLoader.getSpider(
        key,
        className,
        ext,
        jarUrl || '',
      );
      return {
        success,
        error: success ? '' : jarLoader.getLastError(),
      };
    },
  );

  // Init Spider
  ipcMain.handle('jar:initSpider', async (_event, key: string, ext: string) => {
    await jarLoader.initSpider(key, ext);
    return true;
  });

  // Call Spider Method
  ipcMain.handle(
    'jar:callMethod',
    async (
      _event,
      key: string,
      method: string,
      args: any[],
      extraCookies?: Record<string, string>,
    ) => {
      // 在调用 spider 方法前，同步网盘 cookie 到 JVM SharedPreferences
      if (extraCookies && method === 'playerContent') {
        console.log(
          '[JarLoader] jar:callMethod received cookies:',
          Object.keys(extraCookies).map(
            (k) => `${k}(len=${extraCookies[k].length})`,
          ),
        );
        try {
          if (extraCookies.quark) {
            await QuarkPanService.syncCookieToJVM(extraCookies.quark);
          }
        } catch (e: any) {
          console.error('[JarLoader] Failed to sync cookies:', e.message);
        }
      }
      return jarLoader.callSpiderMethod(key, method, args);
    },
  );

  // Debug: list spider methods
  ipcMain.handle('jar:listSpiderMethods', async (_event, key: string) => {
    return jarLoader.listSpiderMethods(key);
  });

  // SharedPreferences: get all names
  ipcMain.handle('jar:prefs:getNames', async () => {
    try {
      const ContextClass = jarLoader.java.importClass(
        'android.content.Context',
      );
      const names = ContextClass.getAllSharedPreferencesNamesSync();
      return { success: true, names: names || [] };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // SharedPreferences: get value
  ipcMain.handle(
    'jar:prefs:getValue',
    async (_event, prefName: string, key: string) => {
      try {
        const ContextClass = jarLoader.java.importClass(
          'android.content.Context',
        );
        const prefs = ContextClass.getSharedPreferencesByNameSync(prefName);
        if (!prefs) {
          return {
            success: false,
            error: 'Preferences not found: ' + prefName,
          };
        }
        const value = prefs.getValueSync(key);
        return { success: true, value: value || null };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },
  );

  // SharedPreferences: set value
  ipcMain.handle(
    'jar:prefs:setValue',
    async (_event, prefName: string, key: string, value: string) => {
      try {
        const ContextClass = jarLoader.java.importClass(
          'android.content.Context',
        );
        const prefs = ContextClass.getSharedPreferencesByNameSync(prefName);
        if (!prefs) {
          // Create it by calling getSharedPreferences
          const context = new (jarLoader.java.importClass(
            'android.content.Context',
          ))();
          context.getSharedPreferencesSync(prefName, 0);
          const prefs2 = ContextClass.getSharedPreferencesByNameSync(prefName);
          if (prefs2) {
            prefs2.setValueSync(key, value);
          }
        } else {
          prefs.setValueSync(key, value);
        }
        console.log(
          `[JarLoader] prefs:setValue ${prefName}/${key}=${value ? value.substring(0, 50) + '...' : 'null'}`,
        );
        return { success: true };
      } catch (e: any) {
        console.error('[JarLoader] prefs:setValue error:', e.message);
        return { success: false, error: e.message };
      }
    },
  );

  // Clear
  ipcMain.handle('jar:clear', async () => {
    jarLoader.clear();
    return true;
  });

  // Clear spider file cache directory
  ipcMain.handle('jar:clearSpiderCache', async (_event, spiderKey: string) => {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const spiderCacheDir = path.join(
        tmpDir,
        'tvbox_' + jarLoader.sanitizeSpiderKey(spiderKey),
      );
      if (fs.existsSync(spiderCacheDir)) {
        fs.rmSync(spiderCacheDir, { recursive: true, force: true });
        console.log('[JarLoader] Cleared spider file cache:', spiderCacheDir);
        return { success: true };
      }
      return { success: false, error: 'Cache directory not found' };
    } catch (e: any) {
      console.error('[JarLoader] clearSpiderCache error:', e.message);
      return { success: false, error: e.message };
    }
  });

  // Test all sources' homeContent - returns array of per-source results
  ipcMain.handle('jar:testAllSources', async () => {
    return jarLoader.testAllSources();
  });

  ipcMain.handle('jar:testGuardSources', async () => {
    return jarLoader.testGuardSources();
  });

  console.log('[JarLoader] IPC handlers registered');

  // Kick off Guard spider JAR preloading in the background so that when the
  // user clicks a Guard source (e.g. WexGuaZiGuard), the heavy InitOrigin.init()
  // network I/O has already completed. This keeps the main window responsive
  // because getSpider() just awaits the promise rather than starting the work
  // synchronously on the IPC call.
  jarLoader.preloadGuardSpiderJar();
}
