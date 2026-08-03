## Hard Constraints
- TVBox JAR files are Android DEX format, requiring dex2jar conversion before loading
- JAR loading requires Java runtime (JDK 8+ with JNI support) and Visual C++ Redistributable 2015+
- Windows file system may lock dex-tools.zip during download, requiring manual deletion of locked files
- Android stub classes (Activity, Application, Dialog, AlertDialog, Context, DialogInterface, ContentProvider, TextView, LinearLayout, EditText, ScrollView, View, ViewGroup, Window, WindowManager, KeyEvent, ViewTreeObserver, Bitmap, Canvas, Paint, Rect, Drawable, ColorDrawable, BitmapDrawable, AsyncTask, Bundle, Handler, Looper, Message, Log, SystemClock, WebView, WebSettings, TextUtils, Uri, android.util.Base64, Environment, Spider, Build, WifiManager, LruCache) must be added to resolve ClassNotFoundException in spider initialization
- Spider initialization must call init(Context, String) with a stub Context as first parameter
- callSpiderMethod must use .call(spider, ...) to correctly bind 'this' context for java-bridge proxy calls
- callSpiderMethod must be asynchronous to support Java await for async methods
- Slow methods (playerContent, searchContent) must use asynchronous calls only, with no fallback to synchronous methods to avoid blocking the main thread
- playerContent and searchContent have a 60-second timeout to prevent permanent卡住
- Vue Proxy objects cannot be serialized by Electron IPC; must convert to plain objects with JSON.parse(JSON.stringify()) before IPC transmission
- 夸克/UC网盘登录状态轮询必须使用7位数字状态码（2000000/50004001/50004002）
- 夸克登录确认判断依据为响应中是否存在非空 'service_ticket' 字段
- 夸克网盘CDN请求（quarkDirect）必须移除Cookie头，仅使用URL中的auth_key进行验证
- 剧集名称和顺序必须与安卓端保持一致，需复用JAR中的逻辑实现
- 网盘类型支持必须与安卓端保持一致
- 详情页所有内容必须调用安卓JAR实现，不允许编写fallback逻辑
- Android stub method signatures must match the real Android API exactly (e.g., Dialog(Context) not Dialog(Object)), because the spider's bytecode was compiled against the real Android API and the JVM resolves methods by exact signature at runtime
- Android stub inner class files use $ in filename (e.g., AlertDialog$Builder.class, Bitmap$Config.class) — use cmd /c with single-quoted PowerShell strings to avoid $ expansion issues when running jar uf
- Windows lacks getprop and chmod commands — must create getprop.exe (returns "arm64-v8a" for ro.product.cpu.abi) and chmod.exe (stub that returns 0) in the project root; Runtime.exec on Windows only finds .exe files, not .bat/.cmd
- libwexproxy.so (ARM) cannot be loaded on x86_64 JVM via System.load() — this UnsatisfiedLinkError is caught by the spider and is non-fatal; libLoadNiMa.so works because it's loaded through unidbg emulation, not System.load()
- Build.CPU_ABI must be set to "arm64-v8a" (not "x86_64") so the spider downloads ARM versions of native libraries compatible with unidbg emulation
- Pan resolver static Cookie fields (NewQuark.OoOoOo0O0o0oO0o0, NewPanUc.oOoOo0O0Oo0o0OoO, NewPan115.oOoOoOo0oOo0o0oO) are initialized to "" and only populated from SharedPreferences inside oOoO0OoO0oOo0oOo() or playerContent() — neither called before detailContentVodPlay(). Must call setPanCookiesForDetailContent() before detailContent to avoid empty Cookie → NPE → "暂无播放源"
- ProxyOrigin.findPort() may detect incorrect ports due to other processes responding; must directly set oOo0oOo0Oo0oO0Oo to the actual ProxyServer port (9978) before calling ProxyOrigin.init() to skip port detection
- 夸克网盘登录成功后必须通过调用 GET /file/sort 接口刷新 '__puus' cookie（原 /clouddrive/auth/pc/flush 端点已废弃返回405）
- detailContent method must trigger retries when spider returns empty string, non-JSON result, or empty {} — check result.trim(), JSON.parse() success, and empty object
- detailContent calls must log ENTRY/RESULT details to %TEMP%\jarloader_detail_errors.log for diagnostic purposes
- detailContent has a maximum of 5 retries with 2s/3s/4s/5s递增间隔，and spider file cache is cleared during retries
- isEmptyResult logic: homeContent is considered empty only when list, class, and filters are all empty; other methods are considered empty when class and list are both empty
- Baidu CDN download URL sign is bound to the spider's Android UA (com.android.chrome/... AndroidXMedia3/...). If the proxy server sends a Windows UA, the CDN returns 403 with error_code 31362 "sign error". Fix: translatePlayerContent must encode spider-provided header into the proxy URL's &header= parameter (even for the standard url field path), and streamPanDirect must read this header and use the spider's UA/Referer instead of hardcoded defaults
- Electron build must include 'tools/' and 'fatcat/' directories in extraResources to ensure spider JARs and dependencies are available at runtime
- JDK 8+ must be available on target system; consider bundling JRE to ensure out-of-box functionality
- 夸克/UC网盘登录状态 (localStorage cookies) 不会随软件迁移，新设备需重新扫码登录
- VC++ Redistributable 2015+ must be installed on target system to run java-bridge native DLLs
- Electron build must bundle JRE to ensure out-of-box functionality on systems without Java installed
- DexConverter must use bundled JRE's java.exe instead of system Java to avoid dependency issues
- JRE must include jdk.zipfs module to support dex2jar's JAR output writing
- Linux and macOS builds require recursive chmod on jre/lib/ directory to ensure jspawnhelper is executable
- Electron asarUnpack must include **/node_modules/java-bridge*/**/* to match platform-specific java-bridge subpackages
- Cross-platform JRE extraction must use tar -xf instead of platform-specific tools (PowerShell Expand-Archive) to ensure compatibility
- JRE flattening must use fs.cpSync instead of fs.renameSync to avoid EPERM errors on Windows due to file locking
- GitHub Actions workflow must use native runners for each platform (windows-latest, ubuntu-latest, macos-13, macos-14) to build platform-specific packages
- Linux build targets must include AppImage and deb formats
- Mac build must include icon and category metadata
- Windows build must use NSIS installer format
- JRE download and extraction must be handled by cross-platform Node scripts instead of platform-specific shell scripts
- After-pack script must apply chmod recursively to jre/lib/ directory on Linux and macOS
- Build scripts must include platform-specific build commands (build:win, build:linux, build:mac)
- JRE must be bundled for all platforms (Windows, Linux, macOS) to ensure out-of-box functionality
- DexConverter must resolve tools path using process.resourcesPath to locate bundled dex-tools in packaged builds
- DexConverter must not rely on system PATH for dex2jar execution; use direct JRE calls to bundled dex-tools JAR
- 跨平台构建需通过推送v*标签或手动触发GitHub Actions workflow_dispatch
- Linux平台需通过chmod +x设置AppImage可执行权限后运行
- Mac平台需拖入Applications文件夹并右键打开以绕过Gatekeeper
- 打包后应用必须在未安装Java的电脑上直接运行
- 三平台并行构建需在GitHub Actions中配置windows-latest、ubuntu-latest、macos-13、macos-14 runners
- Linux .deb package requires author email in package.json maintainer field
- 夸克/UC网盘播放URL重写必须使用正则表达式 /^http:\/\/127\.0\.1:8096\/(\w+)\?url=([^&]+)/ 以匹配带额外参数（thread, chunk, key, type）的kaiser URL
- 登录信息和配置信息必须持久化到文件，确保每次应用启动都能加载正确的配置
- 首页翻页需改为下拉到底部触发加载
- 播放源检测需优先使用域名判断而非名称匹配
- 未登录状态下点击网盘播放源必须直接弹窗显示登录二维码，而非仅提示未登录
- 播放失败弹窗必须显示播放源名称并格式化错误信息（如将"B度"转换为"百度网盘"）
- 必须支持夸克、百度、UC、阿里、B站等源的正常播放
- 应用需通过脚本及Electron测试所有源的首页视频列表、详情页视频信息及播放剧集列表、详情页所有播放源播放功能
- 应用需达到商用级别稳定性要求
- Guard spider loading requires separate guardClassLoader initialized after appending Guard JAR to classpath to avoid class not found errors
- Spider classloader must be explicitly set to guardClassLoader for Guard spiders and restored in finally block
- SpiderInstance.classLoader must use guardClassLoader for Guard spider instances
- DexConverter must implement 3 retries with 1s/2s exponential backoff and partial output cleanup to handle Windows file lock/antivirus interference causing silent dex2jar failures
- wexguard_v8.so (ARM decryption library) compiled before 2026-07-20 cannot decrypt NetEase JARs containing new Guard stub classes added after 2026-06-13, causing class_not_found errors for ManJuHongGuo, ManJuXiFan, and AnimeHuazi sources
- Guard spider JAR candidate paths must include tools/guard_decrypt_work/wexguard-decrypted.jar to use test script-generated decrypted JARs
- InitOrigin.init() downloads libdecjni.so to C:\Users\zk\AppData\Local\Temp\tvbox_...\NewWex\libdecjni.so, which may differ from the configured jar_cache/native_libs path
- ManJuHongGuo spider requires libdecjni.so native library, which must be present in the correct directory to avoid FileNotFoundException
- Guard spider decryption must be triggered when NetEase JAR is in jar_cache and pre-decrypted JAR is missing/expired
- JAR candidate paths must prioritize runtime-decrypted JARs, then pre-decrypted JARs, then test script-generated JARs in tools/guard_decrypt_work/
- Runtime Guard JAR decryption involves extracting wexguard_v8.so and wexshinidie.guard from NetEase JAR, decrypting with unidbg, extracting classes.dex, and converting to JAR
- GuardDecryptor must provide progress callbacks for UI feedback during the 1-2 minute decryption process
- NetEase JAR version check uses MD5 comparison to determine if re-decryption is needed
- Pre-decrypted JARs (tools/wexguard_work/wexguard-spider-enjarify.jar) may become outdated when NetEase JAR updates, causing missing classes
- Running node tools/test-guard-decrypt-flow.cjs downloads NetEase JAR to tools/guard_decrypt_work/netease.jar and generates decrypted JAR
- Android stub classes must be added to the classpath before loading Guard spiders to resolve initialization dependencies
- Guard spider decryption requires unidbg emulation to handle ARM native libraries on x86_64 systems
- ManJuHongGuo spider's homeContent method calls oOoOoOoOoOoOoO0o(), which depends on libdecjni.so for API response decryption
- Missing native libraries (like libdecjni.so) cause runtime errors even if the spider class is successfully loaded
- Guard spider JARs must be re-decrypted whenever the NetEase JAR's MD5 changes to ensure class synchronization
- JarLoader must first check for runtime-decrypted JARs in jar_cache/wexguard/, then pre-decrypted JARs, then test-generated JARs in tools/guard_decrypt_work/
- NetEase JAR must be present in jar_cache for runtime decryption to trigger; otherwise, pre-decrypted JARs are used as fallback
- Decrypted Guard JARs must be cached in jar_cache/wexguard/ to avoid re-decrypting on every application start
- File system permissions may prevent writing to jar_cache/wexguard/ on Windows, requiring fallback to tools/guard_decrypt_work/
- Guard spider initialization requires both the decrypted JAR and all required native libraries (like wexguard_v8.so, libdecjni.so) to be present in the correct paths
- GuardDecryptor must be rewritten to avoid bytecode modification; similar encryption/decryption components should follow this approach
- enjarify does not handle generic signatures, causing TypeToken errors; use dex2jar instead to preserve signatures
- TypeToken构造函数在getGenericSuperclass()不是ParameterizedType时（直接实例化），应设置$type = Object.class而非抛异常 — 解决混淆器导致的匿名子类扁平化成直接实例化问题
- WexGuaZiGuard's homeContent returns empty object due to LoadNiMa decode() returning Base64-encoded binary data instead of JSON; requires secondary decryption (AES/DES) after Base64 decoding
- LoadNiMa decryption requires a key obtained via a specific URL and a PHP method — details documented in WexGuaZi-Decryption-Solution.md
- NetEase JAR re-decryption overwrote the JAR while the classloader was using it, causing potential runtime errors
- PC源码中不得包含任何官方API地址、抓包接口、客户端身份伪造、加密算法，相关逻辑由用户自行获取的第三方JAR承担
- 登录入口改为iframe嵌入http://127.0.0.1:9978/proxy?do=wexconfig（JAR提供的Web配置页），PC不再自己实现二维码登录
- 二维码图片端点由PC拦截生成，输入参数透传自JAR
- 手动cookie注入作为兜底入口，供wexconfig不可用时使用
- 删除PanLoginService.ts、QuarkPanService.fetchPuusCookie、UCPanService中的抓包调用
- Spider initialization must use asynchronous callInitAsync with 30s timeout instead of initSync to prevent blocking the Electron main thread and freezing the window
- proxyInvokeStatic method must save and restore classloader in finally block to prevent ClassNotFoundException when spider calls switch classloaders
- 配置中心是登录状态唯一来源：所有 cookie 读取都通过 getSyncedCookie() 带 JVM fallback 实现
- 未登录时不弹窗，只返回错误消息：由 Detail.vue 的 playError 弹窗显示
- 登录失效时不弹窗，throw Error 让 renderer 显示：用户在配置中心手动重新登录
## 2026-07-27 ��������-����ҳCookieͬ����·�޸���֤��������뱣�棩

