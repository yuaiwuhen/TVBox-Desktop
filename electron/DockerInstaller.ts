/**
 * DockerInstaller - Docker安装引导模块
 *
 * 处理Docker Desktop的下载、安装和配置
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { app } from 'electron';

const execAsync = promisify(exec);

export interface InstallOptions {
  method: 'auto' | 'manual' | 'chocolatey' | 'homebrew';
  silent?: boolean;
}

export interface InstallProgress {
  stage: 'checking' | 'downloading' | 'installing' | 'configuring' | 'done';
  percent?: number;
  message: string;
}

export type ProgressCallback = (progress: InstallProgress) => void;

export class DockerInstaller {
  private readonly dockerDesktopUrl =
    'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';

  /**
   * 检查是否具有管理员权限（Windows）
   */
  async hasAdminPrivilege(): Promise<boolean> {
    if (process.platform !== 'win32') {
      return true; // Linux/macOS不需要管理员权限
    }

    try {
      // 尝试执行需要管理员权限的命令
      await execAsync('net session', { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查Chocolatey是否安装（Windows）
   */
  async isChocolateyInstalled(): Promise<boolean> {
    if (process.platform !== 'win32') {
      return false;
    }

    try {
      await execAsync('choco -v', { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查Homebrew是否安装（macOS）
   */
  async isHomebrewInstalled(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return false;
    }

    try {
      await execAsync('brew --version', { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 自动下载并安装Docker Desktop（Windows）
   */
  async downloadAndInstall(
    progressCallback?: ProgressCallback
  ): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('此方法仅适用于Windows系统');
    }

    const hasAdmin = await this.hasAdminPrivilege();
    if (!hasAdmin) {
      throw new Error('需要管理员权限才能安装Docker Desktop');
    }

    try {
      // 1. 下载安装器
      progressCallback?.({
        stage: 'downloading',
        percent: 0,
        message: '正在下载Docker Desktop安装器...',
      });

      const installerPath = path.join(
        app.getPath('temp'),
        'DockerDesktopInstaller.exe'
      );

      await this.downloadFile(this.dockerDesktopUrl, installerPath, (percent) => {
        progressCallback?.({
          stage: 'downloading',
          percent,
          message: `正在下载... ${percent}%`,
        });
      });

      // 2. 安装Docker Desktop
      progressCallback?.({
        stage: 'installing',
        message: '正在安装Docker Desktop...',
      });

      await this.installDockerDesktop(installerPath);

      // 3. 清理安装文件
      fs.unlinkSync(installerPath);

      progressCallback?.({
        stage: 'done',
        message: 'Docker Desktop安装完成',
      });
    } catch (error: any) {
      progressCallback?.({
        stage: 'installing',
        message: `安装失败: ${error.message}`,
      });
      throw error;
    }
  }

  /**
   * 通过Chocolatey安装（Windows）
   */
  async installViaChocolatey(progressCallback?: ProgressCallback): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('此方法仅适用于Windows系统');
    }

    const hasAdmin = await this.hasAdminPrivilege();
    if (!hasAdmin) {
      throw new Error('需要管理员权限');
    }

    const hasChoco = await this.isChocolateyInstalled();
    if (!hasChoco) {
      throw new Error('Chocolatey未安装');
    }

    try {
      progressCallback?.({
        stage: 'installing',
        message: '正在通过Chocolatey安装Docker Desktop...',
      });

      await execAsync('choco install docker-desktop -y', { timeout: 600000 });

      progressCallback?.({
        stage: 'done',
        message: 'Docker Desktop安装完成',
      });
    } catch (error: any) {
      throw new Error(`Chocolatey安装失败: ${error.message}`);
    }
  }

  /**
   * 通过Homebrew安装（macOS）
   */
  async installViaHomebrew(progressCallback?: ProgressCallback): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('此方法仅适用于macOS系统');
    }

    const hasBrew = await this.isHomebrewInstalled();
    if (!hasBrew) {
      throw new Error('Homebrew未安装');
    }

    try {
      progressCallback?.({
        stage: 'installing',
        message: '正在通过Homebrew安装Docker Desktop...',
      });

      await execAsync('brew install --cask docker', { timeout: 600000 });

      progressCallback?.({
        stage: 'done',
        message: 'Docker Desktop安装完成',
      });
    } catch (error: any) {
      throw new Error(`Homebrew安装失败: ${error.message}`);
    }
  }

  /**
   * 下载文件
   */
  private downloadFile(
    url: string,
    dest: string,
    progressCallback?: (percent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const protocol = url.startsWith('https') ? https : http;

      protocol
        .get(url, (response) => {
          // 处理重定向
          if (
            response.statusCode === 301 ||
            response.statusCode === 302
          ) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              file.close();
              fs.unlinkSync(dest);
              this.downloadFile(redirectUrl, dest, progressCallback)
                .then(resolve)
                .catch(reject);
              return;
            }
          }

          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (totalSize > 0 && progressCallback) {
              const percent = Math.round((downloadedSize / totalSize) * 100);
              progressCallback(percent);
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (error) => {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {}
          reject(error);
        });
    });
  }

  /**
   * 安装Docker Desktop（静默安装）
   */
  private async installDockerDesktop(installerPath: string): Promise<void> {
    const args = [
      'install',
      '--quiet',
      '--accept-license',
      '--norestart',
      '--backend=wsl-2',
    ];

    await new Promise<void>((resolve, reject) => {
      const installer = spawn(installerPath, args, {
        stdio: 'ignore',
        detached: true,
      });

      installer.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`安装器退出码: ${code}`));
        }
      });

      installer.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 打开Docker Desktop下载页面
   */
  openDownloadPage(): void {
    const platform = process.platform;
    let url = '';

    if (platform === 'win32') {
      url = 'https://www.docker.com/products/docker-desktop/';
    } else if (platform === 'darwin') {
      url = 'https://www.docker.com/products/docker-desktop/';
    } else if (platform === 'linux') {
      url = 'https://docs.docker.com/desktop/setup/install/linux/';
    }

    if (url) {
      import('electron').then(({ shell }) => {
        shell.openExternal(url);
      });
    }
  }

  /**
   * 打开WSL 2安装指南
   */
  openWSLGuide(): void {
    import('electron').then(({ shell }) => {
      shell.openExternal(
        'https://docs.microsoft.com/en-us/windows/wsl/install-win10'
      );
    });
  }

  /**
   * 打开系统要求文档
   */
  openRequirementsDoc(): void {
    import('electron').then(({ shell }) => {
      shell.openExternal(
        'https://docs.docker.com/desktop/setup/install/windows-install/'
      );
    });
  }
}