/**
 * JarLoader - JAR Spider Loader for Electron Main Process
 *
 * Implements PNG steganography extraction and JAR loading using java-bridge.
 * Supports DEX to JAR conversion for Android DEX files.
 * Based on Box Android's ApiConfig.java and JarLoader.java implementation.
 */

import { ipcMain } from 'electron';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { DexConverter, dexConverter } from './DexConverter';

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
}

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
        const created = java.ensureJvm({ classpath: stubPaths });
        if (created) {
          console.log('[JarLoader] JVM started with stubs on system classpath');
          this.stubsLoaded = true;
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
      'json.jar',
      'gson.jar',
      'tvbox-spider-stubs.jar',
    ];

    for (const toolsDir of toolsDirs) {
      const stubPath = path.join(toolsDir, 'tvbox-spider-stubs.jar');
      const exists = fs.existsSync(stubPath);
      console.log(
        `[JarLoader] Checking tools dir: ${toolsDir} | tvbox-spider-stubs.jar exists: ${exists}`,
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
      'json.jar',
      'gson.jar',
      'tvbox-spider-stubs.jar',
    ];

    for (const toolsDir of toolsDirs) {
      const stubJarPath = path.join(toolsDir, 'tvbox-spider-stubs.jar');
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
   * Get Spider instance from JAR
   * className format: "csp_Duopan" -> JAR class: "com.github.catvod.spider.Duopan"
   */
  public getSpider(
    key: string,
    className: string,
    ext: string,
    jarUrl: string = '',
  ): boolean {
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
    const fullClassName = `com.github.catvod.spider.${clsKey}`;

    // Determine JAR key
    let jarKey = 'main';
    if (jarUrl) {
      const urls = jarUrl.split(';md5;');
      jarKey = crypto.createHash('md5').update(urls[0]).digest('hex');
    }

    this.recentJarKey = jarKey;

    // Check if JAR is loaded
    if (!this.classLoaders.has(jarKey)) {
      this.lastError = `JAR not loaded for spider: ${key} (jarKey: ${jarKey}). The JAR file may not have been downloaded or converted properly.`;
      console.warn('[JarLoader]', this.lastError);
      return false;
    }

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
          '[JarLoader] Ensure tvbox-spider-stubs.jar is in the classpath',
        );
      }

      return false;
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

    if (isSlowMethod) {
      try {
        const asyncFunc = spider[method];
        if (asyncFunc && typeof asyncFunc === 'function') {
          const result = asyncFunc.call(spider, ...javaArgs);
          if (result && typeof result.then === 'function') {
            const timeoutMs = 60000;
            const timeoutPromise = new Promise<string>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
              }, timeoutMs);
            });
            const asyncResult = await Promise.race([result, timeoutPromise]);
            if (typeof asyncResult === 'string') return asyncResult;
            return JSON.stringify(asyncResult);
          }
          if (typeof result === 'string') return result;
          return JSON.stringify(result);
        }
      } catch (asyncErr: any) {
        throw asyncErr;
      }
    }

    if (!isSlowMethod) {
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

    if (!isSlowMethod) {
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
      if (method === 'homeContent') {
        return listCount === 0;
      }
      return classCount === 0 && listCount === 0;
    } catch {
      return result.trim() === '{}' || result.trim() === '';
    }
  }

  private clearSpiderFileCache(key: string): void {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const spiderCacheDir = path.join(tmpDir, 'tvbox_' + key);
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

    const isHomeMethod =
      method === 'homeContent' || method === 'homeVideoContent';
    let maxRetries = isHomeMethod ? 3 : 1;
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
            },
            null,
            2,
          ),
        );

        const spider = new (this.java.importClass(instance.className))();

        try {
          const ContextClass = this.java.importClass('android.content.Context');

          ContextClass.setCurrentSpiderKeySync(key + '_retry' + retry);

          const context = new ContextClass();

          const cleanExt = this.cleanExtForSpider(currentExt);

          const initSync = spider.initSync;
          if (initSync && typeof initSync === 'function') {
            initSync.call(spider, context, cleanExt);
          } else {
            spider.init(context, cleanExt);
          }
        } catch (initErr: any) {
          console.warn(
            '[JarLoader] Failed to init fresh spider instance:',
            initErr.message,
          );
        }

        const javaArgs = this.convertArgs(method, args);
        const result = await this.executeSpiderMethod(spider, method, javaArgs);

        if (
          isHomeMethod &&
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

        return result;
      } catch {
        if (retry < maxRetries - 1) {
          console.log('[JarLoader] Error, clearing file cache and retrying...');
          this.clearSpiderFileCache(key + '_retry' + retry);
          const rotatedExt = this.rotateSiteUrls(currentExt, retry + 1);
          if (rotatedExt) {
            currentExt = rotatedExt;
          }
          continue;
        }
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

  public initSpider(key: string, ext: string): void {
    const instance = this.spiders.get(key);
    if (!instance) return;

    const cleanExt = this.cleanExtForSpider(ext);

    try {
      const ContextClass = this.java.importClass('android.content.Context');
      const context = new ContextClass();

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
   * Get recent JAR key
   */
  public getRecentJarKey(): string {
    return this.recentJarKey;
  }

  /**
   * Call spider's static Proxy.proxy(Map<String,String>) method.
   * Used by the local proxy server to handle /proxy?do=... requests.
   *
   * Returns Object[]{int statusCode, String mime, InputStream stream, Map<String,String> headers?}
   * or null if the method returns null / fails.
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
    if (!this.java) {
      return null;
    }
    try {
      const ProxyClass = this.java.importClass(
        'com.github.catvod.spider.Proxy',
      );
      const HashMap = this.java.importClass('java.util.HashMap');
      const map = new HashMap();
      for (const [k, v] of Object.entries(params)) {
        map.putSync(k, v);
      }
      const result = ProxyClass.proxySync(map);
      if (!result) {
        return null;
      }
      const arr = result as any[];
      if (arr.length < 3) {
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
    } catch {
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
      const success = jarLoader.getSpider(key, className, ext, jarUrl || '');
      return {
        success,
        error: success ? '' : jarLoader.getLastError(),
      };
    },
  );

  // Init Spider
  ipcMain.handle('jar:initSpider', async (_event, key: string, ext: string) => {
    jarLoader.initSpider(key, ext);
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
          const { QuarkPanService } = require('./QuarkPanService');
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
      const spiderCacheDir = path.join(tmpDir, 'tvbox_' + spiderKey);
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

  console.log('[JarLoader] IPC handlers registered');
}
