# Android-x86 + VirtualBox 部署方案

## 概述

这是为Windows用户提供的最通用、最稳定的Spider服务部署方案。通过VirtualBox运行Android-x86系统，然后在其中安装Spider HTTP服务。

## 优势

- ✅ **Windows全版本支持**：支持Windows 7/8/10/11
- ✅ **无需Docker**：不需要WSL2或Docker Desktop
- ✅ **用户友好**：提供图形界面，操作简单
- ✅ **资源占用低**：2GB内存即可运行
- ✅ **完全控制**：可以完全控制Android环境

## 系统要求

- CPU：支持虚拟化（Intel VT-x或AMD-V）
- RAM：至少4GB（推荐8GB）
- 存储：10GB可用空间
- Windows：7/8/10/11任意版本

## 安装步骤

### 方式一：自动安装（推荐）

运行自动安装脚本：

```bash
scripts\install-android-vm.bat
```

脚本会自动完成：
1. 检测并安装VirtualBox
2. 下载Android-x86系统镜像
3. 创建并配置虚拟机
4. 启动虚拟机

### 方式二：手动安装

#### 1. 安装VirtualBox

下载并安装VirtualBox：
- 下载地址：https://www.virtualbox.org/wiki/Downloads
- 选择 "Windows hosts" 下载
- 安装时选择默认选项

#### 2. 下载Android-x86

下载Android-x86 9.0 ISO：
- 下载地址：https://www.android-x86.org/
- 选择 `android-x86_64-9.0-r2.iso` (64位)
- 或选择 `android-x86-9.0-r2.iso` (32位)

#### 3. 创建虚拟机

在VirtualBox中：

1. 点击 "新建"
2. 名称：Spider-Android
3. 类型：Linux
4. 版本：Linux 2.6 / 3.x / 4.x (64-bit)
5. 内存：2048MB
6. 虚拟硬盘：8GB (动态分配)

#### 4. 配置虚拟机

设置：
- 系统 → 处理器：2核
- 显示 → 显存：128MB
- 网络 → NAT
- 端口转发：
  - 规则1：TCP, 5555, 5555 (ADB)
  - 规则2：TCP, 9978, 9978 (Spider HTTP)

#### 5. 安装Android-x86

1. 启动虚拟机，选择 "Installation"
2. 创建分区：选择 "Create/Modify partitions"
3. 创建主分区并标记为启动
4. 格式化为ext4
5. 安装GRUB引导加载器
6. 重启虚拟机

#### 6. 安装Spider APK

构建Spider APK（在项目根目录）：

```bash
cd docker/android-app
.\build-apk.bat
```

安装APK到虚拟机：

```bash
adb connect localhost:5555
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService
```

## 使用方法

### 启动服务

```bash
# 启动虚拟机（后台运行）
VBoxManage startvm "Spider-Android" --type headless

# 或启动虚拟机（图形界面）
VBoxManage startvm "Spider-Android"

# 连接ADB
adb connect localhost:5555

# 安装并启动Spider服务
adb install -r docker/android-app/app/build/outputs/apk/debug/app-debug.apk
adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService
```

### 验证服务

```bash
# 检查服务状态
curl http://localhost:9978/health

# 测试Spider API
curl -X POST http://localhost:9978/spider/homeContent
```

### 停止服务

```bash
# 停止Spider服务
adb shell am stopservice -n com.tvbox.spiderserver/.SpiderHttpService

# 关闭虚拟机
VBoxManage controlvm "Spider-Android" acpipowerbutton
```

## 自动化脚本

### 一键启动脚本

创建 `start-spider-vm.bat`：

```batch
@echo off
echo 启动Spider虚拟机...

REM 启动虚拟机（后台）
VBoxManage startvm "Spider-Android" --type headless

REM 等待虚拟机启动
timeout /t 30 /nobreak

REM 连接ADB
adb connect localhost:5555

REM 启动Spider服务
adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService

echo Spider服务已启动
echo 访问地址: http://localhost:9978
pause
```

### 一键停止脚本

