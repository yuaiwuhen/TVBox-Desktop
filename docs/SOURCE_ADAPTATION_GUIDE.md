# 视频源适配指南

本文档记录了TVBox-PC项目中适配各种视频源的方法、注意事项和故障排查流程。当配置中的JAR更新后，可参考此文档进行适配。

---

## 一、核心适配方法

### 1.1 Android Stub Classes

**问题**：TVBox JAR文件是Android DEX格式，Spider代码编译时依赖Android SDK类。在JVM中运行时，需要提供stub类来解析这些依赖。

**位置**：`tools/stub-classes/` 目录下的 `.java` 文件

**已实现的stub类列表**：
- `Activity, Application, Dialog, AlertDialog, Context, DialogInterface`
- `ContentProvider, TextView, LinearLayout, EditText, ScrollView`
- `View, ViewGroup, Window, WindowManager, KeyEvent, ViewTreeObserver`
- `Bitmap, Canvas, Paint, Rect, Drawable, ColorDrawable, BitmapDrawable`
- `AsyncTask, Bundle, Handler, Looper, Message, Log, SystemClock`
- `WebView, WebSettings, TextUtils, Uri, android.util.Base64, Environment`
- `Spider, Build, WifiManager, LruCache`

**方法签名必须匹配**：stub方法签名必须与真实Android API完全匹配（如 `Dialog(Context)` 而非 `Dialog(Object)`），因为Spider字节码是针对真实Android API编译的，JVM在运行时按精确签名解析方法。

**内部类文件命名**：Android stub内部类文件使用 `$` 在文件名中（如 `AlertDialog$Builder.class`, `Bitmap$Config.class`）。使用 `cmd /c` 配合单引号PowerShell字符串来避免 `$` 展开问题。

**添加新stub类的步骤**：
```bash
# 1. 编译 stub Java 文件
cd tools/stub-classes
javac -source 1.8 -target 1.8 android/os/Environment.java

# 2. 更新 stub JAR
jar uf ../stub.jar android/os/Environment.class
```

---

### 1.2 DEX 转 JAR 转换

**问题**：TVBox JAR文件实际是Android DEX格式，需要通过dex2jar转换才能在JVM中加载。

**转换器**：`electron/DexConverter.ts`

**关键实现**：
- 使用bundled JRE的 `java.exe` 而非系统Java
- JRE必须包含 `jdk.zipfs` 模块以支持dex2jar的JAR输出写入
- 实现3次重试机制（1s/2s指数退避）和部分输出清理，处理Windows文件锁/杀毒软件干扰导致的静默失败

**手动转换命令**：
```bash
# 使用项目bundled JRE
jre/bin/java -jar tools/dex-tools/dex-tools-2.4.jar -f input.dex -o output.jar

# 或使用系统Java（需要JDK 8+）
java -jar tools/dex-tools/dex-tools-2.4.jar -f input.dex -o output.jar
```

---

### 1.3 Guard JAR 解密

**问题**：部分Spider JAR使用wexguard加密，需要在运行时解密。

**涉及源**：ManJuHongGuo, ManJuXiFan, AnimeHuazi 等 NetEase 系列源

**解密流程**：
1. 从NetEase JAR提取 `wexguard_v8.so` 和 `wexshinidie.guard`
2. 使用unidbg模拟ARM native库进行解密
3. 提取 `classes.dex`
4. 转换为JAR

**关键文件**：
- 加密JAR：`jar_cache/netease.jar`
- 解密后JAR：`jar_cache/wexguard/wexguard-decrypted.jar`
- 测试脚本：`tools/test-guard-decrypt-flow.cjs`

**版本检查**：使用MD5比较判断NetEase JAR是否更新，需要重新解密。

**注意事项**：
- `wexguard_v8.so` 2026-07-20前编译的版本无法解密2026-06-13后新增的Guard stub类
- 解密需要1-2分钟，需提供UI进度反馈
- Windows文件系统权限可能阻止写入 `jar_cache/wexguard/`，需fallback到 `tools/guard_decrypt_work/`

---

### 1.4 网盘 Cookie 设置

**问题**：网盘类型Spider的静态Cookie字段在调用detailContent前未初始化。

**涉及的Spider和字段**：
- `NewQuark.OoOoOo0O0o0oO0o0`
- `NewPanUc.oOoOo0O0Oo0o0OoO`
- `NewPan115.oOoOoOo0oOo0o0oO`

**原因**：这些字段初始化为 `""`，仅在 `oOoO0OoO0oOo0oOo()` 或 `playerContent()` 内部从SharedPreferences填充 —— 但这些方法在 `detailContentVodPlay()` 之前不会被调用。

