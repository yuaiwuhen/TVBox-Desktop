/**
 * JarLoader - JAR Spider Loader for Electron Main Process
 *
 * Implements PNG steganography extraction and JAR loading using java-bridge.
 * Supports DEX to JAR conversion for Android DEX files.
 * Based on Box Android's ApiConfig.java and JarLoader.java implementation.
 *
 * NOTE: stub Init.class now includes lj(), show(), getActivity(), get(),
 *       init(Context), N0(), classLoader() — see tools/stubs/.../Init.java.
 *       Updated in both tools/ and tools/runtime/ stub JARs.
 */

import { ipcMain, BrowserWindow, app } from 'electron';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { exec as execCb, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { DexConverter, dexConverter } from './DexConverter';
import { GuardDecryptor, type DecryptProgress } from './GuardDecryptor';
// Top-level imports instead of dynamic require() — vite bundles dynamic
// require('./QuarkPanService') as createRequire(import.meta.url) which points
// at dist-electron/main.js, where ./QuarkPanService doesn't exist as a file
// (it's already inlined into the bundle). ESM circular deps are safe here
// because neither QuarkPanService nor ProxyServer uses jarLoader at
// module-load time — only inside method bodies.
import { QuarkPanService } from './QuarkPanService';
import { UCPanService } from './UCPanService';
import { BaiduPanService } from './BaiduPanService';
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
  isPackagedElectron?: boolean;
}

interface JavaBridge {
  classpath: { append: (path: string) => void; get: () => string[] };
  importClass(className: string): JavaClass;
  appendClasspath(path: string | string[]): void;
  ensureJvm(options?: JVMOptions): boolean;
  getClassLoader(): any;
  setClassLoader(loader: any): void;
  // Clear the class proxy cache. Must be called after setClassLoader()
  // so importClass() re-imports the class via the new classloader instead
  // of returning a cached proxy bound to the previous classloader.
  clearClassProxies(): void;
}

// Spider instance cache
interface SpiderInstance {
  spider: JavaObject;
  className: string;
  ext: string;
  isGuard: boolean;
  initPromise: Promise<void> | null;
  // Per-spider isolated URLClassLoader (undefined for Guard spiders, which
  // use the shared wexguard-spider-enjarify.jar via appendClasspath).
  // callSpiderMethod switches java.classLoader to this before invoking
  // spider methods so java-bridge's native Class.forName() resolves spider
  // classes from THIS spider's JAR (not the shared stubs classloader).
  classLoader?: any;
}

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

export class JarLoader {
  private classLoaders: Map<string, boolean> = new Map();
  private spiders: Map<string, SpiderInstance> = new Map();
  // Per-spider URLClassLoader to avoid cross-JAR class conflicts.
  // Each spider JAR gets its own classloader with the system classloader
  // (which has stubs) as parent. This prevents classes like
  // com.github.catvod.spider.merge.e from conflicting across JARs.
  private spiderClassLoaders: Map<string, any> = new Map();
  // Cached reference to the system classloader (has stubs from ensureJvm)
  private systemClassLoader: any = null;
  // Cached reference to java-bridge's internal classloader. Saved at startup
  // before any setClassLoader call. Used as a fallback when
  // createSpiderClassLoader fails (e.g. SpiderClassLoaderHelper throws) and
  // the spider JAR is loaded via appendClasspath instead. Without this,
  // instance.classLoader is undefined, callSpiderMethod doesn't switch
  // classloaders, and retry-path importClass() fails with ClassNotFoundException
  // because the current classloader doesn't have the spider JAR.
  private internalClassLoader: any = null;
  // Cached classloader AFTER wexguard-spider-enjarify.jar was added via
  // appendClasspath in loadGuardSpiderJar(). The cached internalClassLoader
  // above is captured BEFORE any appendClasspath call, so it cannot see
  // Guard spider classes. Guard spider getSpider()/callSpiderMethod() must
  // switch to THIS classloader so importClass resolves NewWogg/NewZhiZhen/etc.
  private guardClassLoader: any = null;
  private guardDecryptor: GuardDecryptor | null = null;
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

  // Case-insensitive class name lookup for Guard spiders. Config API names
  // use lowercase (e.g. csp_WexzhizhenGuard → "Wexzhizhen") but JAR classes
  // use CamelCase (e.g. "NewZhiZhen"). Map from lowercaseSimpleName → actual
  // full class name (e.g. "wexzhizhen" → "com.github.catvod.spider.NewZhiZhen").
  private guardClassNameMap: Map<string, string> = new Map();

  // Per-JAR class name lookup for non-Guard spiders. Keyed by jarKey →
  // (lowercase simple name → full class name). Populated after loadJarFile()
  // succeeds by listing the JAR's entries with `jar tf`. Used as a fallback
  // when generateSpiderClassCandidates() fails to match the actual class
  // (e.g. config API is "csp_XBPQ" but JAR class is "XbPq" or "XBPQHiker").
  private jarClassNameMap: Map<string, Map<string, string>> = new Map();

  // True after InitOrigin.init() has been called once to download native
  // libraries (libLoadNiMa.so etc) for unidbg emulation. Set by
  // ensureNativeLibsLoaded() — called from both loadGuardSpiderJar() and
  // loadJarFile() — so non-Guard spiders with native methods (e.g. Douban,
  // Youtube, TgYunDouBanPan) also have the libs available.
  private nativeLibsInitialized: boolean = false;
  private nativeLibsInitPromise: Promise<void> | null = null;

