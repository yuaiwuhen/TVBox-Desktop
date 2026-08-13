/**
 * 自动安装管理器
 * 负责检测平台并自动安装Docker + Spider容器环境
 *
 * 注意：Windows、Linux 统一使用 Docker 方案（redroid-headless 容器）。
 *      Mac M 系列需要手动安装 Android Studio Emulator。
 *      已移除 VirtualBox + Android-x86 方案。
 */

import { BrowserWindow } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execAsync = promisify(exec);

export enum PlatformType {
  WINDOWS = 'win32',
  LINUX = 'linux',
  MAC_ARM = 'darwin-arm64',
  MAC_INTEL = 'darwin-x64',
}

export enum InstallStatus {
  IDLE = 'idle',
  CHECKING = 'checking',
  INSTALLING = 'installing',
  SUCCESS = 'success',
  ERROR = 'error',
}

export interface InstallProgress {
  status: InstallStatus;
  message: string;
  progress?: number;
  error?: string;
}

export class AutoInstallManager {
  private win: BrowserWindow | null = null;
  private currentPlatform: PlatformType;
  private installStatus: InstallStatus = InstallStatus.IDLE;

  // Docker container name (must match docker-compose.yml)
  private readonly containerName = 'tvbox-spider';

  // Spider app package name (must match AndroidManifest.xml)
  private readonly spiderPackage = 'com.tvbox.spiderserver';

  // Spider service name (must match AndroidManifest.xml)
  private readonly spiderService = 'com.tvbox.spiderserver/.SpiderHttpService';

  constructor() {
    this.currentPlatform = this.detectPlatform();
    console.log(
      '[AutoInstallManager] Detected platform:',
      this.currentPlatform,
    );
  }

  /**
   * 设置BrowserWindow引用
   */
  setWindow(window: BrowserWindow) {
    this.win = window;
  }

  /**
   * 检测当前平台
   */
  private detectPlatform(): PlatformType {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      return PlatformType.WINDOWS;
    }

    if (platform === 'linux') {
      return PlatformType.LINUX;
    }

    if (platform === 'darwin') {
      if (arch === 'arm64') {
        return PlatformType.MAC_ARM;
      }
      return PlatformType.MAC_INTEL;
    }

