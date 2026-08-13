/**
 * MuMuManager - Automates MuMu emulator lifecycle for the spider service.
 *
 * Windows (Windows 10/11) uses MuMu 15 (netease) as the Android runtime that
 * hosts spider-server.apk. This manager:
 *   1. Locates the MuMu install + its bundled adb.exe
 *   2. Lists VM instances and launches the configured one
 *   3. Waits for Android to finish booting
 *   4. Sets up `adb forward tcp:19978 tcp:9978` so the PC reaches the
 *      spider HTTP API at http://127.0.0.1:19978
 *   5. Installs the spider APK (upgrade if present)
 *   6. Starts the SpiderHttpService foreground service
 *   7. Waits for /health to succeed
 *
 * Mac/Linux have no MuMu — users run their own Android runtime and configure
 * `spiderApiBaseUrl`; the Electron side then skips this manager.
 *
 * Verified MuMuManager.exe CLI (v6.5.1.0):
 *   MuMuManager.exe version
 *   MuMuManager.exe info -v <index>                  (JSON status)
 *   MuMuManager.exe control launch -v <index>        (boot a VM)
 *   MuMuManager.exe control app install -v <index> --apk <path>
 *   MuMuManager.exe control app launch -v <index> --package <pkg>
 *   nx_main\adb.exe auto-discovers the running VM (emulator-5556)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import http from 'http';

const execAsync = promisify(exec);

export const SPIDER_API_PORT = 19978; // host port (adb forward target)
export const SPIDER_CONTAINER_PORT = 9978; // NanoHTTPD port inside emulator

export interface MuMuInstance {
  index: number;
  name: string;
  androidVersion: string;
  isProcessStarted: boolean;
  isAndroidStarted: boolean;
  isMain: boolean;
}

export interface MuMuStatus {
  installed: boolean;
  running: boolean;
  booted: boolean;
  serviceReady: boolean;
  targetIndex: number;
  instances: MuMuInstance[];
  message: string;
  error?: string;
}

const MUMU_CANDIDATE_ROOTS = [
  process.env.MUMU_HOME || '',
  'D:\\Program Files\\Netease\\MuMu',
  'C:\\Program Files\\Netease\\MuMu',
  'D:\\Program Files\\MuMu',
  'C:\\Program Files\\MuMu',
].filter(Boolean);

function healthCheck(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `${baseUrl}/health`,
      { timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(!!(data && data.success));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export class MuMuManager {
  private muMuRoot: string | null = null;
  private managerExe: string | null = null;
  private adbExe: string | null = null;
  private targetIndex = 0;

  setTargetIndex(index: number) {
    if (typeof index === 'number' && index >= 0) {
      this.targetIndex = index;
    }
  }

  getTargetIndex(): number {
    return this.targetIndex;
  }

  /** Locate MuMu install. Returns true if MuMuManager.exe + adb found. */
  locate(): boolean {
    if (this.managerExe && this.adbExe) return true;
    for (const root of MUMU_CANDIDATE_ROOTS) {
      try {
        if (!fs.existsSync(root)) continue;
        const manager = path.join(root, 'nx_main', 'MuMuManager.exe');
        if (!fs.existsSync(manager)) continue;
        const adb = path.join(root, 'nx_main', 'adb.exe');
        if (!fs.existsSync(adb)) continue;
        this.muMuRoot = root;
        this.managerExe = manager;
        this.adbExe = adb;
        console.log(`[MuMuManager] Located MuMu at ${root}`);
        return true;
      } catch {
        continue;
      }
    }
    console.warn('[MuMuManager] MuMu not found');
    return false;
  }

  private async runManager(args: string[], timeoutMs = 20000): Promise<string> {
    if (!this.managerExe) throw new Error('MuMuManager.exe not located');
    const cmd = `"${this.managerExe}" ${args.join(' ')}`;
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return (stdout || '') + (stderr || '');
  }

  private async runAdb(args: string[], timeoutMs = 20000): Promise<string> {
    if (!this.adbExe) throw new Error('adb.exe not located');
    const cmd = `"${this.adbExe}" ${args.join(' ')}`;
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return (stdout || '') + (stderr || '');
  }

  /** List VM instances (probes info -v 0..n until an error occurs). */
  async listInstances(): Promise<MuMuInstance[]> {
    const instances: MuMuInstance[] = [];
    for (let i = 0; i < 16; i++) {
      let out: string;
      try {
        out = await this.runManager(['info', '-v', String(i)], 10000);
      } catch {
        break;
      }
      if (!out.trim()) break;
      try {
        const json = JSON.parse(out);
        if (!json || typeof json !== 'object' || json.error_code === undefined) {
          break;
        }
        instances.push({
          index: parseInt(String(json.index ?? i), 10),
          name: String(json.name ?? `MuMu ${i}`),
          androidVersion: String(json.android_version ?? ''),
          isProcessStarted: !!json.is_process_started,
          isAndroidStarted: !!json.is_android_started,
          isMain: !!json.is_main,
        });
      } catch {
        break;
      }
    }
    return instances;
  }

  /** Launch (boot) a VM instance. */
  async launchInstance(index = this.targetIndex): Promise<void> {
    console.log(`[MuMuManager] Launching MuMu instance ${index}`);
    await this.runManager(['control', 'launch', '-v', String(index)], 20000);
  }

  /** Wait until the VM's Android has started booting. */
  async waitForAndroidStarted(
    index = this.targetIndex,
    timeoutMs = 120000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const out = await this.runManager(['info', '-v', String(index)], 8000);
        const json = JSON.parse(out);
        if (json.is_android_started) return true;
      } catch {
        // instance not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /** Wait until sys.boot_completed == 1 inside the VM. */
  async waitForBootCompleted(
    index = this.targetIndex,
    timeoutMs = 120000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const out = await this.runAdb([
          'shell',
          'getprop',
          'sys.boot_completed',
        ]);
        if (out.trim() === '1') return true;
      } catch {
        // adb not connected yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /** Set up port forwarding so the PC can reach the spider API. */
  async forwardPorts(): Promise<void> {
    await this.runAdb(['forward', `tcp:${SPIDER_API_PORT}`, `tcp:${SPIDER_CONTAINER_PORT}`]);
    console.log(
      `[MuMuManager] adb forward tcp:${SPIDER_API_PORT} -> tcp:${SPIDER_CONTAINER_PORT}`,
    );
  }

  /** Check whether the spider app is installed. */
  async isAppInstalled(): Promise<boolean> {
    try {
      const out = await this.runAdb(['shell', 'pm', 'list', 'packages'], 15000);
      return out.includes('com.tvbox.spiderserver');
    } catch {
      return false;
    }
  }

  /** Install (or upgrade) the spider APK. */
  async installApk(apkPath: string): Promise<void> {
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found: ${apkPath}`);
    }
    console.log(`[MuMuManager] Installing APK: ${apkPath}`);
    await this.runAdb(['install', '-r', '-t', apkPath], 120000);
    console.log('[MuMuManager] APK installed');
  }

  /** Start the SpiderHttpService foreground service. */
  async startService(): Promise<void> {
    console.log('[MuMuManager] Starting SpiderHttpService...');
    try {
      await this.runAdb(
        ['shell', 'am', 'start-foreground-service', 'com.tvbox.spiderserver/.SpiderHttpService'],
        15000,
      );
    } catch {
      await this.runAdb(
        ['shell', 'am', 'startservice', 'com.tvbox.spiderserver/.SpiderHttpService'],
        15000,
      );
    }
  }

  /** Wait until the spider HTTP API responds to /health. */
  async waitForServiceReady(timeoutMs = 60000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await healthCheck(`http://127.0.0.1:${SPIDER_API_PORT}`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  async isServiceReady(): Promise<boolean> {
    return healthCheck(`http://127.0.0.1:${SPIDER_API_PORT}`);
  }

  /**
   * Full orchestration: ensure the target VM is running, booted, forwarded,
   * with the spider app installed and the HTTP service healthy.
   */
  async ensureRunning(opts?: {
    installApk?: boolean;
    apkPath?: string;
  }): Promise<MuMuStatus> {
    const fail = (message: string, error?: string): MuMuStatus => ({
      installed: !!this.muMuRoot,
      running: false,
      booted: false,
      serviceReady: false,
      targetIndex: this.targetIndex,
      instances: [],
      message,
      error,
    });

    if (!this.locate()) {
      return fail('未找到 MuMu 模拟器，请安装 MuMu 15 后重试');
    }

    const instances = await this.listInstances();
    const target = instances.find((i) => i.index === this.targetIndex);

    // 1. Ensure the VM process + Android is booted.
    if (!target || !target.isAndroidStarted) {
      console.log('[MuMuManager] VM not running, launching...');
      try {
        await this.launchInstance(this.targetIndex);
      } catch (e: any) {
        return fail('MuMu 实例启动失败', e.message);
      }
      const androidStarted = await this.waitForAndroidStarted(this.targetIndex);
      if (!androidStarted) {
        return fail('等待 MuMu 安卓系统启动超时，请手动打开 MuMu');
      }
    }

    // 2. Wait for full boot.
    const booted = await this.waitForBootCompleted(this.targetIndex);
    if (!booted) {
      return fail('MuMu 系统启动完成超时，请手动打开 MuMu');
    }

    // 3. Port forwarding (idempotent).
    try {
      await this.forwardPorts();
    } catch (e: any) {
      return fail('adb 端口转发失败', e.message);
    }

    // 4. Install/upgrade the APK.
    const wantInstall = opts?.installApk ?? true;
    if (wantInstall) {
      const apkPath = opts?.apkPath || this.findSpiderApk();
      if (apkPath) {
        try {
          await this.installApk(apkPath);
        } catch (e: any) {
          // Non-fatal: the app may already be installed and running.
          console.warn('[MuMuManager] APK install failed (non-fatal):', e.message);
        }
      } else if (!(await this.isAppInstalled())) {
        return fail(
          '未找到 Spider APK，请先构建: cd android-app && gradlew assembleDebug',
        );
      }
    }

    // 5. Start the service if it isn't already healthy.
    if (!(await this.isServiceReady())) {
      try {
        await this.startService();
      } catch (e: any) {
        console.warn('[MuMuManager] startService failed:', e.message);
      }
      const ready = await this.waitForServiceReady(60000);
      return {
        installed: true,
        running: true,
        booted: true,
        serviceReady: ready,
        targetIndex: this.targetIndex,
        instances,
        message: ready
          ? 'Spider 服务已就绪'
          : 'Spider 服务未在超时时间内就绪',
        error: ready ? undefined : 'SERVICE_TIMEOUT',
      };
    }

    return {
      installed: true,
      running: true,
      booted: true,
      serviceReady: true,
      targetIndex: this.targetIndex,
      instances,
      message: 'MuMu 已运行，Spider 服务就绪',
    };
  }

  /**
   * Locate the spider APK. Dev: android-app build output. Packaged:
   * resources/spider/app-debug.apk (via electron-builder extraResources).
   */
  findSpiderApk(): string | null {
    const candidates: string[] = [];
    try {
      const { app } = require('electron');
      candidates.push(
        path.join(app.getAppPath(), '..', 'resources', 'spider', 'app-debug.apk'),
        path.join(process.resourcesPath || '', 'spider', 'app-debug.apk'),
      );
    } catch {
      // fall through
    }
    const projectRoot = path.resolve(__dirname, '..');
    candidates.push(
      path.join(
        projectRoot,
        'android-app',
        'app',
        'build',
        'outputs',
        'apk',
        'debug',
        'app-debug.apk',
      ),
      path.join(projectRoot, 'spider-server.apk'),
    );
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          console.log('[MuMuManager] Found APK at:', p);
          return p;
        }
      } catch {
        continue;
      }
    }
    console.warn('[MuMuManager] APK not found in candidates:', candidates);
    return null;
  }
}

export const muMuManager = new MuMuManager();
