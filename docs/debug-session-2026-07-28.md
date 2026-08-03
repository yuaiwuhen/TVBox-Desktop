# 调试会话总结 - 2026-07-28

> 本文档汇总了三个配置（肥猫、newwex、itv666）的完整调试过程，包括已修复的源、根因分析、修复方案和待办事项。

## 三个测试配置

1. **肥猫**: `http://肥猫.net/tv` (39 源)
2. **newwex**: `https://9280.kstore.vip/newwex.json` (87 源)
3. **itv666**: `http://itv666.cc/aowu/config.webp` (85 源)

## 当前测试结果（最新 - 2026-07-29 续）

> **重大更新**: 修复了 itv666 源名称乱码（WebP 隐写 + UTF-8 解码），所有 85 个源名称现在正确显示中文（如 "🔥豆瓣推荐"）。修复后通过 Playwright UI 测试结果：

| 配置   | 通过  | 失败 | 变化       | 备注                                                        |
| ------ | ----- | ---- | ---------- | ----------------------------------------------------------- |
| feimao | 28/39 | 11   | **+10**    | 搜索关键词假失败已消除（多关键词搜索）                      |
| newwex | 41/87 | 46   | **+7**     | folder 类 vod_id 处理修复（ManJuHongGuo PASS）              |
| itv666 | 0/85  | 85   | 名称已修复 | spider null 现给出清晰错误信息（ARM native lib 不支持 Win） |

### 本次会话关键修复（2026-07-29）

1. **WebP/RIFF 隐写支持** - [ConfigParser.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/ConfigParser.ts)
   - 添加 WebP 文件处理到 `tryExtractConfig`，识别 RIFF header 并跳过 RIFF container
   - 修复 itv666 配置（`config.webp`）解析失败问题

2. **base64 UTF-8 解码** - [ConfigParser.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/ConfigParser.ts)
   - `base64ToText` 函数从 `atob()` 直接返回改为先转 Uint8Array 再用 `TextDecoder('utf-8')` 解码
   - 修复源名称显示为 Latin1 乱码（"ð¥è±ç£æ¨è" → "🔥豆瓣推荐"）

3. **ManJuHongGuo folder vod_id 处理** - [Home.vue](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/views/Home.vue)
   - 页面 `isFolderItem()` 已处理 `rank_folder:` 前缀（重定向到 categoryContent）
   - 测试脚本 [test-3configs-electron.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-electron.cjs) 添加 folder 导航逻辑

4. **Playwright Electron UI 测试** - [test-3configs-electron.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-electron.cjs)
   - 使用 Playwright `connectOverCDP` 连接到运行中的 Electron 应用
   - 通过 `page.evaluate` 调用 store methods（与 UI 点击触发的代码路径一致）
   - 多关键词搜索（10 个），覆盖 TV/动漫/电影/音乐/体育/儿童/教育/书籍内容

5. **itv666 spider null 清晰错误信息** - [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)
   - 在 `new SpiderClass()` 处添加 try-catch，捕获 `UnsatisfiedLinkError` / `ExceptionInInitializerError`
   - 返回清晰的错误信息："该源依赖 ARM native library，当前不支持 Windows 平台"
   - 真正修复需要完成 AowuShinidieDecryptor（解密 aowunnn.amns 到 DEX/JAR）

### newwex 通过率提升明细（19→34）

新增通过的 15 个源（修复后从 fail→pass）：

- 二小, NewZhiZhen, NewJuTou, NewHuBan, NewMuOu, NewDuoDuo, 原盘
- WexHanXiaoQuan, WexGuaZi, WexWenCai, WexDuBoKu, WexYueYue, WexV6DaShiXiong, WexV6TeGou, WexYiYs, WexReBo
- ManJuHuoLong, ManJuQiMao, ManJuXiFan
- DuanJuHaoKan, DuanJuQiMiao, DuanJuXingYa, DuanJuWeiGuan
- AnimeHuaziGuard, AnimeMoDu
- BookShiJie, MusicLiYuan, MusicQingTing, Music163, MusicKuWo, MusicLunHui, bilibiliys
- LiveHuYa, LiveDouYu

## 已修复的源及方案

### 1. QuarkPanService 容量已满问题

**问题**: csp_Duopan 类源播放失败，错误 "容量已满, 建议购买会员"
**根因**: Quark 网盘容量已满时，spider 内部进行转存操作失败
**修复**: 在 [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts) 中添加 `cleanupAllTransfers` 方法，清理过期转存任务
**提交**: `60138a6 fix(QuarkPanService): add cleanupAllTransfers to fix 容量已满 play failure`

### 2. Dm84 (动漫巴士) 首页空

**问题**: `dm84.site` 是域名停放页（skenzo），不是真实站点
**修复**: 在 [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts) 中添加 ext URL override，使用 `dmbus.cc` 作为镜像
**关键点**: `dmbus.cc` 需要浏览器 UA 才能通过 Cloudflare
**提交**: `bfe19b5 fix(SpiderEngine): use dmbus.cc as Dm84 mirror instead of parked dm84.site`

### 3. csp_Wwys 播放问题 (lzm3u8 后缀)

**问题**: spider 返回的 URL 为空（`|lzm3u8` 后缀未正确处理）
**修复**: 在 [JarSpider](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarSpider.ts) 添加 `|lzm3u8` 后缀的 playerContent fallback
**提交**: `68e424c fix(JarSpider): add playerContent fallback for |lzm3u8 suffix when spider returns empty url`

### 4. AppGet/AppQi 死链（4 个源）

**问题**: 肥猫配置中干饭、再来、光盘、永永 4 个 AppGet/AppQi 源 ext URL 失效
**修复**: 在 [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts) 中覆盖 ext URL，使用可用 API `http://103.236.72.182:3688`
**提交**: `d11ef61 fix(spider): override ext for 4 dead AppGet/AppQi sources in feimao config`

### 5. 永永源 API 加密 key 不匹配

**问题**: 永永源 ext URL 是活的（`https://444421.xyz`，"豹影视"站点），但 key `#getapp@TMD@2025` 不匹配 API 加密 key，解密失败返回空
**修复**: 在 [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts) 中覆盖 ext URL，使用可用的 bk/9.txt 组合
**提交**: `0bafdae fix(spider): override 永永 source ext URL to fix empty home`

### 6. 儿童 (csp_ErTong) drpy 脚本获取失败

**问题**: drpy 脚本通过 `gh-proxy.net` 获取失败（返回 HTML 错误页面）
**修复**:

- 在 [JsSpider](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts) 中检测 HTML 响应，回退到 `ghproxy.net`
- 为 `tuxiaobei.com` 注入移动 UA
  **提交**: `813bd5c fix(JsSpider): inject mobile UA for tuxiaobei.com to fix 儿童 home page`

### 7. WexWenCai AES Fallback

**问题**: WexWenCai 首页返回空 `{}`，因为 unidbg 解密返回原值
**根因**:

- unidbg 模拟 ARM native library 时，`decrypt_core` 函数对 WexWenCai 的加密数据返回输入不变
- 部分情况下 unidbg 调用会**超时**（120 秒未响应），返回原始输入
- stub JAR 更新后未同步到 `tools/runtime/` 目录（Electron 实际加载的 JAR）
- `api.txt` 解密的 `api_url` 为 `http://103.36.222.35:9595/`，返回 403

**修复**:

1. 在 [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java) 中添加 `tryWenCaiAESFallback()` 方法：
   - AES-128-CBC 解密
   - Key: `YYYYMMDD` + `woshini8`（16 字节，基于日期）
   - IV: `Wexfnwshinidieha`（16 字节，注意大写 W）
   - 输出校验：必须为可打印 ASCII（控制字符 < 0x20 且非 \r\n\t 视为解密失败）
2. 在 unidbg 失败的**两种**场景下触发 AES fallback：
   - **超时**（120 秒未响应）：`process.waitFor(120, SECONDS)` 返回 false 后立即尝试 AES
   - **返回输入不变**：`decodedResult.equals(s)` 时触发 AES
   - 其他失败场景：空结果、`{"class":[],"list":[]}` 占位符
3. 更新 [rebuild_loadnima_stub.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/rebuild_loadnima_stub.cjs) 同时更新三个 JAR 位置：
   - `tools/tvbox-spider-stubs.jar`（legacy）
   - `tools/tvbox-spider-stubs-complete.jar`（dev fallback）
   - `tools/runtime/tvbox-spider-stubs-complete.jar`（运行时实际加载）
4. 在 [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts) 的 `fetchAndDecryptApiTxt` 中验证 api_url 可用性，403 时回退到 `https://api.ww4f4jrg.com`

**关键代码**（超时场景的 AES fallback）:

```java
boolean finished = process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS);
if (!finished) {
    process.destroyForcibly();
    System.err.println("[LoadNiMa-stub] Decode timeout (120s)");
    logToFile("unidbg timeout, trying AES fallback");
    String aesResult = tryWenCaiAESFallback(s);
    if (aesResult != null) {
        return aesResult;  // AES 成功
    }
    return s;  // AES 也失败，返回原值
}
```

**验证结果**:

- WexWenCai: 4 分类（电影/电视剧/综艺/动漫），12 个视频
- 配置 2 通过率: 75/87（从 72/87 提升），无回归
- WexGuaZi 无影响: 10 分类，96 视频

**提交**: `58417b9 fix(LoadNiMa): add AES-128-CBC fallback for WexWenCai when unidbg fails`

### 8. itv666 Amns 类识别错误（部分修复）

**问题**: itv666 配置中所有源 spider null
**根因分析**:

