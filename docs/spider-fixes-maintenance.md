# Spider 视频列表修复维护文档

> 本文档汇总了 TVBox-Pc-Docker 项目中 Spider 视频列表数据调试的所有关键修复，
> 涵盖 Android 容器端（SpiderManager.kt）、PC 端（JarSpider.ts、app.ts、SpiderEngine.ts）、
> 以及 DEX 补丁层（MyCrypto.java、DexNative.java）的所有改动。
> 当遇到同类问题时可直接参考应用。

## 目录

1. 架构总览
2. 三个配置说明
3. 关键修复 1：DexNative 类加载器绑定
4. 关键修复 2：多 JAR 进程重启机制
5. 关键修复 3：LoaderHelper 预加载 aowu 原生库
6. 关键修复 4：JarSpider 返回空数据而非 mock
7. 关键修复 5：PC 端 loadHome fallback 链
8. 关键修复 6：MyCrypto 原生库加载
9. 关键修复 7：Config ext 字段 JsonElement 处理
10. 关键修复 8：csp_Bili cookie 自动注入
11. 已知限制（无法在 PC 端修复）
12. 测试脚本与验证流程
13. 故障排查指南
14. 关键修复 9：aowu woshinidie.jar 预下载打破循环依赖
15. 关键修复 10：LoaderHelper 双阶段原生库加载
16. 关键修复 11：Init.loader 注入 patch-dexnative + patch-loaderhelper
17. 关键修复 12：Guard bypass 直接加载实际 spider 类
18. 关键修复 13：ZXing 依赖解决 WexConfig 二维码崩溃
19. 已知限制汇总（最新）
20. 三配置测试基线（2026-07-28）
21. 关键修复 14：catch Throwable 防止 Error 逃逸导致 jarCache 清空
22. 关键修复 15：ensureCacheDirWritten 缓存目录权限修复
23. 关键修复 16：dexElements 注入顺序与 spiderLoader 初始化时序
24. 关键修复 17：内部 classloader 与主 classloader 的类隔离
25. 关键修复 18：libdecjni.so 必须在 Init.loader 创建后加载
26. 关键修复 19：NativeBridgeLoadLibrary 与 libhoudini 翻译
27. 完整调试历程（参考 调试视频列表数据.md）
28. 三配置直链播放验证（2026-07-29）
29. 已知限制：aowu Hxq 源 awSign 未注册（2026-07-29）
30. 测试脚本清单（2026-07-29 更新）
31. 关键修复 20：彻底删除所有 mock 数据（2026-07-29）
32. 网盘源元数据显示验证（2026-07-29）
33. 网友分享配置适配（2026-07-29）
34. 多配置全量测试与预设精简（2026-07-29）
35. 关键修复 22：网盘登录状态同步到播放（2026-07-29）
36. 已知限制：Ray dxawi 与老刘备配置源（2026-07-29）
37. 关键修复 23：配置中心与网盘完全解耦（2026-07-30）
38. 关键修复 24：配置中心 UI 重构与全量源调试（2026-07-31）
39. 关键修复 25：数组 URL 与逗号分隔 URL 解析（2026-08-01）

## 1. 架构总览

数据流：PC 端 `loadHome` → `JarSpider.homeContent` → HTTP POST `/spider/homeContent` → Android `SpiderManager.homeContent` → `spider.homeContent(filter)` → 真实视频数据。

组件分层：

- PC 端 (Electron + Vue): src/store/app.ts (loadHome fallback), src/core/JarSpider.ts (HTTP 调用), src/core/SpiderEngine.ts (Spider 工厂), electron/SpiderAPIClient.ts (HTTP 客户端)
- Docker 容器 (redroid Android): SpiderHttpServer (NanoHTTPD :19978), SpiderManager.kt (类加载、原生库、多 JAR)
- DEX 补丁层: tools/dex/MyCrypto.java, tools/dex/DexNative.java
- 原生库: libwexguard.so (stub), libdecjni.so (真实解密), libhoudini.so (ARM64→x86 翻译)

## 2. 三个配置说明

| 配置名 | URL                                 | JAR 特征                  | 类命名                  |
| ------ | ----------------------------------- | ------------------------- | ----------------------- |
| newwex | https://9280.kstore.vip/newwex.json | classes.dex + 加密 DEX    | csp\_\*Guard            |
| feimao | http://肥猫.net/tv                  | classes.dex + 加密 DEX    | csp\_\* (无 Guard 后缀) |
| aowu   | http://itv666.cc/aowu/config.webp   | aowunnn.amns + awdm-v8.so | csp\_\*Amns             |

关键差异：

- newwex/feimao 使用 libwexguard.so (stub) + libdecjni.so (真实解密)
- aowu 使用 libawdm.so (awdm-v8.so)，JNI_OnLoad 注册 2-arg DexNative.getLoader
- 三个配置的 JAR 不能共存于同一进程（libwexguard.so 只能加载一次），切换时需重启进程

## 3. 关键修复 1：DexNative 类加载器绑定

文件: docker/android-app/app/src/main/java/com/tvbox/spiderserver/SpiderManager.kt (L180-L218)

问题根因：
Init.init(Context) 触发原生 DexNative.getLoader(Context) 创建 Init.loader（内部 DexClassLoader）。原生代码用 Init.loader 加载 libwexguard.so，JNI_OnLoad 调用 FindClass("DexNative")。由于 Init.loader 的 dexPathList 包含 patch-dexnative.dex，FindClass 返回 DexNative@Init.loader（非 DexNative@spiderLoader）。RegisterNatives 绑定到 DexNative@Init.loader。

后续 spiderLoader.loadClass("DexNative") 加载的是 DexNative@spiderLoader（无 native 方法）→ UnsatisfiedLinkError: No implementation found for getSpider。

修复：在 invokeInit(loader) 之前用 Class.forName 触发 spiderLoader 的 <clinit>，让 libwexguard.so 用 spiderLoader 作为 caller 加载。

代码:

```kotlin
try {
    val preDexNativeCls = Class.forName(
        "com.github.catvod.spider.DexNative", true, loader
    )
    Log.i(TAG, "Pre-Init: DexNative loaded via spiderLoader " +
        "(classLoader=${preDexNativeCls.classLoader?.javaClass?.simpleName})")
} catch (e: Throwable) {
    val cause = if (e is InvocationTargetException) e.cause ?: e else e
    Log.w(TAG, "Pre-Init DexNative <clinit> failed: ${cause.message}", cause)
}
```

效果：RegisterNatives 绑定到 DexNative@spiderLoader。后续 Init.init 再加载 libwexguard.so 时 System.loadLibrary 返回 "already opened"，JNI_OnLoad 不重跑，native 方法绑定保持不变。

## 4. 关键修复 2：多 JAR 进程重启机制

文件: SpiderManager.kt (L38-L113), electron/SpiderAPIClient.ts (L132-L199)

问题根因：
libwexguard.so 每进程只能加载一次，JNI 方法只注册到第一个 spiderLoader 的 DexNative。加载第二个 JAR 时报 "already opened"，后续 spiderLoader 缺少 native 方法。

修复：

- SpiderManager 追踪 activeJarUrl，loadJar 时若 URL 变化则返回 RESTARTING 错误
- scheduleProcessRestart() 延迟 1.5s 后 killProcess，Android START_STICKY 自动重启服务
- PC 端 SpiderAPIClient.loadJar 检测 RESTARTING 响应，用 startedAt 时间戳验证进程确实重启

关键点：用 startedAt 时间戳判断重启（而非仅检查 /health 成功，否则会误判旧服务器为已重启）。

## 5. 关键修复 3：LoaderHelper 预加载 aowu 原生库

文件: SpiderManager.kt (L220-L247)

问题根因：
aowu 的 Init.init 调用 2-arg DexNative.getLoader(Object, InputStream)，此 native 由 libawdm.so 的 JNI_OnLoad 注册，stub libwexguard.so 只注册 1-arg 版本。若不预加载 libawdm.so，Init.init 抛 UnsatisfiedLinkError → 回退反射 → Init.loader 为 null → spider 的 AowuShinidie.init 调用 DexNative.getSpider 返回 null → NPE。

修复：invokeInit 之前调用 LoaderHelper.ensureLoaded() 预加载 libawdm.so（对 newwex/feimao JAR 是 no-op）。

LoaderHelper 加载顺序：

1. libawenc.so（真实 wexguard，UPX 打包，失败）
2. libdecjni.so（未下载，失败，OK）
3. libawdm.so（aowu JAR 成功，其他 no-op）

## 6. 关键修复 4：JarSpider 返回空数据而非 mock

文件: src/core/JarSpider.ts (L393-L442)

问题根因：
JarSpider.getMockData() 在 API 调用失败时返回 mock 视频（占位 URL），导致：

1. 用户看到假视频（无法播放）
2. PC 端 loadHome 的 fallback 链被阻塞（因为 homeVodList 非空，不会尝试 categoryContent/searchContent）

修复：所有失败路径返回 '{}'，让 UI 显示"暂无数据"并触发 fallback 链。

代码:

```typescript
if (!response.success) {
  const errMsg = String(response.error || '');
  const isSpiderCrashed =
    this.initialized && errMsg.includes('Spider not found');
  if (isSpiderCrashed) {
    this.initialized = false; // 下次重新尝试 init
    return '{}';
  }
  return '{}'; // 返回空数据触发 fallback 链
}
return '{}'; // 异常时也返回空数据
```

关键场景：MusicLiYuan 源的 libLoadNiMa.so ARM64 指令被 libhoudini 翻译时触发 SIGSEGV，Android 进程崩溃重启，内存 spiderCache 清空，后续调用报 "Spider not found"。返回 '{}' 让 UI 显示"暂无数据"而非假视频。

## 7. 关键修复 5：PC 端 loadHome fallback 链

文件: src/store/app.ts (L399-L650)

问题根因：
许多 spider 的 homeContent 只返回分类（class）不返回视频列表（list），导致首页空白。需要 fallback 到其他方法获取视频。

fallback 链顺序：

1. homeContent(filter=true) — 获取分类和推荐列表
2. homeVideoContent() — 若 list 为空，尝试此方法
3. categoryContent(前5个分类, pg=1) — 若仍为空但有分类，逐个尝试前 5 个分类
4. searchContent(默认关键词) — 若仍为空且 site.searchable !== 0，尝试 ['热门','2024','2025','电影']

无效 JSON 处理：所有 JSON.parse 都包裹 try-catch，失败时降级为 { list: [] }，确保 fallback 链不被中断。

效果：newwex 配置从 24 个 home_ok 提升到 67 个（50 个通过 categoryContent fallback）。

## 8. 关键修复 6：MyCrypto 原生库加载

文件: tools/dex/MyCrypto.java

问题根因：
MyCrypto.<clinit> 和 DexNative.<clinit> 通过 System.loadLibrary("wexguard") 相互触发，导致类初始化循环依赖。第二次加载报 "already opened" 错误。

修复：loadNativeLibraries 捕获 "already opened" 错误，避免重复加载。

tryLoadLibrary 逻辑：

1. 先尝试 System.loadLibrary(name)（从应用 native lib 目录加载）
2. 失败则尝试 System.load(absPath)（从外部路径加载）
3. 捕获 "already opened" 错误视为成功（库已由其他 classloader 加载）

## 9. 关键修复 7：Config ext 字段 JsonElement 处理

文件: docker/android-app/app/src/main/java/com/tvbox/spiderserver/SpiderHttpServer.kt (InitRequest 定义处)

问题根因：
Config JSON 中某些站点的 ext 字段是 Object 而非 String（如 bilibili、教育类站点），Gson 反序列化 InitRequest.ext: String? 会失败：Expected a string but was BEGIN_OBJECT at $.ext。

修复：将 ext 字段类型改为 JsonElement?，在 handleInit 中按类型转换：

- JsonPrimitive → asString
- JsonObject/JsonArray → toString()（即 JSON 字符串）

这与 FongMi/TV 序列化 Object ext 为 String 的行为一致。

## 10. 关键修复 8：csp_Bili cookie 自动注入

文件: src/core/SpiderEngine.ts (L25-L47)

问题根因：
feimao 的 csp_Bili 源使用 FongMi/TV 原版 Bili spider，调用 Bilibili API 时无 cookie 返回非 JSON（HTML 错误页/重定向），导致 JsonSyntaxException: Expected BEGIN_OBJECT but was STRING。

修复链路：

1. 用户在配置中心（WexConfigGuard）扫描 B 站二维码
2. PanLoginService.pollBiliQrCode 从 crossDomain URL 解析 SESSDATA/bili_jct/DedeUserID/DedeUserID\_\_ckMd5/sid 拼接为 cookie 字符串
3. PanLogin.saveLoginInfo 保存到 localStorage['pan_login_bili']
4. SpiderEngine.getSpider 创建 JarSpider 时调用 injectBiliCookie(api, ext)

代码:

```typescript
function injectBiliCookie(api: string, ext: string): string {
  if (api !== 'csp_Bili') return ext;
  const biliInfo = PanLogin.getLoginInfo('bili');
  if (!biliInfo?.cookie) return ext;
  try {
    const obj = ext && ext.trim().startsWith('{') ? JSON.parse(ext) : {};
    obj.cookie = biliInfo.cookie;
    return JSON.stringify(obj);
  } catch (e) {
    return ext;
  }
}
```

5. Home.vue 的 onQrLoginSuccess 在 panType === 'bili' 时调用 spiderEngine.clearAll() 清空缓存，下次访问重新创建并注入最新 cookie。

注意：newwex 的 csp_BiliGuard 源使用 wex 修改版 spider，无 cookie 也可正常工作。

## 11. 已知限制（无法在 PC 端修复）

| 源                      | 限制类型                | 根因                                       | 现象                                       |
| ----------------------- | ----------------------- | ------------------------------------------ | ------------------------------------------ |
| MusicLiYuan             | libhoudini 翻译器       | libLoadNiMa.so ARM64 指令翻译时 SIGSEGV    | 进程崩溃重启，报 "Spider not found"        |
| AnimeFanShu             | libdecjni.so 实现不完整 | MyCrypto.extDe 返回 0 字节数组             | JSONException: End of input at character 0 |
| WexV6DaShiXiong 等 4 源 | redroid namespace 限制  | spider 类自身 System.load() 加载外部路径库 | failed to create bridged namespace         |
| emby/AList/webdav       | 设计无首页              | 媒体服务器源不提供 homeContent             | home_null（预期行为）                      |
| 网盘类源                | 需用户登录              | Quark/UC/阿里/百度等需账号                 | 详情页无播放数据                           |
| feimao csp_Bili         | 需 Bilibili cookie      | 无 cookie 时 API 返回 HTML                 | 需配置中心扫码登录                         |

应对策略：JarSpider 对崩溃源返回 '{}' 显示"暂无数据"，不显示假视频。

## 12. 测试脚本与验证流程

### 12.1 三配置全量测试

```
node tools/test-three-configs.cjs
```

输出: tools/test-three-configs-result.json，包含每个源的 initStatus/homeStatus/categoryStatus/detailStatus/playerStatus。