**修复**：调用 `setPanCookiesForDetailContent()` 在detailContent之前设置Cookie。

**夸克登录流程**：
1. 登录状态轮询使用7位数字状态码（2000000/50004001/50004002）
2. 登录确认判断依据为响应中是否存在非空 `service_ticket` 字段
3. Token生成UA必须使用 `quark-cloud-drive/2.5.20`
4. 轮询UA使用 `Chrome/38.0.2125.122...SE 2.X MetaSr 1.0`
5. 登录成功后调用 `GET /file/sort` 刷新 `__puus` cookie

**登录失效处理**：
- `refreshCookieForPlayback` 返回 `expired: true` 或CDN返回412
- 显示登录失效提示并弹窗二维码重新登录

---

### 1.5 msearch 聚合

**问题**：发现类源（Douban, NewDouBan）返回 `vod_id` 带 `msearch:NUMBER` 前缀，没有detailContent方法。

**Android行为**：重定向到FastSearchActivity（跨源快速搜索）。

**桌面端实现**：
- 点击msearch vod时触发 `store.doSearch(keyword, undefined, true)` 跨所有可搜索源搜索
- msearch检测添加到：`Home.vue`, `History.vue`, `Favorites.vue`

**关键发现**：Vue 3的 `<keep-alive>` 配合 `<transition mode="out-in">` 会导致：
- `watch()` watcher在组件deactivated时暂停
- `onActivated` 不可靠触发
- **解决方案**：必须从源页面直接触发搜索，而非依赖目标页面的生命周期钩子

---

## 二、具体修复案例

### 2.1 MyBaiDu/MyUcPan vod_id 重排

**问题**：网盘Spider返回的 `vod_id` 数组格式为 `[parent_root_indicator, folder_fid, ...]`，Spider期望使用folder fid。

**修复**：在 `JarLoader.ts` 中交换索引0和2：
```typescript
// vod_id rearrangement for pan spiders
if (vod_ids.length >= 3) {
  [vod_ids[0], vod_ids[2]] = [vod_ids[2], vod_ids[0]];
}
```

---

### 2.2 clsKey 计算

**问题**：Spider类名可能是完整包路径（如 `com.github.catvod.spider.MyUcPanGuard`），需要提取简短名称。

**修复**：
```typescript
const clsKey = instance.className.split('.').pop().replace('csp_', '');
```

---

### 2.3 ProxyServer CDN 重写

**问题**：百度CDN下载URL签名绑定Spider的Android UA，如果proxy server发送Windows UA，CDN返回403错误码31362 "sign error"。

**修复**：`translatePlayerContent` 必须将Spider提供的header编码到proxy URL的 `&header=` 参数中，`streamPanDirect` 读取并使用Spider的UA/Referer而非硬编码默认值。

---

### 2.4 夸克网盘CDN限速

**问题**：`piccc.cdn.51touxiang.com` 对当前IP限速至0.06 MB/s，导致TS下载超时。

**修复**：
1. ProxyServer中添加CdnRewriter到hxq源m3u8管道
2. CDN测速从HTTP TTFB改为TCP连接延迟（不受应用层限速影响）
3. 自动选择TCP延迟最低的CDN

**效果**：TS下载速度从0.03 MB/s提升到2.04 MB/s（约68倍）。

---

## 三、故障排查流程

### 3.1 诊断脚本

| 脚本 | 用途 |
|------|------|
| `tools/e2e/test-feimao-all.cjs` | 测试肥猫配置所有源 |
| `tools/e2e/test-newwex-remaining.cjs` | 测试newwex配置剩余源 |
| `tools/e2e/diag-source.cjs <key> home\|detail\|play` | 单源诊断 |
| `tools/e2e/list-all-sites.cjs` | 列出当前配置所有源 |
| `tools/e2e/switch-config.cjs <url>` | 切换配置 |

### 3.2 常见错误类型

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `ClassNotFoundException` | 缺少Android stub类 | 添加stub类到stub.jar |
| `UnsatisfiedLinkError` | 缺少native库 | 确保lib文件在正确路径 |
| `SpiderException: {}` | Spider返回空结果 | 检查参数/Cookie/网络 |
| `timeout` | 服务器无响应 | 服务器宕机，无法修复 |
| `class_not_found` | Guard JAR未解密或版本过期 | 重新运行解密流程 |
| `vod_play_url empty` | 直播源未开赛 | 时机问题，非bug |

### 3.3 调试步骤

