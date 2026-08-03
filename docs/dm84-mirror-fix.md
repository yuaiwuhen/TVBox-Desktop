# csp_Dm84 首页为空修复

## 问题
- 源: `csp_Dm84` (🤣┃动漫┃巴士) in `http://肥猫.net/tv`
- 现象: 首页返回空 `{"class":[],"list":[]}`，详情页无法获取
- 配置中 `ext` = `https://dm84.net`

## 根本原因
1. `dm84.net` 返回 301 重定向到 `dmbus.cc`
2. `dmbus.cc` 直连返回 522 (Cloudflare origin unreachable)
3. 初次尝试将 ext 覆盖到 `dm84.site`，但 `dm84.site` 是域名停放页（skenzo），
   返回 parking HTML 而非真实站点内容，爬虫解析失败

## 解决方案
将 `ext` 覆盖到 `dmbus.cc`（动漫巴士真实镜像），见 [src/core/SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts#L17-L31):

```typescript
const SITE_EXT_OVERRIDES = [
  {
    api: 'csp_Dm84',
    contains: 'https://dm84.net',
    replaceFrom: 'https://dm84.net',
    replaceTo: 'https://dmbus.cc',
    reason: 'dm84.net 301 -> dmbus.cc (live mirror, requires browser UA through Cloudflare); dm84.site is a parked domain',
  },
];
```

## 关键发现
- `dmbus.cc` 必须用浏览器 UA 才能通过 Cloudflare（curl/默认 UA 返回 522）
- JAR 爬虫内部的 OkHttp 发送的 UA 已足够通过 Cloudflare
- `dm84.site` 实际是域名停放页，`x-redirect: skenzo` 头部表明这点
- 浏览器测试：`curl -H "User-Agent: Mozilla/5.0 ..."` 可获取 200 响应

## 验证
- 首页: 4 个分类 (国漫/日漫/欧美/电影) + 36 个视频
- 详情页: 2 个播放线路 (线路1/线路2) 各 1 集
- 播放: `playerContent` 返回 `https://hhjx.hhplayer.com/index.php?url=...` (parse=1)

## 测试脚本
- [tools/e2e/test-dm84-fix.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-dm84-fix.cjs) - 验证首页和详情页
- [tools/e2e/test-dm84-play.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-dm84-play.cjs) - 验证播放

## 提交
- `bfe19b5 fix(SpiderEngine): use dmbus.cc as Dm84 mirror instead of parked dm84.site`