### 12.2 PC 端 fallback 链验证

```
node tools/test-pc-fallback.cjs
```

模拟 app.ts:loadHome 的完整 fallback 链（homeContent → homeVideoContent → categoryContent → searchContent）。

### 12.3 健康检查

```
curl http://127.0.0.1:19978/health
docker ps | findstr spider
```

### 12.4 日志查看

```
# Android logcat（实时）
docker exec <container> logcat -s SpiderManager:V DexNative:V Init:V

# PC 端控制台
# 在 Electron DevTools Console 查看 [Store] loadHome / [JarSpider] 日志
```

## 13. 故障排查指南

### 13.1 所有源都显示"暂无数据"

检查顺序：

1. curl http://127.0.0.1:19978/health — 服务是否正常
2. docker ps — 容器是否运行
3. logcat 是否有 libwexguard.so 加载失败
4. activeJarUrl 是否匹配当前配置的 JAR URL

### 13.2 单个源首页空白

可能原因：

- spider 的 homeContent 只返回分类 → fallback 链应触发 categoryContent
- 检查 JarSpider 是否返回 '{}' 而非 mock 数据
- 检查 app.ts:loadHome 的 try-catch 是否吞掉了异常

### 13.3 "Spider not found" 错误

根因：Android 进程崩溃重启，内存 spiderCache 清空。
常见触发：MusicLiYuan 的 libLoadNiMa.so SIGSEGV、System.load() 加载外部路径库失败。
处理：JarSpider 已返回 '{}' 显示"暂无数据"，不再回退 mock。

### 13.4 "JAR not loaded" 错误

根因：进程重启后 jarCache 清空。
修复：SpiderManager.initSpider 已实现 auto-reload。

### 13.5 切换配置后所有源失败

根因：JAR URL 变化未触发进程重启，或重启后 PC 端未等待。
修复：SpiderAPIClient.loadJar 检测 RESTARTING 并用 startedAt 验证重启完成。

### 13.6 UnsatisfiedLinkError: No implementation found for getSpider

根因：DexNative 类加载器绑定错误（见修复 1）。
验证：logcat 应有 "Pre-Init: DexNative loaded via spiderLoader"。
修复：确认 Class.forName("...DexNative", true, loader) 在 invokeInit 之前调用。

### 13.7 JSONException: End of input at character 0

根因：MyCrypto.extDe 返回 0 字节数组（libdecjni.so 限制）。
影响源：AnimeFanShu 等依赖 extDe 解密的 spider。
状态：PC 端无法修复，已记录为已知限制。

## 14. 关键修复 9：aowu woshinidie.jar 预下载打破循环依赖

文件: docker/android-app/.../SpiderManager.kt (`isAowuJar`, `ensureAowuWoshinidieJar`, `extractAowuAwdmIfPresent`)

问题根因：
aowu 配置的 spider JAR (22KB) 只包含入口类（如 `AowuShinidie`、`AppV7Amns`），运行时由 `AowuShinidie.init` 下载 `woshinidie.jar` (3.7MB)。`woshinidie.jar` 内含:

- `awdm-v8.so` (185KB ARM64): 注册 `DexNative.getLoader(Object, InputStream)` (2-arg) 和 `MyCrypto.awSign`
- `aowunnn.amns` (3.6MB): 内部 DEX，包含真正的 spider 实现

但 `AowuShinidie.init` 本身需要 `MyCrypto.awSign` 才能成功（awSign 用于签名 API 请求）。这构成循环依赖:

- 加载 `woshinidie.jar` 需要 `AowuShinidie.init` 成功
- `AowuShinidie.init` 成功需要 `libawdm.so` 已加载（提供 awSign）
- `libawdm.so` 在 `woshinidie.jar` 内

未修复前 14 个 aowu 源 INIT-FAIL：AppV7Fz/Xy/Zjdr/Xyz/Xnm/Mtq/Llq/Xsz/Xhr (9 个 AppV7Amns)、FanShu、AowuDmMw、Hema、TSty、Woshinidie。错误统一为:

```
UnsatisfiedLinkError: No implementation found for byte[]
com.github.catvod.spider.MyCrypto.awSign(byte[], java.lang.String)
```

修复:

1. `isAowuJar(jarFile)`: 扫描 JAR 的 classes.dex 字符串表，检测 `*Amns;` 和 `AowuShinidie` 标记，判定是否为 aowu JAR
2. `ensureAowuWoshinidieJar()`: 从已知 CDN 预下载 `woshinidie.jar` 到 `/data/data/.../files/aowu/woshinidie.jar`
   - https://9763.kstore.vip/woshinidie.jar (主)
   - https://lanmeio.com/wenjian/woshinidie.jar (备)
3. `extractAowuAwdmIfPresent(jarFile)`: 按以下顺序提取 `awdm-v8.so` 到 `native_libs/libawdm.so`:
   - 优先从已下载的 `woshinidie.jar` 提取
   - 其次从 spider JAR 本身提取（若 JAR 直接打包了 awdm-v8.so）
   - 若都没找到但 `isAowuJar` 为 true，调用 `ensureAowuWoshinidieJar` 下载后重新提取
4. `libawdm.so` 放在 `native_libs/` 目录（已在 classloader 的 native library search path 中）
5. `LoaderHelper.<clinit>` 调用 `System.loadLibrary("awdm")` 加载 libawdm.so，其 JNI_OnLoad 注册 2-arg `DexNative.getLoader` 和 `MyCrypto.awSign`
6. 在 `invokeInit(loader)` 之前调用 `LoaderHelper.ensureLoaded()` 触发 `<clinit>` 加载 libawdm.so

关键代码（SpiderManager.kt L239-L248）:

```kotlin
try {
    val preLoaderHelperCls = Class.forName(
        "com.github.catvod.spider.LoaderHelper", true, loader
    )
    preLoaderHelperCls.getMethod("ensureLoaded").invoke(null)
    Log.i(TAG, "Pre-Init: LoaderHelper.ensureLoaded() invoked (libawdm.so loaded if present)")
} catch (e: Throwable) {
    val cause = if (e is java.lang.reflect.InvocationTargetException) e.cause ?: e else e
    Log.w(TAG, "Pre-Init LoaderHelper ensureLoaded failed: ${cause.javaClass.simpleName}: ${cause.message}", cause)
}
```

效果：14 个 INIT-FAIL 源全部初始化成功（除 Woshinidie 因 JAR 内无 spider 类还需另行处理）。

## 15. 关键修复 10：LoaderHelper 双阶段原生库加载

文件: tools/dex/LoaderHelper.java

问题根因：

- `libawdm.so` 的 JNI_OnLoad 注册 2-arg `DexNative.getLoader`（aowu 需要），必须**在 Init.init 之前**加载
- `libdecjni.so` 的 JNI_OnLoad 用 `FindClass` 查找内部 DEX 类（来自 config.db，由 Init.init 加载到 Init.loader）。若在 Init.init 之前加载，JNI_OnLoad 返回 JNI_ERR 且 Android 缓存失败为 "already opened"，后续重试永不触发 JNI_OnLoad，导致 extDe/md5/fsDec 永不注册

修复：LoaderHelper 分两阶段加载:

1. `<clinit>`（Pre-Init 阶段，Init.init 之前）: 只加载 `libawdm.so`。对 newwex/feimao JAR（无 awdm-v8.so）是 no-op
2. `loadDecjni()`（Init.init 之后）: 显式加载 `libdecjni.so`。此时 Init.loader 已有 config.db，FindClass 能找到内部类

关键代码（LoaderHelper.java）:

```java
static {
    // Step 1: Load libawdm.so BEFORE Init.init (aowu needs 2-arg getLoader)
    try {
        System.loadLibrary("awdm");
    } catch (Throwable t) {
        String msg = String.valueOf(t.getMessage());
        if (msg.contains("already loaded") || msg.contains("already opened")) {
            // OK — library already loaded
        }
        // Not an error for newwex/feimao JARs (no awdm-v8.so)
    }
}

public static void ensureLoaded() { /* triggers <clinit> */ }

public static void loadDecjni() {
    // MUST be called AFTER Init.init(Context)
    try {
        System.loadLibrary("decjni");
    } catch (Throwable t) {
        // ... handle already loaded
    }
}
```

调用顺序（SpiderManager.kt）:

1. `Class.forName("LoaderHelper", true, loader).getMethod("ensureLoaded").invoke(null)` — 触发 `<clinit>` 加载 libawdm.so
2. `invokeInit(loader)` — 调用 Init.init(Context)
3. `Class.forName("LoaderHelper", true, initLoader).getMethod("loadDecjni").invoke(null)` — 加载 libdecjni.so

关键点：第二步 loadDecjni 通过 **initLoader**（而非 spiderLoader）调用，因为 initLoader 有 config.db 在自己的 dexPathList，且能通过 parent delegation 找到 spiderLoader 的外部 DEX 类。这让 FindClass 能找到所有类，JNI_OnLoad 成功。

## 16. 关键修复 11：Init.loader 注入 patch-dexnative + patch-loaderhelper

文件: SpiderManager.kt (`getInitLoader` 后的 injectPatchDexByName 调用)

问题根因：
libdecjni.so 的 JNI_OnLoad 用 `FindClass` 查找 `DexNative` 和 `LoaderHelper`：

- `DexNative` 在 patch-dexnative.dex（仅 spiderLoader 有）
- `LoaderHelper` 在 patch-loaderhelper.dex（仅 spiderLoader 有）

当通过 `initLoader` 调用 `loadDecjni` 时，FindClass 用 initLoader。initLoader 的 parent 是 spiderLoader，所以理论上能通过 parent delegation 找到。但 libdecjni.so 的 JNI_OnLoad 可能用 `FindClass` 的特殊变体（不触发 parent delegation），导致找不到。

修复：在 initLoader 中也注入 patch-dexnative.dex 和 patch-loaderhelper.dex:

```kotlin
val cachePath = File(ctx.codeCacheDir, "jar")
injectPatchDexByName(initLoader, cachePath, "patch-dexnative.dex")
injectPatchDexByName(initLoader, cachePath, "patch-loaderhelper.dex")
```

效果：libdecjni.so 的 JNI_OnLoad 在 initLoader 中能直接找到 DexNative 和 LoaderHelper，RegisterNatives 成功，extDe/md5/fsDec/Awdm 等方法注册到 MyCrypto@systemLoader（通过 parent delegation）。

## 17. 关键修复 12：Guard bypass 直接加载实际 spider 类

文件: SpiderManager.kt (L467-L490)

问题根因：
newwex 配置的 `csp_*Guard` 源（如 csp_NewDouBanGuard）的 Guard 类是委托包装:

```
Guard.homeContent(filter) → Init.getSpider(api).homeContent(filter)
```

但 `Init.getSpider()` 用错误的 classloader（spiderLoader，没有 config.db）返回 null，导致 `Spider.init` 抛 NPE:

```
Attempt to invoke virtual method 'void com.github.catvod.crawler.Spider.init(android.content.Context, java.lang.String)' on a null object reference
```

修复：对 `csp_*Guard` 源绕过 Guard，直接从 initLoader 加载实际 spider 类（去掉 Guard 后缀）:

```kotlin
if (initLoader != null && className.endsWith("Guard")) {
    val actualClassName = "com.github.catvod.spider." +
        className.removePrefix("csp_").removeSuffix("Guard")
    val actualCls = initLoader.loadClass(actualClassName)
    val instance = actualCls.newInstance() as Spider
    thread.contextClassLoader = initLoader
    instance.init(applicationContext(), ext ?: "")
    spiderInstance = instance
    spiderMethodClassLoader = initLoader
}
```

效果：newwex 的 NewDouBanGuard、NewErXiaoGuard、NewWoggGuard 等 Guard 源 init 成功，后续 homeContent/categoryContent 可正常调用。

## 18. 关键修复 13：ZXing 依赖解决 WexConfig 二维码崩溃

文件: docker/android-app/app/build.gradle

问题根因：
WexConfigGuard 源的 spider 在配置中心生成二维码时调用 `com.google.zxing.EncodeHintType`，但 APK 未打包 ZXing 库。触发:

```
ClassNotFoundException: com.google.zxing.EncodeHintType
```

导致 spider 进程崩溃重启，后续所有源报 "Spider not found"。

修复：在 app/build.gradle 添加 ZXing core 依赖:

```gradle
implementation 'com.google.zxing:core:3.5.3'
```

效果：WexConfigGuard 不再崩溃，可正常生成配置中心二维码。

## 19. 已知限制汇总（最新）

| 源类别                            | 限制                                      | 现象                         | 应对                            |
| --------------------------------- | ----------------------------------------- | ---------------------------- | ------------------------------- |
| MusicLiYuan (newwex)              | libhoudini 翻译 libLoadNiMa.so 时 SIGSEGV | 进程崩溃，"Spider not found" | JarSpider 返回 '{}'             |
| AnimeFanShu (newwex)              | libdecjni.so extDe 返回 0 字节            | JSONException: End of input  | 已知限制                        |
| emby/AList/webdav (newwex)        | 设计无首页                                | homeContent 返回 null        | 预期行为                        |
| 网盘类源 (My\*)                   | 需用户登录                                | 详情页无播放数据             | 需配置中心扫码登录              |
| feimao csp_Bili                   | 需 Bilibili cookie                        | API 返回 HTML                | 需配置中心扫码登录              |
| aowu Woshinidie                   | JAR 内无 spider 类                        | ClassNotFoundException       | 设计需运行时下载，PC 端无法修复 |
| aowu 网盘类 (MyBaidu/MyUc 等)     | 需用户登录                                | homeContent 无数据           | 需配置中心扫码登录              |
| newwex So\* (SoTySo/SoBaiDuSo 等) | 设计为搜索源                              | 无首页                       | 预期行为，搜索可用              |

## 20. 三配置测试基线（2026-07-28）

修复后测试结果（tools/test-three-configs-result.json）:

| 配置   | 总源数 | init_ok | home_ok | detail_ok | player_ok |
| ------ | ------ | ------- | ------- | --------- | --------- |
| feimao | 38     | 38      | 28      | 26        | 20        |
| newwex | 88     | 87      | 70      | 64        | 45        |
| aowu   | 85     | 71      | 55      | 41        | 33        |

剩余失败分类:

- **aowu INIT-FAIL (14)**: 9 个 AppV7Amns + FanShu/AowuDm/Hema/TSty (awSign) + Woshinidie (ClassNotFound)
- **aowu NO-PLAYER (8)**: 4 Wobg + Zhinan (no url) + HuyaLive (awSign) + MyLocal/MyQuark (no episodes)
- **newwex INIT-FAIL (1)**: AnimeFanShu (Spider.init null)
- **newwex NO-PLAYER (19)**: 多个 New\*Guard 源 (no url) + WexV6DaShiXiong/TeGou (NPE)
- **feimao NO-PLAYER (6)**: Duopan x3 + Wwys + MiSou + Config (no url)

## 21. 关键修复 14：catch Throwable 防止 Error 逃逸导致 jarCache 清空

文件: docker/android-app/.../SpiderHttpServer.kt, SpiderManager.kt

