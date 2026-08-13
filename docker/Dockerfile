# 基于redroid-headless镜像
# 使用社区维护的 codysk/redroid:12_houdini 镜像，该镜像预装了 libhoudini
# 原生桥接库，用于将 arm64/arm 代码翻译为 x86_64。
# 官方 redroid 镜像虽设置了 native.bridge 属性，但实际不包含库文件。
FROM ghcr.io/codysk/redroid:12_houdini

# 设置环境变量
ENV ANDROID_HOME=/system \
    SPIDER_SERVER_PORT=9978 \
    REDROID_GPU_MODE=guest

# 暴露端口
EXPOSE 9978

# 数据卷
VOLUME ["/data"]

# 启动命令（redroid默认会启动Android系统）
# Spider服务需要在Android启动后手动安装和启动
# 或者通过adb命令远程安装
