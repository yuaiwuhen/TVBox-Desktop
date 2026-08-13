package com.tvbox.spiderserver

import android.content.Context
import android.util.Log
import com.github.catvod.crawler.Spider
import com.github.catvod.crawler.SpiderNull
import dalvik.system.DexClassLoader
import java.io.File
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Spider JAR loader that mirrors FongMi/TV's official JarLoader.
 *
 * Reference: com.fongmi.android.tv.api.loader.JarLoader
 *   DexClassLoader loader = new DexClassLoader(file.getAbsolutePath(), cachePath, cachePath, App.get().getClassLoader());
 *   invokeInit(loader);   // calls Init.init(Context) with Application
 *   Spider spider = (Spider) loader.loadClass("com.github.catvod.spider." + api.split("csp_")[1]).newInstance();
 *   spider.init(App.get(), ext);
 *
 * catvod's Init.context() is set in SpiderApplication.attachBaseContext
 * via Init.set(base), exactly like FongMi/TV's App.attachBaseContext.
 * This makes the merge.* classes inside the spider JAR find a valid
 * Context for getSharedPreferences() etc.
 */
class SpiderManager {
    private val jarCache: ConcurrentHashMap<String, File> = ConcurrentHashMap()
    private val loaders: ConcurrentHashMap<String, DexClassLoader> = ConcurrentHashMap()
    private val spiders: ConcurrentHashMap<String, Spider> = ConcurrentHashMap()

    /** Track the currently active JAR URL, exposed for /health. */
    @Volatile
    private var activeJarUrl: String? = null

    /** Returns the currently active JAR URL (or null if none loaded yet). */
    fun getActiveJarUrl(): String? = activeJarUrl

    fun loadJar(jarUrl: String, jarPath: String?): ApiResponse {
        Log.d(TAG, "Loading JAR: $jarUrl")
        return try {
            val cached = jarCache[jarUrl]
            val file = if (cached != null && cached.exists()) {
                Log.d(TAG, "JAR already cached: ${cached.absolutePath}")
                cached
            } else if (!jarPath.isNullOrEmpty()) {
                val f = File(jarPath)
                if (f.exists()) {
                    Log.d(TAG, "Using provided JAR path: ${f.absolutePath}")
                    f
                } else {
                    downloadJar(jarUrl)
                }
            } else {
                downloadJar(jarUrl)
            }
            jarCache[jarUrl] = file
            activeJarUrl = jarUrl
            Log.i(TAG, "JAR loaded successfully: ${file.name} (activeJarUrl=$activeJarUrl)")
            ApiResponse.success("JAR loaded successfully: ${file.name}")
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to load JAR: $jarUrl", e)
            ApiResponse.error("Failed to load JAR: ${e.message}")
        }
    }

    /**
     * Initialize a spider identified by [key] and [className].
     *
     * Mirrors FongMi/TV's JarLoader.getSpider:
     *   1. parseJar — ensure spider JAR is loaded into a DexClassLoader
     *   2. invokeInit — call Init.init(Context) with Application
     *   3. loader.loadClass("com.github.catvod.spider." + className).newInstance()
     *   4. spider.init(App.get(), ext)
     */

    /**
     * Most recently used spider key, tracked so /proxy and /spider/resolve can
     * route JAR proxy() calls to the right spider instance without the PC
     * passing a key. Mirrors the old Electron JarLoader.recentSpiderKey and
     * Android's ApiConfig.recentKey mechanism.
     */
    @Volatile
    private var recentSpiderKey: String? = null

    fun getRecentSpiderKey(): String? = recentSpiderKey

    private fun setRecentSpider(key: String) {
        recentSpiderKey = key
    }

    private val initLock = Any()