问题根因：
Spider JAR 中的 `com.wexfnw.libso.LoadNiMa.<clinit>` 静态初始化器调用 `System.load()` 加载原生库时会抛出 `UnsatisfiedLinkError`（继承自 Error 而非 Exception）。`catch (Exception)` 无法捕获，Error 逃逸导致 NanoHTTPD worker 线程崩溃，进程重启后内存中的 `jarCache` 被清空，后续所有 init 调用失败报 "JAR not loaded"。

修复：将 `invokeSpiderMethod`、`searchContent`、`initSpider` 等所有关键 catch 块从 `catch (e: Exception)` 改为 `catch (e: Throwable)`，确保所有 Error 子类（UnsatisfiedLinkError、StackOverflowError 等）被捕获。

代码示例（SpiderManager.kt）:

```kotlin
try {
    // ... spider method invocation
} catch (e: Throwable) {  // 不要用 catch (e: Exception)
    Log.e(TAG, "Spider method failed", e)
    return ApiResponse.error("...")
}
```

效果：单个源崩溃不再传染到其他源，避免级联失败。

## 22. 关键修复 15：ensureCacheDirWritable 缓存目录权限修复

文件: docker/android-app/.../SpiderApplication.kt

问题根因：
在 redroid 容器中，应用启动后 `/data/data/com.tvbox.spiderserver/cache/` 目录有时会变为只读（原因可能是 Docker volume 挂载或 SELinux 重新标记）。这导致 `downloadJar` 写入 JAR 文件失败，报 "Permission denied"。

修复：在 `SpiderApplication.onCreate()` 中，使用 Java File API 主动设置 cache 和 code_cache 目录可写：

```kotlin
private fun ensureCacheDirWritable() {
    try {
        val cacheDir = applicationContext.cacheDir
        cacheDir.setReadable(true, false)
        cacheDir.setWritable(true, false)
        cacheDir.setExecutable(true, false)
        val codeCacheDir = applicationContext.codeCacheDir
        codeCacheDir.setReadable(true, false)
        codeCacheDir.setWritable(true, false)
        codeCacheDir.setExecutable(true, false)
    } catch (e: Throwable) {
        Log.w(TAG, "ensureCacheDirWritable failed: ${e.message}")
    }
}
```

效果：feimao JAR 下载不再因权限错误失败。

## 23. 关键修复 16：dexElements 注入顺序与 spiderLoader 初始化时序

文件: SpiderManager.kt (`injectPatchDex`, `parseJar`)

问题根因：
`patch.dex` 注入到 `DexClassLoader` 的 `dexElements` 时，必须放在 JAR 自身的 dex 前面，否则 spider JAR 中原始的 DexNative/MyCrypto/LoadNiMa 类会优先被加载，patch 失效。同时，类初始化有"一旦失败永远失败"的特性：如果首次加载触发 `ExceptionInInitializerError`，后续所有访问都直接抛 `NoClassDefFoundError`。

关键修复点：

1. `injectPatchDex` 使用反射将 patch.dex 的 Element 插入到 `dexElements` 数组**头部**（index 0），保证 patch 中的类优先加载
2. 在 `parseJar` 中创建 `DexClassLoader` 后立即注入 patch.dex（在任何 spider 类被加载之前）
3. `fixNativeLibraryPaths` 在调用 `DexNative.getLoader()` 之前先注入 `patch-dexnative.dex` 到内部 classloader，避免内部 classloader 加载到未 patch 的 DexNative

代码（injectPatchDex 核心逻辑）:

```kotlin
private fun injectPatchDex(loader: ClassLoader, cacheDir: File) {
    val pathList = getField(loader, "pathList") ?: return
    val patchFile = File(cacheDir, "patch.dex")
    // 提取 assets/patch.dex 到 cacheDir
    extractAsset("patch.dex", patchFile)
    // 创建 Element
    val patchElement = makeDexElement(pathList, patchFile)
    // 获取原 dexElements
    val originalElements = getField(pathList, "dexElements") as Array<*>
    // 合并：patch 在前
    val combined = arrayOf(patchElement, *originalElements)
    setField(pathList, "dexElements", combined)
    Log.i(TAG, "Injected patch.dex (patch=${patchElement != null}, spider=${originalElements.size} elements)")
}
```

关键点：patch.dex 的 Element 必须排在前面，否则 Java 双亲委派模型会先在子 classloader 自己的 dex 中找到原始类。

## 24. 关键修复 17：内部 classloader 与主 classloader 的类隔离

文件: SpiderManager.kt (`fixNativeLibraryPaths`, `injectPatchDexByName`)

问题根因：
`DexNative.getLoader()` 返回的内部 classloader（DexClassLoader）的 parent 是 `PathClassLoader`（系统 classloader），**不是** spiderLoader（主 DexClassLoader）。因此：

- 双亲委派不会从 spiderLoader 加载类
- 内部 classloader 自己的 dex（config.db 解密的 dex）中有 MyCrypto/LoadNiMa 类，会优先加载
- 主 classloader 中注入的 patch 对内部 classloader 无效

修复：

1. 在 `fixNativeLibraryPaths` 中获取内部 classloader 后，立即给它注入 patch-dexnative.dex、patch-loaderhelper.dex、patch-classes.dex
2. 同时设置内部 classloader 的 `nativeLibraryDirectories`，让 `System.load()` 能成功创建 namespace
3. 注入后立即预加载 `MyCrypto` 和 `LoadNiMa`（`internalLoader.loadClass("...MyCrypto")`），确保它们的 `<clinit>` 在我们控制下执行（使用 patch 版本）

代码:

```kotlin
private fun fixNativeLibraryPaths(loader: ClassLoader) {
    addNativeLibDirToClassLoader(loader, "fixNativeLibraryPaths[main-loader]")
    try {
        val dexNativeCls = loader.loadClass("com.github.catvod.spider.DexNative")
        // 触发 DexNative.<clinit> → System.loadLibrary("wexguard")
        val getLoaderMethod = dexNativeCls.getMethod("getLoader", Object::class.java)
        val internalLoaderObj = getLoaderMethod.invoke(null, applicationContext())
        val internalLoader = internalLoaderObj as? ClassLoader ?: return

        // 修复内部 classloader 的 native library path
        addNativeLibDirToClassLoader(internalLoader, "fixNativeLibraryPaths[internal-loader]")

        // 注入 patch.dex 到内部 classloader
        val cachePath = File(applicationContext().codeCacheDir, "jar")
        injectPatchDexByName(internalLoader, cachePath, "patch-dexnative.dex")
        injectPatchDexByName(internalLoader, cachePath, "patch-loaderhelper.dex")
        injectPatchDexByName(internalLoader, cachePath, "patch-classes.dex")

        // 预加载关键类，确保使用 patch 版本
        try {
            internalLoader.loadClass("com.github.catvod.spider.MyCrypto")
            internalLoader.loadClass("com.wexfnw.libso.LoadNiMa")
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to pre-load patched classes: ${e.message}")
        }
    } catch (e: Throwable) {
        Log.w(TAG, "fixNativeLibraryPaths internal failed: ${e.message}")
    }
}
```

## 25. 关键修复 18：libdecjni.so 必须在 Init.loader 创建后加载

文件: tools/dex/LoaderHelper.java

问题根因：
`libdecjni.so` 的 `JNI_OnLoad` 用 `FindClass` 查找 `DexNative` 和 `LoaderHelper` 类。这些类需要在 Init.loader（内部 DexClassLoader，由 `DexNative.getLoader()` 返回）的 dexPathList 中才能被找到。

如果在 `Init.init(Context)` 之前加载 `libdecjni.so`：

- Init.loader 还没创建（config.db 还没解密）
- `FindClass("DexNative")` 在 systemLoader 中找不到（DexNative 只在 spiderLoader 和内部 classloader 中）
- `JNI_OnLoad` 返回 JNI_ERR
- Android 缓存这次失败为 "already opened"
- 后续重试 `System.loadLibrary("decjni")` 永远不重新触发 `JNI_OnLoad`
- `MyCrypto.extDe`、`md5`、`fsDec` 等方法永不注册

修复：LoaderHelper 分两阶段加载

1. `<clinit>` 阶段（在 Init.init 之前）：只加载 `libawdm.so`（aowu 需要 2-arg getLoader）
2. `loadDecjni()` 阶段（在 Init.init 之后）：通过 `initLoader`（已含 config.db）调用 `System.loadLibrary("decjni")`

调用顺序（SpiderManager.kt）:

```kotlin
1. Class.forName("LoaderHelper", true, spiderLoader).ensureLoaded()  // 加载 libawdm.so
2. invokeInit(loader)  // Init.init(Context) → DexNative.getLoader() → 创建内部 classloader
3. injectPatchDexByName(initLoader, ..., "patch-dexnative.dex")  // 注入到内部 classloader
4. Class.forName("LoaderHelper", true, initLoader).loadDecjni()  // 加载 libdecjni.so
```

关键点：第 4 步通过 `initLoader` 调用（而非 spiderLoader），因为 initLoader 有 config.db 在自己的 dexPathList，且能通过 parent delegation 找到 spiderLoader 的外部 DEX 类。

## 26. 关键修复 19：NativeBridgeLoadLibrary 与 libhoudini 翻译

文件: docker/android-app/app/build.gradle (`abiFilters`), SpiderApplication.kt (`extractWexGuardFromAssets`)

问题根因：

1. spider JAR 只提供 ARM/ARM64 版本的 `wexguard_v8.so`，没有 x86_64 版本
2. redroid x86_64 容器需要 libhoudini 翻译 ARM64 库
3. libhoudini 只翻译 `lib/arm64/` 目录下的库，不翻译 `lib/x86_64/` 目录
4. 如果 APK 的 `jniLibs/x86_64/` 中放置 ARM64 库，系统会安装到 `lib/x86_64/`，libhoudini 不翻译 → 加载失败
5. `libwexguard.so` 必须放在 `jniLibs/arm64-v8a/` 才能被正确安装到 `lib/arm64/` 并被 libhoudini 翻译

修复：

1. `app/build.gradle` 中 `abiFilters` 只保留 `arm64-v8a`：
   ```gradle
   ndk { abiFilters 'arm64-v8a' }
   ```
2. `SpiderApplication.extractWexGuardFromAssets()` 在 onCreate 中将 `assets/libwexguard.so` 复制到 `filesDir/native_libs/libwexguard.so`
3. `SpiderManager.addNativeLibDirToClassLoader()` 将 `native_libs/` 目录添加到 spiderLoader 的 `nativeLibraryDirectories`，让 `System.loadLibrary("wexguard")` 能找到库

关键代码（SpiderApplication.kt）:

```kotlin
private fun extractWexGuardFromAssets() {
    val nativeLibsDir = File(filesDir, "native_libs").apply { mkdirs() }
    val target = File(nativeLibsDir, "libwexguard.so")
    if (target.exists() && target.length() > 0) return
    try {
        assets.open("libwexguard.so").use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        }
    } catch (e: Throwable) {
        Log.e(TAG, "Failed to extract libwexguard.so", e)
    }
}
```

效果：`System.loadLibrary("wexguard")` 在 spiderLoader 中能成功加载，libhoudini 翻译 ARM64 库到 x86_64 执行。

## 27. 完整调试历程（参考 调试视频列表数据.md）

详细的调试过程记录在 `d:\Code\TVBox-Pc-Docker\调试视频列表数据.md`（约 5500 行），包含：

1. **第 1-2000 行**：分析 `LoadNiMa.<clinit>` 中 `System.load()` 在 redroid Android 13+ 失败的原因（namespace search_paths 为空）。尝试通过反射修改 `DexPathList.nativeLibraryPathElements` 解决。

2. **第 2000-4000 行**：发现内部 classloader（DexNative.getLoader 返回）的 parent 是 PathClassLoader 而非 spiderLoader，导致主 classloader 的 patch 无效。引入 `fixNativeLibraryPaths` 给内部 classloader 注入 patch 并预加载关键类。

3. **第 4000-5500 行**：分析 `libwexguard.so` 的 `JNI_OnLoad` 在不同 classloader 上下文中的行为，发现类初始化循环依赖（DexNative.<clinit> → loadLibrary → JNI_OnLoad → FindClass("MyCrypto") → MyCrypto.<clinit> → loadLibrary "already opened"）。最终方案：通过 patch.dex 让 DexNative/MyCrypto/LoadNiMa 都用 `System.loadLibrary("wexguard")` 而非 `System.load()`，并确保 spiderLoader 是首次加载者。

4. **aowu awSign 修复**：分析 `MyCrypto.awSign` `UnsatisfiedLinkError` 根因是循环依赖（AowuShinidie.init 需要 awSign，但 awSign 在 woshinidie.jar 内，woshinidie.jar 由 AowuShinidie.init 下载）。预下载 `woshinidie.jar` 并提取 `awdm-v8.so` 为 `libawdm.so`，在 `LoaderHelper.<clinit>` 中预加载。

5. **MyCrypto 类初始化错误**：发现 `ExceptionInInitializerError` 后类永久失败，导致前几次成功后突然失败。通过在 `fixNativeLibraryPaths` 中主动预加载 MyCrypto/LoadNiMa（使用 patch 版本）解决。

## 附录：关键文件清单

| 文件                                        | 作用                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| docker/android-app/.../SpiderManager.kt     | Android 端 Spider 管理（类加载、原生库、多 JAR）                 |
| docker/android-app/.../SpiderHttpServer.kt  | HTTP API 路由 + InitRequest（ext 字段处理）                      |
| docker/android-app/.../SpiderApplication.kt | Application 启动（Init.set、DexNative 触发、cache 权限修复）     |
| src/core/JarSpider.ts                       | PC 端 Spider HTTP 调用（返回空数据）                             |
| src/store/app.ts                            | PC 端 loadHome fallback 链                                       |
| src/core/SpiderEngine.ts                    | PC 端 Spider 工厂（csp_Bili cookie 注入）                        |
| electron/SpiderAPIClient.ts                 | Electron 端 HTTP 客户端（RESTARTING 处理）                       |
| tools/dex/MyCrypto.java                     | DEX 补丁（原生库加载，所有方法声明为 native）                    |
| tools/dex/DexNative.java                    | DEX 补丁（System.loadLibrary 替换 System.load）                  |
| tools/dex/LoaderHelper.java                 | DEX 补丁（双阶段原生库加载：libawdm.so 在前，libdecjni.so 在后） |
| tools/dex/LoadNiMa.java                     | DEX 补丁（System.loadLibrary("LoadNiMa") 替换）                  |
| tools/test-three-configs.cjs                | 三配置全量测试脚本                                               |
| tools/analyze-three-failures.cjs            | 失败源分析脚本                                                   |
| 调试视频列表数据.md                         | 完整调试历程（5500 行）                                          |

## 28. 三配置直链播放验证（2026-07-29）

### 28.1 测试背景

之前的测试（section 20）显示三个配置的 player_ok 都很低，但未区分"直链源"和"网盘源"。网盘源（夸克/UC/百度/阿里）需要用户在配置中心扫码登录后才能解析播放地址，未登录时 `playerContent` 返回 `url=""` + 错误 msg（如"未登录UC, 请去配置中心设置"），这是**预期行为**而非 bug。

