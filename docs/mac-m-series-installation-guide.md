# Mac M系列安装引导文档

## 重要说明

**Mac M系列芯片（M1/M2/M3/M4）无法使用Docker Android方案**

### 技术限制

- ❌ **缺少KVM支持**：macOS不提供Linux的KVM虚拟化接口
- ❌ **内核不兼容**：macOS内核不支持Android必需的binder/ashmem模块
- ❌ **虚拟化框架差异**：macOS虚拟化框架不提供Android需要的硬件抽象层

### 解决方案

Mac M系列芯片用户应使用 **Android Studio Emulator**，这是唯一可行的方案。

## 为什么Android Studio Emulator最佳？

### 性能优势

| 特性 | Mac M系列 | Mac Intel | Windows | Linux |
|------|-----------|-----------|---------|-------|
| **架构匹配** | ✅ ARM原生 | ❌ x86翻译 | ❌ x86翻译 | ✅ ARM原生 |
| **启动速度** | ✅ 3-5秒 | ⚠️ 10-15秒 | ⚠️ 30-60秒 | ✅ 10-20秒 |
| **性能效率** | ✅ 95-100% | ⚠️ 60-70% | ⚠️ 60-70% | ✅ 90-100% |
| **GPU加速** | ✅ M系列GPU | ⚠️ Intel GPU | ⚠️ 翻译层 | ✅ 原生GPU |

### 关键优势

```
Mac M系列（ARM架构）
    ↓
Android Studio Emulator
    ↓
ARM系统镜像（无需翻译）
    ↓
接近原生性能
```

**M系列芯片天然适合Android开发**：
- ✅ 无需Rosetta 2翻译
- ✅ 直接运行ARM指令
- ✅ M系列GPU硬件加速
- ✅ 官方支持，稳定可靠

## 安装步骤

### 步骤1：下载Android Studio

**下载地址**：https://developer.android.com/studio

**选择版本**：
- 推荐下载：**Android Studio Meerkat (最新稳定版)**
- 文件大小：约1.1GB
- 系统要求：macOS 10.14（Mojave）或更高版本

**下载说明**：
```bash
# 使用国内镜像加速（可选）
# 访问：https://developer.android.google.cn/studio
```

### 步骤2：安装Android Studio

1. **打开下载的DMG文件**
2. **拖动Android Studio到Applications文件夹**
3. **启动Android Studio**（首次启动需要一些配置）

**首次启动配置**：
```
启动向导：
├── 选择"Do not import settings"（全新安装）
├── 选择"Standard"安装类型
├── 选择"Darcula"主题（深色主题）
├── 等待组件下载完成（约5-10分钟）
└── 完成安装
```

### 步骤3：配置AVD虚拟设备

#### 3.1 打开AVD管理器

```
Android Studio界面：
├── 点击右上角"Device Manager"图标
└── 或使用菜单：Tools → Device Manager
```

#### 3.2 创建虚拟设备

1. **点击"Create Device"按钮**
2. **选择设备型号**：
   - 推荐选择：**Pixel 6**（标准尺寸，适合测试）
   - 或选择：**Pixel 4 XL**（大屏幕）

3. **选择系统镜像**：
   - 推荐选择：**Android 13.0 (Tiramisu) - API Level 33**
   - 选择：**arm64-v8a架构**（重要！这是M系列优化的关键）
   - 下载镜像：点击"Download"链接

4. **配置虚拟设备**：
   ```
   AVD Name: TVBox_Device（自定义名称）
   Orientation: Portrait（竖屏）或Landscape（横屏）
   Advanced Settings:
   ├── RAM: 4096 MB（推荐4GB）
   ├── VM heap: 512 MB
   ├── Graphics: Software - GLES 2.0（或Automatic）
   └── Network: Default
   ```

5. **点击"Finish"完成创建**

### 步骤4：启动虚拟设备

#### 4.1 启动方法

