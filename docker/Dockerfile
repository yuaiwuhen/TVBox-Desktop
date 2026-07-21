# 基于redroid-headless镜像
# 使用国内镜像加速
FROM docker.m.daocloud.io/redroid/redroid:15.0.0_64only-latest

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