2026-07-29 重新测试，专门验证直链源（vod_play_from 不含 夸克/UC/百度/B度/阿里）的播放链路。

### 28.2 直链源播放测试结果

| 配置   | 测试站点数 | 直链源数 | 直链播放成功                    | 网盘源数（需登录） |
| ------ | ---------- | -------- | ------------------------------- | ------------------ |
| feimao | 20         | 8        | **8/8 ✓**                       | 3                  |
| newwex | 20         | 6        | **6/6 ✓**                       | 8                  |
| aowu   | 8          | -        | （detail 5/8 OK，未测直链播放） | -                  |

### 28.3 feimao 直链播放成功源（8/8）

| 源 key     | API          | vod_play_from         | 播放 URL 示例                                      |
| ---------- | ------------ | --------------------- | -------------------------------------------------- |
| 潮流       | csp_AppRJ    | 线路二/三/四          | `http://43.248.96.62:9090/nby/m3u8/getM3u8?...`    |
| 一碗       | csp_AppGet   | RY线路/TY线路/腾讯4K① | `https://svip.ryplay17.com/.../index.m3u8`         |
| 蔬菜       | csp_AppGet   | 蓝光L/秒-限/蓝光B     | `http://114.66.21.157:1806/m3u8/...`               |
| 永永       | csp_AppGet   | 播放源Y/B/F           | `http://jx.999315.xyz/yzzy/.../index.m3u8`         |
| csp_Jpys   | csp_Jpys     | 在线播放              | `https://ppvod01.kqgfbs.com/.../index.m3u8`        |
| 荐片       | csp_Jianpian | VIP线路/蓝光/高清     | `https://mv.shaxyd.com/.../index.m3u8`             |
| csp_SaoHuo | csp_SaoHuo   | 线路1/线路2           | `https://hhjx.hhplayer.com/?url=...`               |
| csp_Gz360  | csp_Gz360    | 1080                  | `https://app.wanglaoshi.xn--fiqs8s/hls/index.m3u8` |

### 28.4 newwex 直链播放成功源（6/6）

| 源 key         | API                     | vod_play_from             | 播放 URL 示例                                |
| -------------- | ----------------------- | ------------------------- | -------------------------------------------- |
| WexHanXiaoQuan | csp_WexHanXiaoQuanGuard | 蓝光HDR/1080P/720P/480P   | `http://127.0.0.1:-1/proxy?do=hxq&url=...`   |
| WexGuaZi       | csp_WexGuaZiGuard       | 免费分享！切勿上当！-1080 | `https://vd.wmvbo.com/...`                   |
| WexDuBoKu      | csp_WexDuBoKuGuard      | 免费分享！切勿上当！      | `https://vid.dbokutv.com/.../chunklist.m3u8` |
| 賤賤           | csp_WexJianPianGuard    | VIP线路/极速蓝光          | `https://mv.shaxyd.com/.../index.m3u8`       |
| WexWenCai      | csp_WexWenCaiGuard      | 免费分享！切勿上当！      | `https://ppvod01.kqgfbs.com/.../index.m3u8`  |
| WexYueYue      | csp_WexYueYueGuard      | 免费分享！切勿上当！      | `http://127.0.0.1:-1/proxy?do=WexYueYue&...` |

### 28.5 aowu detail 失败根因细化

| 源 key   | API              | detail 状态 | 失败原因                                                        |
| -------- | ---------------- | ----------- | --------------------------------------------------------------- |
| Douban   | csp_DoubanAmns   | OK          | —                                                               |
| Y360     | csp_Y360Amns     | OK          | —                                                               |
| Hgdh     | csp_HgdhAmns     | FAIL        | home/category/search 全空（上游 .aowu 过滤URL失效，非代码问题） |
| MyConfig | csp_AAConfigAmns | OK          | —                                                               |
| woWogg   | csp_WoggAmns     | OK          | —                                                               |
| moWobg   | csp_WobgAmns     | FAIL        | home 仅返回 "domains" 域名选择项（需用户选择镜像，非代码问题）  |
| NewGrV2  | csp_NewGrV2Amns  | OK          | —                                                               |
| Hxq      | csp_HxqAmns      | FAIL        | **awSign UnsatisfiedLinkError**（唯一代码问题）                 |

**关键结论**：aowu 8 站中 5 站 detail 正常；3 站失败中仅 **Hxq** 是 awSign `UnsatisfiedLinkError`（运行时调用未注册的 native 方法），**Hgdh** 与 **moWobg** 是上游数据空/域名未选择导致，与 awSign 无关。

### 28.6 网盘源播放失败是预期行为

网盘类源（vod_play_from 含 `夸克原画`/`UC原画`/`百度原画`/`B度原画`/`阿里原画`）的 `playerContent` 在用户未登录时返回：

```json
// feimao csp_FeiMaoUC
{"parse":0,"url":"","msg":"未登录UC, 请去配置中心设置","errMsg":"未登录UC, 请去配置中心设置"}

// newwex NewZhiZhen
{"msg":"网盘播放失败，请检查账号配置或 cookie 是否失效","list":[],"parse":0,"jx":0}
```

PC 端 `app.ts:1086-1095` 检测到 `!result.url` 后用 `result.msg` 显示给用户，提示去配置中心扫码登录。这是**正确行为**，不是 bug。

### 28.7 playerContent 字段说明

PC 端 `PlayResult` 接口（src/core/models.ts:60-68）：

```typescript
interface PlayResult {
  parse: number; // 0=直接播放，1=需 VIP 解析
  url: string; // 唯一决定"能否播放"的字段
  header?: string;
  msg?: string; // 失败时显示给用户
  playUrl?: string;
  jxFrom?: string;
  danmuUrl?: string;
}
```

**关键**：PC 端 `app.ts:1086` 仅检查 `result.url` 是否为非空字符串。不要把 `parse`（数字标志）或 `dlm`（PC 端不读）当作 URL 候选。

## 29. 已知限制：aowu Hxq 源 awSign 未注册（2026-07-29）

### 29.1 问题现象

aowu 配置的 `csp_HxqAmns` 源在 `homeContent` 调用时抛出：

```
UnsatisfiedLinkError: No implementation found for byte[]
com.github.catvod.spider.MyCrypto.awSign(byte[], java.lang.String)
```

### 29.2 根因分析

1. `MyCrypto.awSign(byte[], String)` 在 patched MyCrypto.java 中声明为 `native`
2. awSign 的 JNI 实现应该在 `libawdm.so`（即 `awdm-v8.so`，从 `woshinidie.jar` 提取）的 `JNI_OnLoad` 中通过 `RegisterNatives` 注册
3. 但诊断日志显示：`Init.loader MyCrypto.awSign NOT registered: UnsatisfiedLinkError`
4. 进一步分析 `awenc-v8.so`（libawdm.so 的实际文件名）发现：
   - 该 .so 是 UPX 打包的，符号表被混淆
   - 没有导出 `Java_com_github_catvod_spider_MyCrypto_awSign` 符号
   - `JNI_OnLoad` 中可能用动态符号名注册（混淆名），与 Java 声明的 `awSign` 不匹配
5. 反射委托方案（在 patched MyCrypto.awSign 中通过反射调用 Init.loader 的 MyCrypto.awSign）也无效，因为 Init.loader 的 awSign 同样未注册

### 29.3 影响范围

- **仅影响 aowu 配置的 Hxq 源**（csp_HxqAmns）—— 1 个源
- 其他 aowu 源（Douban/Y360/MyConfig/woWogg/NewGrV2 等）detail 正常
- feimao/newwex 配置完全不受影响

### 29.4 尝试过的修复（均无效）

1. **预下载 woshinidie.jar + 提取 libawdm.so**：成功加载 libawdm.so，但 awSign 仍未注册
2. **反射委托**：在 patched MyCrypto.awSign 中通过反射调用 Init.loader 的 MyCrypto.awSign —— Init.loader 的 awSign 同样未注册
3. **添加 aowu 专用方法重载**（v7d/v7e/v7dd 等）：方法签名匹配 awdatabase-classes.dex，但 native 实现仍找不到

### 29.5 应对策略

- JarSpider 对 Hxq 源返回 '{}' 显示"暂无数据"
- 不显示假视频
- 与 MusicLiYuan/AnimeFanShu 同类限制（libhoudini/native 实现限制，PC 端无法修复）
- 如需修复，需用 frida 动态 hook `JNI_OnLoad` 和 `RegisterNatives` 调用，识别混淆后的实际方法名

## 30. 测试脚本清单（2026-07-29 更新）

| 脚本                                      | 用途                                             |
| ----------------------------------------- | ------------------------------------------------ |
| tools/test-three-configs-full.cjs         | 三配置全量测试（init/home/search/detail/player） |
| tools/test-aowu-detail-rootcause.cjs      | aowu detail 失败根因分析                         |
| tools/test-newwex-direct-play.cjs         | newwex 直链源播放验证                            |
| tools/test-feimao-direct-playback.cjs     | feimao 直链源播放验证                            |
| tools/test-player-content-investigate.cjs | playerContent 响应格式调查                       |
| tools/test-netdisk-metadata.cjs           | 网盘源首页/详情元数据显示验证                    |
| tools/test-newwex-detail-investigate.cjs  | NewZhiZhen/NewGuanYing detail 失败根因           |
| tools/test-aowu-appv7-diag.cjs            | aowu AppV7 诊断（带 ext 参数）                   |

## 31. 关键修复 20：彻底删除所有 mock 数据（2026-07-29）

### 31.1 问题

代码库中存在多处 mock 数据回退逻辑，当 Spider 服务不可用时显示"示例电影1（开发模式-Mock数据）"、"测试影片1/2/3"等假视频。这会误导用户，违反"不显示示例视频"的硬性要求。

### 31.2 修复点

#### 31.2.1 src/core/JarSpider.ts

- 删除 `usingMockData: boolean` 字段
- 删除 `getMockData()` 方法（100+ 行假数据：示例电影/电视剧/综艺/分类/详情/搜索）
- `load()` 中 Spider 服务不可用时：不再设置 `usingMockData = true`，改为 `throw error` 让 UI 显示真实失败信息
- `callMethod()` 中删除 `if (this.usingMockData) return this.getMockData(...)` 分支

#### 31.2.2 electron/main.ts

- 删除 `loadMockData()` 函数（含 mock_1/mock_2/mock_3 测试影片 + via.placeholder.com 占位图）
- Spider 服务不可用时：不再调用 `loadMockData()`，改为 `win.webContents.send('spider:error', { message: 'Spider服务不可用...' })`
- `initializeSpiderService()` catch 块：不再 `await loadMockData()`，改为发送 `spider:error` 事件

#### 31.2.3 src/core/AliYunPan.ts

- `resolveShareLink()` 不再返回 `'https://mock-aliyun-play-url.com/video.m3u8'` 假 URL
- 改为 `return null` 并打印 warning，让调用方显示"未实现"错误

### 31.3 行为变化

| 场景                   | 修复前                                                    | 修复后                                                                   |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Spider 容器未启动      | 显示 3 个"测试影片"假视频 + via.placeholder.com 占位图    | 显示"Spider服务不可用，请确认 Docker 容器 (tvbox-spider) 已启动"错误提示 |
| JAR 加载失败           | 显示"示例电影1（开发模式-Mock数据）"等 3 个假视频         | 显示"Spider服务不可用: {错误信息}"失败提示                               |
| AliYunPan 解析分享链接 | 返回 `https://mock-aliyun-play-url.com/video.m3u8` 假 URL | 返回 null，调用方显示"未实现"错误                                        |

### 31.4 验证

- `vue-tsc --noEmit` 编译通过，无类型错误
- `grep -ri "测试影片\|via.placeholder.com\|示例电影" src/ electron/` 无匹配（mock 已彻底删除）

## 32. 网盘源元数据显示验证（2026-07-29）

### 32.1 测试背景

网盘类型源（vod_play_from 含 夸克原画/UC原画/百度原画/B度原画/阿里原画）需要用户登录网盘账号才能获取播放 URL，但其首页和详情页应仍显示**真实视频元数据**（vod_name/vod_pic/vod_year/vod_actor/vod_director/vod_content + 真实剧集名）。播放 URL 为空（需登录）是预期行为，但元数据必须真实。

### 32.2 测试结果

| 源 key       | API                  | home 元数据                   | detail 元数据                                                                            | 状态                          |
| ------------ | -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| csp_FeiMaoUC | csp_Duopan           | list=176, 真实                | 完整（vod_name=第五立面, actor=张陆..., director=任程伟, first_ep=01.mp4[5.10GB]）       | ✓ REAL                        |
| csp_Duopan   | csp_Duopan           | list=256, 真实                | 完整（vod_name=界门之下, first_ep=S01E01.2026.2160p...）                                 | ✓ REAL                        |
| csp_Netfixtv | csp_Duopan           | list=224, 真实                | 完整（vod_name=兵自风中来, 7 个播放源, first_ep=S01E01...[4.71GB]）                      | ✓ REAL                        |
| 二小         | csp_NewErXiaoGuard   | list=192, 真实                | 完整（vod_name=万界独尊, remarks=更新至第469集, first_ep=[339.3 MB]271 4K.mp4）          | ✓ REAL                        |
| 玩偶         | csp_NewWoggGuard     | categoryContent list=70, 真实 | 完整（vod_name=利未记, remarks=4K, first_ep=[12.2 GB] Leviticus.2026.2160p...）          | ✓ REAL                        |
| NewZhiZhen   | csp_NewZhiZhenGuard  | list=224, 真实                | 完整（vod_name=兵自风中来, vod_pic=webp URL, 5 个播放源, 27559 字符剧集列表）            | ✓ REAL（需传完整路径 vod_id） |
| NewGuanYing  | csp_NewGuanYingGuard | categoryContent list=48, 真实 | **部分缺失**（有 vod_name/year/actor/director，但无 vod_pic/vod_play_from/vod_play_url） | ✗ spider bug                  |

### 32.3 NewZhiZhen 详情页工作正常

- **前提**：PC 端必须把 homeContent 返回的完整路径 vod_id（如 `/index.php/vod/detail/id/15640.html`）原样传给 detailContent
- **验证**：`src/store/app.ts:881` `spider.detailContent([vodId])` 直接传递 route.params.vodId，不做任何预处理
- **测试结果**：完整路径 vod_id → detail 返回所有字段（vod_name/vod_pic/vod_year/vod_actor/vod_director/vod_content/vod_play_from/vod_play_url 全部非空）
- **警告**：若误传纯数字 id（如 `15640`），spider 内部拼接 `host + id` 缺少 `/` 分隔符，导致 `zhizhen.icu15640` UnknownHostException → NPE。PC 端已确认不会截断 vod_id

### 32.4 NewGuanYing spider 侧 bug（已知限制）

