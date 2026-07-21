# Docker集成部署方案

## 执行摘要

本文档详细说明了如何在TVBox-PC桌面应用中集成Docker和redroid-headless，实现跨平台的自动化部署方案。

## 方案概述

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    TVBox-PC Electron应用                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐│
│  │  Docker检测模块  │  │  Docker管理模块  │  │ Spider客户端 ││
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘│
└───────────┼─────────────────────┼──────────────────┼─────────┘
            │                     │                  │
            ▼                     ▼                  ▼
     ┌─────────────┐       ┌─────────────┐    ┌─────────────┐
     │ Docker安装   │       │ 容器管理     │    │ HTTP API    │
     │ 向导         │       │             │    │ 客户端      │
     └─────────────┘       └─────────────┘    └─────────────┘
            │                     │                  │
            └─────────────────────┼──────────────────┘
                                  ▼
                        ┌──────────────────┐
                        │  Docker Engine    │
                        │  (系统级服务)      │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Redroid容器     │
                        │  (Spider服务)     │
                        └──────────────────┘
```

### 跨平台策略

| 平台 | Docker方案 | 内置策略 | 用户操作 |
|------|-----------|---------|---------|
| **Windows** | Docker Desktop | ❌ 不内置 | 提示安装，提供下载链接和教程 |
| **macOS** | Docker Desktop | ❌ 不内置 | 提示安装，自动检测已安装 |
| **Linux** | Docker Engine | ✅ 可内置 | 自动安装，无感部署 |

## 技术方案

### 1. Windows平台方案

#### 检测逻辑
```typescript
// electron/DockerManager.ts
export class DockerManager {
  /**
   * 检测Docker是否已安装
   */
  async checkDockerInstalled(): Promise<boolean> {
    try {
      const result = await execAsync('docker --version');
      return result.stdout.includes('Docker version');
    } catch {
      return false;
    }
  }

  /**
   * 检测Docker服务是否运行
   */
  async checkDockerRunning(): Promise<boolean> {
    try {
      const result = await execAsync('docker ps');
      return !result.stderr.includes('error');
    } catch {
      return false;
    }
  }
}
```

#### 安装引导
当检测到未安装Docker时：
1. 显示友好的弹窗提示
2. 提供3种安装方式：
   - 自动下载安装器（管理员权限）
   - 手动下载链接
   - Chocolatey包管理器安装

```typescript
// electron/DockerInstaller.ts
export class DockerInstaller {
  /**
   * 自动下载并安装Docker Desktop（需要管理员权限）
   */
  async downloadAndInstall(): Promise<void> {
    const downloadUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';
    const installerPath = path.join(os.tmpdir(), 'DockerDesktopInstaller.exe');
    
    // 下载安装器
    await this.downloadFile(downloadUrl, installerPath);
    
    // 静默安装
    const command = `Start-Process '${installerPath}' -Wait -ArgumentList 'install','--quiet','--accept-license'`;
    await this.executeAsAdmin(command);
  }
  
