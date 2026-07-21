# TVBox-PC Docker快速开始指南

## 概述

本指南帮助你快速在TVBox-PC桌面应用中部署和使用Docker容器化Spider服务。

## 系统要求

### Windows
- Windows 10 版本 2004+ 或 Windows 11
- 启用WSL 2功能
- 至少4GB内存
- BIOS中启用虚拟化（VT-x/AMD-V）

### macOS
- macOS 10.14+（Intel）或 macOS 11+（Apple Silicon）
- 至少4GB内存

### Linux
- 支持的主流发行版（Ubuntu 20.04+, Fedora 35+, Debian 11+）
- 内核支持binder和ashmem模块
- 至少4GB内存

## 快速部署

### 方式一：自动部署（推荐）

**Windows/macOS:**
1. 启动应用，自动检测Docker
2. 如未安装，按照弹窗提示安装Docker Desktop
3. 安装完成后，应用自动启动Spider服务

**Linux:**
1. 应用内置Docker引擎，无需手动安装
2. 启动应用，自动部署Spider服务

### 方式二：手动部署

#### 1. 安装Docker

**Windows:**
```powershell
# 方式1：下载安装器
# 访问 https://www.docker.com/products/docker-desktop/

# 方式2：使用Chocolatey
choco install docker-desktop -y

# 方式3：命令行静默安装
curl -L "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" -o "%TEMP%\DockerDesktopInstaller.exe"
start /w "" "%TEMP%\DockerDesktopInstaller.exe" install --quiet --accept-license
```

**macOS:**
```bash
# 使用Homebrew
brew install --cask docker

# 或下载DMG安装
# https://www.docker.com/products/docker-desktop/
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io

# Fedora
sudo dnf install docker-ce docker-ce-cli containerd.io

# 添加当前用户到docker组
sudo usermod -aG docker $USER
```

#### 2. 加载Docker镜像

```bash
# 拉取镜像（推荐）
docker pull your-repo/tvbox-spider-server:latest

# 或从本地文件加载
docker load -i docker-images/spider-server.tar
```

#### 3. 启动容器

```bash
# 使用Docker Compose（推荐）
cd docker
docker-compose up -d

# 或直接运行
docker run -d \
  --name tvbox-spider \
  --privileged \
  -p 9978:9978 \
  -v tvbox-spider-data:/data \
  -e REDROID_GPU_MODE=guest \
  your-repo/tvbox-spider-server:latest
```

#### 4. 验证服务

```bash
# 检查容器状态
docker ps

# 查看日志
docker logs tvbox-spider

# 测试API
curl http://localhost:9978/health
```

## 使用说明

### 启动应用

1. 确保Docker Desktop正在运行（Windows/macOS）
2. 启动TVBox-PC应用
3. 应用自动检测并启动Spider服务
4. 等待服务就绪（约30-60秒）

### 检查服务状态

在应用中：
- 打开设置 → Docker管理
- 查看容器运行状态
- 查看服务日志

### 手动控制

```bash
# 停止容器
pnpm docker:down

# 重启容器
docker restart tvbox-spider

# 查看日志
pnpm docker:logs
```

## 常见问题

### 1. Windows：提示需要安装WSL 2

**解决方案：**
```powershell
# 以管理员身份运行PowerShell
wsl --install
wsl --set-default-version 2

# 重启计算机
```

### 2. 容器启动失败

**检查内核模块（Linux）：**
```bash
# 加载binder模块
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux

# 添加到开机自动加载
echo "binder_linux" | sudo tee -a /etc/modules
echo "ashmem_linux" | sudo tee -a /etc/modules
```

### 3. API无响应

**诊断步骤：**
```bash
# 1. 检查容器状态
docker ps -a | grep tvbox-spider

# 2. 查看容器日志
docker logs --tail 100 tvbox-spider

# 3. 测试网络连接
curl -v http://localhost:9978/health

# 4. 检查端口占用
netstat -tuln | grep 9978
```

### 4. 镜像拉取失败

**解决方案：**
```bash
# 方式1：使用镜像加速
# 编辑 /etc/docker/daemon.json (Linux)
# 或 Docker Desktop设置 → Docker Engine (Windows/macOS)

{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://registry.cn-hangzhou.aliyuncs.com"
  ]
}

# 方式2：手动下载镜像
# 从项目Release页面下载spider-server.tar
docker load -i spider-server.tar
```

### 5. 内存不足

**解决方案：**
```bash
# 限制容器内存
docker update --memory="2g" --memory-swap="2g" tvbox-spider

# 或在docker-compose.yml中配置
services:
  spider-server:
    mem_limit: 2g
    memswap_limit: 2g
```

## 进阶配置

### 自定义Docker配置

编辑 `docker/docker-compose.yml`:

```yaml
version: '3.8'
services:
  spider-server:
    # ... 基础配置 ...
    
    # 资源限制
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
    
    # 环境变量
    environment:
      - SPIDER_SERVER_PORT=9978
      - LOG_LEVEL=info
      - MAX_CONNECTIONS=100
    
    # 持久化存储
    volumes:
      - spider-data:/data
      - ./config:/config:ro
```

### 性能优化

1. **启用BuildKit缓存：**
```bash
export DOCKER_BUILDKIT=1
docker build -t tvbox-spider-server .
```

2. **使用多阶段构建：**
减小镜像体积，加快部署速度。

3. **配置日志轮转：**
```yaml
services:
  spider-server:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## 故障排查

### 收集诊断信息

```bash
# 导出完整诊断信息
docker inspect tvbox-spider > container-info.json
docker logs tvbox-spider > container.log
docker exec tvbox-spider env > container-env.txt
docker stats --no-stream tvbox-spider > container-stats.txt

# 打包发送给技术支持
tar -czf tvbox-diagnostic.tar.gz container-*
```

### 重新部署

```bash
# 完全清理并重新部署
docker-compose down -v
docker-compose up -d
```

## 开发者指南

### 构建自定义镜像

```bash
# 构建Android应用
cd docker/android-app
./gradlew assembleDebug

# 构建Docker镜像
cd ../
docker build -t tvbox-spider-server:custom .

# 测试镜像
docker run -it --rm \
  -p 9978:9978 \
  tvbox-spider-server:custom
```

### 本地开发

```bash
# 启动开发环境
pnpm dev

# 在另一个终端启动Docker服务
pnpm docker:up

# 查看实时日志
pnpm docker:logs -f
```

## 参考资料

- [Docker Desktop官方文档](https://docs.docker.com/desktop/)
- [Docker命令行参考](https://docs.docker.com/engine/reference/commandline/cli/)
- [Redroid官方文档](https://github.com/remote-android/redroid-doc)
- [WSL 2安装指南](https://docs.microsoft.com/en-us/windows/wsl/install-win10)

## 技术支持

遇到问题？请：
1. 查看本文档的常见问题部分
2. 检查GitHub Issues：https://github.com/your-repo/tvbox-pc/issues
3. 提交新Issue并附上诊断信息