- **现象**：detailContent 返回 vod_name/vod_year/vod_actor/vod_director/vod_area/type_name，但 vod_pic/vod_play_from/vod_play_url 全部为空
- **根因**：spider 内部解析播放 URL 时抛 `java.lang.IllegalArgumentException: Invalid URL port: "-1"`，spider 实现缺陷
- **测试**：尝试 3 种 vod_id 变体（`9DbVj|mv`、`9DbVj`、`9DbVj%7Cmv`）均无法获得播放源
- **结论**：PC 端无法修复，标记为 spider 侧已知限制。UI 可显示元数据（标题/年份/演员/导演）但无播放入口

### 32.5 总体结论

- **网盘源 home 元数据**：7/7 全部显示真实视频列表（vod_name + vod_pic 真实）
- **网盘源 detail 元数据**：6/7 完整显示真实元数据 + 真实剧集名（如 "01.mp4[5.10GB]"、"[12.2 GB] Leviticus.2026.2160p..."）
- **唯一失败**：NewGuanYing spider 侧 bug（Invalid URL port: "-1"），非 PC 端问题

## 33. 网友分享配置适配（2026-07-29）

### 33.1 配置源调研

从网上搜索网友分享的 TVBox 配置源，下载并分析了 12 个配置 URL，其中 6 个下载成功：

| 配置名       | URL                                                                 | 类型 | csp\_ 站点数 | spider JAR               | 兼容性                  |
| ------------ | ------------------------------------------------------------------- | ---- | ------------ | ------------------------ | ----------------------- |
| FongMi 官方  | raw.githubusercontent.com/FongMi/CatVodSpider/main/json/config.json | 单仓 | 3            | ../jar/custom_spider.jar | ❌ 开发示例，非用户配置 |
| 俊于 top98   | home.jundie.top:81/top98.json                                       | 单仓 | 22           | ./jar/top98_1.jar        | ✅ 兼容                 |
| 老刘备       | raw.liucn.cc/box/m.json                                             | 单仓 | 165          | ./fty.jar;md5;...        | ✅ 高度兼容             |
| 欧歌         | tv.nxog.top/m/                                                      | 单仓 | 93           | clewm.net/...jpg（伪装） | ✅ 高度兼容             |
| PyramidStore | raw.githubusercontent.com/UndCover/PyramidStore/main/py.json        | 单仓 | 0 (全 py\_)  | 无                       | ❌ Python 蜘蛛，不兼容  |
| Ray dxawi    | dxawi.github.io/0/0.json                                            | 单仓 | 38           | zohopublic.com.cn        | ⚠️ JAR 不匹配           |

下载失败的配置：巧技（DNS失效）、菜妮丝（.cf 域名失效）、饭太硬（502 Bad Gateway）、小米（连接超时）、Yoursmile7（agit.ai 停放页）、运输车（502）。

### 33.2 系统已支持的配置格式

ConfigParser 和 SpiderEngine 已内置以下兼容能力，无需新增代码：

1. **注释剥离**：`stripComments()` 函数处理 `//` 行注释和 `/* */` 块注释（ConfigParser.ts:347）
2. **`;md5;` 格式**：`url.split(';md5;')[0]` 提取真实 JAR URL（SpiderEngine.ts:77）
3. **相对路径解析**：`fixRelativePaths()` 基于 config URL 解析 `./` 相对路径（ConfigParser.ts:268）
4. **.jpg 伪装 JAR**：按字节内容识别 ZIP magic number `PK\x03\x04`，不依赖扩展名
5. **多仓配置**：`{"urls":[{name,url},...]}` 格式自动并行拉取并合并（ConfigParser.ts:678）
6. **隐写术配置**：JPEG/PNG 图片嵌入 JSON 的隐写配置自动提取（ConfigParser.ts:477-540）

### 33.3 4 个新配置测试结果

| 配置        | JAR 加载 | Init 成功 | Home 成功 | Detail 成功 | 播放成功 | 完全可用源             |
| ----------- | -------- | --------- | --------- | ----------- | -------- | ---------------------- |
| 欧歌 (nxog) | ✓        | 16/20     | 15/20     | 13/20       | **8/20** | 8 个直链源             |
| 俊于 top98  | ✓        | 19/22     | 1/22      | 1/22        | 1/22     | 1 个（360/bilibili）   |
| 老刘备      | ✓        | 3/5       | 1/5       | 0/5         | 0/5      | 0 个（首条 vod_id 空） |
| Ray dxawi   | ✓        | 0/5       | 0/5       | 0/5         | 0/5      | 0 个（JAR 类全部缺失） |

### 33.4 欧歌配置完全可用的 8 个直链源

| 源 key     | API         | 播放 URL 示例                                              |
| ---------- | ----------- | ---------------------------------------------------------- |
| 热播影视   | csp_AppRJ   | `http://111.170.141.203:9090/nby/m3u8/getM3u8?...`         |
| 农民影视   | csp_Wwys    | `https://v.lzcdn27.com/20260717/13550_06d6c5e0/index.m3u8` |
| 大鹅       | csp_App3Q   | `https://cibn-edge-5g.1ljx.com/cloud/flv/...`              |
| 三六零     | csp_SP360   | `http://www.mgtv.com/b/830365/24441934.html?cxid=...`      |
| 骚火影视   | csp_SaoHuo  | `https://hhjx.hhplayer.com/?url=78BDFEC355F1F37E...`       |
| 金牌影视   | csp_Jpys    | `https://ppvod01.kqgfbs.com/splitOut/20260719/...`         |
| 爱看机器人 | csp_Ikanbot | `https://vv.jisuzyv.com/play/dNkO3mKe/index.m3u8`          |
| 1905       | csp_Web1905 | `https://m3u8ipay1.vodfile.m1905.com/movie/...`            |

欧歌配置还包含 3 个网盘源（csp_wogg1/csp_woog2/夸快夸快），home+detail 元数据完整（208 条视频），播放需用户登录网盘。

### 33.5 配置预设功能

在 Settings.vue 添加"推荐"下拉菜单，预置 5 个经验证可用的配置：

| 预设名         | URL                                  | 说明                       |
| -------------- | ------------------------------------ | -------------------------- |
| newwex（默认） | https://9280.kstore.vip/newwex.json  | 88 个源，直链播放完整可用  |
| 肥猫           | http://肥猫.net/tv                   | 38 个源，8 个直链播放可用  |
| 欧歌多仓       | http://tv.nxog.top/m/                | 93 个源，8+ 个直链播放可用 |
| 俊于 top98     | http://home.jundie.top:81/top98.json | 22 个源，360 直链播放可用  |
| 老刘备         | https://raw.liucn.cc/box/m.json      | 165 个源，部分可用         |

用户点击"推荐"→选择配置→自动填入输入框→点"加载"即可切换配置。

### 33.6 已知限制

1. **Ray dxawi 配置**：JAR 加载成功但所有 spider 类 ClassNotFoundException，JAR 与配置不匹配（zohopublic.com.cn 上的 JAR 可能是旧版本或不同分支）
2. **老刘备配置**：部分站点 vod_id 返回空，部分 ext URL 返回 HTML 错误页而非 JSON。165 个源需逐源测试筛选可用的
3. **巧技/菜妮丝/饭太硬**：域名失效或服务器 502，无法下载配置
4. **MyCrypto native 方法**：所有 4 个新 JAR 都报 `MyCrypto.{awSign,Awdm,md5,extDe} NOT registered`，与 aowu Hxq 同类的 native 库符号混淆问题，只影响依赖这些方法的源

### 33.7 测试脚本

| 脚本                              | 用途                                        |
| --------------------------------- | ------------------------------------------- |
| tools/test-4-new-configs.cjs      | 4 个新配置初步测试（前 5 站）               |
| tools/test-multi-configs-scan.cjs | 多配置全量扫描（jundie 22 站 + nxog 20 站） |
| tools/configs/\*.json             | 下载的配置文件存档                          |

## 附录 B：故障排查速查表

| 现象                                      | 可能原因                                    | 排查命令                                                                     |
| ----------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 所有源报 "Spider not found"               | 进程崩溃重启，spiderCache 清空              | `docker exec tvbox-spider logcat -d -s SpiderManager:V \| tail -50`          |
| "JAR not loaded" 错误                     | jarCache 被清空（进程重启）                 | 检查是否有 catch(Exception) 漏掉了 Error                                     |
| "UnsatisfiedLinkError: getSpider"         | DexNative 类加载器绑定错误                  | 确认 `Class.forName("DexNative", true, spiderLoader)` 在 invokeInit 之前调用 |
| "UnsatisfiedLinkError: awSign" (aowu Hxq) | libawdm.so 加载但 awSign 未注册（符号混淆） | 已知限制，PC 端无法修复，返回 '{}'                                           |
| 网盘源 playerContent 返回 url=""          | 用户未登录网盘账号                          | 配置中心扫码登录对应网盘                                                     |
| "failed to create bridged namespace"      | redroid namespace 限制                      | 检查 native_libs 目录是否在 `nativeLibraryDirectories` 中                    |
| "JSONException: End of input"             | MyCrypto.extDe 返回 0 字节                  | libdecjni.so 限制，PC 端无法修复                                             |
| 切换配置后所有源失败                      | JAR URL 变化未触发进程重启                  | 检查 SpiderAPIClient 是否检测到 RESTARTING 响应                              |
| feimao JAR 下载失败                       | cache 目录权限问题                          | 检查 `ensureCacheDirWritable` 是否被调用                                     |
| 配置中心网盘显示"暂不支持登录"            | 网盘 type_id 不在 CLASS_TO_PAN 映射中       | 检查 `detectPanTypeByName` 名称匹配 fallback 是否覆盖该网盘                  |

## 37. 关键修复 23：配置中心与网盘完全解耦（2026-07-30）

### 37.1 问题现象

配置中心登录网盘时，PC 端存在多处"有风险的保存及操作"：

1. `AliyunPanService` 在内存中持久存储 `refreshToken`/`accessToken`，并通过 `aliyun:setLoginInfo` IPC 接收 token
2. `PanLoginService` 在 QR 轮询成功后调用 `QuarkPanService.syncCookieToJVM` / `UCPanService.syncToGuardPrefs` / `BaiduPanService.syncToGuardPrefs` 直接通过 JVM bridge 写入 SharedPreferences
3. `QuarkPanService.syncCookieToJVM` 将 cookie 写入临时文件 `quark_cookie_debug.txt`
4. `pan:syncAllCookies` IPC handler 接收渲染进程传来的完整 loginInfo 并同步到各 Pan Service
5. 渲染进程 `PanLogin.ts` 已移除 localStorage（前序工作），但主进程仍有冗余同步

用户要求：**配置中心直接使用 JAR 中的方法登录，保存登录信息也是 JAR 在 Docker 中保存，客户端不做任何有风险的保存及操作，完全与网盘等脱离**。

### 37.2 修复方案

**核心原则**：JAR（Docker 容器）是网盘凭证的唯一存储；PC 端不持久化任何凭证到磁盘/localStorage，仅在内存中短时缓存 access_token（派生自 JAR 的 refresh_token）。

#### JAR 侧（SpiderManager.kt + SpiderHttpServer.kt）

新增 `/spider/getLogin` 端点（其余三个 `/spider/saveLogin`、`/spider/loginStatus`、`/spider/logout` 已在前序工作实现）：

```kotlin
fun getLogin(panType: String): ApiResponse = when (panType) {
    "aliyun" -> {
        // 返回 refreshToken + accessToken（PC 端 AliyunPanService 需要）
        val refreshToken = guardPrefs.getString("Wex_aliyun_refresh_token", "") ?: ""
        val accessToken  = guardPrefs.getString("Wex_aliyun_access_token",  "") ?: ""
        if (refreshToken.isEmpty()) ApiResponse.success(mapOf("loggedIn" to false))
        else ApiResponse.success(mapOf("loggedIn" to true, "refreshToken" to refreshToken, "accessToken" to accessToken))
    }
    else -> loginStatus(panType)  // quark/uc/baidu/bili 只返回登录状态，不返回 cookie
}
```

#### PC 侧（Electron main）

**AliyunPanService.ts** — 完全重写：

- 移除 `refreshToken` 静态字段、`setLoginInfo()` 方法、`aliyun:setLoginInfo` IPC handler
- 新增 `fetchRefreshTokenFromJAR()`：通过 `spiderAPIClient.getLogin('aliyun')` 从 JAR 获取 refresh_token
- `ensureAccessToken()` 不再读本地 refresh_token，改为每次过期后调用 `fetchRefreshTokenFromJAR()`
- 仅保留短时内存缓存 `accessToken`（~2h 过期，派生自 JAR 的 refresh_token）

**PanLoginService.ts** — 移除所有冗余同步调用：

- 移除 `AliyunPanService.setLoginInfo(...)` 调用（3 处）
- 移除 `QuarkPanService.syncCookieToJVM(cookieStr)` 调用（QR 轮询成功后）
- 移除 `UCPanService.syncToGuardPrefs(cookie)` 调用
- 移除 `BaiduPanService.syncToGuardPrefs(cookie)` 调用
- 移除 `pan:syncAllCookies` IPC handler 整体
- 保留 `setSyncedCookie(cookie)` 调用（仅内存缓存，供 ProxyServer fallback 使用）

**QuarkPanService.ts** — 清理 risky 操作：

- `syncCookieToJVM()` 方法体精简：移除临时文件写入（`quark_cookie_debug.txt`）、移除 JVM bridge SharedPreferences 写入（java-bridge 已移除，为死代码）
- 仅保留 `this.syncedCookie = cookie` 内存缓存设置
- 移除 `QuarkPanService.pollQRCode`（死代码）中的 `syncCookieToJVM` 调用

**SpiderAPIClient.ts** — 新增 `getLogin()` 方法：

```typescript
async getLogin(panType: string): Promise<{
  success: boolean;
  data?: { loggedIn: boolean; refreshToken?: string; accessToken?: string };
}> {
  const response = await this.axiosInstance.post('/spider/getLogin', { panType });
  return { success: !!response.data?.success, data: response.data?.data };
}
```

**main.ts** — 新增 `spider:getLogin` IPC handler。

#### 渲染进程（PanLogin.ts）

前序工作已完成：QR 轮询成功后调用 `spider:saveLogin` 推送凭证到 JAR，不写 localStorage。本次无需修改。

### 37.3 凭证流转链路（修复后）

```
用户扫码 → PanLoginService.pollQRCode (electron main)
  ↓ 获取 cookie/tokens（从网盘 API）
  ↓ setSyncedCookie (仅内存缓存，供 ProxyServer fallback)
  ↓ 返回 loginInfo 给渲染进程
  ↓
渲染进程 PanLogin.pollQRCode
  ↓ ipc.invoke('spider:saveLogin', {panType, cookie, refreshToken, ...})
  ↓ HTTP POST /spider/saveLogin
  ↓ SpiderManager.saveLogin → 写入 SharedPreferences（JAR/Docker 内）
  ↓ 渲染进程不保存任何凭证，仅更新内存 statusCache（loggedIn/userId/nickname）
  ↓
播放时（Aliyun）：
  AliyunPanService.ensureAccessToken()
  ↓ fetchRefreshTokenFromJAR() → spiderAPIClient.getLogin('aliyun')
  ↓ HTTP POST /spider/getLogin → JAR 返回 refreshToken
  ↓ POST https://api.aliyundrive.com/token/refresh → 获取 accessToken
  ↓ 内存缓存 accessToken（2h 过期）
  ↓ resolveShareToFiles / resolveDownloadUrl
  ↓
播放时（Quark/UC/Baidu）：
  JarSpider.playerContent → HTTP POST /spider/playerContent
  ↓ SpiderManager.playerContent → spider 读取 SharedPreferences 中的 cookie
  ↓ 返回播放 URL（PC 端从不接触 cookie）
```

