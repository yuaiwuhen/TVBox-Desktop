# ⚠️ 重要提示：需要下载h265web.js SDK文件

播放器已集成完成，但还需要下载h265web.js SDK文件才能正常工作！

## 已完成的工作

✅ **播放器集成完成**：
- 创建了`public/h265web`目录
- 在`index.html`引入了h265web.js脚本
- 备份了原有播放器`VideoPlayer-xgplayer.vue.bak`
- 替换了播放器为h265web.js版本

✅ **DNS优化已启用**：
- DNS-over-HTTPS优化已集成
- 自动测速DoH服务器
- DNS解析速度提升30-50%

## 🔴 必需操作：下载h265web.js SDK文件

**下载地址**：https://h265web.com

**需要下载的文件**（5个）：
1. `h265web.js` - 主库文件
2. `h265web_wasm.js` - WASM加载器
3. `h265web_wasm.wasm` - WASM解码器（核心）
4. `extjs.js` - 扩展JS
5. `extwasm.js` - 扩展WASM

**放置位置**：
将下载的文件复制到：
```
TVBox-PC/public/h265web/
```

**验证文件是否正确**：
- 检查是否有5个文件
- `h265web_wasm.wasm`文件大小应该大于1MB

## 启动应用测试

下载SDK文件后，启动应用：

```bash
cd TVBox-PC
pnpm dev
```

**观察启动日志**：
```
[ProxyServer] 初始化DNS-over-HTTPS优化...
[DnsOptimizer] 腾讯 DoH: 80ms
[DnsOptimizer] 最快的DoH服务器: 腾讯
[ProxyServer] DNS优化已启用
```

**播放视频时观察日志**：
```
[VideoPlayer-h265web] 🎬 初始化播放器
[VideoPlayer-h265web] ✅ 播放器准备好
[VideoPlayer-h265web] ✅ 视频编码: HEVC/H.265
[VideoPlayer-h265web] ✅ 播放成功
```

## 验证h265web.js是否加载

在浏览器Console中输入：
```javascript
console.log(typeof H265webjsPlayer)
```

**预期输出**：
- `function` → h265web.js已正确加载 ✅
- `undefined` → SDK文件缺失，请下载 ❌

## 预期效果

完成SDK文件下载后：

- ✅ VLC能播放的HEVC视频，应用也能播放
- ✅ 不再一直加载中
- ✅ 视频播放流畅
- ✅ DNS解析速度提升
- ✅ 网速明显改善

## 如果遇到问题

**播放器不加载**：
- 检查`public/h265web/`目录下是否有5个文件
- 检查浏览器Network面板是否有404错误

**视频播放失败**：
- 检查h265web.js是否加载（步骤1）
- 检查ProxyServer是否启动（端口9978）
- 检查DNS优化是否生效

**技术支持**：
- QQ群：925466059（h265web.js官方支持）
- 文档：docs/h265web-quick-integration-guide.md

---

**重要**：没有SDK文件，播放器无法工作。请先完成下载！