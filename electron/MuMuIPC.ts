/**
 * MuMu IPC handlers — bridge between the renderer and MuMuManager.
 * Mirrors the old DockerIPC surface (docker:status / docker:check ...) so the
 * renderer can drive MuMu setup from the setup guide component.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { muMuManager } from './MuMuManager';
import { loadConfigFromFile } from './ConfigPersistence';

export interface MuMuStatusPayload {
  installed: boolean;
  running: boolean;
  booted: boolean;
  serviceReady: boolean;
  targetIndex: number;
  instances: any[];
  message: string;
  error?: string;
}

function broadcastStatus(window: BrowserWindow | null, status: MuMuStatusPayload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('mumu:status', status);
  }
}

export function registerMuMuIPC(): void {
  ipcMain.handle('mumu:getStatus', async (): Promise<MuMuStatusPayload> => {
    try {
      const config = loadConfigFromFile();
      const idx = parseInt(config['mumuVmIndex'] ?? '0', 10) || 0;
      muMuManager.setTargetIndex(idx);
      const installed = muMuManager.locate();
      const instances = installed ? await muMuManager.listInstances() : [];
      const serviceReady = await muMuManager.isServiceReady();
      const target = instances.find((i) => i.index === idx);
      return {
        installed,
        running: !!target?.isProcessStarted,
        booted: !!target?.isAndroidStarted,
        serviceReady,
        targetIndex: idx,
        instances,
        message: !installed
          ? '未找到 MuMu 模拟器'
          : serviceReady
            ? 'Spider 服务已就绪'
            : 'MuMu 已找到，Spider 服务未就绪',
      };
    } catch (e: any) {
      return {
        installed: false,
        running: false,
        booted: false,
        serviceReady: false,
        targetIndex: muMuManager.getTargetIndex(),
        instances: [],
        message: '获取 MuMu 状态失败',
        error: e?.message,
      };
    }
  });

  ipcMain.handle('mumu:start', async (): Promise<MuMuStatusPayload> => {
    const win = BrowserWindow.getAllWindows()[0] || null;
    const config = loadConfigFromFile();
    const idx = parseInt(config['mumuVmIndex'] ?? '0', 10) || 0;
    muMuManager.setTargetIndex(idx);

    const startPayload = (partial: Partial<MuMuStatusPayload>) =>
      broadcastStatus(win, {
        installed: true,
        running: false,
        booted: false,
        serviceReady: false,
        targetIndex: idx,
        instances: [],
        message: '正在启动...',
        ...partial,
      });

    const emitProgress = (message: string, progress: number, stage: string) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('install:progress', {
          status:
            stage === 'error'
              ? 'error'
              : stage === 'ready'
                ? 'success'
                : 'installing',
          message,
          progress,
          error: stage === 'error' ? message : undefined,
        });
      }
    };

    try {
      startPayload({ message: '正在启动 MuMu 模拟器...' });
      const status = await muMuManager.ensureRunning(
        { installApk: true },
        emitProgress,
      );
      broadcastStatus(win, status);
      return status;
    } catch (e: any) {
      emitProgress('MuMu 启动失败', 0, 'error');
      const status: MuMuStatusPayload = {
        installed: true,
        running: false,
        booted: false,
        serviceReady: false,
        targetIndex: idx,
        instances: [],
        message: 'MuMu 启动失败',
        error: e?.message,
      };
      broadcastStatus(win, status);
      return status;
    }
  });

  ipcMain.handle('mumu:installApp', async (): Promise<MuMuStatusPayload> => {
    const win = BrowserWindow.getAllWindows()[0] || null;
    const emitProgress = (message: string, progress: number, stage: string) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('install:progress', {
          status:
            stage === 'error'
              ? 'error'
              : stage === 'ready'
                ? 'success'
                : 'installing',
          message,
          progress,
          error: stage === 'error' ? message : undefined,
        });
      }
    };
    try {
      broadcastStatus(win, {
        installed: true,
        running: true,
        booted: true,
        serviceReady: false,
        targetIndex: muMuManager.getTargetIndex(),
        instances: [],
        message: '正在安装 Spider 应用...',
      });
      const status = await muMuManager.ensureRunning(
        { installApk: true },
        emitProgress,
      );
      broadcastStatus(win, status);
      return status;
    } catch (e: any) {
      return {
        installed: true,
        running: true,
        booted: true,
        serviceReady: false,
        targetIndex: muMuManager.getTargetIndex(),
        instances: [],
        message: '安装失败',
        error: e?.message,
      };
    }
  });

  ipcMain.handle('mumu:listInstances', async () => {
    if (!muMuManager.locate()) return [];
    try {
      return await muMuManager.listInstances();
    } catch {
      return [];
    }
  });

  /**
   * Re-establish adb port forwarding on demand. Called by the renderer when a
   * spider HTTP request fails with a connection error — after the emulator
   * was restarted (or adb reset), the tcp:19978 -> tcp:9978 forward is lost,
   * and re-running it is the only way to reach the spider service again.
   */
  ipcMain.handle(
    'mumu:ensureForward',
    async (): Promise<{ ok: boolean; error?: string }> => {
      if (!muMuManager.locate()) {
        return { ok: false, error: '未找到 MuMu 模拟器' };
      }
      try {
        await muMuManager.forwardPorts();
        return { ok: true };
      } catch (e: any) {
        console.warn('[MuMuIPC] ensureForward failed:', e.message);
        return { ok: false, error: e.message };
      }
    },
  );

  ipcMain.handle('mumu:openGuide', async () => {
    // The renderer opens the MuMu setup guide directly; nothing to do here.
    return { handled: true };
  });
}
