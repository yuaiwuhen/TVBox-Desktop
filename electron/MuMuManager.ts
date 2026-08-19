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
import { fileURLToPath } from 'url';
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
    const doRun = (a: string[]) => {
      const cmd = `"${this.adbExe}" ${a.join(' ')}`;
      return execAsync(cmd, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    };
    try {
      const { stdout, stderr } = await doRun(args);
      return (stdout || '') + (stderr || '');
    } catch (err: any) {
      const msg = `${err?.message || ''} ${err?.stderr || ''}`;
      // 多个设备/模拟器在线时，adb 需要 -s <serial> 指定目标设备。
      // 通过 MuMuManager.exe adb -v <index> 获取目标实例的连接串后重试。
      if (/more than one device|more than one emulator/i.test(msg)) {
        console.warn('[MuMuManager] multiple adb devices detected, retrying with -s');
        const serial = await this.resolveAdbSerial();
        if (serial) {
          const { stdout, stderr } = await doRun(['-s', serial, ...args]);
          return (stdout || '') + (stderr || '');
        }
      }
      throw err;
    }
  }

  /**
   * Resolve the target MuMu instance's adb connection string.
   *
   * `MuMuManager.exe adb -v <index>` prints the instance's adb address.
   * Output format varies: may be `127.0.0.1:16384`, or just a port number.
   * MuMu 12 adb ports are dynamic: 0号 16384, 每多开 +32，端口被占用则 +1.
   *
   * Returns e.g. `127.0.0.1:16384`; null if resolution fails.
   */
  private async resolveAdbSerial(index = this.targetIndex): Promise<string | null> {
    try {
      const out = await this.runManager(['adb', '-v', String(index)], 15000);
      const t = out.trim();
      if (!t) return null;
      // 0) JSON 格式（实测 MuMuManager v6.5.1.0）：
      //    {"adb_host":"127.0.0.1","adb_port":16384}
      try {
        const json = JSON.parse(t);
        if (json.adb_host && json.adb_port) {
          const serial = `${json.adb_host}:${json.adb_port}`;
          console.log(`[MuMuManager] target adb serial (json): ${serial}`);
          return serial;
        }
      } catch {
        // not JSON, fall through
      }
      // 1) 完整连接串：127.0.0.1:port 或 emulator-N
      const full = t.match(
        /\b(\d{1,3}(?:\.\d{1,3}){3}:\d+|emulator-\d+)\b/,
      );
      if (full) {
        console.log(`[MuMuManager] target adb serial: ${full[1]}`);
        return full[1];
      }
      // 2) 纯端口号 → 拼成 127.0.0.1:port
      const port = t.match(/\b(\d{4,5})\b/);
      if (port) {
        const serial = `127.0.0.1:${port[1]}`;
        console.log(`[MuMuManager] target adb serial (port): ${serial}`);
        return serial;
      }
    } catch (e) {
      console.warn('[MuMuManager] resolveAdbSerial failed:', (e as Error).message);
    }
    return null;
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

  /**
   * Wait until the VM's Android has finished booting.
   *
   * MuMu 12 的 `sys.boot_completed` 经常不返回 `1`（定制系统行为），
   * 因此改用更可靠的信号：
   *   1. `sys.boot_completed == 1` 或 `dev.bootcomplete == 1` → 已就绪
   *   2. adb 设备在线（Android 实际上已完成启动、可用）→ 立即视为就绪。
   *      这是最可靠的信号——`waitForAndroidStarted` 已确认系统在启动，
   *      adb 能连通即说明系统可用，无需等待完整超时。
   */
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
      try {
        const devComplete = await this.runAdb([
          'shell',
          'getprop',
          'dev.bootcomplete',
        ]);
        if (devComplete.trim() === '1') return true;
      } catch {
        // ignore
      }
      // adb 设备在线即视为 boot 完成（MuMu 定制系统下最可靠）
      try {
        const devices = await this.runAdb(['devices'], 10000);
        if (/device\b/.test(devices) && !/offline\b/.test(devices)) {
          console.log('[MuMuManager] adb device online, boot considered complete');
          return true;
        }
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Wait until the target MuMu instance's adb device is online.
   *
   * When multiple devices/emulators are attached, we must target the specific
   * MuMu instance — not just "any device". Resolve the target serial first,
   * then wait for it to appear as `device` (not offline/absent).
   */
  private async waitForAdbDevice(timeoutMs = 60000): Promise<boolean> {
    const serial = await this.resolveAdbSerial();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const out = await this.runAdb(['devices'], 10000);
        if (serial) {
          // 目标 serial 必须在线
          const line = out
            .split('\n')
            .find((l) => l.trim().startsWith(serial));
          if (line && /device\b/.test(line) && !/offline\b/.test(line)) {
            return true;
          }
        } else if (/device\b/.test(out) && !/offline\b/.test(out)) {
          // 无法解析目标 serial（例如 MuMuManager 命令异常）时退化为任意设备
          return true;
        }
      } catch {
        // adb server not ready yet
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  /** Set up port forwarding so the PC can reach the spider API. */
  async forwardPorts(): Promise<void> {
    // MuMu may have just been launched — the adb device can take a few
    // seconds to appear. Retry forward until the device is reachable.
    await this.waitForAdbDevice();
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.runAdb(['forward', `tcp:${SPIDER_API_PORT}`, `tcp:${SPIDER_CONTAINER_PORT}`]);
        console.log(
          `[MuMuManager] adb forward tcp:${SPIDER_API_PORT} -> tcp:${SPIDER_CONTAINER_PORT}`,
        );
        return;
      } catch (e: any) {
        lastErr = e;
        console.warn(`[MuMuManager] adb forward attempt ${attempt + 1} failed:`, e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr || new Error('adb forward failed');
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
    // Grant SYSTEM_ALERT_WINDOW (悬浮窗) so the background SpiderHttpService can
    // launch ConfigCenterActivity on Android 10+ (BAL background-activity-start
    // exemption). Without it, /remote/open-config is blocked with BAL_BLOCK
    // (result code=102) and the PC mirror screen reports "no windows".
    await this.grantOverlayPermission();
  }

  /**
   * Grant the overlay (SYSTEM_ALERT_WINDOW) permission to the spider app via
   * appops. Best-effort: harmless if the permission is already granted or the
   * command is unsupported on a device.
   */
  async grantOverlayPermission(): Promise<void> {
    try {
      await this.runAdb(
        ['shell', 'appops', 'set', 'com.tvbox.spiderserver', 'SYSTEM_ALERT_WINDOW', 'allow'],
        15000,
      );
      console.log('[MuMuManager] SYSTEM_ALERT_WINDOW granted');
    } catch (e: any) {
      console.warn('[MuMuManager] grant SYSTEM_ALERT_WINDOW failed:', e.message);
    }
  }

  /** Uninstall the spider app (ignores "not installed"). */
  async uninstallApk(): Promise<void> {
    console.log('[MuMuManager] Uninstalling spider app...');
    try {
      await this.runAdb(
        ['uninstall', 'com.tvbox.spiderserver'],
        30000,
      );
      console.log('[MuMuManager] Spider app uninstalled');
    } catch {
      // "not installed" is fine — nothing to uninstall
      console.log('[MuMuManager] Spider app was not installed (skip uninstall)');
    }
  }

  /**
   * When the service still can't be reached after a normal install/start,
   * uninstall and reinstall the APK once to recover from a corrupted install.
   */
  async reinstallApkOnce(apkPath: string): Promise<boolean> {
    console.log('[MuMuManager] Service unreachable — reinstalling APK once...');
    try {
      await this.uninstallApk();
      await this.installApk(apkPath);
      await this.startService();
      const ready = await this.waitForServiceReady(60000);
      console.log(
        ready
          ? '[MuMuManager] Service healthy after reinstall'
          : '[MuMuManager] Service still unhealthy after reinstall',
      );
      return ready;
    } catch (e: any) {
      console.warn('[MuMuManager] Reinstall failed:', e.message);
      return false;
    }
  }

  /**
   * Start the SpiderHttpService.
   *
   * 注意：SpiderHttpService 在 AndroidManifest 中为 android:exported="false"，
   * 从 adb shell 用 `am start-foreground-service` / `am startservice` 直接启动
   * 会报 `Requires permission not exported from uid`，无法启动。
   * 正确方式：启动 exported=true 的 MainActivity（有 launcher intent），
   * 其 onCreate 会调用 SpiderHttpService.startService(this) 拉起服务。
   */
  async startService(): Promise<void> {
    console.log('[MuMuManager] Starting MainActivity (spawns SpiderHttpService)...');
    await this.runAdb(
      ['shell', 'am', 'start', '-n', 'com.tvbox.spiderserver/.MainActivity'],
      15000,
    );
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
   * MD5 of the locally built APK (hex, lowercased), or null if unreadable.
   */
  private async localApkMd5(apkPath: string): Promise<string | null> {
    try {
      const { createHash } = await import('crypto');
      const buf = await fs.promises.readFile(apkPath);
      return createHash('md5').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * MD5 of the currently installed APK inside the emulator, or null when the
   * app is not installed / md5 is unavailable. Locates the APK via
   * `pm path`, then hashes it on the device with md5sum.
   */
  private async installedApkMd5(): Promise<string | null> {
    try {
      const out = await this.runAdb(
        ['shell', 'pm', 'path', 'com.tvbox.spiderserver'],
        15000,
      );
      const line = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.startsWith('package:'));
      if (!line) return null;
      const apkPath = line.slice('package:'.length).trim();
      if (!apkPath) return null;
      const md5 = await this.runAdb(
        ['shell', 'md5sum', apkPath],
        20000,
      );
      const first = md5.trim().split(/\s+/)[0];
      return first ? first.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /**
   * Lightweight "ensure latest APK is deployed" for an already-running VM.
   * Unlike ensureRunning, it does NOT boot/launch the VM or wait for boot —
   * it assumes the emulator is already up (caller checked checkEnvironment).
   * It only re-installs when the local APK differs from the installed one
   * (by MD5), then reports whether the service is reachable.
   */
  async ensureLatestApk(apkPath?: string): Promise<boolean> {
    const p = apkPath || this.findSpiderApk();
    if (!p) {
      console.warn('[MuMuManager] ensureLatestApk: no local APK found');
      return false;
    }
    try {
      await this.forwardPorts();
      const [localMd5, installedMd5] = await Promise.all([
        this.localApkMd5(p),
        this.installedApkMd5(),
      ]);
      if (localMd5 && installedMd5 === localMd5) {
        console.log(
          '[MuMuManager] Installed APK is up to date (md5 match), skipping install',
        );
        // APK didn't change but the emulator may have been reset — make sure
        // the overlay permission (BAL exemption) is still granted.
        await this.grantOverlayPermission();
      } else {
        await this.installApk(p);
      }
      return await this.isServiceReady();
    } catch (e: any) {
      console.warn('[MuMuManager] ensureLatestApk failed:', e.message);
      return false;
    }
  }

  /**
   * Full orchestration: ensure the target VM is running, booted, forwarded,
   * with the spider app installed and the HTTP service healthy.
   *
   * `onProgress` is called at each lifecycle stage so the renderer can show
   * step-by-step status (starting emulator → emulator ready → starting app →
   * app ready/failed).
   */
  async ensureRunning(
    opts?: {
      installApk?: boolean;
      apkPath?: string;
    },
    onProgress?: (message: string, percent: number, stage: string) => void,
  ): Promise<MuMuStatus> {
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

    // 0. 环境已完全就绪（模拟器 + Spider 应用都在跑）时，不做任何动作、
    //    不上报任何进度，直接返回成功。
    if (await this.isServiceReady()) {
      console.log('[MuMuManager] environment already ready, skipping startup');
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

    // 标记本次是否真正启动了模拟器（用于区分"模拟器已启动"与"本次启动"）
    let startedEmulator = false;

    // 1. Ensure the VM process + Android is booted.
    if (!target || !target.isAndroidStarted) {
      startedEmulator = true;
      console.log('[MuMuManager] VM not running, launching...');
      onProgress?.('正在启动模拟器...', 15, 'starting');
      try {
        await this.launchInstance(this.targetIndex);
      } catch (e: any) {
        return fail('MuMu 实例启动失败', e.message);
      }
      onProgress?.('等待模拟器启动...', 35, 'starting');
      const androidStarted = await this.waitForAndroidStarted(this.targetIndex);
      if (!androidStarted) {
        onProgress?.('模拟器启动超时', 35, 'error');
        return fail('等待 MuMu 安卓系统启动超时，请手动打开 MuMu');
      }
    }

    // 只有本次真正启动了模拟器，才提示"模拟器启动成功"；
    // 若模拟器早已在运行，直接跳到"正在启动应用"。
    if (startedEmulator) {
      onProgress?.('模拟器启动成功，正在启动应用...', 50, 'booting');
    } else {
      onProgress?.('正在启动应用...', 50, 'app');
    }

    // 2. Wait for full boot.
    const booted = await this.waitForBootCompleted(this.targetIndex);
    if (!booted) {
      onProgress?.('系统启动超时', 55, 'error');
      return fail('MuMu 系统启动完成超时，请手动打开 MuMu');
    }

    onProgress?.('正在配置端口转发...', 65, 'forward');

    // 3. Port forwarding (idempotent).
    try {
      await this.forwardPorts();
    } catch (e: any) {
      return fail('adb 端口转发失败', e.message);
    }

    // 4. Install/upgrade the APK.
    const wantInstall = opts?.installApk ?? true;
    let apkPath = opts?.apkPath || this.findSpiderApk();
    if (wantInstall) {
      if (apkPath) {
        onProgress?.('正在安装 Spider 应用...', 75, 'install');
        try {
          await this.installApk(apkPath);
        } catch (e: any) {
          // Non-fatal: the app may already be installed and running.
          console.warn('[MuMuManager] APK install failed (non-fatal):', e.message);
        }
      } else if (!(await this.isAppInstalled())) {
        onProgress?.('未找到 Spider APK', 75, 'error');
        return fail(
          '未找到 Spider APK，请先构建: cd android-app && gradlew assembleDebug',
        );
      }
    }

    // 5. Start the service if it isn't already healthy. If it still can't be
    //    reached after a normal start, uninstall + reinstall the APK once to
    //    recover from a corrupted install.
    if (!(await this.isServiceReady())) {
      onProgress?.('正在启动 Spider 应用...', 85, 'app');
      try {
        await this.startService();
      } catch (e: any) {
        console.warn('[MuMuManager] startService failed:', e.message);
      }
      let ready = await this.waitForServiceReady(60000);
      if (!ready && wantInstall && apkPath) {
        console.log(
          '[MuMuManager] Service unreachable after normal start, trying uninstall + reinstall once...',
        );
        ready = await this.reinstallApkOnce(apkPath);
      }
      onProgress?.(
        ready ? '应用启动成功' : '应用启动失败',
        ready ? 100 : 85,
        ready ? 'ready' : 'error',
      );
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

    // 走到这里说明服务在过程中自行就绪（未经上方启动），无需再报提示
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
    // ESM 下没有 __dirname，用 import.meta.url 推导当前文件所在目录
    const thisDir = path.dirname(
      fileURLToPath(import.meta.url),
    );
    const projectRoot = path.resolve(thisDir, '..');
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