创建 `stop-spider-vm.bat`：

```batch
@echo off
echo 停止Spider虚拟机...

REM 停止Spider服务
adb shell am stopservice -n com.tvbox.spiderserver/.SpiderHttpService

REM 关闭虚拟机
VBoxManage controlvm "Spider-Android" acpipowerbutton

echo Spider服务已停止
pause
```

## 集成到Electron应用

在Electron中自动管理虚拟机：

```typescript
// electron/AndroidVMManager.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class AndroidVMManager {
  private vmName = 'Spider-Android';
  
  async startVM(): Promise<void> {
    console.log('启动Android虚拟机...');
    
    // 检查虚拟机状态
    const { stdout } = await execAsync(
      `VBoxManage showvminfo "${this.vmName}" | findstr "State"`
    );
    
    if (stdout.includes('powered off')) {
      // 启动虚拟机（后台）
      await execAsync(`VBoxManage startvm "${this.vmName}" --type headless`);
      
      // 等待启动
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      // 连接ADB
      await execAsync('adb connect localhost:5555');
      
      // 启动Spider服务
      await execAsync(
        'adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService'
      );
      
      console.log('Android虚拟机已启动');
    }
  }
  
  async stopVM(): Promise<void> {
    console.log('停止Android虚拟机...');
    
    // 停止Spider服务
    await execAsync(
      'adb shell am stopservice -n com.tvbox.spiderserver/.SpiderHttpService'
    ).catch(() => {});
    
    // 关闭虚拟机
    await execAsync(
      `VBoxManage controlvm "${this.vmName}" acpipowerbutton`
    );
    
    console.log('Android虚拟机已停止');
  }
  
  async checkVMStatus(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('curl -s http://localhost:9978/health');
      return stdout.includes('success');
    } catch {
      return false;
    }
  }
}
```

## 性能优化

### 虚拟机配置优化

```bash
# 增加CPU核心
VBoxManage modifyvm "Spider-Android" --cpus 4

# 增加内存
VBoxManage modifyvm "Spider-Android" --memory 4096

# 启用3D加速
VBoxManage modifyvm "Spider-Android" --accelerate3d on

# 优化网络
VBoxManage modifyvm "Spider-Android" --nic1 bridged
```

### Android系统优化

在Android中：
1. 设置 → 开发者选项 → 窗口动画缩放：关闭
2. 设置 → 开发者选项 → 过渡动画缩放：关闭
3. 设置 → 开发者选项 → 动画程序时长缩放：关闭
4. 设置 → 显示 → 休眠：30分钟

## 故障排查

### 虚拟机无法启动

检查虚拟化是否启用：
- 重启电脑进入BIOS
- 找到 Virtualization Technology (VT-x/AMD-V)
- 设置为 Enabled

### ADB连接失败

```bash
# 重启ADB服务
adb kill-server
adb start-server
adb connect localhost:5555
```

### Spider服务无响应

```bash
# 重启Spider服务
adb shell am force-stop com.tvbox.spiderserver
adb shell am startservice -n com.tvbox.spiderserver/.SpiderHttpService
```

## 备选方案

### docker-android（仅Windows 11）

如果你有Windows 11且启用了WSL2，可以使用docker-android：

```yaml
# docker-compose.yml
version: '3.8'
services:
  android:
    image: budtmo/docker-android:emulator_11.0
    container_name: spider-android
    privileged: true
    ports:
      - "6080:6080"  # Web VNC
      - "5555:5555"  # ADB
      - "9978:9978"  # Spider HTTP
    environment:
      - DEVICE=Samsung Galaxy S10
      - EMULATOR_GPU=swiftshader_indirect
    restart: unless-stopped
```

要求：
- Windows 11
- WSL2已启用
- 嵌套虚拟化支持

## 总结

Android-x86 + VirtualBox是Windows用户最通用、最稳定的方案：

- ✅ 支持所有Windows版本
- ✅ 无需复杂配置
- ✅ 性能优秀
- ✅ 用户友好

通过自动化脚本，用户只需运行一个批处理文件即可完成所有安装和配置。