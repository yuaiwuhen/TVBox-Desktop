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

    try {
      startPayload({ message: '正在启动 MuMu 模拟器...' });
      const status = await muMuManager.ensureRunning({ installApk: true });
      broadcastStatus(win, status);
      return status;
    } catch (e: any) {
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
      const status = await muMuManager.ensureRunning({ installApk: true });
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

  ipcMain.handle('mumu:openGuide', async () => {
    // The renderer opens the MuMu setup guide directly; nothing to do here.
    return { handled: true };
  });
}
