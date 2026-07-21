# TVBox Spider Server - Docker部署方案

## 架构说明

本项目使用Docker容器运行Android环境，通过HTTP API提供Spider服务。

### 技术栈

- **容器**: redroid-headless (基于Android 15)
- **HTTP服务**: NanoHTTPD
- **通信方式**: Electron <-> Docker HTTP API <-> Spider JAR

### 目录结构

```
docker/
├── Dockerfile                 # Docker镜像构建文件
├── docker-compose.yml         # Docker Compose配置
├── start-server.sh           # 容器启动脚本
├── jars/                     # JAR文件目录
├── data/                     # 持久化数据目录
└── android-app/              # Android应用源码
    ├── app/
    ├── gradle/
    └── build.gradle
```

## 快速开始

### 1. 准备环境

确保已安装：
- Docker (19.03+)
- Docker Compose (1.27+)

### 2. 构建Android应用

```bash
cd android-app
./gradlew assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk ../spider-server.apk
```

### 3. 构建Docker镜像

```bash
docker-compose build
```

### 4. 启动服务

```bash
docker-compose up -d
```

### 5. 验证服务

```bash
# 检查容器状态
docker ps

# 检查日志
docker logs tvbox-spider

# 测试API
curl http://localhost:9978/health
```

## API接口文档

### 基础URL

```
http://localhost:9978
```

### 接口列表

#### 1. 加载JAR文件

```http
POST /spider/load
Content-Type: application/json

{
  "jarUrl": "http://example.com/spider.jar",
  "jarPath": "/jars/spider.jar"
}
```

响应：
```json
{
  "success": true,
  "message": "JAR loaded successfully"
}
```

#### 2. 初始化Spider

```http
POST /spider/init
Content-Type: application/json

{
  "key": "spider_key",
  "className": "com.example.Spider",
  "ext": "扩展配置"
}
```

#### 3. 获取首页内容

```http
POST /spider/homeContent
Content-Type: application/json

{
  "key": "spider_key",
  "filter": true
}
```

#### 4. 获取分类内容

```http
POST /spider/categoryContent
Content-Type: application/json

{
  "key": "spider_key",
  "tid": "movie",
  "pg": "1",
  "filter": true,
  "extend": {}
}
```

#### 5. 获取详情内容

```http
POST /spider/detailContent
Content-Type: application/json

{
  "key": "spider_key",
  "ids": ["movie_id_1", "movie_id_2"]
}
```

#### 6. 获取播放链接

```http
POST /spider/playerContent
Content-Type: application/json

{
  "key": "spider_key",
  "flag": "flag_name",
  "id": "video_id",
  "vipFlags": ["vip1", "vip2"]
}
```

#### 7. 搜索内容

```http
POST /spider/searchContent
Content-Type: application/json

{
  "key": "spider_key",
  "keyword": "搜索关键词",
  "quick": false,
  "pg": "1"
}
```

## 调试

### 连接ADB

```bash
adb connect localhost:5555
adb shell
```

### 查看应用日志

```bash
adb logcat -s SpiderServer:*
```

### 重启服务

```bash
docker-compose restart
```

## 常见问题

### 1. 容器无法启动

确保内核支持binder和ashmem：
```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux
```

### 2. API无响应

检查端口是否被占用：
```bash
netstat -tuln | grep 9978
```

### 3. JAR加载失败

检查JAR文件路径和权限：
```bash
docker exec -it tvbox-spider ls -la /jars/
```

## 性能优化

1. **内存限制**: 在docker-compose.yml中添加内存限制
2. **日志轮转**: 配置Docker日志驱动
3. **健康检查**: 添加HEALTHCHECK指令

## 安全建议

1. 不要在公网暴露9978端口
2. 使用防火墙规则限制访问
3. 定期更新基础镜像
4. 敏感配置使用环境变量

## 参考资料

- [Redroid官方文档](https://github.com/remote-android/redroid-doc)
- [NanoHTTPD GitHub](https://github.com/NanoHttpd/nanohttpd)
- [FongMi/TV项目](https://github.com/FongMi/TV)