  /**
   * 使用Chocolatey安装
   */
  async installViaChocolatey(): Promise<void> {
    const command = 'choco install docker-desktop -y';
    await this.executeAsAdmin(command);
  }
}
```

#### 用户引导界面
```vue
<!-- src/components/DockerInstallGuide.vue -->
<template>
  <el-dialog 
    title="需要安装Docker Desktop"
    :visible.sync="visible"
    width="600px"
    :close-on-click-modal="false"
  >
    <div class="install-guide">
      <el-alert 
        type="warning" 
        :closable="false"
        title="检测到您的系统未安装Docker"
        description="TVBox需要Docker来运行Spider服务。"
      />
      
      <div class="install-options">
        <h3>请选择安装方式：</h3>
        
        <el-card class="install-option">
          <div slot="header">
            <el-radio v-model="installMethod" label="auto">
              自动安装（推荐）
            </el-radio>
          </div>
          <p>自动下载并安装Docker Desktop</p>
          <el-button 
            type="primary" 
            @click="autoInstall"
            :disabled="!hasAdminPrivilege"
          >
            开始安装
          </el-button>
          <el-alert 
            v-if="!hasAdminPrivilege" 
            type="info" 
            :closable="false"
          >
            需要管理员权限
          </el-alert>
        </el-card>
        
        <el-card class="install-option">
          <div slot="header">
            <el-radio v-model="installMethod" label="manual">
              手动下载安装
            </el-radio>
          </div>
          <p>手动下载安装器并运行</p>
          <el-button type="primary" @click="openDownloadPage">
            打开下载页面
          </el-button>
        </el-card>
        
        <el-card class="install-option">
          <div slot="header">
            <el-radio v-model="installMethod" label="chocolatey">
              使用Chocolatey
            </el-radio>
          </div>
          <p>如果您已安装Chocolatey包管理器</p>
          <el-button 
            type="primary" 
            @click="installWithChocolatey"
            :disabled="!hasAdminPrivilege"
          >
            通过Chocolatey安装
          </el-button>
        </el-card>
      </div>
      
      <div class="requirements">
        <h3>系统要求：</h3>
        <ul>
          <li>Windows 10 版本 2004+ 或 Windows 11</li>
          <li>启用WSL 2功能</li>
          <li>至少4GB内存</li>
          <li>BIOS中启用虚拟化</li>
        </ul>
        
        <el-button type="text" @click="showDetailedGuide">
          查看详细安装教程 →
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>
```

### 2. Linux平台方案

Linux平台可以内置轻量级Docker Engine，实现无感部署。

#### 内置方案
```typescript
// electron/DockerBundler.ts
export class DockerBundler {
  /**
   * 检查并安装内置的Docker Engine
   */
  async ensureDockerInstalled(): Promise<void> {
    if (await this.checkSystemDocker()) {
      console.log('使用系统Docker');
      return;
    }
    
    console.log('安装内置Docker Engine...');
    await this.installBundledDocker();
  }
  
  /**
   * 安装内置的Docker Engine
   */
  private async installBundledDocker(): Promise<void> {
    const bundledDockerPath = path.join(
      process.resourcesPath, 
      'docker-engine'
    );
    
    // 解压内置的Docker二进制文件
    await this.extractBundledDocker(bundledDockerPath);
    
    // 配置systemd服务（如果可用）
    if (this.isSystemdAvailable()) {
      await this.setupDockerService();
    }
  }
}
```

#### 打包配置
```json
// package.json
{
  "build": {
    "extraResources": [
      {
        "from": "docker-engine/linux",
        "to": "docker-engine",
        "filter": ["**/*"]
      },
      {
        "from": "docker-images/spider-server.tar",
        "to": "docker-images/spider-server.tar"
      }
    ]
  }
}
```

### 3. macOS平台方案

macOS平台类似Windows，需要引导用户安装Docker Desktop。

#### Homebrew安装支持
```typescript
// electron/DockerInstallerMac.ts
export class DockerInstallerMac {
  /**
   * 通过Homebrew安装
   */
  async installViaHomebrew(): Promise<void> {
    if (!await this.isHomebrewInstalled()) {
      throw new Error('Homebrew未安装');
    }
    
    await execAsync('brew install --cask docker');
  }
  
  /**
   * 检查Homebrew是否安装
   */
  private async isHomebrewInstalled(): Promise<boolean> {
    try {
      await execAsync('brew --version');
      return true;
    } catch {
      return false;
    }
  }
}
```

## 自定义镜像方案

### 1. 镜像构建

创建优化的Spider服务镜像：

```dockerfile
# docker/spider-server/Dockerfile
FROM redroid/redroid:15.0.0_64only-latest

# 预装Spider应用
COPY spider-server.apk /data/app/