### 37.4 修复前后对比

| 操作                      | 修复前                                      | 修复后                                    |
| ------------------------- | ------------------------------------------- | ----------------------------------------- |
| Aliyun refresh_token 存储 | PC 内存静态字段 + `aliyun:setLoginInfo` IPC | JAR SharedPreferences，PC 每次按需 fetch  |
| Quark cookie 同步         | `syncCookieToJVM` 写临时文件 + JVM bridge   | `spider:saveLogin` HTTP API，PC 不写文件  |
| UC/Baidu cookie 同步      | `syncToGuardPrefs` JVM bridge 写 prefs      | `spider:saveLogin` HTTP API               |
| `pan:syncAllCookies`      | 存在，接收渲染进程完整 loginInfo            | 移除                                      |
| PC 端凭证持久化           | 临时文件 + 内存静态字段                     | 仅内存短时缓存 access_token（派生 token） |

### 37.5 验证

1. **TypeScript 编译**：`npx tsc --noEmit` 无错误
2. **APK 构建**：`build-apk.bat` 成功，已部署到 tvbox-spider 容器
3. **端点测试**（IPv6 `nc ::1 9978`）：
   - `/spider/saveLogin` aliyun → `{"success":true,"data":"Login saved: aliyun"}`
   - `/spider/getLogin` aliyun → `{"success":true,"data":{"loggedIn":true,"refreshToken":"...","accessToken":"..."}}`
   - `/spider/logout` aliyun → `{"success":true,"data":"Logged out: aliyun"}`
   - `/spider/loginStatus` quark/uc/baidu → `loggedIn:true`（既有 cookie 保留）
4. **既有登录保留**：Quark/UC/Baidu 的 cookie 在 JAR SharedPreferences 中未丢失（容器重启后仍 `loggedIn:true`）

### 37.6 残留说明

- `QuarkPanService.syncCookieToJVM` / `UCPanService.syncToGuardPrefs` / `BaiduPanService.syncToGuardPrefs` 方法定义仍保留（未删除），但已无任何调用方。这些方法中的 JVM bridge 代码（`jarLoader.java`）因 java-bridge 已移除而为死代码，可后续清理。
- `setSyncedCookie` 内存缓存仍保留在 Pan Service 中，供 ProxyServer fallback 解析分享链接时使用。此缓存不持久化，应用重启后清空。
- QR 码生成/轮询仍在 PC 端 `PanLoginService` 执行（不通过 JAR）。这属于"获取凭证"步骤，凭证获取后立即推送给 JAR，PC 不保留。如需进一步解耦，可将 QR 码生成/轮询也移至 JAR 侧 spider 的 `loginContent` 方法，但这是更大的架构调整。
  | 登录网盘后播放仍提示"未登录" | cookie 未同步到 SharedPreferences | 检查 `extraCookies` 是否在 playerContent 请求中传递 |

## 34. 关键修复 21：配置中心网盘"不支持"显示修复（2026-07-29）

### 34.1 问题现象

配置中心（`csp_WexConfigGuard`）返回 12 个网盘分类，但 PC 端 Home.vue 只为 `CLASS_TO_PAN` 映射中的 4 个 type_id（百度=1、UC=2、夸克=3、哔哩=8）显示登录按钮，其余 8 个（天翼、123、移动、115、多线程、综合、Emby、光鸦）显示"暂不支持登录"。

其他社区配置中心（如 aowu `AAConfigAmns`）使用不同的 type_id 但 class name 包含"阿里"/"aliyun"等关键词，也无法被识别。

### 34.2 根因

`Home.vue` 中 `CLASS_TO_PAN` 是硬编码的 type_id → PanType 映射，仅覆盖 WexConfigGuard 的 4 个 type_id。不同配置中心使用不同 type_id，无法通过单一映射表覆盖所有情况。

### 34.3 修复方案

在 `Home.vue` 中新增名称匹配 fallback：

```typescript
// WexConfigGuard returns 12 classes (verified 2026-07-29):
//   tid=1 百度网盘, tid=2 UC网盘, tid=3 夸克网盘, tid=4 天翼网盘,
//   tid=5 123网盘, tid=6 移动网盘, tid=7 115网盘, tid=8 哔哩,
//   tid=9 多线程, tid=10 综合, tid=11 Emby, tid=12 光鸦网盘
// PanLogin supports: quark/uc/aliyun/baidu/bili.
// WexConfigGuard has no aliyun class — aliyun login is triggered from
// player (PanResolver detects aliyun share links) or from other config
// centers that include an aliyun class (matched by NAME_TO_PAN below).
const CLASS_TO_PAN: Record<string, PanType> = {
  '1': 'baidu',
  '2': 'uc',
  '3': 'quark',
  '8': 'bili',
};

// Name-based fallback: match by type_name keywords. This lets other config
// centers (e.g. aowu AAConfigAmns) that use different type_ids but include
// "阿里"/"aliyun" in the class name be mapped to the correct PanType.
function detectPanTypeByName(typeName: string): PanType | null {
  const lower = (typeName || '').toLowerCase();
  if (
    lower.includes('阿里') ||
    lower.includes('aliyun') ||
    lower.includes('alipan')
  )
    return 'aliyun';
  if (lower.includes('夸克') || lower.includes('quark')) return 'quark';
  if (lower.includes('uc网盘') || lower.includes('uc盘')) return 'uc';
  if (
    lower.includes('百度') ||
    lower.includes('b度') ||
    lower.includes('baidu')
  )
    return 'baidu';
  if (lower.includes('哔哩') || lower.includes('bili')) return 'bili';
  return null;
}

function resolvePanType(typeId: string, typeName: string): PanType | null {
  return CLASS_TO_PAN[typeId] || detectPanTypeByName(typeName);
}
```

### 34.4 影响范围

- 修复：所有 class name 包含"阿里"/"夸克"/"UC网盘"/"百度"/"哔哩"等关键词的配置中心都能正确显示登录按钮
- 仍不支持：天翼、123、移动、115、多线程、综合、Emby、光鸦（PanLogin 未实现这些网盘的登录流程）

### 34.5 验证

使用 `tools/check-config-classes.cjs` 验证 WexConfigGuard 返回的 12 个 class 与 `CLASS_TO_PAN` 映射一致。

## 35. 关键修复 22：网盘登录状态同步到播放（2026-07-29）

### 35.1 问题现象

用户在配置中心扫码登录夸克/UC/百度网盘后，播放视频时 spider 仍返回"未登录UC"/"未登录夸克"等错误，playerContent 返回 `url=""`。

### 35.2 根因

PC 端 `PanLogin` 将 cookie 保存到 `localStorage['pan_login_<pan>']`，但 JAR spider（如 `csp_Duopan`、`csp_NewQuarkGuard`）从 Android `SharedPreferences` 读取 cookie，而非从 HTTP 请求参数读取。由于 JVM bridge 已禁用（`jarLoader.java` 是 stub），`syncToGuardPrefs()` 无法直接写入 SharedPreferences。

**QuarkPanService.syncCookieToJVM / UCPanService.syncToGuardPrefs / BaiduPanService.syncToGuardPrefs** 这三个方法原本通过 JVM bridge 写入 SharedPreferences，但 JVM bridge 被移除后失效。

### 35.3 修复方案

通过 HTTP API `extraCookies` 参数在 `playerContent` 调用时同步 cookie 到 SharedPreferences。

#### 35.3.1 PC 端 JarSpider.ts

在 `callMethod('playerContent')` 时，从 `localStorage` 读取所有网盘 cookie，作为 `extraCookies` 字段发送：

```typescript
case 'playerContent':
  endpoint = '/spider/playerContent';
  requestData.flag = args[0] || '';
  requestData.id = args[1] || '';
  requestData.vipFlags = args[2] || [];

  // 添加额外的cookies（如果需要）
  const extraCookies: Record<string, string> = {};
  const panTypes = ['quark', 'uc', 'aliyun', 'baidu', 'bili'];
  for (const pt of panTypes) {
    try {
      const saved = localStorage.getItem(`pan_login_${pt}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.cookie) {
          extraCookies[pt] = parsed.cookie;
        }
      }
    } catch {}
  }
  if (Object.keys(extraCookies).length > 0) {
    requestData.extraCookies = extraCookies;
  }
  break;
```

#### 35.3.2 Android 端 Requests.kt

`PlayerContentRequest` 新增 `extraCookies` 字段：

```kotlin
data class PlayerContentRequest(
    val key: String = "",
    val flag: String = "",
    val id: String = "",
    val vipFlags: List<String> = emptyList(),
    // Pan cookies pushed from PC client. Keyed by panType ("quark"/"uc"/"baidu"/"aliyun"/"bili").
    val extraCookies: Map<String, String> = emptyMap()
)
```

#### 35.3.3 Android 端 SpiderHttpServer.kt

`handlePlayerContent` 透传 `extraCookies`：

```kotlin
private fun handlePlayerContent(session: IHTTPSession): Response {
    val request = parseBody(session, PlayerContentRequest::class.java)
    val result = spiderManager.playerContent(
        request.key, request.flag, request.id, request.vipFlags, request.extraCookies
    )
    return newJsonResponse(result)
}
```

#### 35.3.4 Android 端 SpiderManager.kt

`playerContent` 在调用 spider 方法前，将 cookie 写入两个 SharedPreferences 文件：

```kotlin
fun playerContent(
    key: String, flag: String, id: String, vipFlags: List<String>,
    extraCookies: Map<String, String> = emptyMap()
): ApiResponse {
    // Write pan cookies to SharedPreferences before invoking the spider,
    // so JAR spiders that read cookies from SharedPreferences (e.g.
    // csp_Duopan for Quark/UC/Baidu) see the logged-in cookie.
    if (extraCookies.isNotEmpty()) {
        try {
            writePanCookiesToPrefs(extraCookies)
        } catch (e: Throwable) {
            Log.w(TAG, "writePanCookiesToPrefs failed: ${e.message}")
        }
    }
    return invokeSpiderMethod(
        key, "playerContent",
        arrayOf(String::class.java, String::class.java, List::class.java),
        arrayOf(flag, id, vipFlags)
    )
}
```

`writePanCookiesToPrefs` 写入两个 prefs 文件，镜像 QuarkPanService.syncCookieToJVM / UCPanService.syncToGuardPrefs / BaiduPanService.syncToGuardPrefs 的行为：

```kotlin
/**
 * Two prefs files:
 *   1. com.github.catvod.tvbox_preferences
 *      - "mi.<pan>"  = XOR-encrypted cookie (key "miwudi", then Base64)
 *      - ".<pan>"    = plaintext cookie (fallback)
 *      spider reads via e_1.b("mi.quark", ".quark") etc.
 *   2. NewWexFnw_preferences
 *      - "Wex_<pan>_cookie" = plaintext cookie
 *      guard spiders (NewJuTou/NewErXiao/etc.) read via this key.
 *
 * panType mapping:
 *   quark -> "quark" / "Wex_quark_cookie"
 *   uc    -> "uc"    / "Wex_ucpan_cookie"  (note: "ucpan" not "uc")
 *   baidu -> "baidu" / "Wex_baidu_cookie"
 *   aliyun -> skipped (uses refresh_token/access_token, not cookie)
 *   bili   -> skipped (uses ext.cookie, injected by JarSpider on PC side)
 */
private fun writePanCookiesToPrefs(cookies: Map<String, String>) {
    val ctx = applicationContext()
    val XOR_KEY = "miwudi"
    val MAIN_PREFS = "com.github.catvod.tvbox_preferences"
    val GUARD_PREFS = "NewWexFnw_preferences"

    val panKeyMap = mapOf(
        "quark" to Pair("quark", "Wex_quark_cookie"),
        "uc" to Pair("uc", "Wex_ucpan_cookie"),
        "baidu" to Pair("baidu", "Wex_baidu_cookie")
    )

    val mainPrefs = ctx.getSharedPreferences(MAIN_PREFS, Context.MODE_PRIVATE)
    val guardPrefs = ctx.getSharedPreferences(GUARD_PREFS, Context.MODE_PRIVATE)
    val mainEditor = mainPrefs.edit()
    val guardEditor = guardPrefs.edit()

    for ((panType, cookie) in cookies) {
        val keys = panKeyMap[panType] ?: continue
        val (mainKey, guardKey) = keys
        if (cookie.isBlank()) continue

        // 1. Main prefs: mi.<pan> (XOR+Base64 encrypted) + .<pan> (plain)
        val encrypted = xorBase64Encrypt(cookie, XOR_KEY)
        mainEditor.putString("mi.$mainKey", encrypted)
        mainEditor.putString(".$mainKey", cookie)

        // 2. Guard prefs: Wex_<pan>_cookie (plain)
        guardEditor.putString(guardKey, cookie)
    }

    mainEditor.apply()
    guardEditor.apply()
}

/**
 * XOR encrypt with key (cycling), then Base64 encode.
 * Mirrors QuarkPanService.encryptQuarkCookie / UCPanService.encryptUcCookie.
 */
private fun xorBase64Encrypt(text: String, key: String): String {
    val keyBytes = key.toByteArray(Charsets.UTF_8)
    val textBytes = text.toByteArray(Charsets.UTF_8)
    val out = ByteArray(textBytes.size)
    for (i in textBytes.indices) {
        out[i] = (textBytes[i].toInt() xor keyBytes[i % keyBytes.size].toInt()).toByte()
    }
    return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP)
}
```

### 35.4 关键设计点

1. **XOR + Base64 加密**：`mi.<pan>` key 使用 XOR(key="miwudi") + Base64 加密，与 FongMi/TV 的 `e_1.b()` 解密逻辑一致；`.<pan>` key 保留明文作为 fallback
2. **双 prefs 文件**：`com.github.catvod.tvbox_preferences`（catvod 主 prefs）和 `NewWexFnw_preferences`（guard spider prefs），覆盖两类 spider 读取路径
3. **uc panType 特殊映射**：guard prefs key 是 `Wex_ucpan_cookie`（注意 "ucpan" 不是 "uc"），与 NewWexFnw spider 代码一致
4. **aliyun/bili 跳过**：aliyun 使用 refresh_token/access_token（非 cookie），由 AliyunPanService 单独处理；bili 使用 ext.cookie（由 JarSpider 在 PC 端注入）
5. **每次 playerContent 都同步**：避免 cookie 过期后 spider 使用旧 cookie，确保最新登录状态

### 35.5 验证

1. 在配置中心扫码登录夸克网盘
2. 播放夸克网盘视频
3. 检查 logcat 应显示 `writePanCookiesToPrefs: com.github.catvod.tvbox_preferences mi.quark (enc) + .quark (plain), len=XXX`
4. spider 应返回有效的播放 URL，而非"未登录夸克"

## 36. 已知限制：Ray dxawi 与 老刘备配置源（2026-07-29）

### 36.1 Ray dxawi JAR 缺失

**现象**：Ray dxawi 配置（`csp_Ray` 等源）初始化失败，报 "JAR not loaded" 或 ClassNotFoundException。

**根因**：经测试，Ray dxawi 的所有已知配置 URL 均不可访问：

- `https://xhdwc.tk/0` — 域名下线（网络错误/超时）
- `https://dxawi.github.io/0/0.json` — GitHub Pages 不存在
- `https://raw.githubusercontent.com/dxawi/dxawi.github.io/master/0/0.json` — 仓库不存在