  constructor() {
    // Install global error handlers to capture all Java-related errors
    this.installGlobalErrorHandlers();
    // Initialize java-bridge
    this.java = this.initJavaBridge();
    // Cache the system classloader for per-spider URLClassLoader creation.
    // The system classloader has the stub JARs from ensureJvm's classpath.
    if (this.java) {
      try {
        const ClassLoader = this.java.importClass('java.lang.ClassLoader');
        this.systemClassLoader = ClassLoader.getSystemClassLoaderSync();
        console.log(
          '[JarLoader] Cached system classloader for per-spider isolation',
        );
      } catch (e: any) {
        console.warn(
          '[JarLoader] Failed to cache system classloader:',
          e.message,
        );
      }
      // Cache java-bridge's internal classloader BEFORE any setClassLoader
      // call. This is the classloader that appendClasspath adds JARs to, and
      // is used as a fallback when createSpiderClassLoader fails.
      try {
        this.internalClassLoader = this.java.getClassLoader();
        console.log(
          '[JarLoader] Cached internal classloader for fallback isolation',
        );
      } catch (e: any) {
        console.warn(
          '[JarLoader] Failed to cache internal classloader:',
          e.message,
        );
      }
    }
    // Create cache directory.
    // Packaged installs go to Program Files (read-only), so write cache to
    // %APPDATA%/tvbox-pc/ instead. Dev mode keeps using cwd for backward
    // compat with existing caches.
    const baseDir = app.isPackaged ? app.getPath('userData') : process.cwd();
    this.jarCacheDir = path.join(baseDir, 'jar_cache');
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
    // WexGuaZiGuard / GuaziAmns need unidbg for LoadNiMa.decode() native method
    // Other sources may have different requirements - this mapping is isolated
    const specialSources = new Set([
      'WexGuaZiGuard', // 瓜子源(Guard)：需要 unidbg 加载 libLoadNiMa.so
      'GuaziAmns', // 瓜子源(Amns)：同上，wexguard加密壳
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
   * Ensure native libraries (libLoadNiMa.so) are downloaded and available
   * for unidbg emulation. Idempotent: only runs InitOrigin.init() once per
   * process; subsequent calls are no-ops. Called from both loadGuardSpiderJar()
   * and loadJarFile() so non-Guard spiders with native methods (Douban,
   * Youtube, TgYunDouBanPan, etc.) also have the libs available.
   *
   * Why this matters: some non-Guard spider classes call into native methods
   * (e.g. com.github.catvod.en.NetPan.<init>, TgYunDouBanPan.<init>) which
   * are implemented in libLoadNiMa.so via unidbg. Without this method, those
   * spiders throw UnsatisfiedLinkError at construction time.
   */
  public async ensureNativeLibsLoaded(): Promise<void> {
    if (this.nativeLibsInitialized) return;
    if (this.nativeLibsInitPromise) {
      await this.nativeLibsInitPromise;
      return;
    }
    this.nativeLibsInitPromise = this.doEnsureNativeLibsLoaded();
    try {
      await this.nativeLibsInitPromise;
    } finally {
      this.nativeLibsInitPromise = null;
    }
  }

  private async doEnsureNativeLibsLoaded(): Promise<void> {
    if (!this.java) return;
    try {
      // If the JAR doesn't contain InitOrigin (e.g. minimal stub JAR), skip.
      let InitOrigin: any;
      try {
        InitOrigin = this.java.importClass(
          'com.github.catvod.spider.InitOrigin',
        );
      } catch (_) {
        return;
      }
      if (!InitOrigin) return;

      const ApplicationClass = this.java.importClass('android.app.Application');
      const app = new ApplicationClass();

      // Set the singleton Application field on InitOrigin (chicken-and-egg
      // bypass: InitOrigin.init() -> checkPermission() -> context() needs
      // context set first).
      try {
        const instance = await InitOrigin.get();
        try {
          instance.oOoOoOo0oOo0o0oO = app;
        } catch (fieldErr: any) {
          console.warn(
            '[JarLoader] ensureNativeLibs: InitOrigin Application field set failed:',
            fieldErr.message,
          );
        }
      } catch (instErr: any) {
        console.warn(
          '[JarLoader] ensureNativeLibs: InitOrigin.get() failed:',
          instErr.message,
        );
      }

      // CRITICAL: Set filesDir BEFORE init() — init() reads this field to
      // decide where to download libLoadNiMa.so. If null, init() silently
      // skips the download.
      try {
        const nativeLibDir = path.join(this.jarCacheDir, 'native_libs');
        if (!fs.existsSync(nativeLibDir)) {
          fs.mkdirSync(nativeLibDir, { recursive: true });
        }
        InitOrigin.oOoOoOo0O0O0oO0o = nativeLibDir;
      } catch (dirErr: any) {
        console.warn(
          '[JarLoader] ensureNativeLibs: failed to set filesDir:',
          dirErr.message,
        );
      }

      try {
        await InitOrigin.init(app);
        console.log(
          '[JarLoader] ensureNativeLibs: InitOrigin.init() completed',
        );
      } catch (initCallErr: any) {
        console.warn(
          '[JarLoader] ensureNativeLibs: InitOrigin.init() failed:',
          initCallErr?.message || initCallErr,
        );
      }

      await this.verifyAndDownloadLibLoadNiMa();
      this.nativeLibsInitialized = true;
    } catch (e: any) {
      console.warn('[JarLoader] ensureNativeLibs: overall failure:', e.message);
    }
  }

  /**
   * Verify if libLoadNiMa.so was downloaded by InitOrigin.init(),
   * and if not, manually download it from the newgo.txt URLs.
   */
  /**
   * Check if Guard JAR needs re-decryption (NetEase JAR updated or cache missing)
   */
  private async shouldRedecryptGuardJar(): Promise<boolean> {
    const decryptedJarPath = path.join(
      this.jarCacheDir,
      'wexguard',
      'wexguard-decrypted.jar',
    );
    const versionFile = path.join(this.jarCacheDir, 'wexguard', 'version.json');

    // No decrypted JAR exists
    if (!fs.existsSync(decryptedJarPath)) {
      console.log('[JarLoader] No decrypted Guard JAR found, need to decrypt');
      return true;
    }

    // No version info, can't verify
    if (!fs.existsSync(versionFile)) {
      console.log('[JarLoader] No version info found, re-decrypting');
      return true;
    }

    try {
      // Find NetEase JAR
      const neteaseJarPath = await this.findNetEaseJar();
      if (!neteaseJarPath) {
        console.warn(
          '[JarLoader] NetEase JAR not found, skipping re-decryption',
        );
        return false;
      }

      // Compare MD5
      const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      const neteaseBuffer = fs.readFileSync(neteaseJarPath);
      const currentMd5 = crypto
        .createHash('md5')
        .update(neteaseBuffer)
        .digest('hex');

      if (versionInfo.neteaseJarMd5 !== currentMd5) {
        console.log('[JarLoader] NetEase JAR updated, need to re-decrypt');
        return true;
      }

      return false;
    } catch (e: any) {
      console.warn('[JarLoader] Failed to check version:', e.message);
      return false; // Don't force re-decryption on error
    }
  }

  /**
   * Find NetEase JAR path from loaded config
   */
  private async findNetEaseJar(): Promise<string | null> {
    // Look for NetEase JAR in jar_cache
    const neteaseJarPattern = /bd630429.*\.jar$/;
    const jarCacheFiles = fs.existsSync(this.jarCacheDir)
      ? fs.readdirSync(this.jarCacheDir)
      : [];

    for (const file of jarCacheFiles) {
      if (neteaseJarPattern.test(file)) {
        return path.join(this.jarCacheDir, file);
      }
    }

    // Look for converted JAR
    for (const file of jarCacheFiles) {
      if (file.endsWith('_converted.jar')) {
        // Check if this is NetEase JAR by reading metadata
        const metadataFile = file.replace('_converted.jar', '.json');
        const metadataPath = path.join(this.jarCacheDir, metadataFile);
        if (fs.existsSync(metadataPath)) {
          try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (metadata.url && metadata.url.includes('bd630429')) {
              return path.join(this.jarCacheDir, file);
            }
          } catch {}
        }
      }
    }

    return null;
  }

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
      // For WexGuaZiGuard / GuaziAmns: extract libLoadNiMa.so from JAR or use InitOrigin download
      if (this.needsSourceSpecificHandling(clsKey)) {
        let libPath = await this.extractNativeFromJar(
          jarUrl,
          clsKey,
          'libLoadNiMa.so',
        );

        // If not found in JAR, check the shared native_libs directory
        // (where InitOrigin.init() downloads libLoadNiMa.so)
        if (!libPath) {
          const nativeLibDir = path.join(this.jarCacheDir, 'native_libs');
          const sharedLibPath = path.join(nativeLibDir, 'libLoadNiMa.so');
          console.log(
            '[JarLoader] Checking shared native_libs dir for libLoadNiMa.so:',
            sharedLibPath,
          );
          if (fs.existsSync(sharedLibPath)) {
            const stat = fs.statSync(sharedLibPath);
            console.log(
              '[JarLoader] Found libLoadNiMa.so in native_libs, size:',
              stat.size,
              'bytes',
            );
            libPath = sharedLibPath;
          }
        }

        // If still not found, check InitOrigin.init() download location
        // (per-spider filesDir, set during spider init)
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

        // Last resort: trigger manual download to native_libs dir
        if (!libPath) {
          console.warn(
            '[JarLoader] libLoadNiMa.so not found anywhere, attempting manual download...',
          );
          const nativeLibDir = path.join(this.jarCacheDir, 'native_libs');
          if (!fs.existsSync(nativeLibDir)) {
            fs.mkdirSync(nativeLibDir, { recursive: true });
          }
          await this.downloadLibLoadNiMaManually(nativeLibDir);
          const downloadedPath = path.join(nativeLibDir, 'libLoadNiMa.so');
          if (fs.existsSync(downloadedPath)) {
            libPath = downloadedPath;
            console.log('[JarLoader] Manual download succeeded:', libPath);
          }
        }

        if (libPath) {
          // Store in source isolation map
          this.sourceIsolation.set(clsKey, {
            nativeLibPath: libPath,
            needsUnidbg: true,
          });

          // Set Java system properties so the LoadNiMa stub can locate:
          //   1. The native library (libLoadNiMa.so)
          //   2. The unidbg loader JAR (for subprocess decode)
          //   3. The java executable (bundled JRE in packaged mode)
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

            // Locate unidbg loader JAR
            const unidbgCandidates = [
              path.join(
                process.resourcesPath || '',
                'tools',
                'unidbg-loader-1.0.0-shaded.jar',
              ),
              path.join(
                process.resourcesPath || '',
                'tools',
                'unidbg-loader-1.0.0.jar',
              ),
              path.join(
                process.cwd(),
                'tools',
                'unidbg-loader',
                'target',
                'unidbg-loader-1.0.0.jar',
              ),
              path.join(
                __dirname,
                '..',
                'tools',
                'unidbg-loader-1.0.0-shaded.jar',
              ),
              path.join(__dirname, '..', 'tools', 'unidbg-loader-1.0.0.jar'),
            ];
            for (const candidate of unidbgCandidates) {
              if (fs.existsSync(candidate)) {
                SystemClass.setPropertySync('tvbox.unidbg.jar', candidate);
                console.log(
                  '[JarLoader] Set System property tvbox.unidbg.jar:',
                  candidate,
                );
                break;
              }
            }

            // Locate bundled java executable
            const jreDir = path.join(process.resourcesPath || '', 'jre');
            const javaExeCandidates = [
              path.join(jreDir, 'bin', 'java.exe'),
              path.join(jreDir, 'bin', 'java'),
            ];
            for (const candidate of javaExeCandidates) {
              if (fs.existsSync(candidate)) {
                SystemClass.setPropertySync('tvbox.java.exe', candidate);
                console.log(
                  '[JarLoader] Set System property tvbox.java.exe:',
                  candidate,
                );
                break;
              }
            }
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
  private registerBouncyCastle(java: JavaBridge): void {
    if (!java) return;
    try {
      const Security = java.importClass('java.security.Security');
      // Check if already registered
      const existing = Security.getProviderSync
        ? Security.getProviderSync('BC')
        : null;
      if (existing) {
        console.log('[JarLoader] BouncyCastle provider already registered');
        return;
      }
      const BouncyCastleProvider = java.importClass(
        'org.bouncycastle.jce.provider.BouncyCastleProvider',
      );
      const provider = new BouncyCastleProvider();
      // Insert at position 1 (highest priority) so BC wins algorithm lookups
      // for names like "RSA/None/PKCS1Padding" that SunRsaSign rejects.
      // addProvider() appends to the end, letting SunRsaSign veto first.
      const pos = Security.insertProviderAtSync
        ? Security.insertProviderAtSync(provider, 1)
        : Security.insertProviderAt(provider, 1);
      console.log(
        `[JarLoader] BouncyCastle provider inserted at position ${pos}`,
      );
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
        const jvmOpts: JVMOptions = {
          classpath: stubPaths,
          opts: [
            '-Xverify:none',
            '-Dfile.encoding=UTF-8',
            '-Dsun.stdout.encoding=UTF-8',
            '-Dsun.stderr.encoding=UTF-8',
          ],
        };
        // In packaged builds, point java-bridge at the bundled JRE's JVM library
        // so the app doesn't depend on the user having a system JDK.
        // Path differs by platform:
        //   Windows: jre/bin/server/jvm.dll
        //   Linux:   jre/lib/server/libjvm.so
        //   Mac:     jre/lib/server/libjvm.dylib
        if (app.isPackaged) {
          const bundledJre = path.join(process.resourcesPath, 'jre');
          const jvmLib = this.findBundledJvmLib(bundledJre);
          if (jvmLib) {
            jvmOpts.libPath = jvmLib;
            jvmOpts.isPackagedElectron = true;
            console.log('[JarLoader] Using bundled JRE:', jvmLib);

            // CRITICAL: Add jre/bin/ to PATH so Windows can find the JRE's
            // dependent DLLs (java.dll, jli.dll, zip.dll, etc.) when loading
            // jvm.dll. When java.exe runs from jre/bin/, the DLL search path
            // includes jre/bin/ automatically. But when java-bridge loads
            // jvm.dll (from jre/bin/server/jvm.dll) directly via LoadLibrary,
            // Windows only searches jre/bin/server/ (the loaded DLL's directory)
            // and the app's directory — NOT jre/bin/. Without this, the JVM
            // fails to initialize with "Unable to load JVM" or similar errors.
            const jreBinDir = path.join(bundledJre, 'bin');
            if (fs.existsSync(jreBinDir)) {
              const oldPath = process.env.PATH || '';
              process.env.PATH = jreBinDir + path.delimiter + oldPath;
              console.log('[JarLoader] Added JRE bin/ to PATH:', jreBinDir);
            }
          } else {
            console.warn(
              '[JarLoader] Bundled JVM library not found under',
              bundledJre,
              '— falling back to system JAVA_HOME',
            );
          }
        }

        // Add project directory to PATH so Java Runtime.exec() can find
        // getprop.exe and chmod.exe stubs. Guard spiders call
        // Runtime.exec("getprop ro.product.cpu.abi") during init to detect
        // CPU architecture. On Windows, ProcessBuilder only finds .exe files
        // via PATH — not from cwd alone.
        const stubExeDir = app.isPackaged
          ? path.join(process.resourcesPath, 'tools')
          : process.cwd();
        if (fs.existsSync(path.join(stubExeDir, 'getprop.exe'))) {
          const curPath = process.env.PATH || '';
          if (!curPath.includes(stubExeDir)) {
            process.env.PATH = stubExeDir + path.delimiter + curPath;
            console.log('[JarLoader] Added stub exe dir to PATH:', stubExeDir);
          }
        }
        const created = java.ensureJvm(jvmOpts);
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
      this.registerBouncyCastle(java);

      return java;
    } catch (e: any) {
      console.error('[JarLoader] Failed to load java-bridge:', e.message || e);
      console.error('[JarLoader] Error code:', e.code || 'unknown');
      console.error('[JarLoader] Error stack:', e.stack || 'no stack');
      // Log PATH and resourcesPath for debugging
      console.error('[JarLoader] PATH:', process.env.PATH?.substring(0, 500));
      console.error(
        '[JarLoader] resourcesPath:',
        process.resourcesPath || 'not set',
      );
      console.error('[JarLoader] isPackaged:', app.isPackaged);

      if (e.code === 'MODULE_NOT_FOUND') {
        this.lastError =
          'java-bridge 模块未找到。请重新安装应用或执行 pnpm install。';
      } else if (
        /jvm|JAVA_HOME|java runtime|cannot find|dll|libjvm|Visual C\+\+/i.test(
          e.message || '',
        )
      ) {
        this.lastError = `找不到 Java Runtime。打包版请确保 resources/jre 完整；开发版请设置 JAVA_HOME 指向 JDK。若已打包请安装 VC++ 2015+ 运行库。\n详情: ${e.message || '未知错误'}`;
      } else {
        this.lastError = `java-bridge failed: ${e.message || 'unknown error'}`;
      }

      return null;
    }
  }

  /**
   * Find the bundled JVM library file for the current platform.
   * - Windows: jre/bin/server/jvm.dll
   * - Linux:   jre/lib/server/libjvm.so
   * - Mac:     jre/lib/server/libjvm.dylib
   */
  private findBundledJvmLib(jreDir: string): string | null {
    const candidates = [
      path.join(jreDir, 'bin', 'server', 'jvm.dll'),
      path.join(jreDir, 'lib', 'server', 'libjvm.so'),
      path.join(jreDir, 'lib', 'server', 'libjvm.dylib'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Find the JRE bin directory containing jar/jar.exe.
   * Used by loadGuardSpiderJar() to run `jar tf` for class name enumeration.
   */
  private getBundledJreBinDir(): string | null {
    const candidateDirs = [
      path.join(process.resourcesPath || '', 'jre', 'bin'),
      path.join(process.cwd(), 'jre', 'bin'),
      path.join(path.dirname(process.cwd()), 'jre', 'bin'),
    ];
    for (const d of candidateDirs) {
      const jarExe = path.join(
        d,
        process.platform === 'win32' ? 'jar.exe' : 'jar',
      );
      if (fs.existsSync(jarExe)) return d;
    }
    return null;
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
      path.join(process.cwd(), 'tools', 'runtime'),
      path.join(process.cwd(), 'tools'),
      path.join(path.dirname(process.cwd()), 'tools', 'runtime'),
      path.join(path.dirname(process.cwd()), 'tools'),
      path.join(process.cwd(), 'resources', 'tools', 'runtime'),
      path.join(process.cwd(), 'resources', 'tools'),
      path.join(__dirname, 'tools', 'runtime'),
      path.join(__dirname, 'tools'),
      path.join(process.resourcesPath || '', 'tools', 'runtime'),
      path.join(process.resourcesPath || '', 'tools'),
    ];

    const stubJars = [
      'kotlin-stdlib.jar',
      'okhttp.jar',
      'okio.jar',
      'json-patch.jar',
      'json.jar',
      'gson-2.8.9.jar',
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

      // Check if data is actually a JAR/DEX file (regardless of URL extension).
      // Many "image" URLs (e.g. *.jpg) actually serve JAR or DEX content directly.
      // Check this FIRST before attempting steganography extraction.
      if (this.isJarFile(rawData)) {
        console.log(
          '[JarLoader] File is JAR format (despite image URL extension)',
        );
        jarData = rawData;
      } else if (this.isDexFile(rawData)) {
        console.log('[JarLoader] File is DEX format');
        jarData = rawData;
      } else if (isImgJar || this.looksLikeImage(rawData)) {
        console.log(
          '[JarLoader] File is image (PNG/JPG), extracting steganography data...',
        );

        // Extract JAR from image steganography
        jarData = this.extractJdFromBinary(rawData);

        if (jarData.length === 0) {
          console.error('[JarLoader] Failed to extract JAR from image');
          return false;
        }
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

      // Write to cache using temp file + rename with EPERM/EBUSY retry.
      // Windows antivirus / file locks may transiently block writes to the
      // cache directory; retrying with backoff avoids a hard failure.
      const writeOk = await this.writeWithRetry(cachePath, jarData);
      if (!writeOk) {
        this.lastError = `Failed to write JAR cache after retries: ${cachePath}`;
        console.error('[JarLoader]', this.lastError);
        return false;
      }
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
   * Write a buffer to cachePath using a temp file + atomic rename.
   * Retries on EPERM/EBUSY/EACCES (Windows file lock / antivirus).
   */
  private async writeWithRetry(
    cachePath: string,
    data: Buffer,
  ): Promise<boolean> {
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    const maxAttempts = 5;
    const baseDelayMs = 300;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Write to temp file first to avoid partial writes corrupting cache
        fs.writeFileSync(tmpPath, data);

        // Atomic rename (on same filesystem). If target exists, overwrite.
        try {
          fs.renameSync(tmpPath, cachePath);
        } catch (renameErr: any) {
          // rename may fail if target is locked; try unlink + rename
          if (fs.existsSync(cachePath)) {
            try {
              fs.unlinkSync(cachePath);
            } catch {}
          }
          fs.renameSync(tmpPath, cachePath);
        }
        return true;
      } catch (e: any) {
        const code = e.code || '';
        const isTransient =
          code === 'EPERM' ||
          code === 'EBUSY' ||
          code === 'EACCES' ||
          code === 'ENOTEMPTY';
        console.warn(
          `[JarLoader] Write attempt ${attempt}/${maxAttempts} failed: ${code} ${e.message}`,
        );
        // Clean up temp file if it exists
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}

        if (!isTransient || attempt === maxAttempts) {
          console.error('[JarLoader] Write failed permanently:', e);
          return false;
        }
        // Exponential backoff: 300ms, 600ms, 1200ms, 2400ms
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return false;
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
   * Check if data looks like an image (PNG or JPG) by magic number.
   * Both formats can carry Box Android's steganography: the JAR bytes are
   * appended after the image's end marker (IEND for PNG, FFD9 for JPG).
   */
  private looksLikeImage(data: Buffer): boolean {
    if (data.length < 3) return false;
    // PNG magic: 89 50 4E 47
    if (
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      return true;
    }
    // JPG magic: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return true;
    }
    return false;
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
          // ids may be passed as an array (["id1","id2"]) or a single string ("id1")
          const [ids] = args;
          const ArrayList = this.java.importClass('java.util.ArrayList');
          const list = new ArrayList();
          if (Array.isArray(ids)) {
            for (const id of ids) {
              list.addSync(String(id));
            }
          } else if (ids !== undefined && ids !== null) {
            list.addSync(String(ids));
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
   * Create a per-spider URLClassLoader for class isolation.
   * Each spider JAR gets its own classloader with the system classloader
   * (which has stubs) as parent. This prevents cross-JAR class conflicts
   * where different JARs contain the same obfuscated class with different
   * method signatures (e.g. com.github.catvod.spider.merge.e).
   *
   * Parent selection: We prefer the JVM system classloader because stubs
   * are placed there via ensureJvm({ classpath: stubPaths }). The system
   * classloader does NOT have other spider JARs (those are added via
   * appendClasspath to java-bridge's internal classloader), so this gives
   * true isolation. If the system classloader can't see stubs (e.g. JVM
   * was already started before ensureJvm), fall back to the java-bridge
   * internal classloader — isolation is weaker but stubs are visible.
   */
  private createSpiderClassLoader(jarPath: string): any | null {
    if (!this.java) return null;

    // Choose parent: prefer system classloader (has stubs, no spider JARs).
    // Fall back to java-bridge internal classloader if system cannot see
    // a known stub class.
    let parentLoader = this.systemClassLoader;
    if (!parentLoader) {
      console.warn(
        '[JarLoader] No cached system classloader, using java-bridge internal',
      );
      try {
        parentLoader = this.java.getClassLoader();
      } catch (e: any) {
        console.error(
          '[JarLoader] Failed to get java-bridge classloader:',
          e.message,
        );
        return null;
      }
    }

    try {
      // Use the Java helper class SpiderClassLoaderHelper (in stubs JAR)
      // to create URLClassLoader. This avoids JavaScript-to-Java array
      // marshalling issues — java-bridge cannot reliably create URL[] arrays.
      const Helper = this.java.importClass(
        'com.github.catvod.spider.SpiderClassLoaderHelper',
      );
      const classLoader = Helper.createClassLoaderSync(jarPath, parentLoader);
      console.log(
        '[JarLoader] Created per-spider URLClassLoader for:',
        path.basename(jarPath),
      );
      return classLoader;
    } catch (e: any) {
      console.error(
        '[JarLoader] Failed to create per-spider classloader:',
        e.message,
      );
      return null;
    }
  }

  /**
   * Run a callback with java.classLoader temporarily switched to the
   * spider's isolated classloader. Clears the class proxy cache before
   * running so importClass() re-imports via the new classloader, and
   * restores the original classloader (with another cache clear) afterwards.
   *
   * Returns the callback's result. If spiderClassLoader is null/undefined,
   * runs the callback without switching (backwards-compatible fallback).
   */
  private withSpiderClassLoader<T>(spiderClassLoader: any, fn: () => T): T {
    if (!this.java || !spiderClassLoader) {
      return fn();
    }
    let originalCL: any = null;
    try {
      originalCL = this.java.getClassLoader();
    } catch {
      // ignore — get may fail if JVM not yet started
    }
    try {
      this.java.setClassLoader(spiderClassLoader);
      this.java.clearClassProxies();
      return fn();
    } finally {
      try {
        if (originalCL) {
          this.java.setClassLoader(originalCL);
          this.java.clearClassProxies();
        }
      } catch {
        // ignore restore failure
      }
    }
  }

  /**
   * Async-aware version of withSpiderClassLoader.
   *
   * The sync version restores the classloader in a `finally` block that runs
   * as soon as `fn()` returns — which is BEFORE an async fn's Promise
   * resolves. For async callbacks (e.g. executeSpiderMethod which awaits
   * java-bridge async calls), the classloader would be restored too early,
   * causing ClassNotFoundException during the awaited Java invocation.
   *
   * This version awaits `fn()` before restoring the classloader.
   */
  private async withSpiderClassLoaderAsync<T>(
    spiderClassLoader: any,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.java || !spiderClassLoader) {
      return fn() as Promise<T>;
    }
    let originalCL: any = null;
    try {
      originalCL = this.java.getClassLoader();
    } catch {
      // ignore — get may fail if JVM not yet started
    }
    try {
      this.java.setClassLoader(spiderClassLoader);
      this.java.clearClassProxies();
      return await fn();
    } finally {
      try {
        if (originalCL) {
          this.java.setClassLoader(originalCL);
          this.java.clearClassProxies();
        }
      } catch {
        // ignore restore failure
      }
    }
  }

  /**
   * Set thread context classloader to spider's classloader.
   * Returns the previous classloader for restoration.
   */
  private setSpiderContextClassLoader(classLoader?: any): any {
    if (!this.java || !classLoader) return null;
    try {
      const Thread = this.java.importClass('java.lang.Thread');
      const currentThread = Thread.currentThreadSync();
      const prevLoader = currentThread.getContextClassLoaderSync();
      currentThread.setContextClassLoaderSync(classLoader);
      return prevLoader;
    } catch (e: any) {
      return null;
    }
  }

  /**
   * Restore thread context classloader.
   */
  private restoreContextClassLoader(prevLoader: any): void {
    if (!this.java || !prevLoader) return;
    try {
      const Thread = this.java.importClass('java.lang.Thread');
      const currentThread = Thread.currentThreadSync();
      currentThread.setContextClassLoaderSync(prevLoader);
    } catch {
      // ignore
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
      path.join(process.cwd(), 'tools', 'runtime'),
      path.join(process.cwd(), 'tools'),
      path.join(path.dirname(process.cwd()), 'tools', 'runtime'),
      path.join(path.dirname(process.cwd()), 'tools'),
      path.join(process.cwd(), 'resources', 'tools', 'runtime'),
      path.join(process.cwd(), 'resources', 'tools'),
      path.join(__dirname, 'tools', 'runtime'),
      path.join(__dirname, 'tools'),
      path.join(process.resourcesPath || '', 'tools', 'runtime'),
      path.join(process.resourcesPath || '', 'tools'),
    ];

    const requiredJars = [
      'kotlin-stdlib.jar',
      'okhttp.jar',
      'okio.jar',
      'json-patch.jar',
      'json.jar',
      'gson-2.8.9.jar',
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

    // Check for img+ prefix (explicit image steganography marker)
    // OR check if URL ends with .png/.jpg/.jpeg (implicit image steganography)
    // Box Android's getImgJar works on both PNG and JPG files: it searches for
    // the [A-Za-z]{8}** pattern anywhere in the file, which is appended after
    // the image's end marker (IEND for PNG, FFD9 for JPG).
    const lowerUrl = actualJarUrl.toLowerCase();
    const isImgJar =
      actualJarUrl.startsWith('img+') ||
      lowerUrl.endsWith('.png') ||
      lowerUrl.endsWith('.jpg') ||
      lowerUrl.endsWith('.jpeg');

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

      // Create an isolated URLClassLoader for this spider JAR.
      //
      // Why not appendClasspath: java-bridge's appendClasspath adds the JAR
      // to a SHARED internal classloader. Once a class (e.g. merge.b.a) is
      // loaded from one JAR, subsequent JARs with the same obfuscated class
      // name but a different definition (abstract vs concrete, interface vs
      // class, different method signatures) get the FIRST JAR's definition —
      // causing IncompatibleClassChangeError, InstantiationError, etc.
      //
      // Each spider JAR gets its own URLClassLoader with the system
      // classloader as parent (which has stubs only). This gives true
      // isolation: the spider sees its own classes first, stubs via parent,
      // and never sees other spider JARs.
      let spiderClassLoader = this.createSpiderClassLoader(actualJarPath);
      if (spiderClassLoader) {
        this.spiderClassLoaders.set(jarKey, spiderClassLoader);
      } else {
        // Fallback: append to shared classpath. Less isolation but allows
        // spiders to load when URLClassLoader creation fails.
        console.warn(
          '[JarLoader] Isolated classloader creation failed, falling back to appendClasspath (cross-JAR conflicts possible). jarKey=',
          jarKey,
        );
        this.java.appendClasspath(actualJarPath);
        // Save the internal classloader as the spider's classloader so
        // callSpiderMethod can switch to it. Without this, instance.classLoader
        // is undefined and retry-path importClass() fails with
        // ClassNotFoundException because the current classloader (likely the
        // system classloader from a previous getSpider's finally block) doesn't
        // have the spider JAR.
        if (this.internalClassLoader) {
          this.spiderClassLoaders.set(jarKey, this.internalClassLoader);
          spiderClassLoader = this.internalClassLoader;
          console.log(
            '[JarLoader] Saved internal classloader as fallback for jarKey=',
            jarKey,
          );
        }
      }

      // Update thread context classloader to the spider's classloader.
      // OkHttp/Kotlin use Thread.currentThread().getContextClassLoader()
      // which may still point to the system classloader. Without this,
      // library code can't find spider-JAR-local classes (e.g. OkHttp
      // interceptors defined inside the spider JAR).
      if (spiderClassLoader) {
        this.setSpiderContextClassLoader(spiderClassLoader);
      } else {
        this.updateContextClassLoader();
      }

      // Verify the JAR is loadable by trying to import a known class.
      // Use the spider's isolated classloader so the import reflects what
      // getSpider() will actually see (not a class from a previously-loaded
      // spider JAR via the shared classloader).
      try {
        this.withSpiderClassLoader(spiderClassLoader, () => {
          const testClass = this.java.importClass(
            'com.github.catvod.spider.Init',
          );
          if (testClass) {
            console.log('[JarLoader] JAR verified: Init class loadable');
          }
        });
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
            // Re-create the isolated classloader with the converted JAR path
            spiderClassLoader = this.createSpiderClassLoader(actualJarPath);
            if (spiderClassLoader) {
              this.spiderClassLoaders.set(jarKey, spiderClassLoader);
              this.setSpiderContextClassLoader(spiderClassLoader);
            } else {
              this.java.appendClasspath(actualJarPath);
              // Save internal classloader as fallback (same as primary path)
              if (this.internalClassLoader) {
                this.spiderClassLoaders.set(jarKey, this.internalClassLoader);
                spiderClassLoader = this.internalClassLoader;
              }
            }
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
      console.log('[JarLoader] JAR loaded (isolated classloader):', jarKey);
      this.emitProgress('ready', '爬虫加载完成', 100);

      // Call Init.init(Application) - Box Android pattern
      // The Init class stores the application Context in its static field 'c'
      // for spiders to access via Init.context(). The field type is android.app.Application.
      //
      // Java-bridge cannot reliably create Application instances (the proxy is
      // typed as the imported class, not its superclass), so we use a more
      // direct approach: create an Application, set it as the static 'c' field
      // via reflection through java-bridge.
      //
      // CRITICAL: Import Init and Application via the spider's isolated
      // classloader. The Init class lives inside the spider JAR and may
      // differ between JARs. Without isolation, the first JAR's Init class
      // is reused for all subsequent spiders, causing NoSuchMethodError when
      // the spider calls Init methods that exist in its own JAR's version.
      try {
        this.withSpiderClassLoader(spiderClassLoader, () => {
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
          console.log(
            "[JarLoader] Init's 'c' field set to Application instance",
          );
        });
      } catch (initErr: any) {
        console.warn('[JarLoader] Init setup failed:', initErr.message);
      }

      // Index JAR class names for case-insensitive fallback lookup.
      // This enables getSpider() to find classes when the config API name
      // doesn't exactly match the JAR's class name (e.g. csp_XBPQ → XbPq).
      await this.indexJarClasses(actualJarPath, jarKey);

      // Ensure native libraries (libLoadNiMa.so for unidbg emulation) are
      // downloaded. Some non-Guard spiders (Douban, Youtube, TgYunDouBanPan)
      // call native methods at construction time and throw
      // UnsatisfiedLinkError without this. Idempotent — first call downloads,
      // later calls are no-ops.
      await this.ensureNativeLibsLoaded();

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
    return clsKey.endsWith('Guard') || clsKey.endsWith('Amns');
  }

  /**
   * Index spider class names in a JAR for case-insensitive fallback lookup.
   * Uses `jar tf` (bundled JRE) to list class entries and caches them per
   * jarKey. Called after loadJarFile() succeeds. Non-critical: if listing
   * fails, getSpider() falls back to the original candidate-based lookup.
   */
  private async indexJarClasses(
    jarPath: string,
    jarKey: string,
  ): Promise<void> {
    try {
      const jreBinDir = this.getBundledJreBinDir();
      const jarCmd = jreBinDir
        ? path.join(jreBinDir, process.platform === 'win32' ? 'jar.exe' : 'jar')
        : 'jar';
      const { stdout } = await execAsync(`"${jarCmd}" tf "${jarPath}"`, {
        timeout: 10000,
      });
      const lines = stdout.split(/\r?\n/);
      const classMap = new Map<string, string>();
      for (const line of lines) {
        const name = line.trim();
        if (
          name.startsWith('com/github/catvod/spider/') &&
          name.endsWith('.class') &&
          !name.includes('$')
        ) {
          const simpleName = name.slice(
            'com/github/catvod/spider/'.length,
            -'.class'.length,
          );
          const fullName = name.slice(0, -'.class'.length).replace(/\//g, '.');
          // Index by lowercase for case-insensitive lookup. First entry wins
          // (a JAR shouldn't have two classes with the same simple name).
          if (!classMap.has(simpleName.toLowerCase())) {
            classMap.set(simpleName.toLowerCase(), fullName);
          }
        }
      }
      this.jarClassNameMap.set(jarKey, classMap);
      console.log(
        `[JarLoader] Indexed ${classMap.size} spider classes for jarKey=${jarKey.substring(0, 12)}...`,
      );
    } catch (listErr: any) {
      console.warn(
        '[JarLoader] Failed to list JAR entries for class index (non-critical):',
        listErr.message,
      );
    }
  }

  /**
   * Fuzzy-match a spider class name against indexed JAR classes.
   * Tries exact (case-insensitive), then various transformations
   * (strip "App"/"Wex" prefix, strip "91"/"V2" suffix, etc.).
   * Returns the full class name or null.
   */
  private fuzzyMatchSpiderClass(jarKey: string, realClsKey: string): string[] {
    // Search both the per-JAR class map AND the Guard JAR class map.
    // The Guard JAR (wexguard-spider-enjarify.jar) contains pre-decrypted
    // "New*" classes that don't have native method calls — useful when the
    // per-JAR class (e.g. "Douban") throws UnsatisfiedLinkError on init.
    // Returns matches in priority order: exact key matches first, then
    // contains matches. Caller iterates and tests instantiation.
    const maps: Map<string, string>[] = [];
    const perJarMap = this.jarClassNameMap.get(jarKey);
    if (perJarMap && perJarMap.size > 0) maps.push(perJarMap);
    if (this.guardClassNameMap.size > 0) maps.push(this.guardClassNameMap);
    if (maps.length === 0) return [];

    const tryKeys = new Set<string>();
    const lower = realClsKey.toLowerCase();
    tryKeys.add(lower);
    if (!lower.startsWith('new')) tryKeys.add('new' + lower);

    // Spelling variants: Dou ↔ Duo (都都 vs 多多)
    if (lower.includes('dou')) {
      const duo = lower.replace(/dou/g, 'duo');
      tryKeys.add(duo);
      if (!duo.startsWith('new')) tryKeys.add('new' + duo);
    }
    if (lower.includes('duo')) {
      const dou = lower.replace(/duo/g, 'dou');
      tryKeys.add(dou);
      if (!dou.startsWith('new')) tryKeys.add('new' + dou);
    }

    // Strip common prefixes
    if (lower.startsWith('app')) {
      const stripped = lower.slice(3);
      if (stripped) {
        tryKeys.add(stripped);
        if (!stripped.startsWith('new')) tryKeys.add('new' + stripped);
      }
    }
    if (lower.startsWith('wex')) {
      const stripped = lower.slice(3);
      if (stripped) {
        tryKeys.add(stripped);
        if (!stripped.startsWith('new')) tryKeys.add('new' + stripped);
      }
    }

    // Strip common numeric/version suffixes (e.g. "panta91" → "panta")
    const suffixMatch = lower.match(/(v\d+|\d+)$/);
    if (suffixMatch) {
      const stripped = lower.slice(0, -suffixMatch[0].length);
      if (stripped) {
        tryKeys.add(stripped);
        if (!stripped.startsWith('new')) tryKeys.add('new' + stripped);
      }
    }

    // Strip "share" suffix (e.g. "panshare" → "pan")
    if (lower.endsWith('share')) {
      const stripped = lower.slice(0, -'share'.length);
      if (stripped) {
        tryKeys.add(stripped);
        if (!stripped.startsWith('new')) tryKeys.add('new' + stripped);
      }
    }

    const results: string[] = [];
    const seen = new Set<string>();

    // Priority 1: exact key matches (prefer "New*" prefix to skip
    // encrypted original classes that throw UnsatisfiedLinkError)
    const orderedKeys = Array.from(tryKeys).sort((a, b) => {
      // Keys starting with "new" come first
      const aNew = a.startsWith('new') ? 0 : 1;
      const bNew = b.startsWith('new') ? 0 : 1;
      if (aNew !== bNew) return aNew - bNew;
      return a.length - b.length; // shorter keys first
    });

    for (const tryKey of orderedKeys) {
      for (const classMap of maps) {
        const match = classMap.get(tryKey);
        if (match && !seen.has(match)) {
          console.log(
            `[JarLoader] fuzzyMatch: "${realClsKey}" → "${match}" (via key="${tryKey}")`,
          );
          seen.add(match);
          results.push(match);
        }
      }
    }

    // Priority 2: contains matches (last resort)
    // Filter out very short names (length < 3) — these are obfuscated
    // single/double-letter classes (e.g. "a", "b", "ab") that match almost
    // any query via `lower.includes(lowerName)` and are never the right spider.
    for (const classMap of maps) {
      for (const [lowerName, fullName] of classMap.entries()) {
        if (seen.has(fullName)) continue;
        if (lowerName.length < 3) continue;
        if (
          lowerName === lower ||
          lowerName.includes(lower) ||
          lower.includes(lowerName)
        ) {
          console.log(
            `[JarLoader] fuzzyMatch: "${realClsKey}" → "${fullName}" (via contains match "${lowerName}")`,
          );
          seen.add(fullName);
          results.push(fullName);
        }
      }
    }

    return results;
  }

  /**
   * Generate candidate spider class names to try when loading.
   *
   * Different Guard JARs use different naming conventions for the wrapper
   * class vs the actual spider class in wexguard-spider-enjarify.jar:
   *   - fty0528.jar: "DouDouGuard" → wexguard JAR: "NewDuoDuo"
   *     (different Chinese characters 都都 vs 多多, plus "New" prefix)
   *   - wexguard spider JAR: "NewDouBanGuard" → wexguard JAR: "NewDouBan"
   *     (just strip Guard)
   *
   * We generate multiple candidates and try each one until we find a class
   * that loads. Candidates in priority order:
   *   1. Stripped name (current logic, works for NewDouBanGuard → NewDouBan)
   *   2. With "New" prefix (handles DouDouGuard → NewDouDou attempt)
   *   3. Spelling variants: "Dou" ↔ "Duo" (handles DouDou ↔ DuoDuo)
   */
  private generateSpiderClassCandidates(
    realClsKey: string,
    isGuard: boolean,
  ): string[] {
    const candidates: string[] = [];
    const baseName = realClsKey;

    // 1. Stripped name (current logic) - e.g., DouDou, NewDouBan
    candidates.push(baseName);

    // 2. With "New" prefix (if not already starting with New)
    if (!baseName.startsWith('New')) {
      candidates.push('New' + baseName);
    }

    // 3. Spelling variants: Dou ↔ Duo
    // Many Guard wrapper classes use "DouDou" (都都) but the actual class
    // in wexguard JAR is "DuoDuo" (多多) - different Chinese characters
    // with similar English romanization
    if (baseName.includes('Dou')) {
      const duoVariant = baseName.replace(/Dou/g, 'Duo');
      if (!candidates.includes(duoVariant)) candidates.push(duoVariant);
      if (!duoVariant.startsWith('New')) {
        const newDuoVariant = 'New' + duoVariant;
        if (!candidates.includes(newDuoVariant)) {
          candidates.push(newDuoVariant);
        }
      }
    }
    if (baseName.includes('Duo')) {
      const douVariant = baseName.replace(/Duo/g, 'Dou');
      if (!candidates.includes(douVariant)) candidates.push(douVariant);
      if (!douVariant.startsWith('New')) {
        const newDouVariant = 'New' + douVariant;
        if (!candidates.includes(newDouVariant)) {
          candidates.push(newDouVariant);
        }
      }
    }

    // 4. XYQHiker → XYQBiu mapping
    // Bili.jar and other JARs use "XYQBiu" instead of "XYQHiker"
    if (baseName === 'XYQHiker' || baseName === 'XYQHikerAL') {
      const biuName = baseName.replace('XYQHiker', 'XYQBiu');
      if (!candidates.includes(biuName)) candidates.push(biuName);
      const newBiuName = 'New' + biuName;
      if (!candidates.includes(newBiuName)) candidates.push(newBiuName);
    }
    if (baseName === 'XYQBiu' || baseName === 'XYQBiuAL') {
      const hikerName = baseName.replace('XYQBiu', 'XYQHiker');
      if (!candidates.includes(hikerName)) candidates.push(hikerName);
      const newHikerName = 'New' + hikerName;
      if (!candidates.includes(newHikerName)) candidates.push(newHikerName);
    }

    return candidates;
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

    // Initialize GuardDecryptor for runtime decryption
    if (!this.guardDecryptor) {
      this.guardDecryptor = new GuardDecryptor();
    }

    // Candidate paths in order of preference:
    // 1. Runtime decrypted JAR (most up-to-date)
    // 2. Pre-decrypted JAR in tools/wexguard_work/
    // 3. Packaged runtime JAR
    const candidatePaths = [
      // Runtime decrypted JAR (from jar_cache/wexguard/)
      path.join(this.jarCacheDir, 'wexguard', 'wexguard-decrypted.jar'),
      // Pre-decrypted JAR (development)
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
      // Packaged runtime JAR
      path.join(
        process.resourcesPath || '',
        'tools',
        'wexguard_work',
        'wexguard-spider-enjarify.jar',
      ),
      path.join(
        process.resourcesPath || '',
        'tools',
        'wexguard-spider-enjarify.jar',
      ),
    ];

    let jarPath = candidatePaths.find((p) => fs.existsSync(p));

    // If no JAR found or NetEase JAR updated, try runtime decryption
    if (!jarPath || (await this.shouldRedecryptGuardJar())) {
      console.log('[JarLoader] Attempting runtime Guard JAR decryption...');

      // Find NetEase JAR path
      const neteaseJarPath = await this.findNetEaseJar();
      if (neteaseJarPath) {
        try {
          // Report progress to UI
          this.progressCallback?.(
            'decrypt',
            'Decrypting Guard spider classes...',
            0,
          );

          jarPath = await this.guardDecryptor.decrypt(
            neteaseJarPath,
            this.jarCacheDir,
            (progress: DecryptProgress) => {
              console.log(
                `[GuardDecryptor] ${progress.stage}: ${progress.message}`,
              );
              this.progressCallback?.(
                'decrypt',
                progress.message,
                progress.percent || 0,
              );
            },
          );

          this.progressCallback?.('decrypt', 'Guard spider JAR decrypted', 100);
          console.log('[JarLoader] Runtime decryption successful:', jarPath);
        } catch (decryptErr: any) {
          console.error(
            '[JarLoader] Runtime decryption failed:',
            decryptErr.message,
          );
          this.progressCallback?.(
            'error',
            `Decryption failed: ${decryptErr.message}`,
            0,
          );
          // Fall through to use pre-decrypted JAR if available
        }
      } else {
        console.warn(
          '[JarLoader] NetEase JAR not found for runtime decryption',
        );
      }
    }

    // Fallback to pre-decrypted JAR if runtime decryption failed
    if (!jarPath) {
      jarPath = candidatePaths.slice(1).find((p) => fs.existsSync(p)); // Skip runtime decrypted path
    }

    if (!jarPath) {
      this.lastError =
        'wexguard-spider-enjarify.jar not found. Run unidbg decryption + enjarify + ASM patcher first.';
      console.error('[JarLoader]', this.lastError);
      return false;
    }

    try {
      console.log('[JarLoader] Loading WexGuard spider JAR:', jarPath);
      // Append Guard spider JAR to shared classpath
      this.java.appendClasspath(jarPath);
      // Cache the classloader that now includes the Guard JAR. Subsequent
      // setClassLoader calls in getSpider()/callSpiderMethod() for Guard
      // spiders must use this classloader, NOT the internalClassLoader
      // (which was cached BEFORE appendClasspath and cannot see Guard classes).
      this.guardClassLoader = this.java.getClassLoader();
      console.log(
        '[JarLoader] Cached guard classloader (post-appendClasspath)',
      );
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

        // CRITICAL: Set InitOrigin.oOoOoOo0O0O0oO0o (filesDir) BEFORE calling
        // InitOrigin.init(). init() reads this field to determine where to
        // download native libraries (libLoadNiMa.so). If null, init() silently
        // skips the download, and unidbg can't decrypt API responses —
        // causing homeContent to return empty for Wex* sources.
        try {
          const nativeLibDir = path.join(this.jarCacheDir, 'native_libs');
          if (!fs.existsSync(nativeLibDir)) {
            fs.mkdirSync(nativeLibDir, { recursive: true });
          }
          InitOrigin.oOoOoOo0O0O0oO0o = nativeLibDir;
          console.log(
            '[JarLoader] InitOrigin.oOoOoOo0O0O0oO0o (filesDir) set to:',
            nativeLibDir,
          );
        } catch (dirErr: any) {
          console.warn(
            '[JarLoader] Failed to set InitOrigin filesDir:',
            dirErr.message,
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

      // Build case-insensitive class name lookup from the JAR file.
      // Config API names use lowercase (e.g. csp_WexzhizhenGuard →
      // "Wexzhizhen") but JAR classes use CamelCase ("NewZhiZhen").
      // We use `jar tf` (bundled JRE) to list class entries and cache
      // them for case-insensitive fallback matching in initSpider().
      try {
        const jreBinDir = this.getBundledJreBinDir();
        const jarCmd = jreBinDir
          ? path.join(
              jreBinDir,
              process.platform === 'win32' ? 'jar.exe' : 'jar',
            )
          : 'jar';
        const { stdout } = await execAsync(`"${jarCmd}" tf "${jarPath}"`, {
          timeout: 10000,
        });
        const lines = stdout.split(/\r?\n/);
        let count = 0;
        for (const line of lines) {
          const name = line.trim();
          if (
            name.startsWith('com/github/catvod/spider/') &&
            name.endsWith('.class') &&
            !name.includes('$')
          ) {
            const simpleName = name.slice(
              'com/github/catvod/spider/'.length,
              -'.class'.length,
            );
            const fullName = name
              .slice(0, -'.class'.length)
              .replace(/\//g, '.');
            // Index by lowercase for case-insensitive lookup
            this.guardClassNameMap.set(simpleName.toLowerCase(), fullName);
            count++;
          }
        }
        console.log(
          `[JarLoader] Guard spider class name cache: ${count} classes`,
        );
      } catch (listErr: any) {
        console.warn(
          '[JarLoader] Failed to list guard JAR entries (non-critical):',
          listErr.message,
        );
      }

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
    // Clear stale error from previous getSpider/getJar calls so the IPC
    // handler doesn't return a misleading "Tried candidates: ..." message
    // for a completely different spider. Every return false path below
    // sets this.lastError before returning.
    this.lastError = '';

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
    // For Guard/Amns spiders, strip the suffix to get the real spider class
    // (e.g. NewDouBanGuard -> NewDouBan, GuaziAmns -> Guazi). The real class
    // lives in the pre-decrypted wexguard-spider-enjarify.jar, not the outer JAR.
    let realClsKey = clsKey;
    if (isGuard) {
      if (clsKey.endsWith('Guard')) {
        realClsKey = clsKey.slice(0, -'Guard'.length);
      } else if (clsKey.endsWith('Amns')) {
        realClsKey = clsKey.slice(0, -'Amns'.length);
      }
    }
    // Generate candidate class names. Different Guard JARs use different
    // naming conventions for the wrapper class (e.g. fty0528.jar uses
    // "DouDouGuard" but the actual class in wexguard-spider-enjarify.jar
    // is "NewDuoDuo" - different spelling and "New" prefix). We try
    // multiple candidates and use the first one that loads.
    const candidateClsKeys = this.generateSpiderClassCandidates(
      realClsKey,
      isGuard,
    );

    // Determine JAR key
    // IMPORTANT: must match loadJar's jarKey calculation. loadJar strips
    // 'img+' prefix before hashing, so we must do the same here. Otherwise
    // spiderClassLoaders.get(jarKey) returns undefined for img+ JARs, and
    // callSpiderMethod retries fail with ClassNotFoundException because
    // instance.classLoader is undefined.
    let jarKey = 'main';
    if (jarUrl) {
      const urls = jarUrl.split(';md5;');
      const rawUrl = urls[0].replace('img+', '');
      jarKey = crypto.createHash('md5').update(rawUrl).digest('hex');
      console.log(
        '[JarLoader] getSpider jarKey calc:',
        'rawUrl=',
        urls[0].substring(0, 80),
        'stripped=',
        rawUrl.substring(0, 80),
        'jarKey=',
        jarKey,
        'spiderClassLoaders.has=',
        this.spiderClassLoaders.has(jarKey),
        'classLoaders.has=',
        this.classLoaders.has(jarKey),
      );
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
        this.lastError =
          'Guard spider JAR (wexguard-spider-enjarify.jar) failed to load. Check that the file exists and is readable.';
        console.error('[JarLoader]', this.lastError);
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

    // Switch to the spider's isolated classloader before importing the spider
    // class. This ensures importClass() resolves the spider class (and its
    // dependencies like merge.* obfuscated classes) from THIS spider JAR,
    // not from a previously-loaded spider JAR via the shared classloader.
    //
    // Guard spiders use the shared wexguard-spider-enjarify.jar (loaded via
    // appendClasspath in loadGuardSpiderJar), so they don't have an entry in
    // spiderClassLoaders and skip the switch.
    const spiderClassLoader = !isGuard
      ? this.spiderClassLoaders.get(jarKey)
      : undefined;
    console.log(
      '[JarLoader] getSpider classloader lookup:',
      'key=',
      key,
      'jarKey=',
      jarKey,
      'isGuard=',
      isGuard,
      'spiderClassLoader=',
      spiderClassLoader ? 'FOUND' : 'UNDEFINED',
      'spiderClassLoaders.size=',
      this.spiderClassLoaders.size,
    );
    let originalCL: any = null;
    if (spiderClassLoader) {
      try {
        originalCL = this.java.getClassLoader();
        this.java.setClassLoader(spiderClassLoader);
        this.java.clearClassProxies();
        console.log(
          '[JarLoader] Switched to isolated classloader for spider import:',
          path.basename(
            spiderClassLoader.toStringSync
              ? spiderClassLoader.toStringSync()
              : '',
          ),
        );
      } catch (clErr: any) {
        console.warn(
          '[JarLoader] Failed to switch classloader (continuing with shared):',
          clErr.message,
        );
      }
    } else if (isGuard && this.guardClassLoader) {
      // Guard spiders load classes from wexguard-spider-enjarify.jar which
      // was added via appendClasspath in loadGuardSpiderJar(). The
      // internalClassLoader was cached BEFORE appendClasspath, so it cannot
      // see Guard JAR classes. We must switch to guardClassLoader (captured
      // right after appendClasspath) so importClass resolves NewWogg/etc.
      // The java-bridge current classloader may still be a previous non-Guard
      // spider's SpiderURLClassLoader, which also cannot see Guard classes.
      try {
        originalCL = this.java.getClassLoader();
        this.java.setClassLoader(this.guardClassLoader);
        this.java.clearClassProxies();
        console.log(
          '[JarLoader] Switched to guard classloader for Guard spider import:',
          realClsKey,
        );
      } catch (clErr: any) {
        console.warn(
          '[JarLoader] Failed to switch to guard classloader for Guard spider:',
          clErr.message,
        );
      }
    }

    try {
      console.log(
        '[JarLoader] Loading spider class. Base name:',
        realClsKey,
        'Candidates:',
        candidateClsKeys.join(', '),
      );

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

      // Try each candidate class name until one loads successfully AND can be
      // instantiated. For Guard spiders, the outer JAR may contain both the
      // encrypted original class (e.g. "Douban") AND the decrypted "New" class
      // (e.g. "NewDouBan"). The encrypted class loads via importClass but
      // throws UnsatisfiedLinkError on instantiation — we must continue trying
      // other candidates instead of giving up.
      let SpiderClass: any = null;
      let fullClassName = '';
      const failedCandidates: string[] = [];

      for (const candidate of candidateClsKeys) {
        const candidateFullName = `com.github.catvod.spider.${candidate}`;
        try {
          console.log('[JarLoader] Trying spider class:', candidateFullName);

          // Use importClass — it creates method proxies needed by
          // executeSpiderMethod (homeContent, detailContent, etc.)
          const candidateClass = this.java.importClass(candidateFullName);

          if (candidateClass) {
            // Verify the class can be instantiated for ALL spiders (not just
            // Guard). Many upstream JARs contain encrypted original classes
            // (e.g. "Douban", "Wogg") that load via importClass but their
            // <init> is a native method that throws UnsatisfiedLinkError.
            // Skip these and try the next candidate (e.g. "NewDouban").
            // NOTE: Only skip on UnsatisfiedLinkError — other errors (NPE,
            // etc.) may be transient or caught by the spider internally, so
            // we still pick the candidate and let the actual instantiation
            // (below) handle it.
            try {
              // Test instantiation — discard the instance (will re-create below)
              // eslint-disable-next-line no-new
              new candidateClass();
              console.log(
                '[JarLoader] Successfully loaded and instantiated:',
                candidateFullName,
              );
            } catch (initErr: any) {
              const errMsg = (initErr.message || '').substring(0, 200);
              const isNativeInit =
                errMsg.includes('UnsatisfiedLinkError') ||
                errMsg.includes('native method');
              if (isNativeInit) {
                console.log(
                  '[JarLoader] Candidate instantiates failed (native <init>):',
                  candidateFullName,
                  '-',
                  errMsg.substring(0, 100),
                );
                failedCandidates.push(candidate);
                continue;
              }
              // Non-native error: log but still pick this candidate.
              // The actual instantiation below will handle the error if it
              // persists, and some spiders throw recoverable errors in their
              // constructor that don't prevent homeContent from working.
              console.log(
                '[JarLoader] Candidate instantiates threw non-native error (still picking):',
                candidateFullName,
                '-',
                errMsg.substring(0, 100),
              );
            }
            SpiderClass = candidateClass;
            fullClassName = candidateFullName;
            console.log(
              '[JarLoader] Successfully loaded spider class:',
              fullClassName,
            );
            break;
          } else {
            failedCandidates.push(candidate);
          }
        } catch (candidateErr: any) {
          console.log(
            '[JarLoader] Candidate not found:',
            candidateFullName,
            '-',
            candidateErr.message,
          );
          failedCandidates.push(candidate);
        }
      }

      if (!SpiderClass) {
        // Fallback: case-insensitive class name lookup for Guard spiders.
        // Config API names use lowercase (e.g. csp_WexzhizhenGuard →
        // "Wexzhizhen") but JAR classes use CamelCase ("NewZhiZhen").
        if (isGuard && this.guardClassNameMap.size > 0) {
          // Try the base name (without "Guard") in lowercase
          const lowerKey = realClsKey.toLowerCase();
          // Build a set of tryKeys with various transformations
          const tryKeys = new Set<string>();
          tryKeys.add(lowerKey);
          // With "new" prefix
          if (!lowerKey.startsWith('new')) {
            tryKeys.add('new' + lowerKey);
          }
          // With "wex" prefix stripped for some patterns
          // e.g. csp_WexzhizhenGuard → realClsKey="Wexzhizhen" → try "zhizhen"
          if (lowerKey.startsWith('wex')) {
            const stripped = lowerKey.slice(3);
            tryKeys.add(stripped);
            if (!stripped.startsWith('new')) {
              tryKeys.add('new' + stripped);
            }
            // Also strip "ziyuan" suffix (e.g. "wexerxiaoziyuan" → "erxiao")
            if (stripped.endsWith('ziyuan')) {
              const noZiyuan = stripped.slice(0, -'ziyuan'.length);
              tryKeys.add(noZiyuan);
              tryKeys.add('new' + noZiyuan);
            }
          }
          // Strip "ziyuan" suffix even without "wex" prefix
          // e.g. csp_WexduoduoziyuanGuard → "wexduoduoziyuan" → "duoduo"
          if (lowerKey.endsWith('ziyuan')) {
            const noZiyuan = lowerKey.slice(0, -'ziyuan'.length);
            tryKeys.add(noZiyuan);
            if (!noZiyuan.startsWith('new')) {
              tryKeys.add('new' + noZiyuan);
            }
            // If also starts with "wex", strip both
            if (noZiyuan.startsWith('wex')) {
              const stripped = noZiyuan.slice(3);
              tryKeys.add(stripped);
              tryKeys.add('new' + stripped);
            }
          }
          // With "wex" prefix ADDED for Amns patterns
          // e.g. csp_GuaziAmns → realClsKey="Guazi" → try "wexguazi"
          if (!lowerKey.startsWith('wex')) {
            tryKeys.add('wex' + lowerKey);
            if (!lowerKey.startsWith('new')) {
              tryKeys.add('new' + lowerKey);
            }
          }

          for (const tryKey of tryKeys) {
            const matchedFullName = this.guardClassNameMap.get(tryKey);
            if (matchedFullName) {
              try {
                console.log(
                  '[JarLoader] Case-insensitive fallback: trying',
                  matchedFullName,
                  `(key="${tryKey}" from "${realClsKey}")`,
                );
                const fallbackClass = this.java.importClass(matchedFullName);
                if (fallbackClass) {
                  // Verify instantiation for Guard spiders (encrypted classes
                  // load but throw UnsatisfiedLinkError on instantiation)
                  try {
                    // eslint-disable-next-line no-new
                    new fallbackClass();
                  } catch (initErr: any) {
                    console.log(
                      '[JarLoader] Fallback instantiates failed (likely encrypted original):',
                      matchedFullName,
                      '-',
                      initErr.message?.substring(0, 100),
                    );
                    continue;
                  }
                  SpiderClass = fallbackClass;
                  fullClassName = matchedFullName;
                  console.log(
                    '[JarLoader] Successfully loaded spider class via case-insensitive match:',
                    fullClassName,
                  );
                  break;
                }
              } catch (fallbackErr: any) {
                console.log(
                  '[JarLoader] Case-insensitive fallback failed for',
                  matchedFullName,
                  '-',
                  fallbackErr.message,
                );
              }
            }
          }
        }

        if (!SpiderClass) {
          // Fallback: fuzzy-match class name against indexed JAR classes.
          // This handles cases where the config API name doesn't match any
          // candidate (e.g. csp_XBPQ but JAR contains "XbPq", or csp_Panta91
          // but JAR contains "PanTa"). Works for both Guard and non-Guard.
          // Returns multiple matches in priority order; we iterate and test
          // instantiation, skipping classes that throw UnsatisfiedLinkError
          // (encrypted original classes with native <init>).
          const fuzzyMatches = this.fuzzyMatchSpiderClass(jarKey, realClsKey);
          for (const fuzzyMatch of fuzzyMatches) {
            try {
              console.log(
                '[JarLoader] Trying fuzzy-matched class:',
                fuzzyMatch,
              );
              const fuzzyClass = this.java.importClass(fuzzyMatch);
              if (fuzzyClass) {
                // Test instantiation for ALL spiders (not just Guard).
                // Skip on UnsatisfiedLinkError (native <init>) and try the
                // next match — the Guard JAR's "New*" class likely works.
                try {
                  // eslint-disable-next-line no-new
                  new fuzzyClass();
                  SpiderClass = fuzzyClass;
                  fullClassName = fuzzyMatch;
                  console.log(
                    '[JarLoader] Successfully loaded spider class via fuzzy match:',
                    fullClassName,
                  );
                  break;
                } catch (initErr: any) {
                  const errMsg = (initErr.message || '').substring(0, 200);
                  const isNativeInit =
                    errMsg.includes('UnsatisfiedLinkError') ||
                    errMsg.includes('native method');
                  if (isNativeInit) {
                    console.log(
                      '[JarLoader] Fuzzy match instantiates failed (native <init>), trying next:',
                      fuzzyMatch,
                      '-',
                      errMsg.substring(0, 100),
                    );
                    failedCandidates.push(
                      fuzzyMatch.split('.').pop() || fuzzyMatch,
                    );
                    continue;
                  }
                  // Non-native error: still pick this candidate
                  SpiderClass = fuzzyClass;
                  fullClassName = fuzzyMatch;
                  console.log(
                    '[JarLoader] Fuzzy match threw non-native error (still picking):',
                    fullClassName,
                    '-',
                    errMsg.substring(0, 100),
                  );
                  break;
                }
              }
            } catch (fuzzyErr: any) {
              console.log(
                '[JarLoader] Fuzzy match import failed:',
                fuzzyMatch,
                '-',
                fuzzyErr.message,
              );
            }
          }
        }

        if (!SpiderClass) {
          this.lastError = `Spider class not found. Tried candidates: ${failedCandidates.join(
            ', ',
          )}. The JAR may not contain this class or may not have been converted from DEX format.`;
          console.error('[JarLoader]', this.lastError);
          return false;
        }
      }

      // Create spider instance via importClass constructor proxy.
      const spider = new SpiderClass();

      this.spiders.set(key, {
        spider,
        className: fullClassName,
        ext,
        isGuard,
        initPromise: null,
        classLoader:
          spiderClassLoader || (isGuard ? this.guardClassLoader : undefined),
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
    } finally {
      // Restore the original classloader so subsequent importClass calls
      // (e.g. for Context, HashMap in other methods) use the shared
      // classloader. Also clear the class proxy cache so the next
      // getSpider() call re-imports spider classes via its own classloader.
      if (originalCL) {
        try {
          this.java.setClassLoader(originalCL);
          this.java.clearClassProxies();
        } catch {
          // ignore restore failure
        }
      }
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

    // Bili spider returns url as an array: [label, url, label, url, ...].
    // Pick the first URL (odd index) so the rest of this method can treat
    // parsed.url as a string. Without this, the field-preservation loop
    // below would copy the array back into out.url, causing
    // "out.url.substring is not a function" when logging the result.
    if (Array.isArray(parsed.url) && parsed.url.length >= 2) {
      const firstUrl = parsed.url[1];
      if (typeof firstUrl === 'string') {
        parsed.url = firstUrl;
      }
    }

    // If "url" already exists, use it directly (non-Guard spider path).
    // Still must rewrite GoProxy /kaiser URLs — libwexproxy.so is ARM-only
    // and cannot run on Desktop. Convert to our streamPanDirect endpoints.
    if (typeof parsed.url === 'string') {
      let headerStr: string | undefined;
      if (parsed.header && typeof parsed.header === 'object') {
        headerStr = JSON.stringify(parsed.header);
        parsed.header = headerStr;
      } else if (typeof parsed.header === 'string') {
        headerStr = parsed.header;
      }
      parsed.url = this.rewriteKaiserToPanDirect(parsed.url, flag, headerStr);
      parsed.url = this.rewriteProxyScheme(parsed.url);

      // Auto-route direct pan CDN URLs to ProxyServer if no headers provided.
      // Pan CDNs (Quark/UC/Baidu) require specific headers (Cookie/UA/Referer).
      // If spider returns direct CDN URL without headers, route through
      // streamPanDirect which injects the synced cookie and UA.
      if (parsed.url.startsWith('https://')) {
        const panType = this.detectPanTypeFromFlagOrUrl(flag, parsed.url);
        if (panType) {
          const proxyPort = proxyServer.getPort();
          if (proxyPort > 0) {
            const encodedUrl = encodeURIComponent(parsed.url);
            if (headerStr) {
              // Spider provided custom headers: route through streamPanDirect
              // with the headers as header= override. streamPanDirect will
              // inject pan Cookie + default UA/Referer, then header override
              // takes precedence for User-Agent/Referer. This also handles
              // m3u8 manifests (rewrites TS segment URLs through proxy).
              parsed.url = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodedUrl}&header=${encodeURIComponent(headerStr)}`;
              console.log(
                `[JarLoader] Auto-routing direct ${panType} CDN URL (with headers) through proxy:`,
                parsed.url.substring(0, 120),
              );
            } else {
              // No headers: route through streamPanDirect which injects the
              // synced Cookie/UA/Referer automatically.
              parsed.url = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodedUrl}`;
              console.log(
                `[JarLoader] Auto-routing direct ${panType} CDN URL to ProxyServer:`,
                parsed.url.substring(0, 120),
              );
            }
          }
        }
      }

      // Extract danmu URL from any remaining field
      const danmuUrl = this.extractDanmuUrl(parsed);
      if (danmuUrl) {
        parsed.danmuUrl = danmuUrl;
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
    const headerJson = headerValue ? JSON.stringify(headerValue) : undefined;
    // Rewrite GoProxy /kaiser → /proxy?do=*Direct, then fix port / proxy://.
    let finalUrl = this.rewriteKaiserToPanDirect(urlValue, flag, headerJson);
    finalUrl = this.rewriteProxyScheme(finalUrl);

    // If spider provided custom headers, encode them into the URL for proxy URLs.
    if (headerField && headerValue) {
      out.header = headerJson;
      if (finalUrl.includes('/proxy?do=') && !finalUrl.includes('header=')) {
        const encodedHeader = encodeURIComponent(out.header!);
        finalUrl = finalUrl + '&header=' + encodedHeader;
      } else if (!finalUrl.includes('/proxy?do=')) {
        // Direct video URL (not proxied). Check if it's a pan CDN URL
        // (Quark/UC/Baidu) that needs Cookie injection in addition to
        // the custom headers. For pan URLs, route through streamPanDirect
        // which injects the synced Cookie + UA/Referer, then applies the
        // custom header override. For non-pan URLs, fall back to /m3u8.m3u8.
        let panType = this.detectPanTypeFromFlagOrUrl(flag, finalUrl);
        const proxyPort = proxyServer.getPort();
        if (proxyPort > 0) {
          const encodedUrl = encodeURIComponent(finalUrl);
          const encodedHeader = encodeURIComponent(out.header!);
          if (panType) {
            // Pan CDN URL: route through streamPanDirect which injects
            // the synced Cookie/UA/Referer + custom header override.
            finalUrl = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodedUrl}&header=${encodedHeader}`;
            console.log(
              `[JarLoader] Auto-routing direct ${panType} CDN URL (with headers) through proxy:`,
              finalUrl.substring(0, 120),
            );
          } else {
            // Non-pan URL: route through /m3u8.m3u8 proxy which injects
            // the custom headers and handles TLS fingerprinting.
            finalUrl = `http://127.0.0.1:${proxyPort}/m3u8.m3u8?url=${encodedUrl}&header=${encodedHeader}`;
            console.log(
              '[JarLoader] Routing direct video URL through /m3u8.m3u8 proxy:',
              finalUrl.substring(0, 120),
            );
          }
        } else {
          // Fallback: register headers for webRequest injection
          this.registerVideoUrlHeaders(finalUrl, headerValue);
        }
      }
    } else if (finalUrl.startsWith('https://')) {
      // Auto-route direct pan CDN URLs to ProxyServer if no headers provided.
      // Pan CDNs (Quark/UC/Baidu) require specific headers (Cookie/UA/Referer).
      const panType = this.detectPanTypeFromFlagOrUrl(flag, finalUrl);
      if (panType) {
        const proxyPort = proxyServer.getPort();
        if (proxyPort > 0) {
          const encodedUrl = encodeURIComponent(finalUrl);
          finalUrl = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodedUrl}`;
          console.log(
            `[JarLoader] Auto-routing direct ${panType} CDN URL to ProxyServer:`,
            finalUrl.substring(0, 120),
          );
        }
      }
    }
    out.url = finalUrl;
    // Preserve any non-obfuscated fields verbatim.
    for (const [k, v] of Object.entries(parsed)) {
      if (k === urlField || k === headerField) continue;
      if (/^[oO]{1,3}[oO0-9iI]{10,}$/.test(k)) continue;
      out[k] = v;
    }

    // Extract danmu URL from fields that were skipped (obfuscated or not).
    // Some spiders return danmaku URL as a separate field alongside the video URL.
    const danmuUrl = this.extractDanmuUrl(parsed);
    if (danmuUrl) {
      out.danmuUrl = danmuUrl;
    }

    console.log(
      `[JarLoader] translatePlayerContent: urlField=${urlField}, headerField=${headerField || 'none'}, headerValue=${headerValue ? JSON.stringify(headerValue) : 'none'}, originalUrl=${urlValue.substring(0, 80)}..., rewrittenUrl=${out.url.substring(0, 80)}...`,
    );

    return JSON.stringify(out);
  }

  /**
   * Extract danmaku URL from a parsed spider response.
   * Scans all fields for URL-like values that reference danmu proxy
   * endpoints (autodanmu, wexdanmu, wexautodanmu, WexGoDanmu, etc.).
   * Rewrites 127.0.0.1:8096 (Android proxy port) to the PC proxy port.
   */
  private extractDanmuUrl(parsed: Record<string, any>): string | null {
    const proxyPort = proxyServer.getPort();
    const targetPort = proxyPort > 0 ? proxyPort : 9978;
    for (const v of Object.values(parsed)) {
      if (typeof v !== 'string' || v.length < 20) continue;
      // Match danmu proxy URLs (127.0.0.1-based, containing danmu in do= or path)
      if (
        v.startsWith('http://127.0.0.1') &&
        (v.includes('/proxy?do=autodanmu') ||
          v.includes('/proxy?do=wex') ||
          v.includes('/danmu?do=') ||
          v.includes('danmu') ||
          v.includes('danmaku'))
      ) {
        // Rewrite Android proxy port (8096) to PC proxy port
        const rewritten = v.replace(
          /http:\/\/127\.0\.0\.1:\d+/,
          `http://127.0.0.1:${targetPort}`,
        );
        console.log(
          '[JarLoader] extractDanmuUrl: found danmu URL',
          rewritten.substring(0, 120),
        );
        return rewritten;
      }
      // Also match direct danmu service URLs (non-proxy)
      if (
        v.startsWith('http://') &&
        !v.startsWith('http://127.0.0.1') &&
        !v.startsWith('https://') &&
        (v.includes('danmu') || v.includes('danmaku'))
      ) {
        console.log(
          '[JarLoader] extractDanmuUrl: found direct danmu URL',
          v.substring(0, 120),
        );
        return v;
      }
    }
    return null;
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
   * Convert GoProxy kaiser URLs to Desktop streamPanDirect endpoints.
   *
   * Guard spiders return:
   *   http://127.0.0.1:8096/kaiser?url=<CDN>
   * Android loads libwexproxy.so to serve /kaiser with pan cookies. That
   * native ARM binary cannot run on Desktop, so we rewrite to:
   *   http://127.0.0.1:<port>/proxy?do=<pan>Direct&url=<CDN>
   * which ProxyServer.streamPanDirect serves with the synced Cookie/UA.
   */
  private rewriteKaiserToPanDirect(
    url: string,
    flag: string,
    headerJson?: string,
  ): string {
    if (!url || !url.includes('/kaiser')) return url;

    let cdnUrl = '';
    let thread: string | null = null;
    let chunk: string | null = null;
    let key: string | null = null;
    let type: string | null = null;

    try {
      const parsed = new URL(url);
      if (!parsed.pathname.includes('kaiser')) return url;
      cdnUrl = parsed.searchParams.get('url') || '';
      thread = parsed.searchParams.get('thread');
      chunk = parsed.searchParams.get('chunk');
      key = parsed.searchParams.get('key');
      type = parsed.searchParams.get('type');
      // URL may already be percent-encoded once — keep as-is for re-encode.
      if (!cdnUrl) return url;
      try {
        cdnUrl = decodeURIComponent(cdnUrl);
      } catch {
        /* keep raw */
      }
    } catch {
      const m = url.match(/[?&]url=([^&]+)/);
      if (!m) return url;
      try {
        cdnUrl = decodeURIComponent(m[1]);
      } catch {
        cdnUrl = m[1];
      }
      // 尝试从原始 URL 中提取其他参数
      const threadMatch = url.match(/[?&]thread=([^&]+)/);
      const chunkMatch = url.match(/[?&]chunk=([^&]+)/);
      const keyMatch = url.match(/[?&]key=([^&]+)/);
      const typeMatch = url.match(/[?&]type=([^&]+)/);
      if (threadMatch) thread = threadMatch[1];
      if (chunkMatch) chunk = chunkMatch[1];
      if (keyMatch) key = keyMatch[1];
      if (typeMatch) type = typeMatch[1];
    }

    const panType = this.detectPanTypeFromFlagOrUrl(flag, cdnUrl);
    if (!panType) {
      console.warn(
        '[JarLoader] rewriteKaiserToPanDirect: cannot detect pan type, flag=',
        flag,
        'cdn=',
        cdnUrl.substring(0, 80),
      );
      return url;
    }

    let proxyPort = 9978;
    try {
      const p = proxyServer.getPort();
      if (p > 0) proxyPort = p;
    } catch {}

    let rewritten = `http://127.0.0.1:${proxyPort}/proxy?do=${panType}Direct&url=${encodeURIComponent(cdnUrl)}`;
    if (thread) rewritten += `&thread=${thread}`;
    if (chunk) rewritten += `&chunk=${chunk}`;
    if (key) rewritten += `&key=${encodeURIComponent(key)}`;
    if (type) rewritten += `&type=${encodeURIComponent(type)}`;
    if (headerJson && !rewritten.includes('header=')) {
      rewritten += `&header=${encodeURIComponent(headerJson)}`;
    }
    console.log(
      `[JarLoader] rewriteKaiserToPanDirect: /kaiser → do=${panType}Direct, port=${proxyPort}, thread=${thread}, chunk=${chunk}, key=${key}, type=${type}, cdn=${cdnUrl.substring(0, 80)}`,
    );
    return rewritten;
  }

  /**
   * Detect pan type from play flag name and/or CDN hostname.
   */
  private detectPanTypeFromFlagOrUrl(
    flag: string,
    cdnUrl: string,
  ): 'quark' | 'uc' | 'baidu' | null {
    const f = (flag || '').toLowerCase();
    if (/夸克|夸父|quark/.test(f)) return 'quark';
    if (/uc原画|uc盘|\buc\b|优视/.test(f)) return 'uc';
    if (/百度|baidu|b度/.test(f)) return 'baidu';

    const u = (cdnUrl || '').toLowerCase();
    if (u.includes('quark.cn') || u.includes('quark')) return 'quark';
    if (u.includes('uc.cn') || u.includes('drive.uc')) return 'uc';
    if (u.includes('baidupcs.com') || u.includes('baidu.com')) return 'baidu';
    return null;
  }

  /**
   * Rewrite proxy URLs to use the actual ProxyServer port.
   *
   * 1. proxy:// URLs → http://127.0.0.1:<port>/proxy?
   *    (Bili, MQiTV, Local, WebDAV spiders use this scheme)
   *
   * 2. http://127.0.0.1:8096 URLs → http://127.0.0.1:<port>
   *    (Spiders return URLs with hardcoded 8096 port, but ProxyServer
   *    may listen on a different port if 8096 is unavailable)
   */
  private rewriteProxyScheme(url: string): string {
    let proxyPort = 8096;
    try {
      const p = proxyServer.getPort();
      if (p > 0) proxyPort = p;
    } catch {}

    // Pattern 1: proxy:// URLs
    if (url.startsWith('proxy://')) {
      const rewritten = url.replace(
        /^proxy:\/\//,
        `http://127.0.0.1:${proxyPort}/proxy?`,
      );
      console.log(
        `[JarLoader] rewriteProxyScheme: proxy:// → http://127.0.0.1:${proxyPort}/proxy?`,
      );
      return rewritten;
    }

    // Pattern 2: Spider hardcoded localhost ports → actual ProxyServer port
    if (
      proxyPort > 0 &&
      /127\.0\.0\.1:(8096|9978|9979|9980)/.test(url) &&
      !url.includes(`127.0.0.1:${proxyPort}`)
    ) {
      const rewritten = url.replace(
        /127\.0\.0\.1:(8096|9978|9979|9980)/g,
        `127.0.0.1:${proxyPort}`,
      );
      console.log(
        `[JarLoader] rewriteProxyScheme: localhost port → ${proxyPort}`,
      );
      return rewritten;
    }

    return url;
  }

  /**
   * Cached SafeSpiderCaller class proxy.
   * Lazy-imported on first use to avoid slowing down startup.
   */
  private safeCallerClass: any = null;

  /**
   * Fallback for when java-bridge's String → JS conversion fails with
   * "invalid utf-8 sequence" (caused by unpaired surrogates in the Java
   * String returned by spider methods like NewDuoDuo.detailContent).
   *
   * Calls the spider method reflectively via SafeSpiderCaller, which
   * returns byte[] (Java byte[] → Node Buffer, no UTF-8 conversion).
   * The bytes are decoded in Node.js with replacement for any
   * remaining invalid sequences.
   *
   * Returns null if the method is not supported by SafeSpiderCaller or
   * the call failed.
   */
  private async callViaSafeBytes(
    spider: any,
    method: string,
    javaArgs: any[],
  ): Promise<string | null> {
    if (!this.java) return null;
    try {
      if (!this.safeCallerClass) {
        this.safeCallerClass = this.java.importClass(
          'com.github.catvod.utils.SafeSpiderCaller',
        );
      }
      const Caller = this.safeCallerClass;
      let bytesPromise: Promise<any> | null = null;

      if (method === 'detailContent' && javaArgs.length >= 1) {
        bytesPromise = Caller.detailContentBytes(spider, javaArgs[0]);
      } else if (method === 'homeContent' && javaArgs.length >= 1) {
        bytesPromise = Caller.homeContentBytes(spider, javaArgs[0]);
      } else if (method === 'categoryContent' && javaArgs.length >= 3) {
        bytesPromise = Caller.categoryContentBytes(
          spider,
          javaArgs[0],
          javaArgs[1],
          javaArgs[2],
        );
      } else if (method === 'searchContent' && javaArgs.length >= 2) {
        bytesPromise = Caller.searchContentBytes(
          spider,
          javaArgs[0],
          javaArgs[1],
        );
      } else if (method === 'playerContent' && javaArgs.length >= 2) {
        bytesPromise = Caller.playerContentBytes(
          spider,
          javaArgs[0],
          javaArgs[1],
        );
      } else {
        console.warn(
          `[JarLoader] SafeSpiderCaller: method ${method} not supported`,
        );
        return null;
      }

      const bytes = await Promise.race([
        bytesPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`SafeSpiderCaller ${method} timed out`)),
            60000,
          ),
        ),
      ]);
      if (!bytes || !bytes.length) return '';
      // bytes is a Java byte[] → Node Buffer (or Int8Array-like).
      // Buffer.from with no copy if it's already a Buffer.
      const buf = Buffer.from(bytes);
      // Buffer.toString('utf-8') replaces invalid sequences with U+FFFD.
      return buf.toString('utf-8');
    } catch (e: any) {
      console.warn(
        `[JarLoader] SafeSpiderCaller ${method} failed:`,
        e?.message || e,
      );
      return null;
    }
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
            let asyncResult: any;
            try {
              asyncResult = await Promise.race([result, timeoutPromise]);
            } catch (raceErr: any) {
              console.warn(
                `[JarLoader] async ${method} race rejected:`,
                raceErr?.message || raceErr,
              );
              // Fallback: if the Java String returned by the spider contains
              // unpaired surrogates, java-bridge's JNI GetStringUTFChars
              // produces invalid UTF-8 that the native Rust layer rejects
              // with "invalid utf-8 sequence of N bytes from index M". Retry
              // via SafeSpiderCaller which calls the method reflectively and
              // returns bytes via String.getBytes(UTF_8) (replaces invalid
              // surrogates with U+FFFD). Node.js then decodes the bytes.
              if (/invalid utf-8/i.test(raceErr?.message || '')) {
                const safeResult = await this.callViaSafeBytes(
                  spider,
                  method,
                  javaArgs,
                );
                if (safeResult !== null) {
                  console.log(
                    `[JarLoader] SafeSpiderCaller fallback ${method}: len=${safeResult.length}`,
                  );
                  console.log(
                    `[JarLoader] SafeSpiderCaller ${method} preview:`,
                    safeResult.substring(0, 300),
                  );
                  return safeResult;
                }
              }
              if (isSlowMethod) throw raceErr;
              return '{}';
            }
            // Detailed diagnostics: distinguish string / null / Java object
            if (typeof asyncResult === 'string') {
              console.log(
                `[JarLoader] async ${method} resolved string len=${asyncResult.length}`,
              );
              console.log(
                `[JarLoader] async ${method} preview:`,
                asyncResult.substring(0, 300),
              );
              return asyncResult;
            }
            if (asyncResult === null || asyncResult === undefined) {
              console.warn(
                `[JarLoader] async ${method} resolved ${String(asyncResult)}`,
              );
              return '{}';
            }
            // Non-string (likely Java object). Try JSON.stringify, then
            // .toStringSync()/toString(), so we don't silently return '{}'.
            let str: string;
            try {
              str = JSON.stringify(asyncResult);
            } catch {
              try {
                const ts =
                  typeof asyncResult.toStringSync === 'function'
                    ? asyncResult.toStringSync()
                    : typeof asyncResult.toString === 'function'
                      ? asyncResult.toString()
                      : '';
                str = typeof ts === 'string' ? ts : '{}';
              } catch {
                str = '{}';
              }
            }
            console.log(
              `[JarLoader] async ${method} stringified len=${str.length}`,
            );
            console.log(
              `[JarLoader] async ${method} preview:`,
              str.substring(0, 300),
            );
            return str;
          }
          if (typeof result === 'string') return result;
          // Non-Promise Java object — same handling
          let syncStr: string;
          try {
            syncStr = JSON.stringify(result);
          } catch {
            try {
              const ts =
                typeof result.toStringSync === 'function'
                  ? result.toStringSync()
                  : typeof result.toString === 'function'
                    ? result.toString()
                    : '{}';
              syncStr = typeof ts === 'string' ? ts : '{}';
            } catch {
              syncStr = '{}';
            }
          }
          return syncStr;
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
    // Empty/whitespace result: spider returned nothing (e.g. NewDouBanGuard
    // detailContent returns '' when the detail page HTTP request fails).
    // Treat as missing so retry logic kicks in — the first call may have
    // failed due to a cold connection or transient network issue.
    if (!result || !result.trim()) return true;
    try {
      const parsed = JSON.parse(result);
      const list = parsed.list;
      // Empty result {} or empty list — the spider's pan resolver likely
      // timed out (5s internal Quark API timeout on cold connection) and
      // returned nothing. Retry: the first call warmed the JVM DNS cache
      // and OkHttp connection pool, so the next call usually completes.
      if (!Array.isArray(list) || list.length === 0) return true;
      const vod = list[0];
      if (!vod || typeof vod !== 'object') return true;
      const hasPlayUrl =
        vod.vod_play_url !== undefined &&
        vod.vod_play_url !== null &&
        vod.vod_play_url !== '';
      const hasPlayFrom =
        vod.vod_play_from !== undefined &&
        vod.vod_play_from !== null &&
        vod.vod_play_from !== '';
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
      // Non-JSON result (e.g. HTML error page): treat as missing so retry
      // can attempt to get a valid response.
      return true;
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
        // Preserve native libraries (libLoadNiMa.so etc.) across retries.
        // They are large, static, and do not change between retries.
        // Only clear siteconfig and other transient cache files.
        const entries = fs.readdirSync(spiderCacheDir);
        for (const entry of entries) {
          if (entry.endsWith('.so')) continue;
          const entryPath = path.join(spiderCacheDir, entry);
          try {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } catch {
            // ignore individual file deletion errors
          }
        }
        console.log(
          '[JarLoader] Cleared spider file cache (preserved .so):',
          spiderCacheDir,
        );
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

    // Pre-playback UC cookie refresh (same __pus/__puus model as Quark).
    if (
      method === 'playerContent' &&
      typeof args[0] === 'string' &&
      /uc|UC|优视/i.test(args[0]) &&
      UCPanService.getSyncedCookie()
    ) {
      try {
        const refreshResult = await UCPanService.refreshCookieForPlayback();
        if (refreshResult.expired) {
          console.warn(
            '[JarLoader] playerContent: UC login expired, emitting pan:loginExpired',
          );
          try {
            BrowserWindow.getAllWindows().forEach((w) =>
              w.webContents.send('pan:loginExpired', 'uc'),
            );
          } catch (e: any) {
            console.warn(
              '[JarLoader] Failed to emit pan:loginExpired:',
              e.message,
            );
          }
          throw new Error('UC login expired, please re-scan QR code');
        }
        if (refreshResult.refreshed && refreshResult.cookie) {
          UCPanService.setSyncedCookie(refreshResult.cookie);
          await UCPanService.syncToGuardPrefs(refreshResult.cookie);
        }
      } catch (e: any) {
        if (e.message?.includes('UC login expired')) throw e;
        console.warn(
          '[JarLoader] playerContent: UC cookie refresh failed, continuing:',
          e.message,
        );
      }
    }

    // Pre-playback Baidu login check.
    // Baidu doesn't have a refreshCookieForPlayback like Quark/UC — the BDUSS
    // cookie is long-lived. But if no cookie is saved at all, skip the spider
    // call and prompt re-login immediately.
    if (
      method === 'playerContent' &&
      typeof args[0] === 'string' &&
      /百度|baidu|B度/i.test(args[0]) &&
      !BaiduPanService.getSyncedCookie()
    ) {
      console.warn(
        '[JarLoader] playerContent: Baidu cookie missing, emitting pan:loginExpired',
      );
      try {
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send('pan:loginExpired', 'baidu'),
        );
      } catch (e: any) {
        console.warn('[JarLoader] Failed to emit pan:loginExpired:', e.message);
      }
      throw new Error('Baidu login required, please scan QR code');
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

    // Switch to spider's isolated classloader so java-bridge's native
    // Class.forName() (called inside executeSpiderMethod when invoking
    // spider.homeContent/detailContent/etc.) resolves spider classes from
    // THIS spider's JAR. Without this, getSpider's finally block restores
    // the shared stubs classloader, and the next callSpiderMethod's
    // Class.forName('com.github.catvod.spider.X') fails with
    // ClassNotFoundException because stubs don't contain spider classes.
    // Guard spiders have no classLoader (they use shared JAR via
    // appendClasspath) and skip the switch.
    const spiderCL = instance.classLoader;
    let savedCL: any = null;
    if (spiderCL && this.java) {
      try {
        savedCL = this.java.getClassLoader();
        this.java.setClassLoader(spiderCL);
        this.java.clearClassProxies();
        console.log(
          '[JarLoader] Switched to spider classloader for',
          method,
          'key:',
          key,
        );
      } catch (clErr: any) {
        console.warn(
          '[JarLoader] Failed to switch classloader for callSpiderMethod:',
          clErr.message,
        );
      }
    }

    try {
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
            const ContextClass = this.java.importClass(
              'android.content.Context',
            );
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
          if (
            this.needsSourceSpecificHandling(clsKey) &&
            method === 'homeContent'
          ) {
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
              const decodedResult = await this.callLoadNiMaDecode(
                clsKey,
                result,
              );

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
            console.log(
              '[JarLoader] ========== detailContent debug ==========',
            );
            console.log(
              '[JarLoader] detailContent args =',
              JSON.stringify(args),
            );
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
            console.log(
              '[JarLoader] ========== playerContent debug ==========',
            );
            console.log('[JarLoader] playerContent flag =', args[0]);
            console.log(
              '[JarLoader] playerContent id (full) =',
              typeof args[1] === 'string' ? args[1] : args[1],
            );
            console.log(
              '[JarLoader] playerContent raw result (full) =',
              result,
            );
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
            console.log(
              '[JarLoader] Error, clearing file cache and retrying...',
            );
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
            `[JarLoader] ${key} ${method} exhausted all retries and failed`,
          );

          // For playerContent, return the error message so the renderer can
          // show a meaningful message instead of generic "资源已失效".
          // The spider exception often contains the actual root cause, e.g.
          // "未登录百度" or "非会员，请到配置中心用UC浏览器扫描TvToken".
          if (method === 'playerContent') {
            const errMsg = err?.message || String(err);
            // Common Java exception prefixes to strip for cleaner display
            let cleanMsg = errMsg;
            const npeMatch = cleanMsg.match(
              /java\.lang\.(NullPointerException|IllegalStateException|RuntimeException):\s*(.+)/,
            );
            if (npeMatch) {
              cleanMsg = npeMatch[2];
            }
            // If the message is too technical (e.g. "Cannot invoke..."), show
            // a generic message but log the technical details.
            if (
              cleanMsg.startsWith('Cannot invoke') ||
              cleanMsg.startsWith('Cannot cast')
            ) {
              console.error(
                `[JarLoader] ${key} playerContent technical error:`,
                errMsg,
              );
              return JSON.stringify({
                msg: '播放源解析失败，请稍后重试或更换播放源',
              });
            }
            return JSON.stringify({ msg: cleanMsg });
          }

          return '{}';
        }
      }

      return '{}';
    } finally {
      // Restore the original classloader so subsequent calls (e.g. for
      // other spiders, or imports of stub classes like Context) use the
      // shared stubs classloader, not this spider's isolated one.
      if (spiderCL && savedCL && this.java) {
        try {
          this.java.setClassLoader(savedCL);
          this.java.clearClassProxies();
        } catch {
          // ignore restore failure
        }
      }
    }
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
    // If ext is a URL with non-ASCII characters, URL-encode the path.
    // java-bridge corrupts Unicode strings, so Chinese characters in URLs
    // cause fetch failures (e.g. XYQHiker siteconfig returns null → NPE).
    if (/^https?:\/\//.test(ext) && /[^\x00-\x7F]/.test(ext)) {
      try {
        const encoded = encodeURI(ext);
        if (encoded !== ext) {
          console.log(
            '[JarLoader] cleanExtForSpider: URL-encoded non-ASCII:',
            ext.substring(0, 80),
            '->',
            encoded.substring(0, 80),
          );
        }
        return encoded;
      } catch {
        // keep original if encoding fails
      }
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
      // This check applies to ALL spiders, not just Guard ones. Non-Guard
      // spiders like YGP (csp_YGP) also override init(Context) to decode
      // obfuscated config into instance fields. Without this, init resolves
      // to the empty base-class no-op and homeContent returns "{}".
      //
      // Additionally, set InitOrigin.oOoOoOo0O0O0oO0o (the static filesDir
      // field) so oOoOoOoOo0Oo0o0o("siteconfig") resolves to
      // <filesDir>/NewWex/siteconfig. Without this, the field is null and
      // the path becomes "null/NewWex/siteconfig" which doesn't exist.
      const hasInitContextOverride = this.hasInitContextOverride(
        instance.spider,
      );
      if (hasInitContextOverride) {
        try {
          const InitOrigin = this.java.importClass(
            'com.github.catvod.spider.InitOrigin',
          );
          const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
          const filesDir = path.join(tmpDir, 'tvbox_' + sanitizedKey);
          if (!fs.existsSync(filesDir)) {
            fs.mkdirSync(filesDir, { recursive: true });
          }
          InitOrigin.oOoOoOo0O0O0oO0o = filesDir;
          console.log(
            '[JarLoader] Set InitOrigin.oOoOoOo0O0O0oO0o =',
            filesDir,
          );

          // Copy libLoadNiMa.so from shared native_libs dir to per-spider
          // filesDir so the spider's unidbg loader can find it. The spider
          // reads InitOrigin.oOoOoOo0O0O0oO0o to locate filesDir, then looks
          // for filesDir/libLoadNiMa.so. Without this copy, the per-spider
          // filesDir override breaks libLoadNiMa.so discovery.
          const sharedLibPath = path.join(
            this.jarCacheDir,
            'native_libs',
            'libLoadNiMa.so',
          );
          if (fs.existsSync(sharedLibPath)) {
            const perSpiderLibPath = path.join(filesDir, 'libLoadNiMa.so');
            if (!fs.existsSync(perSpiderLibPath)) {
              fs.copyFileSync(sharedLibPath, perSpiderLibPath);
              console.log(
                '[JarLoader] Copied libLoadNiMa.so to per-spider filesDir:',
                perSpiderLibPath,
              );
            }
          }
        } catch (e: any) {
          console.warn(
            '[JarLoader] Failed to set InitOrigin filesDir:',
            e.message,
          );
        }

        try {
          instance.spider.initSync(context);
          console.log(
            '[JarLoader] Spider initialized with init(Context):',
            key,
            instance.isGuard ? '(Guard)' : '(non-Guard)',
          );
          // Inspect spider's base URL field directly (field name from decompiled
          // source: `public String oOoOoOoOoOoOoO0o`). This is the only way to
          // verify init() actually picked a working mirror URL instead of
          // falling back to the hijacked http://www.wogg.lol hardcoded default.
          try {
            const baseUrl = instance.spider.oOoOoOoOoOoOoO0o;
            console.log(
              '[JarLoader] Spider base URL after init:',
              String(baseUrl),
            );
          } catch (e: any) {
            // Non-Guard spiders don't have this field — ignore.
          }
          // Guard spiders (NewWogg/NewJuTou) only need init(Context) —
          // they read siteconfig and don't use the ext string.
          // Non-Guard SpiderApi subclasses (XBPQ, XYQBiu, etc.) also
          // override init(Context) to do base setup, but they need the
          // ext string passed via init(Context, String) to set request
          // rules, headers, etc. Without this, homeContent returns class
          // list but no video items, and categoryContent NPEs because
          // the JSON config fields are never parsed.
          if (instance.isGuard) {
            return;
          }
        } catch (ctxInitErr: any) {
          console.warn(
            '[JarLoader] init(Context) failed, falling back:',
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
      //
      // MUST be awaited (async) — the <clinit> makes an HTTP request to
      // 127.0.0.1:9978/platform which is served by this same Node.js event
      // loop. If we use forNameSync, the event loop blocks waiting for
      // <clinit> to finish, but <clinit> is waiting for ProxyServer to
      // respond to /platform, which can't run because the event loop is
      // blocked → deadlock → 5s timeout → VodBean class init fails → NPE.
      // Using async forName frees the event loop so ProxyServer can respond.
      await this.triggerGuardStaticInit(spider);
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
   *   merge.OoOoOo0O0Oo0o0oO.OoOoOo0O0Oo0o0oO.oOoOoOo0O0O0oO0o ← Wex_baidu_cookie
   *     (Baidu spider core class, OoOoOo0O0Oo0o0oO.java:95,615 — cookie used in
   *      API headers via oOoOoOo0oO0oO0o0() which puts oOoOoOo0O0O0oO0o as Cookie)
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
        {
          className:
            'com.github.catvod.spider.merge.OoOoOo0O0Oo0o0oO.OoOoOo0O0Oo0o0oO',
          fieldName: 'oOoOoOo0O0O0oO0o',
          prefKey: 'Wex_baidu_cookie',
          label: 'baidu',
        },
        {
          className:
            'com.github.catvod.spider.merge.OoOoOo0O0Oo0o0oO.OoOoOo0O0Oo0o0oO',
          fieldName: 'oOoO0o0oOo0oO0Oo',
          prefKey: 'Wex_baidu_cookie',
          label: 'baidu-aux',
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
          console.log(
            `[JarLoader] setPanCookies: importing ${pan.label} class:`,
            pan.className,
          );
          const cls = this.java.importClass(pan.className);
          cls[pan.fieldName] = cookie;
          console.log(
            `[JarLoader] setPanCookies: set ${pan.label} static cookie (len=${cookie.length})`,
          );
          // Also write to com.github.catvod.tvbox_preferences for the
          // spider's SharedPreferences-based read path (e_1.b / e_1.a / e_1.d).
          // Both UC and Baidu use the same XOR-with-"miwudi" encryption.
          if (pan.label === 'uc' || pan.label === 'baidu') {
            try {
              const PREFS = 'com.github.catvod.tvbox_preferences';
              const XOR_KEY = 'miwudi';
              const prefs = ctx.getSharedPreferencesSync(PREFS, 0);
              if (prefs) {
                const editor = prefs.editSync();
                // Encrypted: XOR with "miwudi" then Base64 (mirrors e_1.b)
                const keyChars = XOR_KEY.split('');
                const out: string[] = [];
                for (let i = 0; i < cookie.length; i++) {
                  const c = cookie.charCodeAt(i);
                  const k = keyChars[i % keyChars.length].charCodeAt(0);
                  out.push(String.fromCharCode(c ^ k));
                }
                const encrypted = Buffer.from(out.join(''), 'utf8').toString(
                  'base64',
                );
                const prefsKey = pan.label === 'uc' ? 'uc' : 'baidu';
                editor.putStringSync(`mi.${prefsKey}`, encrypted);
                editor.putStringSync(`.${prefsKey}`, cookie);
                editor.applySync();
                console.log(
                  `[JarLoader] setPanCookies: also synced ${pan.label} cookie to ${PREFS} (mi.${prefsKey} + .${prefsKey})`,
                );
              }
            } catch (e2: any) {
              console.warn(
                `[JarLoader] setPanCookies: failed to write ${pan.label} to ${PREFS}:`,
                e2?.message || e2,
              );
            }
          }
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          console.warn(
            `[JarLoader] setPanCookies: failed to set ${pan.label} cookie:`,
            `class=${pan.className}`,
            `error=${errMsg}`,
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
  private async triggerGuardStaticInit(spider: JavaObject): Promise<void> {
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
      // Use async variants (getClass / getClassLoader) instead of Sync
      // versions. Although these are quick JVM calls, keeping the event loop
      // free is a good habit. More importantly, the forName call below MUST
      // be async.
      const spiderClass =
        typeof spider.getClassSync === 'function'
          ? spider.getClassSync()
          : spider.getClass();
      classLoader =
        typeof spiderClass.getClassLoaderSync === 'function'
          ? spiderClass.getClassLoaderSync()
          : spiderClass.getClassLoader();
    } catch (e: any) {
      console.warn(
        '[JarLoader] preWarm: failed to get spider classloader:',
        e?.message || e,
      );
      return;
    }
    const ClassClass = this.java.importClass('java.lang.Class');
    for (const className of classesToWarm) {
      try {
        // loadClass(name) loads but doesn't initialize. Use the 3-arg
        // Class.forName(name, initialize, classloader) to trigger <clinit>.
        //
        // CRITICAL: Must use ASYNC forName, NOT forNameSync. The <clinit>
        // makes an HTTP request to 127.0.0.1:9978/platform which is served
        // by this Node.js process. forNameSync blocks the event loop →
        // ProxyServer can't respond to /platform → <clinit> times out after
        // 5s → class init fails → detailContent returns no vod_play_url.
        // Async forName yields the event loop so ProxyServer can handle
        // the /platform request immediately.
        if (typeof ClassClass.forName === 'function') {
          try {
            await ClassClass.forName(className, true, classLoader);
            console.log(
              '[JarLoader] preWarm: triggered static init for',
              className,
            );
            continue;
          } catch (e: any) {
            // <clinit> may throw RuntimeException wrapping TimeoutException
            // if /platform still times out. Log and fall through to loadClass
            // (which at least loads the class without initializing).
            console.warn(
              '[JarLoader] preWarm: forName threw for',
              className,
              ':',
              e?.message || e,
            );
          }
        }
        // Fallback: loadClass without initialization. Avoids the <clinit>
        // HTTP call entirely; <clinit> will run on first real use.
        const loaded = classLoader.loadClassSync
          ? classLoader.loadClassSync(className)
          : await classLoader.loadClass(className);
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
    this.spiderClassLoaders.clear();
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
  // Remove existing handlers to prevent duplicate registration errors
  // during Electron hot reload in dev mode
  const handlerNames = [
    'jar:load',
    'jar:getSpider',
    'jar:initSpider',
    'jar:callMethod',
    'jar:getLastError',
    'jar:listSpiderMethods',
    'jar:prefs:getNames',
    'jar:prefs:getValue',
    'jar:prefs:setValue',
    'jar:clear',
    'jar:clearSpiderCache',
    'jar:testAllSources',
    'jar:testGuardSources',
    'jar:debugClassLoad',
    'jar:getSpiderState',
  ];
  for (const name of handlerNames) {
    try {
      ipcMain.removeHandler(name);
    } catch {
      /* ignore */
    }
  }

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
      // 以及 Desktop pan service 内存缓存（streamPanDirect 依赖）。
      if (extraCookies && method === 'playerContent') {
        const cookieSummary = Object.keys(extraCookies).map(
          (k) => `${k}(len=${extraCookies[k].length})`,
        );
        console.log(
          '[JarLoader] jar:callMethod received cookies:',
          cookieSummary,
        );
        // Also log to file via the debug channel if available later
        try {
          if (extraCookies.quark) {
            await QuarkPanService.syncCookieToJVM(extraCookies.quark);
          }
          if (extraCookies.uc) {
            UCPanService.setSyncedCookie(extraCookies.uc);
            await UCPanService.syncToGuardPrefs(extraCookies.uc);
          }
          if (extraCookies.baidu) {
            BaiduPanService.setSyncedCookie(extraCookies.baidu);
            await BaiduPanService.syncToGuardPrefs(extraCookies.baidu);
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

  // Diagnostic: return SpiderInstance state for a given key.
  // Used to debug classloader issues (e.g. instance.classLoader undefined
  // causing ClassNotFoundException in callSpiderMethod retries).
  ipcMain.handle('jar:getSpiderState', async (_event, spiderKey: string) => {
    try {
      const instance = (jarLoader as any).spiders.get(spiderKey);
      if (!instance) {
        return {
          success: true,
          found: false,
          spiderKey,
          spiderClassLoadersSize: (jarLoader as any).spiderClassLoaders.size,
          classLoadersSize: (jarLoader as any).classLoaders.size,
        };
      }
      return {
        success: true,
        found: true,
        spiderKey,
        className: instance.className,
        isGuard: instance.isGuard,
        hasClassLoader: !!instance.classLoader,
        classLoaderType: instance.classLoader
          ? typeof instance.classLoader
          : 'undefined',
        extPreview: (instance.ext || '').substring(0, 80),
        spiderClassLoadersSize: (jarLoader as any).spiderClassLoaders.size,
        classLoadersSize: (jarLoader as any).classLoaders.size,
        recentJarKey: (jarLoader as any).recentJarKey,
      };
    } catch (e: any) {
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

  // Debug: test class loading from a specific JAR
  ipcMain.handle(
    'jar:debugClassLoad',
    async (_event, className: string, jarUrl: string) => {
      try {
        if (!jarLoader.java) {
          return { success: false, error: 'java-bridge not available' };
        }
        const results: any = { className, jarUrl };

        // Try importClass directly
        try {
          const cls = jarLoader.java.importClass(className);
          results.importClassResult = !!cls;
          if (cls) {
            try {
              const instance = new cls();
              results.newInstanceResult = !!instance;
            } catch (instErr: any) {
              results.newInstanceError = instErr.message;
            }
          }
        } catch (importErr: any) {
          results.importClassError = importErr.message;
        }

        // List classpath entries
        try {
          const cp = jarLoader.java.classpath.get();
          results.classpathEntries = cp.length;
          results.classpathList = cp.slice(-10); // last 10 entries
        } catch (cpErr: any) {
          results.classpathError = cpErr.message;
        }

        // Try listing spider classes from the JAR using JarFile
        if (jarUrl) {
          const urls = jarUrl.split(';md5;');
          const jarKey = crypto.createHash('md5').update(urls[0]).digest('hex');
          results.jarKey = jarKey;
          results.classLoadersHas = jarLoader.classLoaders.has(jarKey);

          // Try to read class names from JAR file on disk
          const jarCacheDir = jarLoader.jarCacheDir;
          const convertedPath = path.join(
            jarCacheDir,
            `${jarKey}_converted.jar`,
          );
          const originalPath = path.join(jarCacheDir, `${jarKey}.jar`);
          results.convertedJarExists = fs.existsSync(convertedPath);
          results.originalJarExists = fs.existsSync(originalPath);

          // Use java.util.jar.JarFile to list entries
          try {
            const JarFileClass = jarLoader.java.importClass(
              'java.util.jar.JarFile',
            );
            const jarFilePath = fs.existsSync(convertedPath)
              ? convertedPath
              : originalPath;
            const jarFile = new JarFileClass(jarFilePath);
            const entries = jarFile.entriesSync();
            const spiderClasses: string[] = [];
            while (entries.hasMoreElementsSync()) {
              const entry = entries.nextElementSync();
              const name = entry.getNameSync();
              if (
                name.startsWith('com/github/catvod/spider/') &&
                name.endsWith('.class') &&
                !name.includes('$') &&
                !name.includes('/merge/')
              ) {
                spiderClasses.push(name);
              }
            }
            jarFile.closeSync();
            results.spiderClassesInJar = spiderClasses;
          } catch (jarErr: any) {
            results.jarListError = jarErr.message;
          }
        }

        results.success = true;
        return results;
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },
  );

  console.log('[JarLoader] IPC handlers registered');

  // Kick off Guard spider JAR preloading in the background so that when the
  // user clicks a Guard source (e.g. WexGuaZiGuard), the heavy InitOrigin.init()
  // network I/O has already completed. This keeps the main window responsive
  // because getSpider() just awaits the promise rather than starting the work
  // synchronously on the IPC call.
  jarLoader.preloadGuardSpiderJar();
}