    fun initSpider(key: String, className: String, ext: String?, jarUrl: String): ApiResponse {
        // Serialize spider init — the spider JAR uses static state that
        // corrupts when two threads init concurrently (NPE on Spider.init).
        // NanoHTTPD serves requests on a thread pool, so without this lock
        // the Electron app's parallel requests crash the spider.
        synchronized(initLock) {
            Log.d(TAG, "Initializing spider: $className")
            return try {
                // Auto-reload JAR if missing from in-memory cache. The JAR file
                // is still on disk in /cache/, so we just need to re-populate
                // the cache.
                var jarFile = jarCache[jarUrl]
                if (jarFile == null || !jarFile.exists()) {
                    Log.w(TAG, "JAR cache miss for $jarUrl, auto-reloading")
                    val loadResp = loadJar(jarUrl, null)
                    if (!loadResp.success) {
                        throw Exception("JAR reload failed: ${loadResp.error}")
                    }
                    jarFile = jarCache[jarUrl]
                        ?: throw Exception("JAR not loaded: $jarUrl")
                }

                val loader = parseJar(jarUrl, jarFile)

                // Set the thread's context classloader to the spiderLoader for
                // the duration of all spider JAR method calls. Spider JAR code
                // (e.g. Init.init, spider.homeContent) uses Kotlin coroutines
                // (runBlocking) which default to the thread's context
                // classloader for FindClass. Without this, coroutines use the
                // systemLoader (PathClassLoader), which lacks spider JAR
                // classes (Init, etc.), causing ClassNotFoundException ->
                // SIGABRT ("JNI NewGlobalRef called with pending exception").
                val thread = Thread.currentThread()
                val originalTccl = thread.contextClassLoader
                thread.contextClassLoader = loader
                try {
                    // Call Init.init(Context) — populates spider JAR's
                    // Init.context used by spider code for getSharedPreferences.
                    invokeInit(loader)

                    // Resolve the spider class name. className is like "csp_NewDouBanGuard".
                    val spiderClassName = "com.github.catvod.spider." + className.split("csp_").last()
                    Log.d(TAG, "Loading spider class: $spiderClassName")

                    val spiderClassLoader: ClassLoader = loader
                    Log.i(TAG, "Using spider classloader: ${spiderClassLoader.javaClass.simpleName}")
                    var spiderInstance: Spider? = null
                    var loadError: Throwable? = null

                    try {
                        spiderInstance = spiderClassLoader.loadClass(spiderClassName).newInstance() as? Spider
                    } catch (e: Throwable) {
                        Log.w(TAG, "Load $spiderClassName via spiderClassLoader failed: ${e.javaClass.simpleName}: ${e.message}")
                        loadError = e
                    }

                    val finalizedSpider = spiderInstance
                        ?: throw (loadError ?: Exception("Failed to load spider class: $spiderClassName (newInstance returned null)"))

                    try {
                        finalizedSpider.init(applicationContext(), ext ?: "")
                    } catch (initError: Throwable) {
                        Log.w(TAG, "Spider.init() threw ${initError.javaClass.simpleName}: ${initError.message}")
                    }
                    Log.i(TAG, "Spider initialized: $className (class=${finalizedSpider.javaClass.name})")

                    spiders[key] = finalizedSpider
                    recentSpiderKey = key
                    ApiResponse.success("Spider initialized: $className")
                } finally {
                    thread.contextClassLoader = originalTccl
                }
            } catch (e: Throwable) {
                // Catch Throwable — spider init can throw Errors like
                // UnsatisfiedLinkError / ExceptionInInitializerError. These
                // must not escape or they crash the worker thread and clear
                // the JAR cache.
                Log.e(TAG, "Failed to initialize spider: $className", e)
                ApiResponse.error("Failed to initialize spider: ${e.message}")
            }
        }
    }

