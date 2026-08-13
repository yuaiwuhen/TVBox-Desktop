# Spider HTTP服务编译指南

## 方案1：使用Docker编译（推荐）

### 1. 构建编译镜像
```bash
cd docker/android-app
docker build -f Dockerfile.build -t spider-builder .
```

### 2. 编译APK
```bash
docker run --rm -v ${PWD}:/app spider-builder
```

### 3. APK位置
编译完成后，APK位于：`build/outputs/apk/debug/app-debug.apk`

## 方案2：安装Android SDK

### Windows安装步骤

1. **安装Android Studio**
   - 下载：https://developer.android.com/studio
   - 安装Android Studio

2. **配置环境变量**
   ```powershell
   # 添加到系统环境变量
   ANDROID_HOME=C:\Users\<用户名>\AppData\Local\Android\Sdk
   Path添加：;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\tools
   ```

3. **安装SDK组件**
   打开Android Studio → Settings → Appearance & Behavior → System Settings → Android SDK
   - Android SDK Platform 34
   - Android SDK Build-Tools 34
   - Android SDK Command-line Tools

4. **编译项目**
   ```bash
   cd docker/android-app
   gradlew assembleDebug
   ```

## 方案3：使用在线编译服务

如果以上方案都不可行，可以使用GitHub Actions或其他CI/CD服务编译APK。

## 下一步

编译成功后：
1. 复制APK到容器：`docker cp app-debug.apk tvbox-spider:/data/`
2. 安装APK：`docker exec -it tvbox-spider adb install /data/app-debug.apk`
3. 启动服务：`docker exec -it tvbox-spider am start -n com.tvbox.spiderserver/.SpiderHttpService`