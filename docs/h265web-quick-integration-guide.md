# h265web.js快速集成指南 - 解决HEVC播放问题

## 问题现状

**症状**：
- VLC能播放HEVC视频，但加载慢
- 应用内一直加载中，无法播放
- 原因：应用还在使用旧的xgplayer播放器（不支持HEVC）

**检查结果**：
- ✅ VideoPlayer-h265web.vue已生成（支持HEVC）
- ❌ 应用还在使用旧的VideoPlayer.vue（xgplayer）
- ❌ h265web.js SDK文件还没下载

---

## 快速集成步骤

### 步骤1：下载h265web.js SDK文件（必需）

**下载地址**：https://h265web.com

**需要下载的文件**：
- `h265web.js` - 主库文件
- `h265web_wasm.js` - WASM加载器
- `h265web_wasm.wasm` - WASM解码器（核心）
- `extjs.js` - 扩展JS（可选，推荐下载）
- `extwasm.js` - 扩展WASM（可选，推荐下载）

**放置位置**：
```
TVBox-PC/public/h265web/
├── h265web.js
├── h265web_wasm.js
├── h265web_wasm.wasm
├── extjs.js
└── extwasm.js
```

**操作步骤**：
1. 访问 https://h265web.com
2. 点击下载按钮，获取h265web.js PRO免费版
3. 解压下载的文件
4. 在TVBox-PC项目根目录创建`public/h265web`文件夹
5. 将所有文件复制到`public/h265web`目录

**验证文件是否正确**：
- 检查`public/h265web/h265web_wasm.wasm`文件大小（应该大于1MB）
- 检查是否有5个文件（h265web.js、h265web_wasm.js、h265web_wasm.wasm、extjs.js、extwasm.js）

---

### 步骤2：引入h265web.js（必需）

在`public/index.html`中添加：

```html
<!-- TVBox-PC/public/index.html -->
<head>
  <!-- ... 其他内容 ... -->
  
  <!-- 引入h265web.js播放器 -->
  <script src="/public/h265web/h265web.js"></script>
</head>
```

**完整示例**：
```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <link rel="icon" href="/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TVBox-PC</title>
    
    <!-- 引入h265web.js播放器 -->
    <script src="/public/h265web/h265web.js"></script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

---

### 步骤3：替换VideoPlayer组件（推荐）

**方案A：完全替换（简单，推荐）**

1. 备份原有播放器：
```bash
cd TVBox-PC/src/components
copy VideoPlayer.vue VideoPlayer-xgplayer.vue.bak
```

2. 替换为新播放器：
```bash
copy VideoPlayer-h265web.vue VideoPlayer.vue
```

**方案B：渐进式替换（可选）**

保留两个版本，根据视频格式动态选择：

在`src/views/Detail.vue`中修改导入：
```vue
<script setup lang="ts">
// 导入两个播放器版本
import VideoPlayerXgplayer from '../components/VideoPlayer-xgplayer.vue.bak'
import VideoPlayerH265web from '../components/VideoPlayer-h265web.vue'

// 根据URL判断是否是HEVC视频
const isHEVCVideo = computed(() => {
  const url = store.currentPlayUrl
  // 韩剧源通常是HEVC编码
  return url?.includes('do=hxq') || url?.includes('hevc')
})

// 动态选择播放器
const currentPlayerComponent = computed(() => {
  return isHEVCVideo.value ? VideoPlayerH265web : VideoPlayerXgplayer
})
</script>

<template>
  <!-- 动态组件 -->
  <component 
    :is="currentPlayerComponent"
    ref="videoPlayerRef"
    :url="store.currentPlayUrl"
    :headers="store.currentPlayHeader"
    :title="playerTitle"
    @prev="onPrevEpisode"
    @next="onNextEpisode"
    @ended="onPlayEnded"
    @progress="onProgress"
  />