# 预配置环境
ENV SPIDER_SERVER_PORT=9978
ENV REDROID_GPU_MODE=guest

# 优化镜像大小
RUN rm -rf /var/cache/* /tmp/* && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 暴露端口
EXPOSE 9978

# 启动脚本
COPY start-spider.sh /start-spider.sh
RUN chmod +x /start-spider.sh
CMD ["/start-spider.sh"]
```

### 2. 镜像分发策略

#### 方案A：镜像内置于应用（推荐用于Linux）
```typescript
// 应用启动时自动导入镜像
async function importBundledImage(): Promise<void> {
  const imagePath = path.join(
    process.resourcesPath,
    'docker-images/spider-server.tar'
  );
  
  if (fs.existsSync(imagePath)) {
    await execAsync(`docker load -i "${imagePath}"`);
    console.log('Spider镜像已导入');
  }
}
```

#### 方案B：从仓库拉取（Windows/macOS）
```yaml
# docker/docker-compose.yml
version: '3.8'
services:
  spider-server:
    image: your-repo/spider-server:latest
    pull_policy: always
    # ... 其他配置
```

#### 方案C：混合方案
- 首次运行：尝试从内置路径加载
- 如果失败：从Docker Hub拉取
- 最终备用：提示用户手动下载

```typescript
// electron/ImageManager.ts
export class ImageManager {
  async ensureImageAvailable(): Promise<void> {
    const imageName = 'tvbox-spider-server:latest';
    
    // 1. 检查镜像是否已存在
    if (await this.imageExists(imageName)) {
      return;
    }
    
    // 2. 尝试从内置文件加载
    if (await this.loadBundledImage()) {
      return;
    }
    
    // 3. 从仓库拉取
    try {
      await this.pullFromRegistry(imageName);
    } catch (error) {
      throw new Error('无法获取Spider镜像，请手动下载');
    }
  }
}
```

## 自动化部署流程

### 完整启动流程

```typescript
// electron/StartupManager.ts
export class StartupManager {
  async initialize(): Promise<void> {
    // 1. 检测操作系统
    const platform = process.platform;
    
    // 2. 检查Docker环境
    const dockerOk = await this.checkDockerEnvironment();
    
    if (!dockerOk) {
      if (platform === 'win32' || platform === 'darwin') {
        // Windows/macOS：显示安装向导
        await this.showDockerInstallGuide();
        return;
      } else if (platform === 'linux') {
        // Linux：自动安装内置Docker
        await this.installBundledDocker();
      }
    }
    
    // 3. 启动Docker服务（如果未运行）
    await this.ensureDockerRunning();
    
    // 4. 确保镜像可用
    await this.ensureImageAvailable();
    
    // 5. 启动Spider容器
    await this.startSpiderContainer();
    
    // 6. 等待服务就绪
    await this.waitServiceReady();
  }
  
  /**
   * 检查Docker环境
   */
  private async checkDockerEnvironment(): Promise<boolean> {
    try {
      // 检查Docker是否安装
      await execAsync('docker --version');
      
      // 检查Docker服务是否运行
      await execAsync('docker ps');
      
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * 确保Docker服务运行
   */
  private async ensureDockerRunning(): Promise<void> {
    try {
      await execAsync('docker ps');
    } catch {
      // 尝试启动Docker服务
      if (process.platform === 'win32') {
        await execAsync('"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"');
      } else if (process.platform === 'darwin') {
        await execAsync('open -a Docker');
      } else {
        await execAsync('sudo systemctl start docker');
      }
      
      // 等待Docker启动
      await this.waitForDocker(30);
    }
  }
  
  /**
   * 等待Docker服务就绪
   */
  private async waitForDocker(timeout: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout * 1000) {
      try {
        await execAsync('docker ps');
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    throw new Error('Docker服务启动超时');
  }
}
```

### 容器管理模块

```typescript
// electron/ContainerManager.ts
export class ContainerManager {
  private containerName = 'tvbox-spider';
  
  /**
   * 启动Spider容器
   */
  async startContainer(): Promise<void> {
    // 检查容器是否已存在
    const exists = await this.containerExists();
    
    if (exists) {
      // 启动现有容器
      await execAsync(`docker start ${this.containerName}`);
    } else {
      // 创建新容器
      await this.createContainer();
    }
    
    // 等待服务就绪
    await this.waitForService(9978, 60);
  }
  
  /**
   * 创建容器
   */
  private async createContainer(): Promise<void> {
    const cmd = `docker run -d \
      --name ${this.containerName} \
      --privileged \
      -p 9978:9978 \
      -v spider-data:/data \
      -e REDROID_GPU_MODE=guest \
      tvbox-spider-server:latest`;
    
    await execAsync(cmd);
  }
  
  /**
   * 停止容器
   */
  async stopContainer(): Promise<void> {
    await execAsync(`docker stop ${this.containerName}`);
  }
  
  /**
   * 重启容器
   */
  async restartContainer(): Promise<void> {
    await execAsync(`docker restart ${this.containerName}`);
  }
  
  /**
   * 查看容器日志
   */
  async getContainerLogs(): Promise<string> {
    const result = await execAsync(
      `docker logs --tail 100 ${this.containerName}`
    );
    return result.stdout;
  }
  
  /**
   * 检查容器是否存在
   */
  private async containerExists(): Promise<boolean> {
    try {
      const result = await execAsync(
        `docker ps -a --filter name=${this.containerName} --format {{.Names}}`
      );
      return result.stdout.trim() === this.containerName;
    } catch {
      return false;
    }
  }
  
  /**
   * 等待服务就绪
   */
  private async waitForService(port: number, timeout: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout * 1000) {
      try {
        await axios.get(`http://localhost:${port}/health`);
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    throw new Error('Spider服务启动超时');
  }
}
```

## 性能优化

### 1. 镜像体积优化
- 使用多阶段构建
- 清理apt缓存和临时文件
- 只包含必要的组件

### 2. 启动速度优化
- 预拉取镜像
- 使用镜像缓存
- 优化容器启动参数

### 3. 内存占用优化
- 限制容器内存使用
- 配置合理的JVM参数
- 启用内存压缩

## 安全考虑

### 1. 权限管理
- 不使用root用户运行应用
- 合理配置Docker socket权限
- 限制容器特权

### 2. 网络安全
- 使用本地回环地址
- 限制端口暴露
- 启用TLS（生产环境）

### 3. 数据安全
- 加密敏感配置
- 使用Docker secrets
- 定期清理敏感数据

## 故障排查

### 常见问题

1. **Docker未启动**
   - 自动尝试启动Docker服务
   - 显示友好的错误提示

2. **镜像拉取失败**
   - 尝试从内置镜像加载
   - 显示网络诊断信息
   - 提供手动下载方案

3. **容器启动失败**
   - 检查内核模块（binder/ashmem）
   - 显示详细错误日志
   - 提供修复建议

### 日志记录
```typescript
// electron/Logger.ts
export class DockerLogger {
  private logFile = path.join(app.getPath('logs'), 'docker.log');
  
  log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    fs.appendFileSync(this.logFile, logMessage);
    console.log(message);
  }
}
```

## 部署检查清单

- [ ] Docker环境检测逻辑
- [ ] Docker安装引导界面
- [ ] 自定义镜像构建
- [ ] 镜像导入/拉取逻辑
- [ ] 容器生命周期管理
- [ ] 服务健康检查
- [ ] 错误处理和日志
- [ ] 用户文档和教程

## 参考资源

- [Docker Desktop安装文档](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Electron + Docker最佳实践](https://blog.csdn.net/ArmorClaw/article/details/159475542)
- [Redroid官方文档](https://github.com/remote-android/redroid-doc)
- [Rancher Desktop（替代方案）](https://rancherdesktop.io/)