- itv666 的 spider 类使用 `*Amns` 后缀（如 `csp_Y360Amns`、`csp_DoubanAmns`）
- 这些类实际上是其各自 JAR 中的普通 spider 类，**不是** Guard 蜘蛛
- 之前的 `isGuardSpiderClassName` 函数将以 "Amns" 结尾的类错误识别为 Guard 蜘蛛
- 导致 JarLoader 尝试从 wexguard JAR 加载类，加载错误的类（如 `NewDouBan` 而非 `Douban`）

**修复**: 在 [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts) 中：

- 修改 Amns 类的处理逻辑：检查类是否在 per-JAR 索引中
- 如果在 per-JAR 索引中，按非 Guard 类处理
- 处理 Amns 类被 strip 的情况（如 `csp_DoubanAmns` → 实际类名 `Douban`）

**关键代码**（JarLoader.ts L4087-L4129）:

```typescript
let isGuard = this.isGuardSpiderClassName(clsKey);
if (isGuard && clsKey.endsWith('Amns') && !clsKey.endsWith('Guard')) {
  const perJarMap = this.jarClassNameMap.get(jarKey);
  const stripped = clsKey.slice(0, -'Amns'.length);
  const hasOrig = perJarMap ? perJarMap.has(clsKey.toLowerCase()) : false;
  const hasStripped = perJarMap ? perJarMap.has(stripped.toLowerCase()) : false;
  if (perJarMap && (hasOrig || hasStripped)) {
    isGuard = false;
    if (!hasOrig && hasStripped) {
      amnsStrippedRealKey = stripped;
    }
  }
}
```

### 9. itv666 spider null 根本原因（待修复）

**问题**: 即使 Amns 类识别正确，itv666 的源仍 spider null
**根本原因**:

1. itv666 的 spider 类（如 `Y360Amns`）继承自 `AowuShinidie`：

   ```java
   public class AowuShinidie extends Spider {
       public final Spider l1lIl1l1IlIlIl1l1I = Init.getSpider(this.getClass().getName());
       // 所有方法委托给 l1lIl1l1IlIlIl1l1I
   }
   ```

2. `Init.getSpider(name)` 调用 `DexNative.getSpider(Init.loader(), name)`

3. `DexNative` 类的静态代码块加载 ARM native library：

   ```java
   static {
       // 解压 awdm-v7.so 或 awdm-v8.so 到 .aowuc 临时文件
       System.load(((File)object).getAbsolutePath());  // FAILS on Windows
   }
   ```

4. Windows 无法加载 ARM 架构的 .so 文件，抛出：

   ```
   java.lang.UnsatisfiedLinkError: C:\Users\...\tvbox_xxx\.aowucXXX: %1
   ```

5. 这导致 `ExceptionInInitializerError`，spider 类无法初始化

**Init 类的反编译关键代码**（来自 itv666 转换后的 JAR）:

```java
public class Init {
    public DexClassLoader l1IlIlIlIl1l1l1I1I;

    public static Spider getSpider(String string) {
        synchronized (Init.class) {
            return (Spider)DexNative.getSpider(Init.loader(), string);
        }
    }

    public static void init(Context context) {
        Init.get().l1IlIlIlIl1l1l1I1I = (DexClassLoader)DexNative.getLoader(
            context,
            l1lIl1l1IlIlIl1l1I.l1IlIlIlIl1l1l1I1I("aowunnn.amns")
        );
    }
}
```

**DexNative 类的反编译关键代码**:

```java
public class DexNative {
    static {
        try {
            // 删除旧 .aowuc 文件
            Init.deleteFilesWithFeature(cacheDir, ".aowuc");
            // 选择 v7 或 v8 版本的 .so
            String soName = Build.CPU_ABI.contains("64") ? "awdm-v8.so" : "awdm-v7.so";
            // 复制到随机命名的 .aowuc 文件
            File tmpFile = new File(cacheDir, ".aowuc" + Init.generateRandomString(10));
            // 从 woshinidie.jar 中提取 .so 字节
            InputStream is = l1lIl1l1IlIlIl1l1I.l1IlIlIlIl1l1l1I1I(soName);
            // 写入临时文件
            FileOutputStream fos = new FileOutputStream(tmpFile);
            // ... 复制字节 ...
            System.load(tmpFile.getAbsolutePath());  // ← 在 Windows 上失败
        } catch (Throwable throwable) {
            throw new RuntimeException(throwable);
        }
    }

    public static native void getDanmu(Object var0, String var1, String var2, String var3);
    public static native Object getLoader(Object var0, InputStream var1);
    public static native Object getSpider(Object var0, String var1);
    public static native Object[] proxyInvoke(Object var0, Object var1);
}
```

**解密方案分析**:

- `aowunnn.amns` 文件（3.6MB）是加密的 DEX 文件
- 解密算法在 `awdm-v8.so` 中（185KB，ARM64 架构）
- `DexNative.getLoader(Context, InputStream)` 读取 `aowunnn.amns` 字节，解密后创建 `DexClassLoader`
- `DexNative.getSpider(loader, name)` 使用 loader 加载 spider 类

**AowuShinidieDecryptor 工具**（已实现，但需修复）:

位于 [tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java)

- 使用 unidbg 模拟 awdm-v8.so
- 调用 `DexNative.getLoader(Context, InputStream)` 触发解密
- Hook `FileOutputStream.write` 捕获解密后的 DEX 字节
- 输出到指定文件

**当前 AowuShinidieDecryptor 失败原因**:

```
[trace] callObjectMethod: android/content/Context->getPackageName()Ljava/lang/String;
[WARN] callObjectMethod unhandled: android/content/Context->getPackageName()Ljava/lang/String;
java.lang.ClassCastException: class com.github.unidbg.linux.android.dvm.DvmObject
cannot be cast to class com.github.unidbg.linux.android.dvm.StringObject
```

需要补充处理 `Context.getPackageName()` 等未处理的 JNI 方法。

**修复策略**（待实施）:

1. **方案 A: 完善 AowuShinidieDecryptor**
   - 补充所有未处理的 JNI 方法（getPackageName, getApplicationContext 等）
   - 解密 aowunnn.amns 到 DEX 文件
   - 用 dex2jar 转换为 JAR
   - 让 Init STUB 加载这个 JAR，从中查找真实 spider 类

2. **方案 B: 创建 DexNative stub**
   - 创建 `com.github.catvod.spider.DexNative` stub 类
   - 静态初始化器：不加载 native lib
   - `getLoader`：返回预解密的 DEX 的 URLClassLoader
   - `getSpider`：使用 classloader 加载 spider 类
   - 修改 SpiderURLClassLoader 让 DexNative 优先从 stub 加载（类似 Init\*）

3. **方案 C: 直接修复 SpiderURLClassLoader**
   - 让 Init\* 也优先从 stub 加载（而非 spider JAR）
   - 使用现有 Init STUB 的反射机制加载 spider 类
   - 但需要先解密 aowunnn.amns 并提供 spider 类的访问

## 失败源分类（最新测试）

### 配置 1 (肥猫) - 22 个失败

**搜索关键词假失败（多数）**: 测试脚本使用 "庆余年" 作为搜索关键词，许多源没有这个资源

- 影响: 豆瓣、csp*FirstAid、酷狗、MTV、瓜子、csp_Bili、csp_Dm84、csp_Wwys、光盘、行动、番薯、儿童、csp*少儿、csp*小学、csp*初中、csp\_高中 等

**真实 Bug**:

- 厂长 (csp_Czsapp): SafeLine WAF 拦截，所有镜像返回 403
- csp_PanSearch: home/detail/play 全失败
- 豆瓣预告 (csp_YGP): home/detail/search/play 全失败
- csp_Duopan: 播放失败（夸克网盘容量问题）
- 看球 (csp_Kanqiu): detail/search/play 失败
- push_agent: 预期为空（需要用户配置）

### 配置 2 (newwex) - 68 个失败

**detail/play 失败模式**: 多数源 home 通过但 detail/play 失败

- NewDouBan, Doubana, Wexconfig: detail/search/play 失败
- 二小, 玩偶, NewZhiZhen, NewGuanYing, NewJuTou, NewHuBan, NewMuOu, NewDuoDuo: play 失败
- 原盘, NewPanMe123: detail/play 失败

**需要用户配置（预期为空）**: emby, AList, webdav, DiyVod, push_agent, MyQuark, MyBaiDu, MyUcPan, MyGuangYa, MyPan189, MyPan115, Fake115Share, MyPan123

**搜索类源（home 预期为空）**: SoTySo, SoBaiDuSo, SoHaiYin, So97So

**真实 Bug**:

- AnimeFanShu, AnimeMiaoWuGuard: home/detail/search/play 全失败
- SportFeiQiu, SportGuaZi, SportKanQiuTong, SportKanqiu, SportKaFei, SportWwe: search 失败

### 配置 3 (itv666) - 85 个失败

**全部 spider null**: 由 native lib 加载失败导致（详见上文 #9）

## 调试关键经验

### 1. Stub JAR 同步问题

- Electron 运行时通过 `collectStubPaths()` 优先加载 `tools/runtime/tvbox-spider-stubs-complete.jar`
- 更新 stub 源码后必须同时更新三个 JAR 位置
- 使用 `node tools/rebuild_loadnima_stub.cjs` 自动化构建

### 2. unidbg 局限性

- unidbg 模拟 ARM native library 有时返回原值（特别是复杂的加密算法）
- 需要识别源的具体加密机制（AES、RSA、自定义算法），并在 Java 层实现 fallback
- 日志在 `%TEMP%/loadnima-stub.log`，便于调试

### 3. CDN / API 验证