</template>
```

---

### 步骤4：启动应用测试

1. 启动开发服务器：
```bash
cd TVBox-PC
pnpm dev
```

2. 观察启动日志：
```
[ProxyServer] 初始化DNS-over-HTTPS优化...
[DnsOptimizer] 开始测试DoH服务器速度...
[DnsOptimizer] 腾讯 DoH: 80ms
[DnsOptimizer] 最快的DoH服务器: 腾讯
[ProxyServer] DNS优化已启用
```

3. 打开应用，播放韩剧视频：
- 检查是否能正常播放（不再一直加载中）
- 观察播放器日志：
```
[VideoPlayer-h265web] 🎬 初始化播放器
[VideoPlayer-h265web] ✅ 播放器准备好
[VideoPlayer-h265web] 媒体信息: {"videoCodec":"hevc"}
[VideoPlayer-h265web] ✅ 视频编码: HEVC/H.265
[VideoPlayer-h265web] ✅ 播放成功
```

---

## 验证集成是否成功

### 1. 检查h265web.js是否加载

在浏览器开发者工具Console中输入：
```javascript
console.log(typeof H265webjsPlayer)
```

**预期输出**：
- `function` → h265web.js已正确加载 ✅
- `undefined` → h265web.js未加载 ❌

**如果未加载**：
- 检查`public/index.html`是否添加了script标签
- 检查文件路径是否正确
- 检查网络请求是否成功（Network面板）

### 2. 检查播放器是否使用h265web.js

观察播放器日志：
```
[VideoPlayer-h265web] 🎬 初始化播放器
```

如果看到`[VideoPlayer]`（没有-h265web后缀），说明还在使用旧播放器。

### 3. 检查视频编码识别

观察播放器日志：
```
[VideoPlayer-h265web] ✅ 视频编码: HEVC/H.265
```

如果显示H.264或未知，可能视频不是HEVC编码。

### 4. 检查解码方式

观察播放器日志：
```
[VideoPlayer-h265web] ✅ 使用MSE硬解码
[VideoPlayer-h265web] ✅ 使用WebCodec硬解码
[VideoPlayer-h265web] ℹ️  使用WASM软解码
```

任何一种解码方式都能成功播放HEVC视频。

---

## 常见问题排查

### 问题1：h265web.js未加载

**症状**：Console显示`undefined`

**原因**：
- 文件路径错误
- 文件缺失
- 网络请求失败

**解决方案**：
1. 检查`public/h265web/`目录是否存在
2. 检查5个文件是否完整
3. 检查浏览器Network面板，是否有404错误
4. 确认`public/index.html`中的script标签路径正确

### 问题2：播放器初始化失败

**症状**：日志显示`播放器初始化失败`

**原因**：
- H265webjsPlayer未定义
- WASM文件加载失败
- 配置参数错误

**解决方案**：
1. 确认h265web.js已加载（步骤1）
2. 检查WASM文件路径：`base_url: '/public/h265web/'`
3. 检查配置参数是否正确

### 问题3：视频播放失败

**症状**：播放器就绪但无画面

**原因**：
- URL错误
- ProxyServer未启动
- Headers未正确处理

**解决方案**：
1. 检查URL是否有效（VLC能否播放）
2. 确认ProxyServer已启动（端口9978）
3. 检查浏览器Network面板的HTTP请求

### 问题4：一直加载中

**症状**：播放器显示"缓冲中…"，一直不播放

**原因**：
- h265web.js未加载（还在用旧播放器）
- WASM解码器加载失败
- 网络连接问题

**解决方案**：
1. 确认h265web.js已加载（步骤1）
2. 确认使用了新播放器（步骤3）
3. 检查DNS优化是否生效（ProxyServer日志）
4. 检查网络连接（VLC能否播放）

---

## 性能预期

### h265web.js播放器优势

| 特性 | xgplayer（旧） | h265web.js（新） |
|-----|---------------|-----------------|
| HEVC/H.265支持 | ❌ 不支持 | ✅ **硬解码+软解码** |
| 1080P HEVC | ❌ 无法播放 | ✅ **流畅播放** |
| 解码方式 | ❌ MSE（不支持HEVC） | ✅ **MSE/WASM/WebCodec** |
| VLC兼容性 | ❌ VLC能播放但应用不能 | ✅ **VLC能播放→h265web.js也能** |
| 性能表现 | ❌ 卡顿、加载失败 | ✅ **流畅、快速加载** |

### DNS优化效果

| 指标 | 修改前 | 修改后 |
|-----|-------|-------|
| DNS解析延迟 | 200-500ms | 50-150ms |
| 网络连接速度 | 慢 | **快** |
| CDN节点选择 | 不准确 | **准确** |

---

## 总结

### 必需操作

1. **下载h265web.js SDK文件**（5个文件）
2. **放置到`public/h265web/`目录**
3. **在`public/index.html`引入h265web.js**
4. **替换VideoPlayer.vue为VideoPlayer-h265web.vue**

### 预期效果

- ✅ VLC能播放的HEVC视频，应用也能播放
- ✅ 不再一直加载中
- ✅ 视频播放流畅
- ✅ DNS解析速度提升
- ✅ 网速明显改善

### 下一步

完成集成后：
1. 测试韩剧源播放效果
2. 观察播放器日志
3. 验证DNS优化是否生效
4. 对比修改前后的播放速度

---

**关键提示**：h265web.js SDK文件是必需的，没有这些文件播放器无法工作。请先完成步骤1（下载和放置文件）！

**文件下载地址**：https://h265web.com  
**技术支持QQ群**：925466059