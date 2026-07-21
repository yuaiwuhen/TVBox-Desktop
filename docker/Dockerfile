# 基于redroid-headless镜像
FROM redroid/redroid:15.0.0_64only-latest

# 设置环境变量
ENV ANDROID_HOME=/system \
    SPIDER_SERVER_PORT=9978

# 创建工作目录
RUN mkdir -p /data/app /jars /logs

# 复制Android应用APK（需要先编译）
# COPY app/build/outputs/apk/debug/spider-server-debug.apk /data/app/

# 复制启动脚本
COPY start-server.sh /start-server.sh
RUN chmod +x /start-server.sh

# 暴露HTTP API端口
EXPOSE 9978 5555

# 启动服务
CMD ["/start-server.sh"]