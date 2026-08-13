/**
 * DockerManager - Docker环境检测和管理模块
 *
 * 负责检测Docker安装状态、管理Docker服务、处理容器生命周期
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

const execAsync = promisify(exec);

export interface DockerStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  error?: string;
}

export interface ContainerStatus {
  running: boolean;
  healthy: boolean;
  port: number;
  uptime?: string;
}

export class DockerManager {
  private static instance: DockerManager;
  private readonly containerName = 'tvbox-spider';
  private readonly imageName = 'tvbox-spider-server:latest';
  // 宿主机暴露端口：19978（避开 Clash Verge 等代理软件占用 9978）。
  // 容器内 spider 服务监听端口：9978（见 SpiderHttpService.DEFAULT_PORT）。
  // docker-compose.yml 也使用 19978:9978 映射。
  private readonly hostPort = 19978;
  private readonly containerPort = 9978;

  private constructor() {}

  static getInstance(): DockerManager {
    if (!DockerManager.instance) {
      DockerManager.instance = new DockerManager();
    }
    return DockerManager.instance;
  }

  /**
   * 检测Docker是否已安装
   */
  async checkDockerInstalled(): Promise<DockerStatus> {
    try {
      const result = await execAsync('docker --version', {
        timeout: 5000,
      });

      const versionMatch = result.stdout.match(/Docker version ([\d.]+)/);
      const version = versionMatch ? versionMatch[1] : 'unknown';

      return {
        installed: true,
        running: false,
        version,
      };
    } catch (error: any) {
      return {
        installed: false,
        running: false,
        error: error.message,
      };
    }
  }

  /**
   * 检测Docker服务是否运行
   */
  async checkDockerRunning(): Promise<DockerStatus> {
    const status = await this.checkDockerInstalled();

    if (!status.installed) {
      return status;
    }

    try {
      await execAsync('docker ps', { timeout: 5000 });
      status.running = true;
    } catch {
      status.running = false;
      status.error = 'Docker服务未运行';
    }

    return status;
  }

  /**
   * 启动Docker服务
   */
  async startDockerService(): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        // Windows: 启动Docker Desktop
        const dockerPath =
          'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
        if (fs.existsSync(dockerPath)) {
          spawn(dockerPath, [], { detached: true });
        } else {
          throw new Error('未找到Docker Desktop');
        }
      } else if (platform === 'darwin') {
        // macOS: 启动Docker Desktop
        await execAsync('open -a Docker');
      } else if (platform === 'linux') {
        // Linux: 启动Docker服务
        await execAsync('sudo systemctl start docker');
      }

      // 等待Docker服务就绪
      await this.waitForDockerReady(30);
    } catch (error: any) {
      console.error('[DockerManager] Failed to start Docker:', error);
      throw new Error(`无法启动Docker服务: ${error.message}`);
    }
  }

  /**
   * 等待Docker服务就绪
   */
  private async waitForDockerReady(timeout: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 2000; // 2秒

    while (Date.now() - startTime < timeout * 1000) {
      try {
        await execAsync('docker ps', { timeout: 3000 });
        console.log('[DockerManager] Docker服务已就绪');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    throw new Error('Docker服务启动超时');
  }

  /**
   * 检查容器是否存在
   */
  async containerExists(): Promise<boolean> {
    try {
      const result = await execAsync(
        `docker ps -a --filter name=${this.containerName} --format {{.Names}}`,
        { timeout: 5000 },
      );
      return result.stdout.trim() === this.containerName;
    } catch {
      return false;
    }
  }

  /**
   * 检查容器状态
   */
  async getContainerStatus(): Promise<ContainerStatus> {
    try {
      const result = await execAsync(
        `docker ps --filter name=${this.containerName} --format {{.Status}}`,
        { timeout: 5000 },
      );

      const status = result.stdout.trim();
      if (!status) {
        return {
          running: false,
          healthy: false,
          port: this.hostPort,
        };
      }

      // 检查健康状态
      const isUp = status.startsWith('Up');
      const uptime = status.replace('Up ', '').split(' ')[0];

      return {
        running: isUp,
        healthy: isUp,
        port: this.hostPort,
        uptime,
      };
    } catch (error: any) {
      return {
        running: false,
        healthy: false,
        port: this.hostPort,
        error: error.message,
      };
    }
  }

  /**
   * 创建容器
   */
  async createContainer(): Promise<void> {
    console.log('[DockerManager] Creating container...');

    const cmd = `docker run -d \
      --name ${this.containerName} \
      --privileged \
      -p ${this.hostPort}:${this.containerPort} \
      -v tvbox-spider-data:/data \
      -e REDROID_PROP_ro.debuggable=1 \
      -e ANDROIDBOOT_REDROID_GPU_MODE=guest \
      ${this.imageName}`;

    try {
      await execAsync(cmd, { timeout: 30000 });
      console.log('[DockerManager] Container created successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to create container:', error);
      throw new Error(`创建容器失败: ${error.message}`);
    }
  }

  /**
   * 启动容器
   */
  async startContainer(): Promise<void> {
    console.log('[DockerManager] Starting container...');

    const exists = await this.containerExists();

    try {
      if (exists) {
        await execAsync(`docker start ${this.containerName}`, {
          timeout: 30000,
        });
      } else {
        await this.createContainer();
      }

      // 等待服务就绪
      await this.waitForServiceReady(60);
      console.log('[DockerManager] Container started successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to start container:', error);
      throw new Error(`启动容器失败: ${error.message}`);
    }
  }

  /**
   * 停止容器
   */
  async stopContainer(): Promise<void> {
    console.log('[DockerManager] Stopping container...');

    try {
      await execAsync(`docker stop ${this.containerName}`, {
        timeout: 30000,
      });
      console.log('[DockerManager] Container stopped successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to stop container:', error);
      throw new Error(`停止容器失败: ${error.message}`);
    }
  }

  /**
   * 重启容器
   */
  async restartContainer(): Promise<void> {
    console.log('[DockerManager] Restarting container...');

    try {
      await execAsync(`docker restart ${this.containerName}`, {
        timeout: 30000,
      });

      // 等待服务就绪
      await this.waitForServiceReady(60);
      console.log('[DockerManager] Container restarted successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to restart container:', error);
      throw new Error(`重启容器失败: ${error.message}`);
    }
  }

  /**
   * 删除容器
   */
  async removeContainer(): Promise<void> {
    console.log('[DockerManager] Removing container...');

    try {
      await execAsync(`docker rm -f ${this.containerName}`, {
        timeout: 30000,
      });
      console.log('[DockerManager] Container removed successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to remove container:', error);
      throw new Error(`删除容器失败: ${error.message}`);
    }
  }

  /**
   * 获取容器日志
   */
  async getContainerLogs(lines: number = 100): Promise<string> {
    try {
      const result = await execAsync(
        `docker logs --tail ${lines} ${this.containerName}`,
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      return result.stdout;
    } catch (error: any) {
      console.error('[DockerManager] Failed to get logs:', error);
      return '';
    }
  }

  /**
   * 等待服务就绪
   */
  private async waitForServiceReady(timeout: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 2000; // 2秒

    while (Date.now() - startTime < timeout * 1000) {
      try {
        const response = await axios.get(
          `http://localhost:${this.hostPort}/health`,
          { timeout: 3000 },
        );

        if (response.data.success) {
          console.log('[DockerManager] Spider service is ready');
          return;
        }
      } catch {
        // 服务还未就绪，继续等待
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error('Spider服务启动超时');
  }

  /**
   * 检查镜像是否存在
   */
  async imageExists(imageName?: string): Promise<boolean> {
    const image = imageName || this.imageName;

    try {
      const result = await execAsync(
        `docker images --filter reference=${image} --format {{.Repository}}`,
        { timeout: 5000 },
      );
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 拉取镜像
   */
  async pullImage(imageName?: string): Promise<void> {
    const image = imageName || this.imageName;
    console.log(`[DockerManager] Pulling image: ${image}`);

    try {
      await execAsync(`docker pull ${image}`, { timeout: 300000 }); // 5分钟超时
      console.log('[DockerManager] Image pulled successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to pull image:', error);
      throw new Error(`拉取镜像失败: ${error.message}`);
    }
  }

  /**
   * 加载本地镜像
   */
  async loadImage(imagePath: string): Promise<void> {
    console.log(`[DockerManager] Loading image from: ${imagePath}`);

    try {
      await execAsync(`docker load -i "${imagePath}"`, { timeout: 60000 });
      console.log('[DockerManager] Image loaded successfully');
    } catch (error: any) {
      console.error('[DockerManager] Failed to load image:', error);
      throw new Error(`加载镜像失败: ${error.message}`);
    }
  }
}

// 导出单例
export const dockerManager = DockerManager.getInstance();