    throw new Error(`Unsupported platform: ${platform} ${arch}`);
  }

  /**
   * 发送安装进度到渲染进程
   */
  private sendProgress(progress: InstallProgress) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('install:progress', progress);
    }
    console.log(`[AutoInstallManager] ${progress.status}: ${progress.message}`);
  }

  /**
   * Ensure Docker Desktop is installed and running. If Docker is installed
   * but not running, automatically start it and wait for it to be ready.
   *
   * This is called on every app startup before any container operations.
   * Returns true if Docker is ready, false if Docker is not installed.
   */
  async ensureDockerReady(): Promise<boolean> {
    // Step 1: Check if Docker is installed
    let hasDocker = false;
    try {
      await execAsync('docker --version', { timeout: 5000 });
      hasDocker = true;
    } catch {
      hasDocker = false;
    }

    if (!hasDocker) {
      console.warn('[AutoInstallManager] Docker is not installed');
      return false;
    }

    // Step 2: Check if Docker daemon is running
    let dockerRunning = false;
    try {
      await execAsync('docker ps', { timeout: 5000 });
      dockerRunning = true;
    } catch {
      dockerRunning = false;
    }

    if (dockerRunning) {
      console.log('[AutoInstallManager] Docker is already running');
      return true;
    }

    // Step 3: Docker is installed but not running — start it
    console.log('[AutoInstallManager] Docker is not running, starting...');
    this.sendProgress({
      status: InstallStatus.INSTALLING,
      message: '正在启动 Docker Desktop...',
      progress: 10,
    });

    try {
      if (this.currentPlatform === PlatformType.WINDOWS) {
        const dockerPath =
          'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
        if (fs.existsSync(dockerPath)) {
          const { spawn } = await import('child_process');
          spawn(dockerPath, [], { detached: true, stdio: 'ignore' }).unref();
        } else {
          throw new Error('未找到 Docker Desktop，请手动启动');
        }
      } else if (this.currentPlatform === PlatformType.LINUX) {
        await execAsync('sudo systemctl start docker', { timeout: 15000 });
      } else {
        // Mac: open -a Docker
        await execAsync('open -a Docker', { timeout: 10000 });
      }
    } catch (e: any) {
      console.error('[AutoInstallManager] Failed to start Docker:', e.message);
      this.sendProgress({
        status: InstallStatus.ERROR,
        message: 'Docker Desktop 启动失败，请手动启动',
        error: e.message,
      });
      return false;
    }

    // Step 4: Wait for Docker daemon to be ready (up to 60s)
    this.sendProgress({
      status: InstallStatus.INSTALLING,
      message: '等待 Docker Desktop 启动完成...',
      progress: 15,
    });

    const maxWait = 60000; // 60 seconds
    const checkInterval = 2000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      try {
        await execAsync('docker ps', { timeout: 3000 });
        console.log('[AutoInstallManager] Docker Desktop is now running');
        this.sendProgress({
          status: InstallStatus.INSTALLING,
          message: 'Docker Desktop 已启动',
          progress: 25,
        });
        return true;
      } catch {
        // Not ready yet
        const elapsed = Date.now() - startTime;
        const progress = Math.min(25, 15 + Math.floor(elapsed / 4000));
        this.sendProgress({
          status: InstallStatus.INSTALLING,
          message: `等待 Docker Desktop 启动... (${Math.floor(elapsed / 1000)}s)`,
          progress,
        });
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    console.error('[AutoInstallManager] Docker Desktop startup timed out');
    this.sendProgress({
      status: InstallStatus.ERROR,
      message: 'Docker Desktop 启动超时，请手动启动',
      error: 'TIMEOUT',
    });
    return false;
  }

  /**
   * 检查Docker环境（Windows 和 Linux 通用）
   */
  private async checkDockerEnvironment(): Promise<{
    hasDocker: boolean;
    dockerRunning: boolean;
    containerRunning: boolean;
  }> {
    // 检查Docker是否安装
    let hasDocker = false;
    try {
      await execAsync('docker --version', { timeout: 5000 });
      hasDocker = true;
    } catch {
      hasDocker = false;
    }

    if (!hasDocker) {
      return {
        hasDocker: false,
        dockerRunning: false,
        containerRunning: false,
      };
    }

    // 检查Docker服务是否运行
    let dockerRunning = false;
    try {
      await execAsync('docker ps', { timeout: 5000 });
      dockerRunning = true;
    } catch {
      dockerRunning = false;
    }

    if (!dockerRunning) {
      return { hasDocker: true, dockerRunning: false, containerRunning: false };
    }

    // 检查Spider容器是否运行
    let containerRunning = false;
    try {
      const { stdout } = await execAsync(
        `docker ps --filter name=${this.containerName} --format "{{.Names}}"`,
        { timeout: 5000 },
      );
      containerRunning = stdout.trim().includes(this.containerName);
    } catch {
      containerRunning = false;
    }

    return { hasDocker, dockerRunning, containerRunning };
  }

  /**
   * 启动Spider容器
   */
  private async startSpiderContainer(): Promise<void> {
    try {
      // 检查容器是否已运行
      const { stdout } = await execAsync(
        `docker ps --filter name=${this.containerName} --format "{{.Names}}"`,
      );
      if (stdout.trim().includes(this.containerName)) {
        console.log('[AutoInstallManager] Container already running');
        return;
      }

      // 检查容器是否存在（已停止）
      const { stdout: allContainers } = await execAsync(
        `docker ps -a --filter name=${this.containerName} --format "{{.Names}}"`,
      );
      if (allContainers.trim().includes(this.containerName)) {
        // 容器存在但未运行，启动它
        await execAsync(`docker start ${this.containerName}`);
        console.log('[AutoInstallManager] Container started');
      } else {
        // 容器不存在，使用 docker-compose 启动（compose 文件在 docker/ 目录）
        // 注意：不使用 --build，直接使用已构建的镜像，避免每次启动都重新拉取基础镜像
        const projectRoot = path.resolve(__dirname, '..');
        const dockerDir = path.join(projectRoot, 'docker');
        const composeFile = path.join(dockerDir, 'docker-compose.yml');
        if (fs.existsSync(composeFile)) {
          // 优先使用 docker compose (v2)，回退到 docker-compose (v1)
          try {
            await execAsync(`docker compose -f "${composeFile}" up -d`, {
              cwd: dockerDir,
              timeout: 120000, // 2分钟超时
            });
            console.log(
              '[AutoInstallManager] Container created via docker compose v2',
            );
          } catch {
            await execAsync(`docker-compose -f "${composeFile}" up -d`, {
              cwd: dockerDir,
              timeout: 120000,
            });
            console.log(
              '[AutoInstallManager] Container created via docker-compose v1',
            );
          }
        } else {
          throw new Error(`docker-compose.yml not found at ${composeFile}`);
        }
      }

      // 等待容器启动
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error: any) {
      throw new Error(`启动容器失败: ${error.message}`);
    }
  }

  /**
   * 查找 Spider APK 文件
   * 优先使用 docker/spider-server.apk，回退到 android-app 构建产物
   */
  private findSpiderApk(): string | null {
    const projectRoot = path.resolve(__dirname, '..');
    const candidates = [
      path.join(projectRoot, 'docker', 'spider-server.apk'),
      path.join(
        projectRoot,
        'docker',
        'android-app',
        'app',
        'build',
        'outputs',
        'apk',
        'debug',
        'app-debug.apk',
      ),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log('[AutoInstallManager] Found APK at:', p);
        return p;
      }
    }
    console.warn(
      '[AutoInstallManager] APK file not found in candidates:',
      candidates,
    );
    return null;
  }

  /**
   * 检查 Spider 应用是否已安装
   */
  private async isSpiderAppInstalled(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} pm list packages`,
        { timeout: 10000 },
      );
      return stdout.includes(`package:${this.spiderPackage}`);
    } catch {
      return false;
    }
  }

  /**
   * 安装 Spider APK 到容器
   */
  private async installSpiderApp(apkPath: string): Promise<void> {
    const containerPath = '/data/local/tmp/spider-server.apk';
    console.log('[AutoInstallManager] Installing APK to container...');

    // 复制 APK 到容器
    await execAsync(
      `docker cp "${apkPath}" ${this.containerName}:${containerPath}`,
      { timeout: 30000 },
    );

    // 安装 APK
    const { stdout, stderr } = await execAsync(
      `docker exec ${this.containerName} pm install -r -t ${containerPath}`,
      { timeout: 120000 },
    );

    const output = (stdout || '') + (stderr || '');
    if (!output.includes('Success')) {
      throw new Error(`APK install failed: ${output}`);
    }
    console.log('[AutoInstallManager] APK installed successfully');
  }

  /**
   * 启动 Spider HTTP 服务
   */
  private async startSpiderService(): Promise<void> {
    console.log('[AutoInstallManager] Starting SpiderHttpService...');

    // Android 8+ 需要使用 start-foreground-service
    try {
      await execAsync(
        `docker exec ${this.containerName} am start-foreground-service ${this.spiderService}`,
        { timeout: 15000 },
      );
    } catch (e: any) {
      console.warn(
        '[AutoInstallManager] start-foreground-service failed, trying startservice:',
        e.message,
      );
      try {
        await execAsync(
          `docker exec ${this.containerName} am startservice ${this.spiderService}`,
          { timeout: 15000 },
        );
      } catch (e2: any) {
        throw new Error(`Failed to start Spider service: ${e2.message}`);
      }
    }

    // 等待端口监听（最多 20 秒）
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const { stdout } = await execAsync(
          `docker exec ${this.containerName} sh -c "netstat -tln 2>/dev/null | grep 9978 || ss -tln 2>/dev/null | grep 9978"`,
          { timeout: 5000 },
        );
        if (stdout && stdout.includes('9978')) {
          console.log(
            '[AutoInstallManager] Spider service is listening on 9978',
          );
          return;
        }
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      'Spider service did not start listening on port 9978 within 20s',
    );
  }

  /**
   * 设置 Spider 应用（安装 APK + 启动服务）
   * 容器启动后调用
   */
  async setupSpiderApp(): Promise<void> {
    // Always install the latest APK from the build directory.
    // This ensures the spider service stays in sync with the PC client
    // after code updates. pm install -r performs an upgrade if the app
    // is already installed, so this is idempotent.
    const apkPath = this.findSpiderApk();
    if (apkPath) {
      this.sendProgress({
        status: InstallStatus.INSTALLING,
        message: '正在安装 Spider 应用...',
        progress: 70,
      });
      await this.installSpiderApp(apkPath);
    } else if (!(await this.isSpiderAppInstalled())) {
      throw new Error(
        'Spider APK not found. Please build it first: cd docker/android-app && ./gradlew assembleDebug',
      );
    } else {
      console.log('[AutoInstallManager] Spider app already installed (no local APK to upgrade)');
    }

    // 检查端口是否已监听
    let serviceRunning = false;
    try {
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} sh -c "netstat -tln 2>/dev/null | grep 9978 || ss -tln 2>/dev/null | grep 9978"`,
        { timeout: 5000 },
      );
      serviceRunning = !!(stdout && stdout.includes('9978'));
    } catch {
      serviceRunning = false;
    }

    if (!serviceRunning) {
      this.sendProgress({
        status: InstallStatus.INSTALLING,
        message: '正在启动 Spider HTTP 服务...',
        progress: 85,
      });
      await this.startSpiderService();
    } else {
      console.log(
        '[AutoInstallManager] Spider service already running on 9978',
      );
    }
  }

  /**
   * 检查Mac环境
   */
  private async checkMacEnvironment(): Promise<{
    hasAndroidStudio: boolean;
    hasAdb: boolean;
    hasDevice: boolean;
  }> {
    try {
      // 检查Android Studio
      const studioPath = '/Applications/Android Studio.app';
      const hasAndroidStudio = fs.existsSync(studioPath);

      // 检查ADB
      let hasAdb = false;
      try {
        await execAsync('adb version');
        hasAdb = true;
      } catch {
        // 检查Android SDK路径
        const adbPath = path.join(
          os.homedir(),
          'Library',
          'Android',
          'sdk',
          'platform-tools',
          'adb',
        );
        hasAdb = fs.existsSync(adbPath);
      }

      // 检查设备
      let hasDevice = false;
      if (hasAdb) {
        try {
          const { stdout } = await execAsync('adb devices');
          hasDevice =
            stdout.includes('device') && !stdout.includes('List of devices');
        } catch {
          hasDevice = false;
        }
      }

      return { hasAndroidStudio, hasAdb, hasDevice };
    } catch (error: any) {
      console.error('[AutoInstallManager] Mac check failed:', error.message);
      return { hasAndroidStudio: false, hasAdb: false, hasDevice: false };
    }
  }

  /**
   * 安装Mac环境（引导用户）
   */
  private async installMacEnvironment(): Promise<void> {
    this.sendProgress({
      status: InstallStatus.INSTALLING,
      message: '检测到Mac M系列芯片，需要安装Android Studio',
      progress: 0,
    });

    // 打开引导文档
    const guidePath = path.join(
      process.cwd(),
      'docs',
      'mac-m-series-installation-guide.md',
    );

    if (fs.existsSync(guidePath)) {
      await execAsync(`open "${guidePath}"`);
    } else {
      // 打开在线文档
      await execAsync('open https://developer.android.com/studio');
    }

    this.sendProgress({
      status: InstallStatus.ERROR,
      message: 'Mac需要手动安装Android Studio，请按照引导文档操作',
      progress: 0,
      error: 'MANUAL_INSTALL_REQUIRED',
    });

    throw new Error('Mac需要手动安装');
  }

  /**
   * 检查 Spider 服务端口是否监听
   */
  private async isSpiderServiceRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} sh -c "netstat -tln 2>/dev/null | grep 9978 || ss -tln 2>/dev/null | grep 9978"`,
        { timeout: 5000 },
      );
      return !!(stdout && stdout.includes('9978'));
    } catch {
      return false;
    }
  }

  /**
   * 检查环境状态
   */
  async checkEnvironment(): Promise<InstallProgress> {
    this.installStatus = InstallStatus.CHECKING;

    try {
      let status: InstallProgress;

      switch (this.currentPlatform) {
        case PlatformType.WINDOWS:
        case PlatformType.LINUX: {
          // Windows 和 Linux 统一使用 Docker 方案
          const dockerEnv = await this.checkDockerEnvironment();
          if (dockerEnv.containerRunning) {
            // 容器运行中，还需检查 Spider 服务是否监听 9978
            const serviceRunning = await this.isSpiderServiceRunning();
            if (serviceRunning) {
              status = {
                status: InstallStatus.SUCCESS,
                message: `${this.currentPlatform === PlatformType.WINDOWS ? 'Windows' : 'Linux'}环境已就绪，Spider 服务运行中`,
                progress: 100,
              };
            } else {
              status = {
                status: InstallStatus.IDLE,
                message: '容器已运行，但 Spider 服务未启动',
                progress: 50,
              };
            }
          } else if (dockerEnv.dockerRunning) {
            status = {
              status: InstallStatus.IDLE,
              message: 'Docker已运行，需要启动Spider容器',
              progress: 0,
            };
          } else if (dockerEnv.hasDocker) {
            status = {
              status: InstallStatus.IDLE,
              message: 'Docker已安装，需要启动Docker服务',
              progress: 0,
            };
          } else {
            status = {
              status: InstallStatus.IDLE,
              message: '需要安装Docker',
              progress: 0,
            };
          }
          break;
        }

        case PlatformType.MAC_ARM:
        case PlatformType.MAC_INTEL: {
          const macEnv = await this.checkMacEnvironment();
          if (macEnv.hasDevice) {
            status = {
              status: InstallStatus.SUCCESS,
              message: 'Mac环境已就绪，设备已连接',
              progress: 100,
            };
          } else if (macEnv.hasAdb) {
            status = {
              status: InstallStatus.IDLE,
              message: 'ADB已安装，需要启动Android模拟器',
              progress: 0,
            };
          } else if (macEnv.hasAndroidStudio) {
            status = {
              status: InstallStatus.IDLE,
              message: 'Android Studio已安装，需要配置AVD',
              progress: 0,
            };
          } else {
            status = {
              status: InstallStatus.IDLE,
              message: '需要安装Android Studio',
              progress: 0,
            };
          }
          break;
        }

        default:
          status = {
            status: InstallStatus.ERROR,
            message: '不支持的平台',
            error: 'UNSUPPORTED_PLATFORM',
          };
      }

      this.installStatus = status.status;
      this.sendProgress(status);
      return status;
    } catch (error: any) {
      const status: InstallProgress = {
        status: InstallStatus.ERROR,
        message: '环境检查失败',
        error: error.message,
      };
      this.installStatus = InstallStatus.ERROR;
      this.sendProgress(status);
      return status;
    }
  }

  /**
   * 自动安装环境
   * Windows/Linux: 启动Docker容器（需要Docker已安装并运行）
   * Mac: 引导用户手动安装
   */
  async autoInstall(): Promise<void> {
    try {
      console.log('[AutoInstallManager] Starting auto install...');

      // 先检查环境
      const checkResult = await this.checkEnvironment();

      // 如果已经就绪，直接返回
      if (checkResult.status === InstallStatus.SUCCESS) {
        console.log('[AutoInstallManager] Environment already ready');
        return;
      }

      // 根据平台执行安装
      switch (this.currentPlatform) {
        case PlatformType.WINDOWS:
        case PlatformType.LINUX: {
          // 检查容器是否运行，未运行则启动
          const dockerEnv = await this.checkDockerEnvironment();
          if (!dockerEnv.containerRunning) {
            this.sendProgress({
              status: InstallStatus.INSTALLING,
              message: '正在启动Spider容器...',
              progress: 30,
            });
            await this.startSpiderContainer();
          } else {
            console.log('[AutoInstallManager] Container already running');
          }

          // 安装 APK + 启动 Spider HTTP 服务（幂等操作）
          await this.setupSpiderApp();

          this.sendProgress({
            status: InstallStatus.SUCCESS,
            message: 'Spider 服务已就绪',
            progress: 100,
          });
          break;
        }

        case PlatformType.MAC_ARM:
        case PlatformType.MAC_INTEL:
          await this.installMacEnvironment();
          break;
      }
    } catch (error: any) {
      console.error('[AutoInstallManager] Auto install failed:', error.message);
      this.sendProgress({
        status: InstallStatus.ERROR,
        message: '自动安装失败',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取当前安装状态
   */
  getStatus(): InstallStatus {
    return this.installStatus;
  }

  /**
   * 获取当前平台
   */
  getPlatform(): PlatformType {
    return this.currentPlatform;
  }
}

// 导出单例
export const autoInstallManager = new AutoInstallManager();
