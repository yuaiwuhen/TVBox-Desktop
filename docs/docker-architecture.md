# TVBox-PC Docker架构迁移文档

## 概述

本项目已完成从Java本地调用到Docker容器化架构的迁移，使用redroid-headless容器运行Android环境，通过HTTP API提供Spider服务。

## 架构对比

### 旧架构（已废弃）
```
Electron (渲染进程)
    ↓ IPC通信
Electron (主进程)
    ↓ java-bridge
JVM (本地进程)
    ↓ 加载JAR
Spider实现
```

### 新架构（当前）
```
Electron (渲染进程)
    ↓ HTTP请求
Docker容器 (redroid-headless)
    ↓ Android应用
    ↓ NanoHTTPD (HTTP服务器)
    ↓ DexClassLoader
    ↓ Spider JAR
    ↓ 返回JSON数据
```

## 技术栈

### Docker层
- **基础镜像**: redroid/redroid:15.0.0_64only-latest
- **Android版本**: Android 15 (API 34)
- **渲染模式**: headless (SwiftShader软件渲染)

### Android应用层
- **HTTP服务器**: NanoHTTPD 2.3.1
- **JSON解析**: Gson 2.10.1
- **异步处理**: Kotlin Coroutines
- **服务端口**: 9978

### Electron层
- **HTTP客户端**: Axios
- **通信协议**: RESTful JSON API

## 目录结构

```
docker/
├── Dockerfile                 # Docker镜像构建文件
├── docker-compose.yml         # Docker Compose配置
├── start-server.sh           # 容器启动脚本
├── README.md                 # Docker部署文档
└── android-app/              # Android应用源码
    ├── build.gradle
    ├── settings.gradle
    ├── src/main/
    │   ├── AndroidManifest.xml
    │   ├── java/com/tvbox/spiderserver/
    │   │   ├── SpiderApplication.kt
    │   │   ├── MainActivity.kt
    │   │   ├── SpiderHttpService.kt
    │   │   ├── SpiderHttpServer.kt
    │   │   └── SpiderManager.kt
    │   └── res/
    │       ├── layout/activity_main.xml
    │       └── values/
    │           ├── strings.xml
    │           ├── colors.xml
    │           └── themes.xml
    └── gradle/
```

## API接口文档

### 基础URL
```
http://localhost:9978
```

### 接口列表

#### 1. 健康检查
```http
GET /health
```

响应：
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "server": "SpiderHTTPServer",
    "version": "1.0.0"
  }
}
```

#### 2. 加载JAR文件
```http
POST /spider/load
Content-Type: application/json

{
  "jarUrl": "http://example.com/spider.jar",
  "jarPath": "/jars/spider.jar"
}
```

#### 3. 初始化Spider
```http
POST /spider/init
Content-Type: application/json

{
  "key": "spider_key",
  "className": "com.example.Spider",
  "ext": "扩展配置",
  "jarUrl": "http://example.com/spider.jar"
}
```

#### 4. 获取首页内容
```http
POST /spider/homeContent
Content-Type: application/json

{
  "key": "spider_key",
  "filter": true
}
```

#### 5. 获取分类内容
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

#### 6. 获取详情内容
```http
POST /spider/detailContent
Content-Type: application/json

{
  "key": "spider_key",
  "ids": ["movie_id_1", "movie_id_2"]
}
```

#### 7. 获取播放链接
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

#### 8. 搜索内容
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

#### 9. 销毁Spider
```http
POST /spider/destroy
Content-Type: application/json

{
  "key": "spider_key"
}
```

## 部署指南

### 前置要求
- Docker 19.03+
- Docker Compose 1.27+
- Linux内核支持binder和ashmem模块

### 快速开始

1. **构建Android应用**
```bash
cd docker/android-app
./gradlew assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk ../spider-server.apk
```

2. **构建Docker镜像**
```bash
pnpm docker:build
```

3. **启动服务**
```bash
pnpm docker:up
```

4. **验证服务**
```bash
curl http://localhost:9978/health
```

### 内核模块加载

在Linux系统上，需要先加载内核模块：

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux
```

## 开发指南

### 本地开发

1. **启动Docker服务**
```bash
pnpm docker:up
```

2. **启动Electron应用**
```bash
pnpm dev
```

### 调试

- **查看容器日志**: `docker logs tvbox-spider`
- **连接ADB**: `adb connect localhost:5555`
- **查看Android日志**: `adb logcat -s SpiderServer:*`

## 性能优化

### 容器配置

在docker-compose.yml中可以配置：
- 内存限制
- CPU限制
- 磁盘IO限制

### 网络优化

- 使用host网络模式减少NAT开销
- 启用HTTP Keep-Alive
- 增加连接池大小

### 缓存策略

- JAR文件缓存到本地磁盘
- Spider实例缓存到内存
- 使用LRU缓存策略管理实例

## 安全建议

1. 不要在公网暴露9978端口
2. 使用防火墙规则限制访问
3. 定期更新基础镜像
4. 敏感配置使用环境变量
5. 启用HTTPS（生产环境）

## 故障排查

### 常见问题

#### 1. 容器无法启动
**原因**: 内核不支持binder/ashmem
**解决**: 加载内核模块

#### 2. API无响应
**原因**: 端口被占用或服务未启动
**解决**: 检查端口和服务状态

#### 3. JAR加载失败
**原因**: JAR文件不存在或权限不足
**解决**: 检查文件路径和权限

#### 4. 性能低下
**原因**: 内存不足或未启用优化
**解决**: 增加内存限制，启用缓存

## 迁移收益

### 架构优势
1. **容器化**: 环境隔离，易于部署
2. **跨平台**: 统一的运行环境
3. **可扩展**: 支持多实例部署
4. **易维护**: 清晰的架构边界

### 性能优势
1. **内存占用**: 减少~200MB（JVM开销）
2. **启动速度**: 无需等待JVM预热
3. **稳定性**: 容器隔离，崩溃不影响主进程

### 开发优势
1. **简化依赖**: 无需安装JRE
2. **简化打包**: 减少JRE和Dex工具打包
3. **统一管理**: 所有服务在容器中

## 未来规划

1. 支持多个Spider实例并行
2. 添加负载均衡和故障转移
3. 实现健康检查和自动重启
4. 优化内存使用和启动速度
5. 添加Prometheus监控指标

## 参考资料

- [Redroid官方文档](https://github.com/remote-android/redroid-doc)
- [NanoHTTPD GitHub](https://github.com/NanoHttpd/nanohttpd)
- [FongMi/TV项目](https://github.com/FongMi/TV)
- [Docker官方文档](https://docs.docker.com/)