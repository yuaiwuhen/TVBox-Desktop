#!/bin/bash

# 等待Android系统启动完成
echo "Waiting for Android system to boot..."
sleep 10

# 启动Spider服务应用
# 注意：实际部署时需要先通过ADB安装APK
# adb install /data/app/spider-server-debug.apk
# adb shell am start -n com.tvbox.spiderserver/.MainActivity

# 如果应用已内置在镜像中，直接启动
if [ -f "/data/app/spider-server-debug.apk" ]; then
    # 模拟启动应用的逻辑
    # 实际上在redroid中，需要通过init.rc或system_server启动应用
    echo "Starting Spider Server application..."
fi

# 保持容器运行
tail -f /dev/null