```
方法1：在Device Manager中
├── 找到创建的虚拟设备
├── 点击右侧的"▶"播放按钮
└── 等待虚拟设备启动（约3-5秒）

方法2：使用命令行
├── 打开Terminal
├── 进入Android SDK目录: ~/Library/Android/sdk
└── 运行: ./emulator -avd TVBox_Device
```

#### 4.2 等待启动完成

```
启动流程：
├── 显示Android启动画面（约2-3秒）
├── 显示锁屏界面
├── 滑动解锁
└── 进入桌面 → 设备就绪
```

### 步骤5：安装Spider APK

#### 5.1 准备APK文件

**方式1：使用项目已编译的APK**

```bash
# APK路径
TVBox-Pc-Docker/docker/android-app/app/build/outputs/apk/debug/app-debug.apk
```

**方式2：自己编译APK**

```bash
# 进入项目目录
cd TVBox-Pc-Docker/docker/android-app

# 编译APK（需要安装Android SDK）
./gradlew assembleDebug

# APK输出路径
app/build/outputs/apk/debug/app-debug.apk
```

#### 5.2 安装APK

**方法1：拖拽安装**
```
1. 将app-debug.apk拖拽到虚拟设备窗口
2. 等待安装完成
3. 点击"Open"打开应用
```

**方法2：使用adb命令**
```bash
# 检查设备连接
~/Library/Android/sdk/platform-tools/adb devices

# 安装APK
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk

# 启动Spider服务
~/Library/Android/sdk/platform-tools/adb shell am startservice com.tvbox.spiderserver/.SpiderHttpService
```

### 步骤6：验证安装

#### 6.1 测试Spider API

```bash
# 测试健康检查接口
curl http://localhost:9978/health

# 预期返回
{
  "success": true,
  "data": {
    "status": "ok",
    "server": "SpiderHTTPServer",
    "version": "1.0.0"
  }
}
```

#### 6.2 测试完整功能

```bash
# 测试加载Spider JAR
curl -X POST http://localhost:9978/spider/load \
  -H "Content-Type: application/json" \
  -d '{"jarUrl": "https://example.com/spider.jar"}'
```

## 常见问题

### Q1: Android Studio启动很慢？

**解决方案**：
1. 在Preferences中增加内存分配：
   ```
   Android Studio → Preferences → Appearance & Behavior → System Settings → Memory Settings
   ├── IDE heap: 2048 MB
   └── Off-heap: 1024 MB
   ```

2. 禁用不必要的插件：
   ```
   Preferences → Plugins
   ├── 禁用: Markdown、CSV、记录工具等
   └── 保留: Android、Kotlin、Gradle
   ```

### Q2: 虚拟设备启动失败？

**可能原因**：
- 系统镜像下载不完整 → 重新下载镜像
- 内存不足 → 关闭其他应用，释放内存
- 权限问题 → 重启Android Studio

**解决步骤**：
```bash
# 1. 清除AVD数据
rm -rf ~/.android/avd/TVBox_Device.avd

# 2. 重新创建虚拟设备
# 在Android Studio中重新创建
```

### Q3: 找不到adb命令？

**解决方案**：
```bash
# 添加Android SDK到PATH
echo 'export PATH=$PATH:$HOME/Library/Android/sdk/platform-tools' >> ~/.zshrc
echo 'export PATH=$PATH:$HOME/Library/Android/sdk/tools' >> ~/.zshrc

# 重新加载配置
source ~/.zshrc

# 验证
adb version
```

### Q4: Spider API无法连接？

**检查清单**：
```bash
# 1. 检查虚拟设备是否运行
adb devices

# 2. 检查Spider服务是否启动
adb shell ps | grep spiderserver

# 3. 检查端口是否监听
adb shell netstat -an | grep 9978

# 4. 重启Spider服务
adb shell am force-stop com.tvbox.spiderserver
adb shell am startservice com.tvbox.spiderserver/.SpiderHttpService
```