### ��֤�ű�
- ·��: `d:\Code\TVBOXDesktop\TVBox-PC\tools\e2e\verify-quark-cookie-fix.cjs`
- ��;: ͨ�� CDP ���� Electron renderer������ `quark:checkTokenValid` IPC ��֤ cookie ��ȡ��·

### ��֤�����2026-07-27��
```
=== Quark Cookie Sync Fix Verification ===
Step 1: window.electronIPC.invoke available: true
Step 2: Calling quark:checkTokenValid (uses getSyncedCookie with JVM fallback)...
Result: {"valid":true}
Step 3: Interpretation:
  valid=true, nickname=(unknown)
  -> Cookie was read successfully from JVM SharedPreferences
  -> Fix VERIFIED: config center login state propagates to detail page
```

### ��֤Ҫ��
1. **���������ѵ�¼״̬**: �û���ǰͨ�� wexconfig iframe ɨ���¼��ˣ�cookie д�� JVM SharedPreferences (`NewWexFnw_preferences.Wex_quark_cookie`)
2. **QuarkPanService.syncedCookie �ڴ��ֶ�Ϊ null**: ��Ϊ��¼��ͨ�� wexconfig iframe��û�е��� `setSyncedCookie`
3. **getSyncedCookie() fallback ��Ч**: �ڴ�Ϊ null ʱ������ `jarLoader.readQuarkCookieFromJVM()` �� JVM ��ȡ
4. **Quark API ��֤ͨ��**: �ö�ȡ���� cookie ���� `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token`�����ط� 31001 ״̬��֤�� cookie ��Ч