    /**
     * Build (or reuse) a DexClassLoader for [jarFile].
     *
     * Mirrors FongMi/TV's JarLoader.load():
     *   String cachePath = Path.jar().getAbsolutePath();
     *   DexClassLoader loader = new DexClassLoader(file.getAbsolutePath(), cachePath, cachePath, App.get().getClassLoader());
     *
     * We pass the app's native library dir as librarySearchPath so spider
     * JARs that bundle native libraries can find them via System.loadLibrary.
     */
    private fun parseJar(jarUrl: String, jarFile: File): DexClassLoader {
        loaders[jarUrl]?.let { return it }

        val ctx = applicationContext()
        val cachePath = File(ctx.codeCacheDir, "jar").apply { mkdirs() }.absolutePath
        val nativeLibDir = ctx.applicationInfo.nativeLibraryDir

        Log.d(TAG, "parseJar: file=${jarFile.absolutePath}, cachePath=$cachePath, nativeLibDir=$nativeLibDir")

        val loader = DexClassLoader(
            jarFile.absolutePath,
            cachePath,
            nativeLibDir,
            javaClass.classLoader
        )

        loaders[jarUrl] = loader
        return loader
    }

    /**
     * Initialize the spider JAR's `Init` singleton by calling
     * Init.init(Context) with the Application. This mirrors
     * FongMi/TV's JarLoader.invokeInit.
     */
    private fun invokeInit(loader: ClassLoader) {
        try {
            val clz = loader.loadClass("com.github.catvod.spider.Init")
            val method = clz.getMethod("init", Context::class.java)
            method.invoke(null, applicationContext())
            Log.d(TAG, "Init.init(Context) called")
        } catch (e: Throwable) {
            Log.w(TAG, "invokeInit failed (spider JAR may not expose Init.init): ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun applicationContext(): Context {
        // Prefer SpiderApplication.get() — returns the Application instance.
        // The spider JAR's Init.init(Context) casts Context to Application,
        // so we MUST pass an Application, not a ContextImpl.
        // Mirrors FongMi/TV's JarLoader which calls method.invoke(clz, App.get()).
        try {
            return SpiderApplication.get()
        } catch (_: Throwable) {
            // instance not set yet — fall through
        }
        // Fallback: ActivityThread.currentApplication() also returns Application.
        val cls = Class.forName("android.app.ActivityThread")
        val method = cls.getMethod("currentApplication")
        val app = method.invoke(null) as? android.app.Application
            ?: throw IllegalStateException("ActivityThread.currentApplication() returned null")
        return app
    }

    fun homeContent(key: String, filter: Boolean): ApiResponse =
        invokeSpiderMethod(key, "homeContent", arrayOf(Boolean::class.java), arrayOf(filter))

    fun homeVideoContent(key: String): ApiResponse =
        invokeSpiderMethod(key, "homeVideoContent", arrayOf(), arrayOf())

    fun categoryContent(key: String, tid: String, pg: String, filter: Boolean, extend: Map<String, String>): ApiResponse {
        val hashMap = if (extend is java.util.HashMap) extend else java.util.HashMap(extend)
        return invokeSpiderMethod(
            key, "categoryContent",
            arrayOf(String::class.java, String::class.java, Boolean::class.java, java.util.HashMap::class.java),
            arrayOf(tid, pg, filter, hashMap)
        )
    }

    fun detailContent(key: String, ids: List<String>): ApiResponse =
        invokeSpiderMethod(key, "detailContent", arrayOf(List::class.java), arrayOf(ids))

    fun playerContent(key: String, flag: String, id: String, vipFlags: List<String>): ApiResponse {
        // Remember which spider produced the playback URL. /proxy requests
        // that follow (streaming video segments through the JAR proxy) route
        // to this spider.
        setRecentSpider(key)
        return invokeSpiderMethod(
            key, "playerContent",
            arrayOf(String::class.java, String::class.java, List::class.java),
            arrayOf(flag, id, vipFlags)
        )
    }

    fun searchContent(key: String, keyword: String, quick: Boolean, pg: String): ApiResponse {
        val spider = spiders[key] ?: return ApiResponse.error("Spider not found: $key")
        return try {
            val spiderClass = spider.javaClass
            val result = try {
                val m = spiderClass.getMethod("searchContent", String::class.java, Boolean::class.java, String::class.java)
                m.invoke(spider, keyword, quick, pg) as String
            } catch (nf: NoSuchMethodException) {
                val m = spiderClass.getMethod("searchContent", String::class.java, Boolean::class.java)
                m.invoke(spider, keyword, quick) as String
            }
            ApiResponse.success(result)
        } catch (e: Throwable) {
            // Catch Throwable (not Exception) — spider JARs can throw
            // UnsatisfiedLinkError / NoClassDefFoundError. Letting these
            // escape crashes the NanoHTTPD worker thread and may take down
            // the whole process, clearing the in-memory JAR cache.
            Log.e(TAG, "searchContent failed for $key", e)
            ApiResponse.error("searchContent failed: ${e.message}")
        }
    }

    fun destroy(key: String) {
        val spider = spiders.remove(key)
        try {
            spider?.destroy()
        } catch (e: Throwable) {
            Log.w(TAG, "destroy failed for $key: ${e.message}")
        }
    }

    // =========================================================================
    // JAR proxy execution (desktop playback streams through /proxy).
    //
    // The spider JAR's proxy(Map<String,String>) returns
    //   Object[]{ int statusCode, String mime, InputStream stream,
    //             Map<String,String> headers? }
    // (matches the old Electron JarLoader.parseProxyResult). We invoke it on
    // the most recent spider, mirroring Android's ApiConfig.proxyLocal flow:
    //   1. spider.proxyLocal(Map) instance method (if present)
    //   2. spider.proxy(Map) instance method
    //   3. static com.github.catvod.spider.ProxyOrigin.proxy(Map)
    // =========================================================================

    data class ProxyResult(
        val status: Int,
        val mime: String,
        val bytes: ByteArray,
        val headers: Map<String, String> = emptyMap(),
        val error: String? = null,
    )

    fun handleProxy(params: Map<String, String>): ProxyResult {
        val key = recentSpiderKey
            ?: return ProxyResult(500, "text/plain", byteArrayOf(), error = "No recent spider key set")
        val spider = spiders[key]
            ?: return ProxyResult(404, "text/plain", byteArrayOf(), error = "Spider not found: $key")
        return try {
            val thread = Thread.currentThread()
            val originalTccl = thread.contextClassLoader
            thread.contextClassLoader = spider.javaClass.classLoader
            try {
                val result = invokeProxy(spider, HashMap(params))
                if (result == null) {
                    ProxyResult(502, "text/plain", byteArrayOf(), error = "proxy returned null (do=${params["do"]})")
                } else {
                    parseProxyResult(result)
                }
            } finally {
                thread.contextClassLoader = originalTccl
            }
        } catch (e: Throwable) {
            val cause = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
            Log.e(TAG, "handleProxy failed: ${cause.javaClass.simpleName}: ${cause.message}")
            ProxyResult(500, "text/plain", byteArrayOf(), error = "proxy failed: ${cause.message}")
        }
    }

    private fun invokeProxy(spider: Spider, params: Map<String, String>): Any? {
        val spiderClass = spider.javaClass
        // 1. Instance proxyLocal(Map) — spider-specific logic (encryption,
        //    CDN scheduling). Mirrors Android ApiConfig.proxyLocal().
        try {
            val m = spiderClass.getMethod("proxyLocal", Map::class.java)
            val r = m.invoke(spider, params)
            if (r != null) {
                Log.i(TAG, "proxyLocal succeeded (do=${params["do"]})")
                return r
            }
            Log.w(TAG, "proxyLocal returned null (do=${params["do"]})")
        } catch (e: NoSuchMethodException) {
            // proxyLocal not implemented — fine.
        } catch (e: Throwable) {
            Log.w(TAG, "proxyLocal failed: ${e.message}", e)
        }
        // 2. Instance proxy(Map) — standard catvod interface.
        try {
            val m = spiderClass.getMethod("proxy", Map::class.java)
            val r = m.invoke(spider, params)
            if (r != null) return r
            Log.w(TAG, "proxy returned null (do=${params["do"]})")
        } catch (e: NoSuchMethodException) {
            // fall through
        } catch (e: Throwable) {
            Log.w(TAG, "proxy failed: ${e.message}", e)
        }
        // 3. Static ProxyOrigin.proxy(Map) — the original desktop fallback.
        try {
            val cls = spiderClass.classLoader?.loadClass("com.github.catvod.spider.ProxyOrigin")
                ?: return null
            val m = cls.getMethod("proxy", Map::class.java)
            val r = m.invoke(null, params)
            if (r != null) return r
            Log.w(TAG, "ProxyOrigin.proxy returned null (do=${params["do"]})")
        } catch (e: Throwable) {
            Log.w(TAG, "ProxyOrigin.proxy failed: ${e.message}", e)
        }
        return null
    }

    private fun parseProxyResult(result: Any): ProxyResult {
        when (result) {
            is Array<*> -> {
                val arr = result
                if (arr.size < 3) {
                    return ProxyResult(500, "text/plain", byteArrayOf(), error = "proxy result array length < 3")
                }
                val status = (arr[0] as? Number)?.toInt() ?: 200
                val mime = (arr[1] as? String) ?: "application/octet-stream"
                val stream = arr[2]
                val headers = mutableMapOf<String, String>()
                if (arr.size >= 4 && arr[3] is Map<*, *>) {
                    for ((k, v) in arr[3] as Map<*, *>) {
                        if (k != null && v != null) headers[k.toString()] = v.toString()
                    }
                }
                val bytes = when (stream) {
                    is java.io.InputStream -> stream.use { it.readBytes() }
                    is String -> stream.toByteArray(Charsets.UTF_8)
                    is ByteArray -> stream
                    else -> null
                }
                if (bytes == null) {
                    return ProxyResult(500, "text/plain", byteArrayOf(), error = "proxy stream null (type=${stream?.javaClass?.name})")
                }
                return ProxyResult(status, mime, bytes, headers)
            }
            is String -> return ProxyResult(200, "text/plain; charset=utf-8", result.toByteArray(Charsets.UTF_8))
            is ByteArray -> return ProxyResult(200, "application/octet-stream", result)
            else -> return ProxyResult(500, "text/plain", byteArrayOf(), error = "unexpected proxy result type: ${result.javaClass.name}")
        }
    }

    /**
     * Resolve a proxy request to concrete playback info for the desktop
     * player: { url, headers, mime, type, body }.
     *
     * Runs the JAR proxy() (same path as /proxy) and reports what it produced:
     *  - If the result is a playlist (m3u8) or text/json, `body` carries the
     *    (rewritten) content and `type` = "m3u8" | "text" | "json".
     *  - If the result is a video stream, `url` is the streamable URL the PC
     *    can fetch (through this same server) and `headers` are the headers the
     *    JAR requested. The PC player can either fetch `url` directly or re-run
     *    /proxy for segments.
     */
    fun resolve(params: Map<String, String>): ApiResponse {
        val result = handleProxy(params)
        if (result.error != null) {
            return ApiResponse.error(result.error ?: "resolve failed")
        }
        return try {
            val text = String(result.bytes, Charsets.UTF_8)
            val type = when {
                result.mime.contains("mpegurl") || text.startsWith("#EXTM3U") -> "m3u8"
                result.mime.contains("json") -> "json"
                result.mime.startsWith("text/") -> "text"
                else -> "video"
            }
            val data = mutableMapOf<String, Any?>(
                "mime" to result.mime,
                "headers" to result.headers,
                "type" to type,
                "status" to result.status,
            )
            if (type == "m3u8") {
                val rewritten = m3u8Rewrite(text, params)
                data["body"] = rewritten
                data["url"] = null
            } else if (type == "text" || type == "json") {
                data["body"] = text
                data["url"] = null
            } else {
                // Video stream: expose the original CDN URL (if the JAR passed
                // one) plus the /proxy URL as the fetchable stream URL.
                data["url"] = params["url"] ?: ""
                data["body"] = null
            }
            ApiResponse.success(data)
        } catch (e: Throwable) {
            ApiResponse.error("resolve parse failed: ${e.message}")
        }
    }

    /**
     * Rewrite an m3u8 manifest so every segment/playlist URI points back at
     * this proxy server (http://127.0.0.1:9978/proxy?<same params>&url=<segment>).
     * The desktop player fetches segments through the adb forward (19978),
     * so the JAR re-applies anti-leech headers for every segment — the browser
     * cannot set those headers directly.
     */
    fun m3u8Rewrite(manifest: String, params: Map<String, String>): String {
        val base = params["url"]
        val sb = StringBuilder()
        val lines = manifest.split("\n")
        for (line in lines) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                sb.append(line).append("\n")
                continue
            }
            // Resolve the segment URI against the base playlist URL.
            val segmentUrl = try {
                if (base.isNullOrEmpty()) trimmed
                else URL(URL(base), trimmed).toString()
            } catch (e: Throwable) {
                trimmed
            }
            val q = HashMap(params)
            q["url"] = segmentUrl
            val query = q.entries.joinToString("&") { (k, v) ->
                "${k.encode()}=${v.encode()}"
            }
            sb.append("http://127.0.0.1:9978/proxy?").append(query).append("\n")
        }
        return sb.toString()
    }

