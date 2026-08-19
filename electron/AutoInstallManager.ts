/**
 * 自动安装管理器（MuMu 版）
 *
 * Windows: 自动启动 MuMu 模拟器 + 安装 spider-server APK + 启动服务。
 * Mac/Linux: 引导用户使用自带模拟器/设备，配置 Spider 接口地址。
 */

import { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { muMuManager } from './MuMuManager';

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

  constructor() {
    this.currentPlatform = this.detectPlatform();
    console.log(
      '[AutoInstallManager] Detected platform:',
      this.currentPlatform,
    );
  }

  setWindow(window: BrowserWindow) {
    this.win = window;
  }

  private detectPlatform(): PlatformType {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') return PlatformType.WINDOWS;
    if (platform === 'linux') return PlatformType.LINUX;
    if (platform === 'darwin') {
      return arch === 'arm64' ? PlatformType.MAC_ARM : PlatformType.MAC_INTEL;
    }
    throw new Error(`Unsupported platform: ${platform} ${arch}`);
  }

  private sendProgress(progress: InstallProgress) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('install:progress', progress);
    }
    console.log(`[AutoInstallManager] ${progress.status}: ${progress.message}`);
  }

  getPlatform(): PlatformType {
    return this.currentPlatform;
  }

  getStatus(): InstallStatus {
    return this.installStatus;
  }

  /**
   * Compatibility alias for the old ensureDockerReady. On Windows this
   * verifies MuMu is installed; other platforms report unsupported.
   */
  async ensureDockerReady(): Promise<boolean> {
    if (this.currentPlatform === PlatformType.WINDOWS) {
      return muMuManager.locate();
    }
    // Mac/Linux: user-configured Android runtime (not auto-managed).
    return true;
  }

  /**
   * Ensure the MuMu emulator + spider service are running (Windows only).
   * On Mac/Linux, just reports whether the configured API is reachable.
   */
  async checkEnvironment(): Promise<InstallProgress> {
    this.installStatus = InstallStatus.CHECKING;

    try {
      if (this.currentPlatform === PlatformType.WINDOWS) {
        if (!muMuManager.locate()) {
          const status: InstallProgress = {
            status: InstallStatus.IDLE,
            message: '需要安装 MuMu 模拟器',
            progress: 0,
          };
          this.installStatus = status.status;
          this.sendProgress(status);
          return status;
        }
        if (await muMuManager.isServiceReady()) {
          const status: InstallProgress = {
            status: InstallStatus.SUCCESS,
            message: 'MuMu 环境已就绪，Spider 服务运行中',
            progress: 100,
          };
          this.installStatus = status.status;
          this.sendProgress(status);
          return status;
        }
        const status: InstallProgress = {
          status: InstallStatus.IDLE,
          message: 'MuMu 已安装，Spider 服务未运行',
          progress: 0,
        };
        this.installStatus = status.status;
        this.sendProgress(status);
        return status;
      }

      // Mac/Linux: rely on user-configured API address.
      const status: InstallProgress = {
        status: InstallStatus.SUCCESS,
        message:
          '当前平台请手动安装 Android 模拟器，并在设置中配置 Spider 接口地址',
        progress: 100,
      };
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
   * Full auto-install: boot MuMu, install APK, start service (Windows).
   * Mac/Linux: show guidance.
   */
  async autoInstall(): Promise<void> {
    try {
      console.log('[AutoInstallManager] Starting auto install...');
      this.sendProgress({
        status: InstallStatus.INSTALLING,
        message: '正在启动 MuMu 模拟器...',
        progress: 10,
      });

      if (this.currentPlatform === PlatformType.WINDOWS) {
        const status = await muMuManager.ensureRunning(
          { installApk: true },
          (message, percent, stage) => {
            this.sendProgress({
              status:
                stage === 'error'
                  ? InstallStatus.ERROR
                  : InstallStatus.INSTALLING,
              message,
              progress: percent,
              error: stage === 'error' ? message : undefined,
            });
          },
        );
        if (status.serviceReady) {
          this.sendProgress({
            status: InstallStatus.SUCCESS,
            message: 'Spider 服务已就绪',
            progress: 100,
          });
        } else {
          this.sendProgress({
            status: InstallStatus.ERROR,
            message: status.message,
            error: status.error,
            progress: 60,
          });
          throw new Error(status.message);
        }
      } else {
        // Mac/Linux manual guidance
        this.sendProgress({
          status: InstallStatus.ERROR,
          message:
            'Mac/Linux 需要手动安装 Android 模拟器并配置 Spider 接口地址',
          progress: 0,
          error: 'MANUAL_INSTALL_REQUIRED',
        });
        throw new Error('Mac/Linux 需要手动配置');
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
   * Compatibility alias for setupSpiderApp — installs/upgrades the APK and
   * starts the service if needed.
   */
  async setupSpiderApp(): Promise<void> {
    if (this.currentPlatform !== PlatformType.WINDOWS) return;
    this.sendProgress({
      status: InstallStatus.INSTALLING,
      message: '正在安装 Spider 应用...',
      progress: 70,
    });
    await muMuManager.ensureRunning({ installApk: true });
  }

  /**
   * Ensure the latest locally-built APK is deployed to an already-running
   * emulator. Called on startup even when the spider service is healthy, so a
   * freshly built APK is always installed. Failures are non-fatal — the app
   * keeps running with the old APK if the re-install can't complete.
   */
  async ensureLatestApkOnStartup(): Promise<void> {
    if (this.currentPlatform !== PlatformType.WINDOWS) return;
    try {
      const ok = await muMuManager.ensureLatestApk();
      console.log(
        ok
          ? '[AutoInstallManager] Latest APK deployed, service healthy'
          : '[AutoInstallManager] APK deploy finished, service status unknown',
      );
    } catch (error: any) {
      console.warn('[AutoInstallManager] Startup APK upgrade failed:', error.message);
    }
  }

  /**
   * Re-verify the emulator is actually running even when the spider service
   * reported healthy. Handles the case where the MuMu process was shut down
   * while an adb forward / service cache lingered: ensureRunning will detect
   * the VM is down, launch it, wait for boot, re-forward ports and start the
   * service. APK install is skipped here (handled by ensureLatestApkOnStartup).
   */
  async ensureEmulatorRunning(): Promise<void> {
    if (this.currentPlatform !== PlatformType.WINDOWS) return;
    try {
      const result = await muMuManager.ensureRunning(
        { installApk: false },
        (message, percent, stage) => {
          this.sendProgress({
            status:
              stage === 'error'
                ? InstallStatus.ERROR
                : InstallStatus.INSTALLING,
            message,
            progress: percent,
            error: stage === 'error' ? message : undefined,
          });
        },
      );
      console.log(
        result.running && result.serviceReady
          ? '[AutoInstallManager] Emulator + service verified running'
          : `[AutoInstallManager] Emulator state: running=${result.running} serviceReady=${result.serviceReady}`,
      );
    } catch (error: any) {
      console.warn('[AutoInstallManager] Emulator verify failed:', error.message);
    }
  }
}

// 导出单例
export const autoInstallManager = new AutoInstallManager();