### �޸���·����֤ͨ����
```
[�������� wexconfig iframe ��¼]
   JVM SharedPreferences д�� Wex_quark_cookie
   �û��������ҳ����
   JarLoader.playerContent quark: fallback
   QuarkPanService.resolveQuarkDownloadUrl(shareId, fid)
   QuarkPanService.getSyncedCookie()  // �ڴ� null
   jarLoader.readQuarkCookieFromJVM()  // �� JVM ��ȡ
   �õ� cookie������ Quark API �������� URL
   ���� CDN URL�����ųɹ�
```

### UC/Baidu �޸�˵��
- UC �� Baidu ʹ����ͬ�Ĵ���ģʽ��`readUcCookieFromJVM`/`readBaiduCookieFromJVM` + `getSyncedCookie` JVM fallback��
- ���� UC/Baidu û�� `checkTokenValid` IPC���޷�ֱ����֤
- ������ģʽ�� Quark ��ȫһ�£��� `vite build` ����ͨ����Ԥ��ͬ����Ч

### ע������
- `jar:prefs:getValue` IPC ���� `{success: true, value: ...}` ����value ������ Java ���󣨲���ʱ��ʾ `[object Object]`��
- �� `readQuarkCookieFromJVM`/`readUcCookieFromJVM`/`readBaiduCookieFromJVM` ʹ�� `getStringSync()` ֱ�Ӷ�ȡ�ַ������ƹ��� IPC ���л�����
- �����Ϊʲô `quark:checkTokenValid` ������������ֱ�ӵ��� Java ���������� `jar:prefs:getValue` ���ض����ԭ��
