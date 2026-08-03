# csp_Wwys 播放失败修复（|lzm3u8 后缀回退）

## 问题
- 源: `csp_Wwys` (🌾️┃农民┃影视) in `http://肥猫.net/tv`
- 现象: `playerContent` 返回 `{"url":"","parse":0,"jx":0}` （URL 为空），导致播放失败 "视频资源已失效"
- 输入 id 格式: `https://vip.123pan.cn/.../xxx.m3u8|lzm3u8`

## 根本原因
1. 爬虫 `Wwys.java` 的 `playerContent` 方法流程：
   - 按 `|` 分割 id: `[url, lzm3u8]`
   - 拼接 `https://vip.wwgz.cn:5200/player/lzm3u8.js?url=<URL>`
   - fetch 该 JS（返回含 iframe 的 HTML）
   - 用 regex 提取 iframe URL → fetch iframe 页面
   - 用 regex 从 iframe 页面提取最终 m3u8 URL
2. 上游解析页 `https://api.wwgz.cn:520/player/?url=...` 的 HTML 结构已变化
3. JAR 内的 regex（加密字符串）无法匹配新格式，返回空 URL

## 解决方案
在 [src/core/JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/JarSpider.ts#L293-L337) 的 `playerContent` 方法添加后处理回退逻辑：

```typescript
async playerContent(flag, id, vipFlags) {
  const raw = await this.callMethod('playerContent', [flag, id, vipFlags]);
  try {
    const parsed = JSON.parse(raw);
    const url = parsed?.url || '';
    // 如果 spider 返回空 URL 但 id 含 |suffix，且 URL 是已知媒体格式
    if (!url && id && id.includes('|')) {
      const [realUrl, suffix] = id.split('|');
      if (/\.(m3u8|mp4|flv|ts)(\?|$)/i.test(realUrl) &&
          /^(lz)?m3u8$|^(lz)?mp4$|^flv$/i.test(suffix || '')) {
        // 直接用 id 中的 URL 作为播放地址
        const fallback = {
          ...parsed,
          url: realUrl,
          parse: 0,
          jx: 0,
          header: parsed.header || JSON.stringify({
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-A037U) ... uacq',
          }),
        };
        return JSON.stringify(fallback);
      }
    }
  } catch { /* return raw */ }
  return raw;
}
```

## 关键发现
- `https://vip.wwgz.cn:5200/player/lzm3u8.js?url=...` 返回 JS，其中 iframe 指向 `https://api.wwgz.cn:520/player/?url=...`
- iframe 页面包含 `var config = {"url": "<原始m3u8 URL>"}`，即原始 m3u8 URL
- 原始 m3u8 URL `https://vip.123pan.cn/...m3u8` 直接传给播放器即可（hls.js 会跟随 302 重定向）
- 浏览器/Chromium 网络栈能正确处理非 ASCII 字符的 Location 头

## 验证
- `currentPlayUrl`: `https://vip.123pan.cn/1853039965/202510/依然的喜事/依然的喜事EP01.m3u8`
- `playError`: "" （无错误）
- 16 集全部可解析

## 通用性
该回退逻辑对所有 `csp_*` 爬虫通用，不限于 `csp_Wwys`：
- 任何 spider 返回空 URL 但 id 包含 `|lzm3u8`/`|lzmp4`/`|flv` 后缀时触发
- 仅当 URL 后缀是 `.m3u8`/`.mp4`/`.flv`/`.ts` 时生效，避免误匹配

## 测试脚本
- [tools/e2e/test-wwys-play.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-wwys-play.cjs)

## 提交
- `68e424c fix(JarSpider): add playerContent fallback for |lzm3u8 suffix when spider returns empty url`