    private fun String.encode(): String =
        java.net.URLEncoder.encode(this, "UTF-8")

    /**
     * Persist a playback preference into SharedPreferences so JAR spiders
     * that read these keys during playerContent honor the value set on the
     * PC side. The preference file is the same one FongMi/TV uses
     * ("tvbox_prefs") so existing JAR spiders can read it via
     * context.getSharedPreferences("tvbox_prefs", 0).
     */
    fun setPref(key: String, value: String): Boolean {
        return try {
            val ctx = applicationContext()
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit().putString(key, value).apply()
            Log.i(TAG, "Pref saved: $key=$value")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "setPref failed for $key", e)
            false
        }
    }

    private fun invokeSpiderMethod(
        key: String,
        methodName: String,
        paramTypes: Array<Class<*>>,
        args: Array<Any?>
    ): ApiResponse {
        val spider = spiders[key] ?: return ApiResponse.error("Spider not found: $key")
        return try {
            val spiderClass = spider.javaClass
            val method = spiderClass.getMethod(methodName, *paramTypes)
            val result = method.invoke(spider, *args) as String
            ApiResponse.success(result)
        } catch (e: Throwable) {
            // Catch Throwable (not Exception) — spider JARs can throw
            // UnsatisfiedLinkError / NoClassDefFoundError / ExceptionInInitializerError.
            // These Errors escape `catch (Exception)` and crash the NanoHTTPD
            // worker thread, which clears the in-memory JAR cache and breaks
            // all subsequent inits.
            Log.e(TAG, "$methodName failed for $key", e)
            // Unwrap InvocationTargetException to expose the real cause (the spider
            // method's actual exception). The wrapper's message is null, which makes
            // the error message useless for debugging.
            val cause = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
            Log.e(TAG, "$methodName cause for $key", cause)
            ApiResponse.error("$methodName failed: ${cause.javaClass.simpleName}: ${cause.message ?: "null"}")
        }
    }

    private fun downloadJar(jarUrl: String): File {
        Log.d(TAG, "Downloading JAR from: $jarUrl")
        val fileName = jarUrl.substringAfterLast('/')
        val targetFile = File("/data/data/com.tvbox.spiderserver/cache/$fileName")
        if (!targetFile.exists()) {
            URL(jarUrl).openStream().use { input ->
                targetFile.outputStream().use { output -> input.copyTo(output) }
            }
            Log.i(TAG, "JAR downloaded: ${targetFile.absolutePath}")
        }
        // Android 10+ forbids loading writable DEX files.
        if (targetFile.canWrite()) {
            targetFile.setReadOnly()
            Log.d(TAG, "JAR set read-only: ${targetFile.absolutePath}")
        }
        return targetFile
    }

    @Suppress("unused")
    private fun spiderNull(): Spider = SpiderNull()

    companion object {
        private const val TAG = "SpiderManager"
        // SharedPreferences file name. JAR spiders read via:
        //   Init.context().getSharedPreferences("tvbox_prefs", 0)
        private const val PREFS_NAME = "tvbox_prefs"
    }
}