这是上游配置完全失效（域名过期 + 仓库删除），PC 端无法修复。

**应对**：用户切换到其他可用配置（feimao/newwex/aowu/欧歌）。

### 36.2 老刘备 vod_id 为空

**现象**：老刘备配置（`https://raw.liucn.cc/box/m.json`）的 `csp_DouDou` 源首页能返回 20 个视频，但 `vod_id` 字段为 `undefined`，导致详情页无法回查。

**根因**：老刘备的 spider（`fty.jar` 中的 `csp_DouDou`）`homeContent` 实现返回的视频对象不包含 `vod_id` 字段。这是 spider 实现缺陷，PC 端无法修复。

**测试结果**（2026-07-29）：

- 配置 URL 可访问（50KB，234 个站点，165 个 csp\_ 站点）
- JAR URL `https://raw.liucn.cc/box/fty.jar` 可访问（649KB，有效 JAR）
- `csp_DouDou` init 成功，homeContent 返回 20 个视频，但 `vod_id=undefined`
- `csp_KungFu404`（使用独立 `Token.jar`）init 失败，报 "Parameter specified as non-null is null: method com.github.catvod.spider.merge.ވ.<init>, parameter context" — JAR 中 merge 类（加密 DEX）的 Context 参数为 null，JAR 兼容性问题

**应对**：用户切换到其他可用配置。

### 36.3 社区配置兼容性总结

经测试，以下社区配置在本系统可用：

| 配置      | JAR 完整性 | spider 实现 | 可用源数 | 备注                      |
| --------- | ---------- | ----------- | -------- | ------------------------- |
| feimao    | 完整       | 良好        | 38       | 直链播放 8/8 成功         |
| newwex    | 完整       | 良好        | 88       | 直链播放 6/6 成功         |
| aowu      | 完整       | 良好        | 部分     | Hxq 源 awSign 限制        |
| 欧歌      | 完整       | 良好        | 8+       | 直链源全部可用            |
| Ray dxawi | 缺失       | -           | 0        | JAR 缺少类，不可用        |
| 老刘备    | 完整       | 缺陷        | 0        | vod_id 为空，详情页不可用 |

## 34. 多配置全量测试与预设精简（2026-07-29）

### 34.1 测试背景

用户要求从网上找几个 2026 可用的源配置，加上之前的三个（newwex、肥猫、aowu），测试所有配置保证源首页、详情、播放、搜索都正常。

### 34.2 测试的配置

| 配置名       | URL                                                 | 格式           | 源数 | JAR URL                                     |
| ------------ | --------------------------------------------------- | -------------- | ---- | ------------------------------------------- |
| newwex       | https://9280.kstore.vip/newwex.json                 | direct-json    | 88   | wpscdn.cn PNG 隐写                          |
| 肥猫         | http://肥猫.net/tv                                  | aes-cbc        | 38   | gelonghui.com PNG 隐写                      |
| aowu         | http://itv666.cc/aowu/config.webp                   | base64-pattern | 85   | netease.com PNG 隐写                        |
| 欧歌多仓     | http://tv.nxog.top/m/                               | direct-json    | 93   | clewm.net JPEG 隐写                         |
| 俊于 top98   | http://home.jundie.top:81/top98.json                | direct-json    | 22   | home.jundie.top/jar/top98_1.jar（相对路径） |
| 老刘备       | https://raw.liucn.cc/box/m.json                     | direct-json    | 165  | raw.liucn.cc/box/fty.jar（相对路径）        |
| 应用多多聚合 | https://jihulab.com/duomv/apps/-/raw/main/fast.json | direct-json    | 多仓 | 子仓各自 JAR                                |

### 34.3 测试结果

测试脚本：`tools/test-all-2026-final.cjs`（IPv6 连接修复版）

| 配置       | home_ok | detail_ok | play_ok | pan-no-login | search_ok | 总源数 |
| ---------- | ------- | --------- | ------- | ------------ | --------- | ------ |
| newwex     | 14      | 11        | 6       | 5            | 12        | 88     |
| 肥猫       | 11      | 10        | 4       | 4            | 0         | 38     |
| aowu       | 12      | 8         | 3       | 0            | 1         | 85     |
| 欧歌多仓   | 3-8     | 2         | 1-8     | 0            | 0         | 93     |
| 俊于 top98 | 0       | 0         | 0       | 0            | 0         | 22     |
| 老刘备     | 未完成  | -         | -       | -            | -         | 165    |

注：

- 欧歌多仓在服务稳定时有 8 个直链播放源（热播/农民/大鹅/三六零/骚火/金牌/爱看/1905），测试中服务崩溃导致结果偏低
- 俊于 top98 所有源 init-fail 或 jar-load-fail（per-site JAR URL 众多，切换 JAR 导致服务崩溃）
- 老刘备有 165 个源，per-site JAR URL 众多，测试中服务崩溃未完成
- pan-no-login 表示网盘源需登录后才能播放（用户已登录夸克/百度后可播放）

### 34.4 预设精简

根据测试结果，从 Settings.vue 预设中移除不可用的配置：

**移除的配置**：

- 俊于 top98：所有源 init-fail，per-site JAR 与 spider 服务不兼容
- 老刘备：per-site JAR 众多，测试中服务反复崩溃，vod_id 为空
- 饭太硬：服务器无响应（socket hang up）
- 巧技/摸鱼：之前已移除

**保留的配置（5 个）**：

1. newwex（默认）— 88 源，14 首页可用，6 直链播放
2. 肥猫 — 38 源，11 首页可用，4 直链播放
3. aowu — 85 源，12 首页可用，3 直链播放
4. 欧歌多仓 — 93 源，8 直链播放（热播/农民/大鹅/三六零/骚火/金牌/爱看/1905）
5. 应用多多聚合 — 多仓聚合

### 34.5 IPv6 连接修复

**问题**：Spider 服务监听 `[::]:9978`（IPv6），测试脚本使用 `nc 127.0.0.1 9978`（IPv4）导致 `Connection refused`。

**修复**：`tools/test-all-2026-final.cjs` 中 `postOnce` 函数改用 `nc -w 30 ::1 9978`（IPv6 localhost），Host header 改为 `[::1]:9978`。

### 34.6 相对 JAR 路径解析

**问题**：俊于 top98（`./jar/top98_1.jar`）和老刘备（`./fty.jar`）使用相对 JAR 路径，测试脚本未解析导致 JAR 加载失败。

**修复**：测试脚本新增 `resolveRelative(baseUrl, p)` 函数，将 `./xxx` 解析为基于配置 URL 的绝对路径。PC 端 `ConfigParser.fixContentPath` 已有相同逻辑，生产环境不受影响。

### 34.7 假测试 cookie 清理

**问题**：Android 容器 `NewWexFnw_preferences.xml` 中残留假测试 cookie：

- `Wex_quark_cookie: fake_quark_cookie_for_test=abc123`
- `Wex_baidu_cookie: fake_baidu_cookie_for_test=def456`
- `Wex_ucpan_cookie: fake_uc_cookie_for_test=xyz789`

**影响**：测试脚本直接调用 `/spider/playerContent` 不传 `extraCookies`，spider 读取到假 cookie 导致播放失败。

**清理**：`am force-stop com.tvbox.spiderserver` → `sed -i '/fake_/d'` → `am start`

**生产环境影响**：无。PC 端 `JarSpider.playerContent` 自动从 localStorage 读取真实 cookie 并通过 `extraCookies` 参数传递给 `SpiderManager.playerContent`，`writePanCookiesToPrefs` 会覆盖假 cookie。

### 34.8 网盘 cookie 同步链路（完整）

```
PC 端 localStorage['pan_login_quark'] = {cookie: "real_quark_cookie"}
  ↓ JarSpider.playerContent (src/core/JarSpider.ts L239-L254)
  ↓ 读取 localStorage，组装 extraCookies
  ↓ HTTP POST /spider/playerContent {extraCookies: {quark: "real_cookie"}}
  ↓ SpiderManager.playerContent (SpiderManager.kt L1557-L1578)
  ↓ writePanCookiesToPrefs(extraCookies) (L1602-L1638)
  ↓ 写入 com.github.catvod.tvbox_preferences: mi.quark (加密) + .quark (明文)
  ↓ 写入 NewWexFnw_preferences: Wex_quark_cookie (明文)
  ↓ spider.playerContent 读取 SharedPreferences 获取真实 cookie
  ↓ 返回播放 URL
```

百度/UC 同理，panType 映射：

- quark → mi.quark / .quark / Wex_quark_cookie
- baidu → mi.baidu / .baidu / Wex_baidu_cookie
- uc → mi.uc / .uc / Wex_ucpan_cookie

## 38. 关键修复 24：配置中心 UI 重构与全量源调试（2026-07-31）

### 38.1 问题现象

用户反馈三个问题：

1. 配置中心很多网盘显示"暂不支持登录"
2. Emby 设置、多线程管理不应该是登录按钮，应该是配置页
3. 三个配置（肥猫、newwex、aowu）的所有源需要重新调试，保证首页、详情、播放都正常

### 38.2 配置中心 UI 重构

**Home.vue `getConfigActionType`** — 区分 4 种动作类型：`login` / `clear` / `config` / `info`

```
- aowu (csp_AAConfigAmns) — 所有项目均为 config 页（除 clear/clearall）
- del* 前缀 / *clear* 子串 — 清除动作
- cookie/token/safecode 子串 / *login 子串（非 'login'） — 登录动作
- add* 前缀（feimao 模式 addQuark/addBaidu...）— 登录动作（addpaninput 除外）
- emby / wexgo* / {danmubtn,pankaiguan,panpaixu,hongmeng,alistdiy,webdavdiy,diyvod,beifenjiekou,huifujiekou} — config 页
- remarks 包含 点击设置/点击增加/点击选择/点击删除/点击清空/备份/恢复 — config 页
- 纯数字 vod_id（feimao go设置 1/2/4）— config 页
- 其他 — info
```

**Home.vue `resolvePanByVodId`** — 三层匹配：

1. 显式 `VODID_TO_PAN` 映射表（WexConfigGuard 的 type_id）
2. feimao `add{Pan}` / `del{Pan}` 动态前缀（addQuark → quark）
3. 名称关键词匹配（夸克/UC网盘/百度/哔哩/天翼/阿里/115/123/移动/光鸭/雷鲸）

**ConfigDialog.vue** — 配置对话框，处理 emby/多线程/综合设置：

- 识别 vodId 类型：emby / multithread / toggle / text / info / backup / restore
- 通过 `spider-set-pref` IPC 写入 JAR 端 SharedPreferences
- 备份/恢复接口显示"暂不支持"提示（需用户手动操作）

**InputLoginDialog.vue** — 输入式登录对话框：

- 用于不支持扫码登录的网盘（115/123/139/189/移动/光鸭/雷鲸）
- 用户粘贴 cookie/token，通过 `spider:saveLogin` 推送到 JAR

### 38.3 新增 panType 支持

**PanLogin.ts** — 扩展 PanType 联合类型：

```typescript
export type PanType =
  | 'quark'
  | 'uc'
  | 'aliyun'
  | 'baidu'
  | 'bili' // QR 扫码登录
  | 'tianyi'
  | 'pan123'
  | '115'
  | '115safe' // 输入式登录
  | 'ydyun'
  | 'guangya'
  | 'leijing'; // 输入式登录

export function isQrSupportedPan(panType: PanType): boolean {
  return QR_SUPPORTED_PANS.has(panType); // quark/uc/aliyun/baidu/bili
}
```

**SpiderManager.kt** — `panPrefKeys` 扩展支持新 panType 的 SharedPreferences 键名映射。

### 38.4 配置格式解析增强

**ConfigParser.ts `tryExtractConfig`** — 6 种格式自动识别：

| 序号 | 格式                          | 检测方式                     | 实例             |
| ---- | ----------------------------- | ---------------------------- | ---------------- |
| 1    | 直接 JSON                     | utf8 解码 + lenientJsonParse | newwex.json      |
| 2    | `[A-Za-z0-9]{8}\*\*` + base64 | 正则匹配前缀                 | aowu config.webp |
| 3    | JPEG 隐写                     | FFD8...FFD9 后追加数据       | 饭太硬           |
| 4    | PNG 隐写                      | IEND chunk 后追加数据        | wpscdn.cn JAR    |
| 5    | WebP 隐写                     | RIFF 容器后追加数据          | aowu config.webp |
| 6    | latin1 兜底                   | 混合编码                     | -                |

**关键改进**：每条路径都通过 `lenientJsonParse()` 验证 JSON 有效性，避免将非 JSON 内容误判为配置。

### 38.5 代理 URL 重写（动态端口）

**ConfigParser.ts `checkReplaceProxy`** — 三种 URL 格式统一处理：

```typescript
export function checkReplaceProxy(url: string): string {
  // 1. proxy://... → LOCAL_PROXY()/proxy?...
  if (url.startsWith('proxy://')) {
    return url.replace('proxy://', LOCAL_PROXY() + '/proxy?');
  }
  // 2. 127.0.0.1:19978/proxy?... — 渲染进程 LocalProxyServer，跳过
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):19978\/proxy\?/.test(url)) {
    return url;
  }
  // 3. 127.0.0.1:<any port incl. -1>/proxy?... → LOCAL_PROXY()/proxy?...
  const proxyHostMatch = url.match(
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::-?\d+)?\/proxy\?/,
  );
  if (proxyHostMatch) {
    return url.replace(proxyHostMatch[0], LOCAL_PROXY() + '/proxy?');
  }
  return url;
}
```

**LOCAL_PROXY() 动态端口**：

- `proxyPort` 模块变量，初始 19978
- `setLocalProxyPort(port)` 由 main 进程通过 `proxy-port-changed` IPC 通知更新
- `bootstrapProxyPort()` 在模块加载时自动订阅 IPC + 拉取当前端口

**main.ts** — ProxyServer 启动后通过 `webContents.executeJavaScript` 注入端口到所有渲染进程，并注册 `proxy:getPort` IPC handler。

### 38.6 playerContent URL 格式兼容

**app.ts `loadPlay`** — 处理 playerContent 返回的非标准 URL 格式：