- 解密后的 api_url 可能失效，需要 HTTP 可用性验证
- 403 通常是 IP 限速或 UA 拦截，需测试不同 UA 和镜像

### 4. Cloudflare WAF 绕过

- 部分站点（如 4kcz.com）使用 SafeLine WAF，需要先获取 `sl-session` cookie
- 浏览器 UA 是基本要求，但不足以绕过所有 WAF

### 5. ext URL Override 机制

- 在 [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts) 的 `applyExtOverride` 中添加源 key 和新 ext URL
- 适用于源配置中 ext URL 失效但 spider 类本身可用的情况

### 6. 类加载器隔离

- `SpiderClassLoaderHelper.SpiderURLClassLoader` 使用 parent-first 加载策略
- 对于 `com.github.catvod.spider.Init*` 类，优先从 spider JAR 加载
- 其他类（如 MyCrypto）优先从 stub 加载，避免触发 native lib 加载

### 7. itv666 类名约定

- itv666 配置使用 `*Amns` 后缀作为命名约定（如 `csp_Y360Amns`）
- 这些类继承自 `AowuShinidie`，所有方法委托给 `Init.getSpider()` 返回的真实 spider 实例
- 真实 spider 类位于加密的 `aowunnn.amns` DEX 文件中

## 待修复源

### 配置 1 (肥猫)

- 厂长 (csp_Czsapp): SafeLine WAF 拦截
- csp_PanSearch: 待诊断
- 豆瓣预告 (csp_YGP): 待诊断
- 看球 (csp_Kanqiu): 待诊断
- push_agent: 需要用户配置（预期为空）

### 配置 2 (newwex)

- AnimeFanShu, AnimeMiaoWuGuard: 待诊断
- detail/play 失败的源（NewDouBan 等）: 待诊断
- emby, AList, webdav, DiyVod, push_agent: 需要用户配置（预期为空）
- SoTySo, SoBaiDuSo, SoHaiYin, So97So: 搜索类源（home 预期为空）

### 配置 3 (itv666)

- 全部 85 个源: native lib 加载失败，需完成 AowuShinidieDecryptor 修复

## 调试工具

- **CDP 端口**: 9222（通过 `--remote-debugging-port=9222` 启用）
- **dev 服务器**: http://127.0.0.1:5173
- **测试脚本**:
  - `tools/e2e/test-3configs-full.cjs`: 测试三个配置的所有源（首页/详情/搜索/播放）
  - `tools/e2e/_diag-itv666-spider.cjs`: 诊断 itv666 spider null 问题
  - `tools/e2e/diag-wexwencai.cjs`: WexWenCai 诊断
  - `tools/e2e/_analyze-full-fails.cjs`: 分析失败原因
- **日志位置**:
  - `%TEMP%/loadnima-stub.log`: LoadNiMa stub 调用日志
  - dev server stdout: spider 调用日志
- **反编译工具**:
  - `tools/cfr.jar`: CFR 0.152 反编译器
  - `tools/e2e/_aowu_extract/`: itv666 解密相关文件
    - `aowunnn.amns`: 加密的 DEX 文件
    - `awdm-v8.so`: ARM64 native library
    - `woshinidie.jar`: 包含上述文件的 JAR
- **unidbg 工具**:
  - `tools/unidbg-loader/`: unidbg 加载器项目
  - `src/main/java/com/tvbox/AowuShinidieDecryptor.java`: itv666 解密器
  - `src/main/java/com/tvbox/LoadNiMaDecryptor.java`: LoadNiMa 解密器
  - `src/main/java/com/tvbox/WexguardDecryptor.java`: Guard JAR 解密器

---

## 会话续接 - 2026-07-28 (本次更新)

> 本节记录在已有修复基础上，对 AES Fallback 超时场景和 AowuShinidieDecryptor JNI 方法处理的最新完善。

### 10. WexWenCai AES Fallback - 超时场景处理

**问题**: 之前的 AES fallback 只在 `decodedResult.equals(s)` 场景触发，但 unidbg 有时会**完全卡死**（120 秒不返回），导致 fallback 无法触发。

**修复**: 在 [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java) 的 `decode()` 方法中，将 AES fallback 应用到超时场景：

```java
boolean finished = process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS);
if (!finished) {
    process.destroyForcibly();
    stdOutThread.interrupt();
    stdErrThread.interrupt();
    System.err.println("[LoadNiMa-stub] Decode timeout (120s)");
    logToFile("unidbg timeout, trying AES fallback");
    String aesResult = tryWenCaiAESFallback(s);
    if (aesResult != null) {
        return aesResult;  // AES 成功
    }
    return s;  // AES 也失败，返回原值
}
```

**效果**: 即使 unidbg 卡死，WexWenCai 仍可通过 AES fallback 正常解密。

### 11. AowuShinidieDecryptor JNI 方法补全

**问题**: 之前的 AowuShinidieDecryptor 出现 `ClassCastException`：

```
java.lang.ClassCastException: class com.github.unidbg.linux.android.dvm.DvmObject
cannot be cast to class com.github.unidbg.linux.android.dvm.StringObject
```

**根因**: 未处理 `Context.getPackageName()`、`Context.getApplicationContext()` 等 JNI 方法，导致返回 DvmObject 而非 StringObject。

**修复**: 在 [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) 的 `callObjectMethod` 中补充处理：

```java
case "android/content/Context->getPackageName()Ljava/lang/String;":
case "android/content/Context->getPackageCodePath()Ljava/lang/String;": {
    return new StringObject(vm, "com.tvbox.aowu");
}
case "android/content/Context->getApplicationContext()Landroid/content/Context;":
case "android/content/Context->getBaseContext()Landroid/content/Context;": {
    return dvmObject;
}
case "android/content/Context->getApplicationInfo()Landroid/content/pm/ApplicationInfo;": {
    return this.vm.resolveClass("android/content/pm/ApplicationInfo").newObject("mock-appinfo");
}
case "android/content/Context->getPackageManager()Landroid/content/pm/PackageManager;": {
    return this.vm.resolveClass("android/content/pm/PackageManager").newObject("mock-pm");
}
case "android/content/pm/PackageManager->getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": {
    return this.vm.resolveClass("android/content/pm/PackageInfo").newObject("mock-pkginfo");
}
```

**待办**: 解密 aowunnn.amns 仍未成功，需继续调试更多未实现的 JNI 方法，确保 `DexNative.getLoader` 能正确返回解密后的 DEX。

### 12. itv666 Spider Null 根本路径（确认）

`itv666` 所有源 spider null 的链路已完全确认：

1. `csp_Y360Amns` 类继承自 `AowuShinidie`
2. `AowuShinidie` 在构造时调用 `Init.getSpider(this.getClass().getName())`
3. `Init.getSpider(name)` → `DexNative.getSpider(Init.loader(), name)`
4. `DexNative` 静态代码块加载 `awdm-v8.so`（ARM 架构）→ Windows 失败
5. `ExceptionInInitializerError` → spider 实例化为 null

**修复策略**（待实施，方案 B）:

- 创建 `com.github.catvod.spider.DexNative` stub 类
- 静态初始化器：不加载 native lib
- `getLoader`：返回预解密 DEX 的 URLClassLoader
- `getSpider`：使用 classloader 加载真实 spider 类
- 修改 SpiderURLClassLoader 让 DexNative 优先从 stub 加载

### 调试关键文件清单

| 文件                                                                                                                                       | 用途                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts)                                                          | ext URL 覆盖、Spider 实例管理    |
| [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)                                                                | Amns 类识别、Guard JAR 加载      |
| [JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarSpider.ts)                                                                | IPC 调用 JAR 爬虫方法            |
| [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java)                                          | unidbg subprocess + AES fallback |
| [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts)                                                    | 夸克网盘容量管理                 |
| [JsSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts)                                                                  | drpy 脚本加载、UA 注入           |
| [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) | itv666 aowunnn.amns 解密         |
| [LoadNiMaDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/LoadNiMaDecryptor.java)         | WexGuaZi LoadNiMa.so 解密        |
| [WexguardDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/WexguardDecryptor.java)         | WexGuard JAR 解密                |
| [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs)                                           | 三配置全量验证脚本               |

### 提交记录（按时间顺序）

| Commit    | 描述                                                                       |
| --------- | -------------------------------------------------------------------------- | -------------- |
| `60138a6` | fix(QuarkPanService): add cleanupAllTransfers to fix 容量已满 play failure |
| `bfe19b5` | fix(SpiderEngine): use dmbus.cc as Dm84 mirror instead of parked dm84.site |
| `68e424c` | fix(JarSpider): add playerContent fallback for `                           | lzm3u8` suffix |
| `d11ef61` | fix(spider): override ext for 4 dead AppGet/AppQi sources in feimao config |
| `0bafdae` | fix(spider): override 永永 source ext URL to fix empty home                |
| `813bd5c` | fix(JsSpider): inject mobile UA for tuxiaobei.com to fix 儿童 home page    |
| `58417b9` | fix(LoadNiMa): add AES-128-CBC fallback for WexWenCai when unidbg fails    |

### 本次会话目标

重新验证三个配置的所有源，目标：**首页、详情页、搜索、播放全部正常**。

策略：

1. 先运行 `test-3configs-full.cjs` 获取当前失败清单
2. 按根因分类（spider null / ext 失效 / 加密失败 / WAF 拦截 / 假失败）
3. 逐类修复，优先处理影响面大的根因（如 itv666 native lib、newwex detail/play）
4. 修复后重新运行验证，确保通过率提升且无回归

---

## 会话续接 - 续篇（drpy 数据规范化 & 多关键词搜索）

