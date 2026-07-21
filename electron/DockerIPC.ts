/**
 * Docker IPC Handlers
 *
 * 处理渲染进程与主进程之间的Docker相关通信
 */

import { ipcMain, shell } from 'electron';
import { DockerManager } from './DockerManager';
import { DockerInstaller } from './DockerInstaller';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

const dockerManager = DockerManager.getInstance();
const dockerInstaller = new DockerInstaller();

export function registerDockerIPC(): void {
  // Check Docker status
  ipcMain.handle('docker:check', async () => {
    return await dockerManager.checkDockerRunning();
  });

  // Check admin privilege
  ipcMain.handle('docker:hasAdmin', async () => {
    return await dockerInstaller.hasAdminPrivilege();
  });

  // Check Chocolatey installed
  ipcMain.handle('docker:hasChoco', async () => {
    return await dockerInstaller.isChocolateyInstalled();
  });

  // Check Homebrew installed
  ipcMain.handle('docker:hasHomebrew', async () => {
    return await dockerInstaller.isHomebrewInstalled();
  });

  // Check WSL status (Windows only)
  ipcMain.handle('docker:checkWSL', async () => {
    if (process.platform !== 'win32') {
      return { installed: true };
    }

    try {
      await execAsync('wsl --list', { timeout: 5000 });
      return { installed: true };
    } catch {
      return { installed: false };
    }
  });

  // Auto install Docker Desktop
  ipcMain.handle('docker:autoInstall', async (event) => {
    try {
      await dockerInstaller.downloadAndInstall((progress) => {
        event.sender.send('docker:installProgress', progress);
      });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Install via Chocolatey
  ipcMain.handle('docker:chocoInstall', async (event) => {
    try {
      await dockerInstaller.installViaChocolatey((progress) => {
        event.sender.send('docker:installProgress', progress);
      });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Install via Homebrew
  ipcMain.handle('docker:brewInstall', async (event) => {
    try {
      await dockerInstaller.installViaHomebrew((progress) => {
        event.sender.send('docker:installProgress', progress);
      });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Open Docker download page
  ipcMain.handle('docker:openDownload', async () => {
    dockerInstaller.openDownloadPage();
  });

  // Open Docker installation guide
  ipcMain.handle('docker:openGuide', async () => {
    dockerInstaller.openRequirementsDoc();
  });

  // Open WSL installation guide
  ipcMain.handle('docker:openWSLGuide', async () => {
    dockerInstaller.openWSLGuide();
  });

  // Open Chocolatey page
  ipcMain.handle('docker:openChocolatey', async () => {
    shell.openExternal('https://chocolatey.org/install');
  });

  // Start Docker service
  ipcMain.handle('docker:startService', async () => {
    try {
      await dockerManager.startDockerService();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Start Spider container
  ipcMain.handle('docker:startContainer', async () => {
    try {
      await dockerManager.startContainer();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Stop Spider container
  ipcMain.handle('docker:stopContainer', async () => {
    try {
      await dockerManager.stopContainer();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Restart Spider container
  ipcMain.handle('docker:restartContainer', async () => {
    try {
      await dockerManager.restartContainer();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get container status
  ipcMain.handle('docker:containerStatus', async () => {
    return await dockerManager.getContainerStatus();
  });

  // Get container logs
  ipcMain.handle('docker:getLogs', async (_event, lines?: number) => {
    return await dockerManager.getContainerLogs(lines || 100);
  });

  // Ensure image is available
  ipcMain.handle('docker:ensureImage', async () => {
    try {
      const exists = await dockerManager.imageExists();
      if (!exists) {
        await dockerManager.pullImage();
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  console.log('[DockerIPC] Registered all Docker IPC handlers');
}