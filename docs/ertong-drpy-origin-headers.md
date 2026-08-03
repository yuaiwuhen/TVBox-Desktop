# 儿童 (兔小贝) drpy 源首页为空修复

## 问题

`肥猫.net/tv` 配置中的 `儿童` 源（drpy_js_儿童，api 指向兔小贝 drpy 脚本）：
- 首页分类可以加载，但视频列表为空 `{"list":[]}`
- `homeVideoContent()` 和 `categoryContent()` 都返回空列表

## 根本原因（三层）

### 1. 首页改版，原选择器失效
`tuxiaobei.com` 首页改版后，原 drpy 规则中的 `.pic-list.list-box .items` 选择器
已不存在。`homeVodParse` 用旧选择器 `_pdfa(html, p0)` 找不到任何 item。

### 2. API 返回 JSONP 而非 JSON
改用 `/list/mip-data?typeId=2&page=1&callback=` API（兔小贝的儿歌分类接口）：
- 该 API 必须带 `callback=` 参数（不带则返回空响应）
- 返回格式是 JSONP：`({"status":0,"data":{"items":[...]}})`，前后带括号
- drpy2 的 `json:` 解析器调用 `JSON.parse`，无法处理前缀 `(` 和后缀 `)`

### 3. 桌面 User-Agent 被 tuxiaobei.com 拒绝（404）
即使修正了选择器/解析逻辑，请求 `tuxiaobei.com` API 时仍返回 `404 Not Found`：

| 请求方式 | User-Agent | 结果 |
|---------|-----------|------|
| Node.js axios | Mobile UA | 200 + 30 items |
| Node.js https  | Mobile UA | 200 + 30 items |
| Node.js https  | Windows desktop UA | **404** |
| Electron XHR  | 桌面 UA（默认） | **404** |
| Electron XHR  | setRequestHeader('User-Agent', mobile) | **404**（被忽略） |
| Electron IPC js:fetchModule | Windows desktop UA（硬编码） | **404** |

**关键**：浏览器将 `User-Agent` 列为 forbidden header，`XMLHttpRequest.setRequestHeader()`
会静默丢弃。Electron 的 XHR 使用页面默认的桌面 UA，无法在 renderer 进程内覆盖。

## 修复

### 1. 在主进程注入 per-origin 请求头

`electron/main.ts` 新增：
- `spiderOriginHeaders: Map<string, Record<string, string>>` 保存 origin → headers 映射
- IPC 处理器 `js:registerSpiderOriginHeaders(origin, headers)` 注册映射
- 修改 `onBeforeSendHeaders`：除了 `videoHeaders`，也检查 `spiderOriginHeaders`，
  命中则注入 headers 并剥离 `Sec-Fetch-*` / `Sec-Ch-Ua` 等浏览器泄漏头
- 修改 `onHeadersReceived`：命中 origin 时附加 `Access-Control-Allow-Origin: *` 等
  CORS 头，让 renderer 的 XHR 能读取响应

### 2. drpy 规则补丁机制扩展

`src/core/JsSpider.ts` 的 `DRPY_RULE_PATCHES` 新增可选字段 `originHeaders`：
```ts
{
  儿童: {
    reason: '...',
    fields: { homeUrl: '...', 推荐: '*', 一级: 'js:...' },
    originHeaders: {
      'https://www.tuxiaobei.com': {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) ...',
        'Referer': 'https://www.tuxiaobei.com/',
      },
    },
  },
}
```

`applyDrpyRulePatch()` 应用规则后，遍历 `originHeaders` 并通过
`electronIPC.invoke('js:registerSpiderOriginHeaders', origin, headers)` 注册。

### 3. 一级规则改用 `js:` 前缀手动解析 JSONP

```js
一级: 'js:var d=[];var resp=request(input);
       var data=JSON.parse(resp.replace(/^\(/,"").replace(/\);?\s*$/,""));
       data.data.items.forEach(function(it){
         d.push({title:it.name,img:it.image,url:String(it.video_id),desc:it.duration_string})
       });
       VODS=d;input=d'
```

要点：
- `resp.replace(/^\(/,"").replace(/\);?\s*$/,"")` 剥离 JSONP 的 `()` 包装
- **必须显式设置 `VODS=d`**，不能只设 `input=d`。drpy2 的 `homeVodParse` 和
  `categoryParse` 在 `__hostEval` 后读取的是 `VODS`，不是 `input`
- 同时设 `input=d` 以兼容其他可能读取 `input` 的代码路径

## 测试

```
=== Call homeVideoContent ===
homeVod result: {"list":[{"title":"梦想成真","img":"...","url":"2667","desc":"04:50"}, ...共 30 项]

=== Call categoryContent("2", "1", false, {}) ===
category result: {"page":1,"pagecount":999,"limit":20,"total":999,"list":[...共 30 项]}
```

## 文件变更

- `electron/main.ts`：新增 `spiderOriginHeaders` Map、`js:registerSpiderOriginHeaders`
  IPC 处理器、`onBeforeSendHeaders` / `onHeadersReceived` 注入逻辑
- `src/core/JsSpider.ts`：`DRPY_RULE_PATCHES` 类型扩展 `originHeaders?` 字段；
  `applyDrpyRulePatch` 在应用规则后通过 IPC 注册 origin headers；
  儿童 patch 改用 `js:` 一级规则并显式设置 `VODS`

## 通用性

`originHeaders` 机制是通用的，未来其他 drpy 源如果也遇到桌面 UA 被拒（404/403）
的情况，只需在 `DRPY_RULE_PATCHES` 里加一条 `originHeaders` 即可，无需再改主进程。