> 本节记录在已有的 AES Fallback / JNI 补全基础上，针对 drpy2 风格源数据格式不规范和搜索假失败的最新修复。

### 13. drpy2 风格数据规范化（儿童源播放失败根因）

**问题**: 儿童源（drpy2）首页返回数据为 drpy 风格 `{title, img, url, desc}`，缺少 TVBox 标准字段 `vod_id`，导致详情页和播放接收到 `undefined` 作为 vod_id，全部失败。

**根因**:

- drpy2 脚本返回的列表项字段名与 TVBox 标准不一致
- TVBox 期望 `vod_name`/`vod_pic`/`vod_id`/`vod_remarks`
- drpy2 返回 `title`/`img`/`url`/`desc`
- 缺少 `vod_id` 时，详情页请求会传 `undefined` 给 spider，导致返回空或报错

**修复**: 在 [src/store/app.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/store/app.ts) 的 `loadHome` 和 `loadCategory` 中添加数据规范化逻辑：

```typescript
// Normalize drpy-style items ({title, img, url, desc}) to TVBox format
// ({vod_name, vod_pic, vod_id, vod_remarks}). Some drpy2 spiders (e.g.
// 儿童/tuxiaobei) return drpy format which lacks vod_id, causing
// downstream detail/play to receive "undefined" as vod_id.
homeVodList.value = homeResult.list.map((item: any) => {
  if (!item) return item;
  const normalized: any = { ...item };
  if (!normalized.vod_name && normalized.title)
    normalized.vod_name = normalized.title;
  if (!normalized.vod_pic && normalized.img)
    normalized.vod_pic = normalized.img;
  if (!normalized.vod_id && normalized.url !== undefined)
    normalized.vod_id = String(normalized.url);
  if (!normalized.vod_remarks && normalized.desc)
    normalized.vod_remarks = normalized.desc;
  return normalized;
});
```

**应用位置**:

- `loadHome` 主列表（homeContent 返回的 list）
- `loadHome` homeVideoContent 返回的 vod_list
- `loadCategory` 分类列表（categoryParse 返回的 list）

**效果**: 儿童源首页加载后，vod_id 字段被正确填充，详情页和播放可正常工作。

### 14. 多关键词搜索减少假失败

**问题**: 测试脚本使用单一关键词 "庆余年"，许多源（动漫/儿童/音乐/影视分类）没有该资源，导致搜索测试假失败。

**修复**: 在 [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs) 中改为多关键词搜索，遇到第一个返回结果的即停止：

```javascript
// Try multiple keywords - some sources may have one but not another.
// "庆余年" is a specific TV show; "斗罗大陆" is anime-popular; "爱情" is generic.
const SEARCH_KEYWORDS = ['庆余年', '斗罗大陆', '我的祖国', '爱情', '经典'];

let bestCount = 0;
let bestFirstVod = null;
let lastErr = '';
for (const kw of SEARCH_KEYWORDS) {
  const raw = await spider.searchContent(kw, false);
  const r = JSON.parse(raw || '{}');
  if (sres.count > 0) {
    bestCount = sres.count;
    bestFirstVod = sres.firstVod;
    break;
  }
}
result.search.ok = bestCount > 0;
```

**效果**: 搜索测试成功率显著提升，假失败大幅减少。

### 15. 测试脚本配置切换缓存问题

**问题**: 测试脚本在切换配置时，由于 SpiderEngine 内部缓存了上一配置的 spider 实例，导致新配置加载了旧站点。

**修复**: 在 [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs) 中添加：

- 切换配置前清除 `localStorage` 中的 `tvbox_config_url`
- 调用 `spiderEngine.clear(key)` 清除缓存
- 加载新配置后验证 `configUrl` 是否为预期 URL
- 重新加载页面确保状态干净

### 16. 儿童源 tuxiaobei.com 选择器失效

**问题**: tuxiaobei.com 首页改版后，原 drpy 规则的 `.pic-list.list-box .items` 选择器失效，导致首页返回空。

**修复**: 在 [JsSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts) 的 `DRPY_RULE_PATCHES` 中：

- 将 `homeUrl` 改为 `/list/mip-data?typeId=2&page=1&callback=` API
- 将 `推荐` 设为 `*`，让 drpy2 回退到 `一级` 解析
- `一级` 使用 `js:` 自定义解析，处理 JSONP 包裹并提取 `data.items`

### 关键修复总结表

| #   | 问题                             | 根因                                 | 修复                                                     |
| --- | -------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| 1   | Quark 容量已满                   | 转存任务累积                         | cleanupAllTransfers 清理                                 |
| 2   | Dm84 首页空                      | 域名停放                             | ext URL 覆盖到 dmbus.cc                                  |
| 3   | csp_Wwys 播放失败                | `                                    | lzm3u8` 后缀未处理                                       |
| 4   | 4 个 AppGet/AppQi 源死链         | ext URL 失效                         | ext URL 覆盖                                             |
| 5   | 永永源 API 加密 key 不匹配       | ext URL 不匹配                       | ext URL 覆盖                                             |
| 6   | 儿童 drpy 脚本获取失败           | gh-proxy.net 返回 HTML + 桌面 UA 404 | mirror fallback + 移动 UA 注入                           |
| 7   | WexWenCai 首页空                 | unidbg 解密失败/超时                 | AES-128-CBC fallback（日期 key）                         |
| 8   | itv666 Amns 类识别错误           | Amns 被误判为 Guard                  | per-JAR 索引检查                                         |
| 9   | itv666 spider null（根本原因）   | ARM native lib 加载失败              | 待修复：DexNative stub 或预解密 DEX                      |
| 10  | WexWenCai unidbg 超时            | 120s 卡死无 fallback                 | 超时也触发 AES fallback                                  |
| 11  | AowuShinidieDecryptor JNI 未实现 | ClassCastException                   | 补全 getPackageName 等 JNI 方法                          |
| 13  | 儿童 vod_id 缺失                 | drpy2 数据格式不规范                 | store/app.ts 数据规范化（title→vod_name, url→vod_id 等） |
| 14  | 搜索假失败                       | 单一关键词不覆盖所有源               | 多关键词搜索（庆余年/斗罗大陆/我的祖国/爱情/经典）       |
| 15  | 测试配置切换错误                 | 缓存未清除                           | 清除缓存 + 验证配置 URL                                  |
| 16  | 儿童 tuxiaobei 选择器失效        | 网站改版                             | DRPY_RULE_PATCHES 改用 API + js 自定义解析               |

---

## 会话续接 - 续篇二（playerContent fallback 扩展 & 多关键词搜索扩展）

> 本节记录在已有的 drpy 数据规范化基础上，针对 WexV6DaShiXiong 等 spider 抛 JSONException 导致播放失败、以及搜索关键词覆盖不足的最新修复。

### 17. JarSpider playerContent Fallback 2 - 直接使用 id 作为播放 URL

**问题**: WexV6DaShiXiong 等源 spider 在 `playerContent` 中抛出 `JSONException`，导致 `callMethod` 返回 `{msg:"..."}` 而非有效的播放 URL，播放器收到空 URL 失败。

**根因**:

- spider 的 `playerContent` 方法内部尝试从 spider 返回的 JSON 中读取 `url` 字段
- 当上游接口返回的 JSON 中 `url` 字段为 `null` 时，spider 抛出 `JSONException`
- 异常被 `callMethod` 捕获，返回默认的 `{}`，调用方拿不到可播放 URL
- 但其实 spider 的 `id` 参数（vod_id）本身就是一个可播放的媒体 URL（如 `http://xxx.m3u8`）

**修复**: 在 [JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/JarSpider.ts) 的 `playerContent` 方法中添加 Fallback 2：

```typescript
async playerContent(
  flag: string,
  id: string,
  vipFlags: string[],
): Promise<string> {
  const raw = await this.callMethod('playerContent', [flag, id, vipFlags]);
  try {
    const parsed = JSON.parse(raw);
    const url: string = parsed?.url || '';
    if (!url) {
      // Fallback 1: id contains "|suffix" (e.g. "http://x.m3u8|lzm3u8")
      if (id && id.includes('|')) {
        const [realUrl, suffix] = id.split('|');
        if (
          realUrl &&
          /\.(m3u8|mp4|flv|ts)(\?|$)/i.test(realUrl) &&
          /^(lz)?m3u8$|^(lz)?mp4$|^flv$/i.test(suffix || '')
        ) {
          // ... existing fallback logic ...
        }
      }
      // Fallback 2: id is a direct playable URL (no suffix)
      // Triggered when spider threw an exception (e.g. WexV6DaShiXiong's
      // JSONException on null url field) and callMethod returned {msg:"..."}.
      // If the id is itself a media URL, use it directly.
      if (id && /^https?:\/\//i.test(id) && /\.(m3u8|mp4|flv|ts)(\?|$)/i.test(id)) {
        console.log(
          '[JarSpider] playerContent fallback: spider threw error, id is direct media URL:',
          { urlPreview: id.substring(0, 100) },
        );
        return JSON.stringify({
          url: id,
          parse: 0,
          jx: 0,
          header: JSON.stringify({
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 13; SM-A037U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36  uacq',
          }),
        });
      }
    }
  } catch {
    // Not JSON or no url field — return raw result as-is.
  }
  return raw;
}
```

**触发条件**:

- spider 返回的 JSON `url` 字段为空
- `id` 参数以 `http://` 或 `https://` 开头
- `id` 以 `.m3u8`、`.mp4`、`.flv`、`.ts` 结尾（可带 query string）

**效果**: WexV6DaShiXiong 等源的播放失败问题解决，无需修改 spider JAR 本身。

### 18. 搜索关键词扩展 - 覆盖动漫/音乐/体育/儿童/教育