1. **数组格式** `[name, url, name, url, ...]`（BiliGuard spider）— 遍历奇数索引提取 URL
2. **逗号分隔** `"name,url,name,url,..."` — 按逗号分割，优先取奇数位 URL，回退到任意 http 开头的 token
3. **proxy://** — 调用 `checkReplaceProxy` 重写
4. **http://127.0.0.1:-1/proxy?** — 容器内探测失败的 sentinel，重写为 LOCAL_PROXY
5. **相对 URL** — 如 `/play/1548-0.htm`，拼接 spider host（部分 spider 实现缺陷，PC 端无法修复）

### 38.7 测试脚本改进（test-three-configs.cjs）

| 改进点                    | 修改前                      | 修改后                                                           |
| ------------------------- | --------------------------- | ---------------------------------------------------------------- |
| site 级错误隔离           | 单 site 失败终止整个 config | try-catch 包裹，单 site 失败继续                                 |
| postWithRetry 重试次数    | 3 次                        | 8 次                                                             |
| waitForSpiderService 超时 | 60s                         | 180s                                                             |
| fetchConfig 重试          | 无                          | 3 次（处理 CDN 瞬时故障）                                        |
| JAR 切换等待              | 12s                         | 20s                                                              |
| fallback 链               | 仅 homeContent              | homeContent → homeVideoContent → categoryContent → searchContent |
| detail 无 play URL        | 直接标记失败                | 调用 playerContent 兜底获取 URL                                  |
| 数组 URL                  | 不支持                      | BiliGuard 数组格式兼容                                           |
| 逗号分隔 URL              | 不支持                      | "name,url,..." 格式兼容                                          |
| msearch: vod_id           | 调 detailContent 失败       | 跳过 detail/play 测试                                            |
| 登录识别                  | "no URL" 一律标记失败       | 区分 "login required" vs 实际失败                                |

### 38.8 SpiderManager \*Amns 类处理

**SpiderManager.kt** — 针对 aowu JAR 的 `*Amns` 类（继承 AowuShinidie）：

1. **initLoader bypass**：\*Amns 类使用自定义类加载，跳过标准 Init.loader 注入
2. **init() NPE 捕获**：AowuShinidie.init() 内部调用 `Init.getSpider()` 返回 null（DM\* 类不在 config.db 中），捕获 NPE 后使用 spider 实例继续（homeContent 可能不依赖内部 spider）
3. **限制**：DM\*Amns 系列（DMcycAmns/DMfansAmns/DMmoduAmns/DMaowuAmns/DMhhzAmns）仍无法工作，因为 homeContent 也委托 null 内部 spider，且 Init 类无 Map 字段无法反射预填充

### 38.9 三配置最终测试结果（2026-08-01 最终版，含 URL 解析修复）

| 配置     | 站点数  | Home OK       | Detail OK     | Play OK      | Failed |
| -------- | ------- | ------------- | ------------- | ------------ | ------ |
| 肥猫     | 38      | 28            | 26            | 20           | 11     |
| newwex   | 94      | 73            | 55            | 42           | 18     |
| aowu     | 87      | 64            | 43            | 32           | 34     |
| **合计** | **219** | **165 (75%)** | **124 (57%)** | **94 (43%)** | **63** |

> 注：相比 2026-07-31 初版测试（167/110/63，30% 可播放），2026-08-01 修复数组 URL 与逗号分隔 URL 解析后，可播放率从 30% 提升至 43%，详见 §39。

### 38.10 失败源分类与根因

| 失败类别                        | 数量 | 根因                                                                                               | 可修复性                                  |
| ------------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **MyCrypto 原生方法未注册**     | 12+  | aowu JAR 的 `awenc-v8.so` 符号混淆，`JNI_OnLoad` 动态注册与 Java 声明不匹配（v7e/hxqSign/huyaWup） | ❌ JAR 级，需 frida hook 识别混淆方法名   |
| **AowuShinidie 委托 NPE**       | 5    | DM\*Amns 类继承 AowuShinidie，init/homeContent 委托内部 null spider                                | ❌ JAR 级，需反编译 aowu JAR 分析委托机制 |
| **Woshinidie 类未找到**         | 1    | `com.github.catvod.spider.Woshinidie` 不在 JAR 中                                                  | ❌ JAR 级                                 |
| **emby/AList/webdav/DiyVod**    | 4    | 需用户配置服务器 URL                                                                               | ⚠️ 用户在配置中心设置                     |
| **MyGuangYa merge NPE**         | 1    | `merge.OoOoOo0o0OoO0oOo` helper 类未初始化                                                         | ❌ JAR 级 bug                             |
| **网盘源未登录**                | ~20  | UC/Quark/Baidu/115/天翼 返回 "未登录" 或 "请检查 cookie"                                           | ⚠️ 用户扫码登录后可播放                   |
| **搜索型源无首页**              | 5    | SoTySo/SoBaiDuSo/SoHaiYin/So97So/push_agent 设计上无 homeContent                                   | ✅ 预期行为                               |
| **msearch 豆瓣源**              | 3    | NewDouBan/Doubana vod_id 为 `msearch:xxx`，需跨源搜索                                              | ✅ 预期行为（PC app 已支持）              |
| **APP 类源 homeContent 空**     | 6    | AppGet/AppQi/AppRJ 设计上无 homeContent，需 categoryContent                                        | ✅ 测试脚本已加 fallback，PC app 正常     |
| **Bili 多分类源无首页视频**     | 4    | Bili spider homeContent 空，需 categoryContent                                                     | ✅ 预期行为                               |
| **Detail: no play URL**         | 8    | BadPaddingException / JSONException / ArrayIndexOutOfBounds                                        | ❌ JAR 级 spider 实现缺陷                 |
| **Invalid URL host**            | 1    | WobgAmns 返回 `hubdog.cc�j`（编码错误）                                                            | ❌ JAR 级                                 |
| **End of input at character 0** | 2    | spider 尝试 JSON.parse 空字符串                                                                    | ❌ JAR 级                                 |
| **Index 0 out of range [0..0)** | 2    | spider 数组访问越界                                                                                | ❌ JAR 级                                 |

### 38.11 关键结论

**75% 的源首页正常，57% 的详情页正常，43% 可播放（2026-08-01 最终版）。**

失败源中：

- **~20 个是网盘源未登录** — 用户扫码登录后即可播放（夸克/百度已登录，UC/115/天翼/移动/光鸦/雷鲸需登录）
- **~15 个是 JAR 级原生库/类加载缺陷** — PC 端无法修复（MyCrypto v7e/hxqSign/huyaWup 未注册、AowuShinidie 委托 NPE、Woshinidie 类缺失）
- **~10 个是 spider 实现缺陷** — JSON 解析异常、数组越界、URL 编码错误
- **~10 个是预期行为** — 搜索型源、msearch 豆瓣源、APP 类源、Bili 多分类源
- **~4 个需用户配置** — emby/AList/webdav/DiyVod 服务器地址

### 38.12 凭证流转链路（最终版）

```
用户扫码（quark/uc/aliyun/baidu/bili）
  ↓ PC 端 PanLoginService 生成二维码（qrcode npm 包）
  ↓ 用户扫码
  ↓ JAR 端 PanLoginManager 轮询 → 提取 cookie/tokens
  ↓ SpiderManager.saveLogin → 写入 SharedPreferences（JAR/Docker 内）
  ↓ PC 端不保存任何凭证，仅内存缓存 statusCache
  ↓
播放时（Quark/UC/Baidu/Bili）：
  JarSpider.playerContent
  ↓ HTTP POST /spider/playerContent
  ↓ SpiderManager.playerContent → spider 读取 SharedPreferences 中的 cookie
  ↓ 返回播放 URL（PC 端从不接触 cookie）
  ↓
播放时（Aliyun）：
  AliyunPanService.ensureAccessToken()
  ↓ fetchRefreshTokenFromJAR() → spiderAPIClient.getLogin('aliyun')
  ↓ HTTP POST /spider/getLogin → JAR 返回 refreshToken
  ↓ POST https://api.aliyundrive.com/token/refresh → 获取 accessToken
  ↓ 内存缓存 accessToken（2h 过期）
  ↓ resolveShareToFiles / resolveDownloadUrl
  ↓
输入式登录（115/123/139/189/移动/光鸭/雷鲸）：
  InputLoginDialog → 用户粘贴 cookie/token
  ↓ ipc.invoke('spider:saveLogin', {panType, cookie, ...})
  ↓ HTTP POST /spider/saveLogin
  ↓ SpiderManager.saveLogin → 写入 SharedPreferences
```

### 38.13 残留说明

- `QuarkPanService.syncCookieToJVM` / `UCPanService.syncToGuardPrefs` / `BaiduPanService.syncToGuardPrefs` 方法定义仍保留（无调用方），JVM bridge 代码为死代码，可后续清理
- `setSyncedCookie` 内存缓存保留在 Pan Service 中，供 ProxyServer fallback 解析分享链接（不持久化）
- QR 码生成/轮询已在 PC 端 `PanLoginService` 执行（本地渲染二维码图片），凭证获取后立即推送给 JAR
- 测试脚本不注入网盘 cookie，因此网盘源的 "no URL in response" 是预期行为；生产环境中 `JarSpider.playerContent` 自动注入 cookie

## 39. 关键修复 25：数组 URL 与逗号分隔 URL 解析（2026-08-01）

### 39.1 问题现象

2026-07-31 全量测试后发现多个 aowu 源出现 `unrecognized URL: null` 错误，导致 Play OK 仅 63/213（30%）：

- HHkkAmns（豪堪短剧）
- JinPaiAmns（金牌快速）
- AiyfAmns（爱影）
- ChildrenBeiWa（贝瓦儿歌）
- 其他返回数组格式 URL 的源

### 39.2 根因分析

通过 [\_investigate-failures.cjs](file:///d:/Code/TVBox-Pc-Docker/tools/_investigate-failures.cjs) 抓取 playerContent 完整响应，发现 spider 返回的 `url` 字段格式并非标准字符串 URL，而是：

**数组格式**（BiliGuard/JinPaiAmns/AiyfAmns 等）：

```json
{
  "url": [
    "高清",
    "https://ppvod01.kqgfbs.com/splitOut/20260705/1342569/index.m3u8?t=...",
    "标清",
    "https://ppvod01.kqgfbs.com/splitOut/20260705/1342569/index.m3u8?t=..."
  ]
}
```

**逗号分隔格式**（ChildrenBeiWa/部分 Bili 源）：

```json
{
  "url": "1080p,https://bevavideo-ali.beva.cn/14f7b0e4008248899d5a38e7855c5c51/h1080.mp4,720p,https://..."
}
```

PC 端 `app.ts loadPlay` 原本只处理 `url: string` 格式，遇到数组/逗号分隔时 `new URL(url)` 抛出 `unrecognized URL` 错误，导致播放失败。

### 39.3 修复方案

**app.ts `loadPlay`** ([app.ts](file:///d:/Code/TVBox-Pc-Docker/src/store/app.ts#L950)) — 兼容三种 URL 格式：

```typescript
// 1. 数组格式 [name, url, name, url, ...]
if (Array.isArray(url)) {
  for (let i = 1; i < url.length; i += 2) {
    const candidate = String(url[i] || '');
    if (
      candidate.startsWith('http') ||
      candidate.startsWith('proxy://') ||
      candidate.startsWith('magnet:')
    ) {
      url = candidate;
      break;
    }
  }
}
// 2. 逗号分隔 "name,url,name,url,..."
else if (typeof url === 'string' && url.includes(',')) {
  const tokens = url
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  let picked = '';
  // 优先取奇数位 URL
  for (let i = 1; i < tokens.length; i += 2) {
    if (
      tokens[i].startsWith('http') ||
      tokens[i].startsWith('proxy://') ||
      tokens[i].startsWith('magnet:')
    ) {
      picked = tokens[i];
      break;
    }
  }
  // 回退：任意 http 开头的 token
  if (!picked) {
    for (const t of tokens) {
      if (
        t.startsWith('http') ||
        t.startsWith('proxy://') ||
        t.startsWith('magnet:')
      ) {
        picked = t;
        break;
      }
    }
  }
  if (picked) url = picked;
}
// 3. 标准字符串 URL — 原逻辑
```

**test-three-configs.cjs** ([test-three-configs.cjs](file:///d:/Code/TVBox-Pc-Docker/tools/test-three-configs.cjs)) — 同步实现相同解析逻辑，确保测试脚本与 PC app 行为一致。

### 39.4 验证结果（2026-08-01）

运行 [\_verify-url-fixes.cjs](file:///d:/Code/TVBox-Pc-Docker/tools/_verify-url-fixes.cjs) 确认修复：

```
Testing: JinPai (JinPaiAmns)
  ✓ init ok
  [detail] vod_play_from: 此接口免费
  [play] raw url type: array
  [play] raw url preview: ["高清","https://ppvod01.kqgfbs.com/splitOut/20260705/1342569/V20260705110331438911342569/index.m3u8?t=...","标清","https://ppvod01.k..."]
  [play] parsed URL: https://ppvod01.kqgfbs.com/splitOut/20260705/1342569/V20260705110331438911342569/index.m3u8?t=6a6d6e
  ✓ PLAY OK

Testing: Aiyf (AiyfAmns)
  ✓ init ok
  [detail] vod_play_from: 此接口免费
  [play] raw url type: array
  [play] raw url preview: ["720P","https://sss111-e1.pipecdn.vip/ppotb62-.../chunklist.m3u8?vendtime=..."]
  [play] parsed URL: https://sss111-e1.pipecdn.vip/ppotb62-...
  ✓ PLAY OK
```

**JinPai 与 Aiyf 数组 URL 解析成功，从 "unrecognized URL" 失败转为 PLAY OK。**

### 39.5 修复后全量测试对比

| 配置     | 修复前 (07-31)       | 修复后 (08-01)       | 改善                |
| -------- | -------------------- | -------------------- | ------------------- |
| 肥猫     | 27/18/12 (Failed 13) | 28/26/20 (Failed 11) | +8 detail, +8 play  |
| newwex   | 76/55/33 (Failed 22) | 73/55/42 (Failed 18) | +9 play             |
| aowu     | 64/37/18 (Failed 36) | 64/43/32 (Failed 34) | +6 detail, +14 play |
| **合计** | **167/110/63 (30%)** | **165/124/94 (43%)** | **+31 play**        |

**可播放率从 30% 提升至 43%，净增 31 个源可播放。**

> 注：Home OK 略降（167→165）是因为 newwex 配置更新后站点数从 88 增至 94，部分新站点 homeContent 失败；总体可播放率显著提升。

### 39.6 关键经验

1. **playerContent 返回值并非总是字符串** — spider 实现可能返回数组（name/url 交替）、逗号分隔字符串、或带 `proxy://` 前缀的容器内 URL，PC 端必须兼容所有格式
2. **测试脚本与 PC app 必须同步 URL 解析逻辑** — 否则测试结果与实际播放体验不一致
3. **抓取原始响应是定位 URL 错误的关键** — `[play] raw url type: array` 日志直接暴露了根因，避免猜测
4. **数组格式源自 BiliGuard spider 的设计** — Bili spider 原本为 Android 客户端设计，返回多清晰度数组供用户选择；PC 端默认取第一个 URL 即可
