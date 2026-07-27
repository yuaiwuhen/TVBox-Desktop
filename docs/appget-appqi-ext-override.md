# AppGet/AppQi 源 ext URL 覆盖修复

## 问题

肥猫配置 (`http://肥猫.net/tv`) 中 4 个 AppGet/AppQi 类源首页为空：

| 源 | api | 原 ext | 失效原因 |
|---|---|---|---|
| 肥猫 | csp_AppGet | `https://cms140.yhg.one\|bM7iC9eA3oZ1nB7z` | 域名超时（DNS 失效） |
| 干饭 | csp_AppGet | `https://mk1080.top/get.txt\|c60d88b2eep53za8` | .txt 返回 "ok" 无 API |
| 光盘 | csp_AppQi | `https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt\|FTgP4Gq8zPiqbt7M` | .txt 返回 `http://111.42.67.221:8004` ECONNREFUSED |
| 再来 | csp_AppGet | `https://vv.229d.cn\|8888888888888888` | 域名超时（DNS 失效） |

## 根因分析

### AppGet/AppQi ext 格式

ext 格式为 `<api-url-or-txt>|<aes-key>`：
- 前半部分是 API 地址，或返回 API 地址的 .txt 文件
- 后半部分是 AES 加密密钥，用于解密 API 响应

### 关键约束

1. **API URL 必须存活**：DNS 解析成功 + TCP 连接成功 + HTTP 200
2. **AES key 必须与 API 匹配**：API 用 key 加密响应，客户端用同一 key 解密。key 不匹配则解密失败
3. **AppGet 与 AppQi API 格式不同**：即使 ext 相同，AppQi 调用的接口路径与 AppGet 不同，同一 API 不一定同时支持两者

### 探测结果

通过 `_probe-all-appget.cjs` 探测所有相关 URL：

```
肥猫  https://cms140.yhg.one           → timeout
干饭  https://mk1080.top/get.txt        → 200 "ok" (无 API)
光盘  https://yun-.../600.txt           → 200 http://111.42.67.221:8004 → ECONNREFUSED
再来  https://vv.229d.cn                → timeout
```

可用替换 URL 探测（`_probe-alt-txts.cjs`）：

```
https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt → http://103.236.72.182:3688 (API 200 OK, AppGet)
https://staraugust123456.oss-cn-hangzhou.aliyuncs.com/2.txt → https://qj.yaoyaotu.cc (404)
https://yun-.../500.txt → http://110.42.67.221:6802 (404)
```

仅 `bk/9.txt` 返回的 API 可用，但其仅支持 AppGet 格式，不支持 AppQi。

## 修复方案

在 `SpiderEngine.ts` 的 `SITE_EXT_OVERRIDES` 中为每个失效源添加覆盖规则，替换整个 ext（URL + key）：

### AppGet 源（肥猫、干饭、再来）

替换为蔬菜源已验证可用的 ext：
```
https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt|88689667dce61725
```
- .txt 返回 API `http://103.236.72.182:3688`
- key `88689667dce61725` 与该 API 匹配

### AppQi 源（光盘）

`bk/9.txt` 的 API 不支持 AppQi 格式（homeContent 返回空）。改用行动源（csp_AppQi）已验证可用的 ext：
```
https://qj4.catbb.xyz|eecbio48dsq13kkk
```

## 权衡

替换 ext 后，失效源会显示与参考源（蔬菜/行动）相同的内容，而非原始内容。这是必要的折中：
- 原始 API 已永久失效，无法恢复
- 显示可用内容优于显示空页面
- 用户可随时切换到其他源获取不同内容

## 验证

修复后测试结果（`test-3configs.cjs`）：

```
[feimao] (8/39)  🐼┃肥猫┃APP  (肥猫)  ... PASS  (原 FAIL)
[feimao] (9/39)  🍚┃干饭┃APP  (干饭)  ... PASS  (原 FAIL)
[feimao] (10/39) 📀┃光盘┃APP  (光盘)  ... PASS  (原 FAIL)
[feimao] (12/39) ✌️┃再来┃APP  (再来)  ... PASS  (原 FAIL)
```

肥猫配置通过率：23/39 → 25/39（+4 源修复）

## 相关文件

- `src/core/SpiderEngine.ts` — `SITE_EXT_OVERRIDES` 覆盖规则
- `tools/e2e/_probe-all-appget.cjs` — URL 可用性探测脚本
- `tools/e2e/_probe-alt-txts.cjs` — 替换 .txt URL 探测脚本
- `tools/e2e/test-appget-fix.cjs` — 修复验证脚本