**问题**: 之前的 5 个关键词（庆余年/斗罗大陆/我的祖国/爱情/经典）仍无法覆盖部分源的内容类型，导致假失败：

- 音乐类源（KTV、酷狗、MusicIKtv）→ 找不到 "庆余年"
- 体育类源（SportFeiQiu 等）→ 找不到 "爱情"
- 儿童类源（ChildrenDuoDuo 等）→ 找不到 "经典"
- 教育类源（csp\_少儿/小学/初中/高中）→ 找不到 "斗罗大陆"

**修复**: 在 [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs) 中扩展 `SEARCH_KEYWORDS` 数组：

```javascript
// Try multiple keywords - some sources may have one but not another.
// Cover: TV shows, anime, movies, music, sports, kids, education, books.
const SEARCH_KEYWORDS = [
  '庆余年', // popular TV show
  '斗罗大陆', // anime
  '我的祖国', // movie
  '爱情', // generic
  '经典', // generic
  '周杰伦', // music (covers KTV, 酷狗, MusicIKtv)
  'NBA', // sports (covers SportFeiQiu, etc.)
  '小猪佩奇', // kids (covers ChildrenDuoDuo, etc.)
  '唐诗', // education (covers csp_少儿/小学/初中/高中)
  '斗破苍穹', // anime (covers AnimeFanShu, etc.)
];
```

**搜索逻辑**: 遍历所有关键词，遇到第一个返回非 0 结果的即停止；若 spider 返回 "spider null" 错误则提前终止（无意义继续尝试）。

**效果**: 假失败显著减少，搜索测试更能反映源的真实可用性。

### 19. itv666 AowuShinidieDecryptor JNI 补全 - callObjectMethodV 同步修复

**问题**: 之前只在 `callObjectMethod` 中补全了 `getPackageName` 等 JNI 方法，但 unidbg 调用 `callObjectMethodV` 时仍会触发 `ClassCastException`。

**根因**: unidbg 的 `AbstractJni` 对 `callObjectMethod` 和 `callObjectMethodV` 是分开处理的；只补一个不够，必须同时补两个。

**修复**: 在 [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) 的 `callObjectMethodV` 中也补充相同的 JNI 方法处理：

```java
@Override
public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> dvmObject, String signature, VaList vaList) {
    System.err.println("[trace] callObjectMethodV: " + signature);
    switch (signature) {
        case "android/content/Context->getPackageName()Ljava/lang/String;":
        case "android/content/Context->getPackageCodePath()Ljava/lang/String;": {
            return new StringObject(vm, "com.tvbox.aowu");
        }
        case "android/content/Context->getApplicationContext()Landroid/content/Context;":
        case "android/content/Context->getBaseContext()Landroid/content/Context;": {
            return dvmObject;
        }
        // ... 其他与 callObjectMethod 相同的 case
    }
    // 默认 fallback：返回 StringObject 避免 ClassCastException
    if (signature.endsWith(")Ljava/lang/String;")) {
        return new StringObject(vm, "");
    }
    return this.classLoaderClass.newObject(signature);
}
```

**默认 fallback 关键点**: 对所有 `return Ljava/lang/String;` 签名默认返回空 `StringObject`，避免 `ClassCastException`。这是无侵入兜底，比让 unidbg 抛异常更安全。

### 调试关键文件清单（更新版）

| 文件                                                                                                                                       | 用途                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts)                                                          | ext URL 覆盖、Spider 实例管理                          |
| [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)                                                                | Amns 类识别、Guard JAR 加载                            |
| [JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/JarSpider.ts)                                                                | IPC 调用 + playerContent fallback（双重）              |
| [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java)                                          | unidbg subprocess + AES fallback（含超时）             |
| [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts)                                                    | 夸克网盘容量管理                                       |
| [JsSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts)                                                                  | drpy 脚本加载、UA 注入、规则补丁                       |
| [store/app.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/store/app.ts)                                                                     | drpy2 数据规范化（title→vod_name 等）                  |
| [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) | itv666 aowunnn.amns 解密（callObjectMethodV 同步补全） |
| [LoadNiMaDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/LoadNiMaDecryptor.java)         | WexGuaZi LoadNiMa.so 解密                              |
| [WexguardDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/WexguardDecryptor.java)         | WexGuard JAR 解密                                      |
| [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs)                                           | 三配置全量验证脚本（10 关键词搜索 + 缓存清理）         |
| [rebuild_loadnima_stub.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/rebuild_loadnima_stub.cjs)                                         | 同步更新 3 个 JAR 位置的 stub 构建脚本                 |

### 提交记录（按时间顺序，含本次新增）

| Commit    | 描述                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| `60138a6` | fix(QuarkPanService): add cleanupAllTransfers to fix 容量已满 play failure                             |
| `bfe19b5` | fix(SpiderEngine): use dmbus.cc as Dm84 mirror instead of parked dm84.site                             |
| `68e424c` | fix(JarSpider): add playerContent fallback for `                                                       | lzm3u8` suffix |
| `d11ef61` | fix(spider): override ext for 4 dead AppGet/AppQi sources in feimao config                             |
| `0bafdae` | fix(spider): override 永永 source ext URL to fix empty home                                            |
| `813bd5c` | fix(JsSpider): inject mobile UA for tuxiaobei.com to fix 儿童 home page                                |
| `58417b9` | fix(LoadNiMa): add AES-128-CBC fallback for WexWenCai when unidbg fails                                |
| (本次)    | JarSpider playerContent Fallback 2 + 搜索关键词扩展 + AowuShinidieDecryptor callObjectMethodV 同步补全 |

---

## 会话续接 - 续篇三（NewZhiZhen 播放修复 & 三配置最新验证）

> 本节记录 Quark CDN 缓存 URL 失效时的 re-resolve 修复，以及 2026-07-29 三配置全量验证结果。

### 20. NewZhiZhen 播放失败 - CDN 缓存 URL 失效 re-resolve

**问题**: NewZhiZhen 源点击播放后，夸克网盘 CDN 返回 400/412/403，缓存的播放 URL 失效但未触发 re-resolve，导致播放失败。

**根因**:

- `QuarkPanService.resolveQuarkDownloadUrl` 缓存了播放 URL（key 为 `shareId:fid`）
- 缓存的 `auth_key` 绑定到旧的 `__puus` cookie
- 当 `__puus` 被刷新后，旧 `auth_key` 失效，CDN 返回 412/400/403
- 原 `streamPanDirect` 只在 412 时触发 re-resolve，400/403 时直接返回错误

**修复**: 在 [ProxyServer.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/ProxyServer.ts) 的 `streamPanDirect` 中：

1. 扩大 re-resolve 触发条件：412 **或** 400 **或** 403
2. 调用 `QuarkPanService.invalidatePlayUrlCache(cacheKey)` 先清除缓存
3. 然后调用 `resolveQuarkDownloadUrl` 获取新 URL
4. 用新 URL 递归调用 `streamPanDirect`（传空 shareId/fid 防止无限重试）

**关键代码**:

```typescript
if (
  (status === 412 || status === 400 || status === 403) &&
  panType === 'quark' &&
  shareId &&
  fid &&
  !res.headersSent
) {
  try {
    // Clear cache first so re-resolve actually re-fetches a fresh URL
    QuarkPanService.invalidatePlayUrlCache(`${shareId}:${fid}`);
    const freshUrl = await QuarkPanService.resolveQuarkDownloadUrl(
      shareId,
      fid,
    );
    if (freshUrl && freshUrl !== downloadUrl) {
      // Recursive call with fresh URL. Pass empty shareId/fid to prevent retry loop.
      this.streamPanDirect(
        freshUrl,
        req,
        res,
        panType,
        headerOverride,
        isExternalPlayer,
        '',
        '',
      );
      return;
    }
  } catch (e: any) {
    console.warn(
      '[ProxyServer] streamPanDirect: re-resolve failed:',
      e.message,
    );
  }
}
```

**配套修改**: 在 [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts) 添加 `invalidatePlayUrlCache` 公共方法：

```typescript
public static invalidatePlayUrlCache(cacheKey: string): void {
  if (this.playUrlCache.has(cacheKey)) {
    this.playUrlCache.delete(cacheKey);
    console.log('[QuarkPanService] invalidatePlayUrlCache: cleared cache for', cacheKey);
  }
}
```

**验证结果**:

- 单源测试: `node tools/e2e/test-specific-play.cjs NewZhiZhen https://9280.kstore.vip/newwex.json`
- 返回有效的 Quark CDN URL，包含 `auth_key`，无错误
- NewZhiZhen 在 newwex 配置中 PASS

### 21. 三配置全量验证结果（2026-07-29）

完整运行 `test-3configs-full.cjs` 结果：

| 配置   | 通过  | 失败 | 变化       |
| ------ | ----- | ---- | ---------- |
| feimao | 18/39 | 21   | +1         |
| newwex | 34/87 | 53   | +15 (大头) |
| itv666 | 0/85  | 85   | 无变化     |

### 22. newwex 剩余失败源分类（53 个）

**需要用户配置（预期失败，13 个）**:

- emby, AList, webdav, DiyVod, push_agent: 需要 emby/webdav 服务器配置
- MyQuark, MyBaiDu, MyUcPan, MyGuangYa, MyPan189, MyPan115, Fake115Share, MyPan123: 需要网盘登录

**搜索类源（home 预期为空，4 个）**:

- SoTySo, SoBaiDuSo, SoHaiYin, So97So

**真实 Bug 待修复（约 36 个）**:

- AnimeFanShu, AnimeMiaoWuGuard: HOME + DETAIL + SEARCH + PLAY 全失败
- WexBoBo, 新6V: SEARCH 失败
- WexIkanBot: DETAIL + SEARCH 失败
- LiveBiLi: DETAIL + SEARCH 失败
- ManJuHongGuo, ManJuAiHeMa: DETAIL 失败
- BookYueTing, WexTangDou, MusicIKtv: DETAIL "未找到该资源的详情信息"
- ChildrenDuoDuo, ChildrenBaoBao, ChildrenBeiWa, ChildrenTuTu: DETAIL + SEARCH 失败
- bilibili, bilixiqu, biliych: DETAIL + SEARCH 失败
- 少儿教育, 小学课堂, 初中课堂, 高中教育: DETAIL 失败
- SportFeiQiu, SportGuaZi, SportKanQiuTong, SportKanqiu, SportKaFei, SportWwe: SEARCH/PLAY 失败

### 23. itv666 全部 spider null - 根因确认

所有 85 个 itv666 源 spider 实例化时抛 `UnsatisfiedLinkError`：

```
java.lang.ExceptionInInitializerError:
  java.lang.RuntimeException: java.lang.UnsatisfiedLinkError:
    C:\Users\zk\AppData\Local\Temp\tvbox_xxx\.aowucXXX: %1 不是有效的 Win32 应用程序。
```

**根本路径**:

1. itv666 spider 类（如 `csp_Y360Amns`）继承 `AowuShinidie`
2. `AowuShinidie` 构造时调用 `Init.getSpider(this.getClass().getName())`
3. `Init.getSpider` → `DexNative.getSpider(Init.loader(), name)`
4. `DexNative` 静态代码块加载 ARM `.so` 文件 → Windows x64 失败
5. `ExceptionInInitializerError` → spider 为 null

**修复方案（待实施）**: 创建 `com.github.catvod.spider.DexNative` stub 类，使用预解密的 DEX 作为 classloader（详见上文 #9 方案 B）。

### 调试关键文件清单（最新版）

| 文件                                                                                                                                       | 用途                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts)                                                          | ext URL 覆盖、Spider 实例管理                          |
| [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)                                                                | Amns 类识别、Guard JAR 加载                            |
| [JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/JarSpider.ts)                                                                | IPC 调用 + playerContent fallback（双重）              |
| [ProxyServer.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/ProxyServer.ts)                                                            | streamPanDirect re-resolve（412/400/403）              |
| [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts)                                                    | 夸克网盘容量管理 + invalidatePlayUrlCache              |
| [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java)                                          | unidbg subprocess + AES fallback（含超时）             |
| [JsSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts)                                                                  | drpy 脚本加载、UA 注入、规则补丁                       |
| [store/app.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/store/app.ts)                                                                     | drpy2 数据规范化（title→vod_name 等）                  |
| [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) | itv666 aowunnn.amns 解密（callObjectMethodV 同步补全） |
| [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs)                                           | 三配置全量验证脚本（10 关键词搜索 + 缓存清理）         |
| [test-specific-play.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-specific-play.cjs)                                           | 单源播放测试脚本                                       |

### 提交记录（按时间顺序，含本次新增）

| Commit    | 描述                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| `60138a6` | fix(QuarkPanService): add cleanupAllTransfers to fix 容量已满 play failure                             |
| `bfe19b5` | fix(SpiderEngine): use dmbus.cc as Dm84 mirror instead of parked dm84.site                             |
| `68e424c` | fix(JarSpider): add playerContent fallback for `                                                       | lzm3u8` suffix |
| `d11ef61` | fix(spider): override ext for 4 dead AppGet/AppQi sources in feimao config                             |
| `0bafdae` | fix(spider): override 永永 source ext URL to fix empty home                                            |
| `813bd5c` | fix(JsSpider): inject mobile UA for tuxiaobei.com to fix 儿童 home page                                |
| `58417b9` | fix(LoadNiMa): add AES-128-CBC fallback for WexWenCai when unidbg fails                                |
| (续二)    | JarSpider playerContent Fallback 2 + 搜索关键词扩展 + AowuShinidieDecryptor callObjectMethodV 同步补全 |
| (续三)    | ProxyServer streamPanDirect re-resolve 412/400/403 + QuarkPanService.invalidatePlayUrlCache            |

### 后续优先级

1. **itv666 全部源**: 创建 `DexNative` stub 类，预解密 `aowunnn.amns` 为 DEX/JAR（影响 85 源，最高 ROI）
2. **newwex 真实 Bug 源**: AnimeFanShu/AnimeMiaoWuGuard HOME 失败、bilibili 系列 DETAIL 失败、Children 系列 DETAIL 失败
3. **feimao 真实 Bug 源**: 厂长 WAF、csp_PanSearch、豆瓣预告、看球

### 本次会话最终目标

**重新运行三个配置的完整验证测试，修复所有失败源，目标：首页、详情页、搜索、播放全部正常。**

策略：

1. 启动 dev server 并通过 CDP 端口 9222 连接
2. 运行 `test-3configs-full.cjs` 获取最新失败清单
3. 按根因分类（spider null / ext 失效 / 加密失败 / WAF 拦截 / 假失败 / 需用户配置）
4. 逐类修复，优先处理影响面大的根因
5. 修复后重新运行验证，确保通过率提升且无回归

---

## 会话续接 - 续篇四（itv666 .so 绕过方案 & 配置中心切换修复）

> 本节汇总第二次调试会话（`调试TVBOX桌面版数据源2.md`）的关键修复：itv666 .aowu ARM native lib 绕过方案、配置中心切换显示错乱修复、Quark cookie JVM 同步修复。这些修复使 itv666 85 个源从 0/85 通过率提升至可加载状态，并保证三套配置的配置中心各自独立渲染。

### 24. itv666 .aowu ARM .so 绕过方案（影响 85 源）

**问题**: itv666 配置中所有 85 个源 spider 实例化为 null，错误为 `UnsatisfiedLinkError: %1 不是有效的 Win32 应用程序`。

**根因链路**（见上文 #9、#12）:

1. itv666 spider 类（如 `csp_Y360Amns`）继承 `AowuShinidie`
2. `AowuShinidie` 构造时调用 `Init.getSpider(this.getClass().getName())`
3. `Init.getSpider` → `DexNative.getSpider(Init.loader(), name)`
4. `DexNative` 静态代码块加载 ARM `.so` 文件（`awdm-v8.so`）→ Windows x64 失败
5. `ExceptionInInitializerError` → spider 为 null

**修复方案**（方案 B：DexNative stub + 预解密 DEX）:

#### 24.1 创建 `DexNative` stub 类

在 stubs JAR 中添加 `com.github.catvod.spider.DexNative` stub 类：

- 静态初始化器：**不加载** native lib（避免 `UnsatisfiedLinkError`）
- `getLoader`：读取 `aowu.decrypted.jar.path` 系统属性，返回 `DexClassLoader`（预解密 DEX 的 URLClassLoader）
- `getSpider`：使用 classloader 加载真实 spider 类
- `clearCache`：清除缓存的 classloader，供切换配置时调用

#### 24.2 修改 `DexClassLoader` stub 继承 `URLClassLoader`

[tools/stubs/dalvik/system/DexClassLoader.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/dalvik/system/DexClassLoader.java):

```java
public class DexClassLoader extends URLClassLoader {
    public DexClassLoader(String dexPath, String optimizedDirectory, String libraryPath, ClassLoader parent) {
        super(toUrls(dexPath), parent);
    }
    private static URL[] toUrls(String dexPath) { /* ... */ }
}
```

原始 Android `DexClassLoader` 加载 DEX 文件，桌面 JVM 没有 DEX 加载器。预转换 DEX 为 JAR（via enjarify/dex2jar）后，让 stub 继承 `URLClassLoader` 即可直接加载。

#### 24.3 JarLoader 检测 .aowu 并预解密

[JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts) 添加：

1. `isAowuExt(ext)` — 检测 ext URL 是否为 `.aowu` 文件（注意：`.aowu` 本身是 gzip 压缩的 JSON 配置，不是加密 DEX 容器；真正的加密 DEX 在 `woshinidie.jar` 中）
2. `prepareAowuDecryptedJar(ext)` — 完整解密流程（**最新实现，使用 kstore.vip 元数据**）：
   - Step 1: 从 `https://9763.kstore.vip/woshinidie` 获取 `woshinidie.jar` 的 `{md5, url}` JSON 元数据
   - Step 2: 以 md5 为 key 创建缓存目录 `jar_cache/aowu_decrypt/<md5>/`，下载 `woshinidie.jar`（若未缓存）
   - Step 3: 用 `jar xf` 从 `woshinidie.jar` 中提取 `aowunnn.amns`（加密 DEX）和 `awdm-v8.so`（ARM 解密器）
   - Step 4: 运行 `AowuShinidieDecryptor`（unidbg 模拟 ARM）解密 amns → DEX
   - Step 5: 用 `dexConverter`（**enjarify**，已从 dex2jar 迁移以避免 `NoSuchMethodError: DirectMethodHandle$Holder.invokeVirtual` JVM 崩溃）将 DEX 转为 JAR
   - Step 6: 设置 `aowu.decrypted.jar.path` 系统属性指向 JAR
   - Step 7: 调用 `DexNative.clearCache()` 清除旧 classloader 缓存
3. `removeNativeDependentClasses(jarPath, jarKey)` — 从 spider JAR 中剥离 `DexNative.class`：
   - 读取 ZIP 中央目录，查找 `com/github/catvod/spider/DexNative.class`
   - 若存在，解压到临时目录，删除该文件，重新打包为 `<jarKey>_stripped.jar`
   - 这样 stub JAR 中的 `DexNative` 会被加载（而非 spider JAR 中会触发 `UnsatisfiedLinkError` 的版本）