1. **确认JAR加载成功**
   ```javascript
   // CDP console
   const {useAppStore} = await import('/src/store/app.ts');
   const s = useAppStore();
   console.log('Active site:', s.activeSite);
   console.log('Sites count:', s.sites.length);
   ```

2. **检查homeContent**
   ```bash
   node tools/e2e/diag-source.cjs <sourceKey> home
   ```

3. **检查detailContent**
   ```bash
   node tools/e2e/diag-source.cjs <sourceKey> detail
   ```

4. **检查playerContent**
   ```bash
   node tools/e2e/diag-source.cjs <sourceKey> play
   ```

---

## 四、不可修复的源类型

以下类型的源无法通过代码修复：

| 类型 | 原因 | 示例 |
|------|------|------|
| 服务器宕机 | API无响应 | 肥猫、光盘、永永等 |
| 发现类源 | 无detailContent方法 | 豆瓣、豆瓣预告 |
| 搜索类源 | homeContent为空 | 米搜、PanSearch |
| 直播源 | 时机依赖 | 看球、瓜子 |
| WAF保护 | 需要JS指纹验证 | NewJuTou |
| Spider bug | 代码缺陷 | WexBoBo (replaceAll) |
| 配置问题 | 需要特定账户/Token | MyUcPan (非VIP) |
| JS Spider | 需要JS引擎 | 儿童 (drpy2.min.js) |

---

## 五、新JAR适配流程

当配置中的JAR更新后，按以下流程适配：

### 5.1 自动适配脚本

运行 `tools/e2e/adapt-new-jar.cjs`：
```bash
# 1. 清理旧缓存
rm -rf jar_cache/*

# 2. 运行适配脚本
node tools/e2e/adapt-new-jar.cjs

# 3. 查看报告
# 报告生成在 tools/e2e/adapt-report-<date>.json
```

脚本会自动：
1. 加载配置并下载JAR
2. 执行dex2jar转换
3. 检测Guard加密并解密
4. 测试所有源的home/detail/play
5. 生成适配报告

### 5.2 手动适配步骤

如果自动脚本失败，手动执行：

1. **下载新JAR**
   ```bash
   # 从配置JSON中获取spider URL
   curl -o jar_cache/spider.jar <spider_url>
   ```

2. **转换DEX到JAR**
   ```bash
   jre/bin/java -jar tools/dex-tools/dex-tools-2.4.jar -f jar_cache/spider.jar -o jar_cache/spider-converted.jar
   ```

3. **测试转换结果**
   ```bash
   node tools/e2e/test-jar-full.cjs jar_cache/spider-converted.jar
   ```

4. **检查缺失的stub类**
   ```bash
   # 查看JarLoader日志，找到ClassNotFoundException
   # 添加缺失的stub类
   ```

5. **重新测试所有源**
   ```bash
   node tools/e2e/test-feimao-all.cjs
   node tools/e2e/test-newwex-remaining.cjs
   ```

---

## 六、最佳实践

### 6.1 代码修改原则

1. **最小化修改**：只修改解决当前问题所需的代码
2. **匹配现有风格**：即使你有不同偏好，也要匹配现有代码风格
3. **不重构相邻代码**：只修改问题相关代码，不"顺便"改进
4. **添加注释**：只在逻辑不明显的地方添加注释

### 6.2 测试原则

1. **回归测试**：修改后运行全量测试确保不破坏现有功能
2. **边界测试**：测试空值、边界值、异常情况
3. **跨配置测试**：同时在feimao和newwex配置上测试

### 6.3 提交原则

1. **原子提交**：每个commit只解决一个问题
2. **清晰的commit message**：说明what和why
3. **不提交调试文件**：不提交临时测试脚本和日志

---

## 七、相关文件

| 文件 | 说明 |
|------|------|
| `electron/JarLoader.ts` | JAR加载核心逻辑 |
| `electron/DexConverter.ts` | DEX转JAR转换器 |
| `electron/GuardDecryptor.ts` | Guard JAR解密器 |
| `electron/ProxyServer.ts` | 代理服务器（CDN重写） |
| `src/store/app.ts` | 应用状态管理 |
| `src/core/SpiderEngine.ts` | Spider引擎 |
| `src/core/PanLogin.ts` | 网盘登录逻辑 |
| `tools/stub-classes/` | Android stub类源码 |
| `tools/e2e/` | 诊断和测试脚本 |

---

## 八、更新记录

| 日期 | 内容 |
|------|------|
| 2026-07-23 | 初版：整理所有适配方法和注意事项 |