### Q5: 虚拟设备占用内存过多？

**优化建议**：
1. 减少虚拟设备内存：
   ```
   Device Manager → 编辑设备 → Show Advanced Settings
   ├── RAM: 2048 MB（降低到2GB）
   └── VM heap: 256 MB
   ```

2. 启用快速启动：
   ```
   虚拟设备设置 → Enable Device Frame → 取消勾选
   虚拟设备设置 → Boot option → Cold boot
   ```

## 性能优化建议

### 1. 使用ARM系统镜像（重要）

```
选择镜像时，必须选择：
✅ arm64-v8a (ARM架构) ← 推荐M系列使用
❌ x86_64 (x86架构) ← 需要翻译，性能差
```

### 2. 启用硬件加速

```
虚拟设备设置 → Graphics:
✅ Hardware - GLES 2.0 ← 使用M系列GPU
⚠️ Software - GLES 2.0 ← 备选方案
```

### 3. 网络优化

```
虚拟设备设置 → Network:
✅ Default ← 使用默认NAT
```

## 自动化脚本（可选）

### 快速启动脚本

```bash
#!/bin/bash
# quick-start.sh - Mac M系列快速启动脚本

echo "启动Android模拟器..."

# 启动虚拟设备
~/Library/Android/sdk/emulator/emulator -avd TVBox_Device -no-snapshot-load &

# 等待设备启动
echo "等待设备启动..."
sleep 10

# 安装Spider APK（如果未安装）
echo "检查Spider APK..."
if ! ~/Library/Android/sdk/platform-tools/adb shell pm list packages | grep -q "com.tvbox.spiderserver"; then
    echo "安装Spider APK..."
    ~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
fi

# 启动Spider服务
echo "启动Spider服务..."
~/Library/Android/sdk/platform-tools/adb shell am startservice com.tvbox.spiderserver/.SpiderHttpService

# 等待服务启动
sleep 3

# 测试API
echo "测试Spider API..."
curl -s http://localhost:9978/health

echo ""
echo "✅ Spider服务已启动"
echo "API地址: http://localhost:9978"
```

### 保存为快捷方式

```bash
# 添加别名
echo 'alias start-spider="~/TVBox-Pc-Docker/scripts/quick-start-mac.sh"' >> ~/.zshrc
source ~/.zshrc

# 使用方法
start-spider
```

## 性能对比总结

### Mac M系列 vs 其他平台

| 指标 | Mac M系列 | Windows / Linux Docker |
|------|-----------|-------------------------|
| **启动时间** | ⭐⭐⭐⭐⭐ 3-5秒 | ⭐⭐⭐ 10-20秒 |
| **运行性能** | ⭐⭐⭐⭐⭐ 95-100% | ⭐⭐⭐⭐⭐ 90-100% |
| **内存占用** | ⭐⭐⭐⭐ 2-4GB | ⭐⭐⭐⭐ 2-4GB |
| **自动化程度** | ⭐⭐ 手动安装 | ⭐⭐⭐⭐⭐ 完全自动 |
| **用户体验** | ⭐⭐⭐⭐ 需要引导 | ⭐⭐⭐⭐⭐ 一键安装 |

## 下一步操作

安装完成后，你可以：

1. **启动TVBox应用**：应用会自动检测已启动的模拟器
2. **开始使用Spider功能**：应用会自动连接到localhost:9978
3. **享受高性能体验**：M系列芯片提供最佳性能

## 需要帮助？

如果遇到问题，请检查：

1. **日志文件**：`~/Library/Android/sdk/emulator/emulator.log`
2. **ADB日志**：`adb logcat | grep SpiderHttpServer`
3. **官方文档**：https://developer.android.com/studio/run/emulator

---

**最后更新**：2026-07-21  
**适用版本**：Android Studio Meerkat (最新稳定版)  
**系统要求**：macOS 10.14+ | Mac M1/M2/M3/M4芯片