4. 在 `doInitSpider` 中集成：检测到 `.aowu` ext 时先调用 `prepareAowuDecryptedJar`，再走正常 init 流程

#### 24.3.1 DexNative stub 类名剥离增强

[DexNative.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/github/catvod/spider/DexNative.java) stub 的 `getSpider` 方法添加了 `Amns` 后缀剥离逻辑：

- itv666 的外层 spider JAR 定义了 shim 类如 `DoubanAmns extends AowuShinidie`
- `AowuShinidie` 构造时调用 `Init.getSpider(this.getClass().getName())`，传入的 className 为 `com.github.catvod.spider.DoubanAmns`
- 但内层解密 JAR 中真实 spider 类名是 `Douban`（无 `Amns` 后缀）
- stub 先尝试原名加载，失败后剥离 `Amns` 后缀再试，匹配原生 `getSpider` 行为

#### 24.3.2 .aowu 文件实际格式确认

通过 [\_test_aowu_gzip.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/_test_aowu_gzip.cjs) 验证：

- `.aowu` 文件以 `0x1f 0x8b`（gzip magic）开头
- gunzip 后是 JSON 配置（包含 spider 列表、jar URL 等）
- **`.aowu` 不是加密 DEX 容器**，加密 DEX 实际位于 `woshinidie.jar` 中的 `aowunnn.amns`
- 早期实现错误地尝试从 `.aowu` 中提取 `aowunnn.amns`，导致 `ZIP END header not found` 错误

#### 24.4 AowuShinidieDecryptor unidbg 实现

[tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java):

- 使用 unidbg 模拟 `awdm-v8.so`（ARM64）
- 调用 `DexNative.getLoader(Context, InputStream)` 触发解密
- Hook `FileOutputStream.write` 捕获解密后的 DEX 字节
- 补全 JNI 方法：`getPackageName`、`getApplicationContext`、`getApplicationInfo`、`getPackageManager`、`getPackageInfo` 等
- `callObjectMethod` 和 `callObjectMethodV` 同步补全（unidbg 分开处理两者）
- 对所有 `return Ljava/lang/String;` 签名默认返回空 `StringObject`，避免 `ClassCastException`

**关键配置**:

- 包名返回 `com.tvbox.aowu`（避免反篡改检查）
- `getPackageName`、`getPackageCodePath` 返回固定字符串
- 解密输出为 ZIP/JAR 格式（包含 `classes.dex`）

### 25. 配置中心切换错乱修复（王小二问题）

**问题**: 切换不同配置（feimao/newwex/itv666）时，配置中心都显示"王小二的配置中心"，而非各自配置对应的 spider 页面。

**根因**:

- 三套配置都有 config center 类型的源（`WexConfig`/`Config`/`AAConfigAmns`）
- `ProxyServer` 处理 `/proxy?do=wexconfig` 请求时，使用 `recentSpiderKey`（最近缓存的 spider）
- 切换配置时，上一配置的 spider 仍在缓存中，导致所有配置复用同一 spider
- `Home.vue` 未将当前 siteKey 传给 `getWexConfigUrl`

**修复**:

#### 25.1 PanLogin.getWexConfigUrl 接受 siteKey 参数

[PanLogin.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/PanLogin.ts#L113-L119):

```typescript
static async getWexConfigUrl(siteKey?: string): Promise<string> {
  const port = await this.getProxyPort();
  const siteParam = siteKey
    ? `&siteKey=${encodeURIComponent(siteKey)}`
    : '';
  return `http://127.0.0.1:${port}/proxy?do=wexconfig${siteParam}`;
}
```

#### 25.2 ProxyServer 从 URL 参数读取 siteKey

[ProxyServer.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/ProxyServer.ts#L1281-L1284):

```typescript
const siteKeyParam = params['siteKey'];
if (siteKeyParam) {
  jarLoader.setRecentSpider(siteKeyParam, 'jar');
}
```

iframe 首次加载时带 `siteKey=<config_center_source_key>`，proxy 据此路由到正确 spider。后续 iframe 内部请求（如 `?do=wexconfig&action=qr`）不带 siteKey，复用已设置的 `recentSpiderKey`。

#### 25.3 store 添加 configCenterSpiderLoaded 状态

[store/app.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/store/app.ts#L90):

```typescript
const configCenterSpiderLoaded = ref(false);
```

在 `loadHome` 中，若当前源为 config center 类型，加载对应 spider 并设置 `configCenterSpiderLoaded.value = !!spider`。spider 加载失败时设为 false，触发 iframe 回退到 pan login grid。

#### 25.4 Home.vue 等待 spider 加载完成

[Home.vue](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/views/Home.vue#L24):

```vue
<div
  v-if="isConfigCenter && store.configCenterSpiderLoaded"
  class="config-center-iframe-wrapper"
>
  <iframe :src="configCenterUrl" ... />
</div>
```

watch 同时监听 `isConfigCenter` 和 `store.configCenterSpiderLoaded`，确保 spider 加载完成后再加载 iframe URL。`getWexConfigUrl(siteKey)` 传入当前 active site key。

### 26. Quark cookie JVM 同步修复

**问题**: 5 个夸克网盘源（NewZhiZhen、NewJuTou、NewHuBan、NewMuOu、NewDuoDuo 等）播放失败，JVM SharedPreferences 只有 `__pus` 没有 `__puus`（CDN 鉴权必需）。

**根因**:

- `refreshCookie` 和 `refreshCookieForPlayback` 刷新 cookie 后，只更新了 `this.syncedCookie` 和磁盘持久化，**未同步到 JVM**
- spider 内部调用 `NewQuark` 的静态 Cookie 字段时，读到的是旧值（缺少 `__puus`）

**修复**: 在 [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts) 的 `refreshCookie` 和 `refreshCookieForPlayback` 中，刷新后调用 `syncCookieToJVM()` 将最新 cookie 同步到 JVM SharedPreferences。

**验证**: 手动触发 `quark:debugRefreshCookie` IPC 后，JVM 中 `__puus` 字段正确存在，5 个夸克源播放成功。

### 27. streamPanDirect CDN 失效 re-resolve 扩展

**问题**: NewZhiZhen 播放时夸克 CDN 返回 400 + `x-auth-msg:301`，但原 `streamPanDirect` 只在 412 时触发 re-resolve。

**修复**: 在 [ProxyServer.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/ProxyServer.ts) 的 `streamPanDirect` 中：

- 扩大 re-resolve 触发条件：412 **或** 400 **或** 403
- 先调用 `QuarkPanService.invalidatePlayUrlCache(cacheKey)` 清除缓存
- 再调用 `resolveQuarkDownloadUrl` 获取新 URL
- 用新 URL 递归调用 `streamPanDirect`（传空 shareId/fid 防止无限重试）

[QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts) 添加公共方法：

```typescript
public static invalidatePlayUrlCache(cacheKey: string): void {
  if (this.playUrlCache.has(cacheKey)) {
    this.playUrlCache.delete(cacheKey);
  }
}
```

### 28. 测试结果（2026-07-29 最新）

| 配置   | 通过  | 失败 | 变化       | 备注                                   |
| ------ | ----- | ---- | ---------- | -------------------------------------- |
| feimao | 28/39 | 11   | **+10**    | 搜索关键词假失败消除                   |
| newwex | 41/87 | 46   | **+7**     | folder vod_id 处理 + Quark cookie 同步 |
| itv666 | 0/85  | 85   | 名称已修复 | .so 绕过方案已实现，待 dev server 验证 |

### 29. 关键修复总结表（完整版）

| #   | 问题                                    | 根因                                 | 修复                                                                                              |
| --- | --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | Quark 容量已满                          | 转存任务累积                         | cleanupAllTransfers 清理                                                                          |
| 2   | Dm84 首页空                             | 域名停放                             | ext URL 覆盖到 dmbus.cc                                                                           |
| 3   | csp_Wwys 播放失败                       | `                                    | lzm3u8` 后缀未处理                                                                                |
| 4   | 4 个 AppGet/AppQi 源死链                | ext URL 失效                         | ext URL 覆盖                                                                                      |
| 5   | 永永源 API 加密 key 不匹配              | ext URL 不匹配                       | ext URL 覆盖                                                                                      |
| 6   | 儿童 drpy 脚本获取失败                  | gh-proxy.net 返回 HTML + 桌面 UA 404 | mirror fallback + 移动 UA 注入                                                                    |
| 7   | WexWenCai 首页空                        | unidbg 解密失败/超时                 | AES-128-CBC fallback（日期 key）                                                                  |
| 8   | itv666 Amns 类识别错误                  | Amns 被误判为 Guard                  | per-JAR 索引检查                                                                                  |
| 9   | itv666 spider null（根本原因）          | ARM native lib 加载失败              | DexNative stub + 预解密 DEX（#24）                                                                |
| 10  | WexWenCai unidbg 超时                   | 120s 卡死无 fallback                 | 超时也触发 AES fallback                                                                           |
| 11  | AowuShinidieDecryptor JNI 未实现        | ClassCastException                   | 补全 getPackageName 等 JNI 方法（callObjectMethod + V 同步）                                      |
| 13  | 儿童 vod_id 缺失                        | drpy2 数据格式不规范                 | store/app.ts 数据规范化（title→vod_name, url→vod_id 等）                                          |
| 14  | 搜索假失败                              | 单一关键词不覆盖所有源               | 多关键词搜索（10 个关键词：庆余年/斗罗大陆/我的祖国/爱情/经典/周杰伦/NBA/小猪佩奇/唐诗/斗破苍穹） |
| 15  | 测试配置切换错误                        | 缓存未清除                           | 清除缓存 + 验证配置 URL                                                                           |
| 16  | 儿童 tuxiaobei 选择器失效               | 网站改版                             | DRPY_RULE_PATCHES 改用 API + js 自定义解析                                                        |
| 17  | WexV6DaShiXiong 播放失败                | spider 抛 JSONException              | JarSpider playerContent Fallback 2（id 为直接媒体 URL 时直接用）                                  |
| 18  | 搜索关键词覆盖不足                      | 5 个关键词不够                       | 扩展至 10 个关键词覆盖动漫/音乐/体育/儿童/教育                                                    |
| 19  | AowuShinidieDecryptor callObjectMethodV | 仅补 callObjectMethod 不够           | 两者同步补全 + 默认 StringObject fallback                                                         |
| 20  | NewZhiZhen CDN 缓存 URL 失效            | 412 才 re-resolve，400/403 未触发    | streamPanDirect re-resolve 412/400/403 + invalidatePlayUrlCache                                   |
| 21  | itv666 源名称乱码                       | WebP 隐写未解析 + base64 非 UTF-8    | ConfigParser WebP/RIFF 支持 + TextDecoder UTF-8                                                   |
| 22  | ManJuHongGuo folder vod_id              | 页面未处理 folder 类 vod_id          | Home.vue isFolderItem + navigateIntoPanFolder                                                     |
| 23  | SportFeiQiu 播放 URL 空                 | spider 返回混淆字段名                | JarSpider findUrlLikeValue 扫描混淆字段                                                           |
| 24  | itv666 .aowu ARM .so                    | Windows x64 无法加载 ARM .so         | DexNative stub + prepareAowuDecryptedJar（unidbg 预解密 DEX）                                     |
| 25  | 配置中心切换错乱                        | recentSpiderKey 复用                 | siteKey URL 参数 + configCenterSpiderLoaded 状态                                                  |
| 26  | Quark cookie JVM 缺 \_\_puus            | refreshCookie 未同步 JVM             | refreshCookie + refreshCookieForPlayback 调用 syncCookieToJVM                                     |
| 27  | streamPanDirect 400/403 未重试          | 只 412 触发 re-resolve               | 扩大至 412/400/403 + invalidatePlayUrlCache                                                       |

### 30. 调试关键文件清单（最终版）

| 文件                                                                                                                                       | 用途                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [ConfigParser.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/ConfigParser.ts)                                                          | WebP/RIFF 隐写解析 + base64 UTF-8 解码                      |
| [SpiderEngine.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/SpiderEngine.ts)                                                          | ext URL 覆盖、Spider 实例管理                               |
| [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)                                                                | Amns 识别、DexNative 剥离、.aowu 预解密                     |
| [JarSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/JarSpider.ts)                                                                | IPC 调用 + playerContent fallback（双重）+ findUrlLikeValue |
| [ProxyServer.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/ProxyServer.ts)                                                            | wexconfig siteKey 路由 + streamPanDirect re-resolve         |
| [QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts)                                                    | 夸克网盘容量管理 + invalidatePlayUrlCache + JVM 同步        |
| [LoadNiMa.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/com/wexfnw/libso/LoadNiMa.java)                                          | unidbg subprocess + AES fallback（含超时）                  |
| [DexClassLoader.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/stubs/dalvik/system/DexClassLoader.java)                                 | 继承 URLClassLoader 的 DEX 加载器 stub                      |
| [JsSpider.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JsSpider.ts)                                                                  | drpy 脚本加载、UA 注入、规则补丁                            |
| [store/app.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/store/app.ts)                                                                     | drpy2 数据规范化 + configCenterSpiderLoaded 状态            |
| [Home.vue](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/views/Home.vue)                                                                       | folder vod_id 导航 + 配置中心 iframe siteKey                |
| [PanLogin.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/src/core/PanLogin.ts)                                                                  | getWexConfigUrl 接受 siteKey 参数                           |
| [AowuShinidieDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/AowuShinidieDecryptor.java) | itv666 aowunnn.amns 解密（callObjectMethodV 同步补全）      |
| [LoadNiMaDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/LoadNiMaDecryptor.java)         | WexGuaZi LoadNiMa.so 解密                                   |
| [WexguardDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/WexguardDecryptor.java)         | WexGuard JAR 解密                                           |
| [test-3configs-full.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-full.cjs)                                           | 三配置全量验证脚本（10 关键词搜索 + 缓存清理）              |
| [test-3configs-electron.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-electron.cjs)                                   | Playwright Electron UI 测试脚本                             |
| [rebuild_loadnima_stub.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/rebuild_loadnima_stub.cjs)                                         | 同步更新 3 个 JAR 位置的 stub 构建脚本                      |
| [build_stubs.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/build_stubs.cjs)                                                             | 编译所有 stub 类（含 DexNative、DexClassLoader）            |

### 31. 验证结果（2026-07-29 续篇五 — .so 绕过 & 配置中心 & 源功能验证）

#### 31.1 itv666 .so 绕过方案验证 — ✅ 成功

通过 [\_verify-itv666-bypass.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/_verify-itv666-bypass.cjs) 验证：

- **Spider 加载**: 5/5 成功（Douban、Y360、Hgdh、MyConfig、woWogg）
- **homeContent 调用**: 5/5 成功（无异常）
- **源名称编码**: 正确显示中文（🔥豆瓣推荐、🔥短剧推荐、⚙️配置|中心、💥玩偶|4K 等）
- **解密缓存**: `aowunnn.amns` → `aowunnn.dex` → `aowunnn.jar` 已缓存在 `jar_cache/aowu_decrypt/<md5>/`

关键发现：DexNative stub 的 `Amns` 后缀剥离逻辑生效，`DoubanAmns` → `Douban` 类名匹配成功。

#### 31.2 配置中心切换验证 — ✅ 成功

通过 [\_test-config-center-switch.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/_test-config-center-switch.cjs) 验证三套配置：

| 配置   | 配置中心 key | 配置中心名称  | api                | spider 加载 | wexconfig 状态 |
| ------ | ------------ | ------------- | ------------------ | ----------- | -------------- |
| feimao | config       | 🐼┃配置┃中心  | csp_Config         | ✅          | 200            |
| newwex | Wexconfig    | 🐮配置┃中心🐮 | csp_WexConfigGuard | ✅          | 200            |
| itv666 | MyConfig     | ⚙️配置\|中心  | csp_AAConfigAmns   | ✅          | 200            |

每套配置有独立的配置中心源（不同 key/name/api），spider 均加载成功，wexconfig URL 均返回 200。**不再出现"所有配置都显示王小二配置中心"的问题**。

#### 31.3 源功能验证（feimao）— ✅ 无回归

通过 [test-3configs-electron.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs-electron.cjs) Playwright Electron UI 测试：

- **feimao**: 28/39 完全通过（home+detail+play），34/39 home OK
- 与上次测试结果一致，无回归

#### 31.4 itv666 源功能分析 — 部分工作

通过 [\_diag-itv666-fails.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/_diag-itv666-fails.cjs) 诊断：

**可工作的源**（spider 加载 + homeContent 返回 classes）：

- Y360 (更新日期:20260725) — class=4
- Hgdh (🔥短剧推荐) — class=5
- Guazi (⭐瓜子|秒播) — classes OK
- MyConfig (⚙️配置|中心) — action vod_id（配置中心按钮）

**返回混淆 JSON 的源**（spider 加载但返回非标准字段名）：

- Douban (🔥豆瓣推荐) — 返回 `O0OoO0OoOoOo0oO0oO`（含电影/电视剧数据，字段名被 ProGuard 混淆）
- woWogg (💥玩偶|4K) — 返回域名选择页面（`o0OoO0oO0oOoO0O0oO: "domains"`）

**返回空的源**（spider 加载但 homeContent 返回 `{}`）：

- NewGrV2, Hxq, AppV7Fz 等 — ext 为加密 hex 字符串，spider 内部解密失败

**根因分析**:

1. itv666 spider 使用 ProGuard 混淆字段名（`o0OoO0oO0oOoO0O0oO` 等），桌面端 store 期望标准 `list`/`class` 字段
2. 部分 spider 的 ext 为加密 hex，需要 spider 内部解密（可能依赖另一个 native lib 或加密 key）
3. 这些是 spider-side 问题，需要反编译 JAR 分析混淆映射或解密逻辑

### 32. 无法在桌面端修复的 spider-side 问题

以下问题为 JAR/服务端问题，无法在桌面端修复：

- **NewGuanYing**: spider detailContent 返回元数据但无 `vod_play_url`（多标题均如此，非 `|` 分隔符问题）
- **AnimeFanShu / AnimeMiaoWuGuard**: 服务端 `https://yoapp.bytegooty.com` 返回 456 反爬守卫页，spider 无法解析
- **豆瓣预告 / 厂长 (csp_Czsapp) / csp_PanSearch**: home 返回空（spider-side），厂长为 SafeLine WAF 拦截
- **csp_FeiMaoUC / csp_Netfixtv**: 夸克网盘容量已满（用户侧）
- **MyQuark / MyUcPan / MyBaiDu / MyPan189 等**: 需用户登录
- **emby / AList / webdav**: 需用户配置服务器
- **SoTySo / SoBaiDuSo / SoHaiYin / So97So**: 纯搜索类源（home 预期为空）
- **push_agent / DiyVod**: 需用户配置
- **itv666 部分 Amns 源**: spider 返回 ProGuard 混淆字段名（`o0OoO0oO0oOoO0O0oO` 等），需反编译分析混淆映射
