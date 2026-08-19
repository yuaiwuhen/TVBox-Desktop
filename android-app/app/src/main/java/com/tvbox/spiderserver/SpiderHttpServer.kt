package com.tvbox.spiderserver

import android.util.Log
import com.google.gson.Gson
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

/**
 * HTTP server exposing spider API endpoints on port 9978.
 */
class SpiderHttpServer(port: Int = DEFAULT_PORT) : NanoHTTPD(port) {
    private val gson: Gson = Gson()
    private val spiderManager: SpiderManager = SpiderManager()

    init {
        SpiderManager.instance = spiderManager
    }

    override fun serve(session: IHTTPSession): Response {
        // NanoHTTPD decodes the POST body with the charset declared in the
        // "Content-Type" header, defaulting to US-ASCII when none is present
        // (see ContentType.getEncoding()). Our desktop frontend sends JSON
        // bodies with UTF-8 bytes and "Content-Type: application/json" (no
        // charset), so Chinese characters in keys/flags (e.g. "夸克原画#01")
        // got mangled into US-ASCII garbage. Patching the header here makes
        // NanoHTTPD decode the body as UTF-8, fixing Chinese flag matching
        // (Quark / UC / etc.) in the spider JARs.
        if (session.method == NanoHTTPD.Method.POST) {
            val headers = session.headers
            val ct = headers["content-type"] ?: headers["Content-Type"] ?: ""
            if (ct.isNotEmpty() && !ct.contains("charset", ignoreCase = true)) {
                val base = ct.substringBefore(";").trim()
                headers["content-type"] = "$base; charset=UTF-8"
                headers["Content-Type"] = "$base; charset=UTF-8"
            }
        }
        return runBlocking {
            try {
                handleSpiderRequest(session)
            } catch (e: Throwable) {
                // Catch Throwable — spider JAR static initializers can throw
                // UnsatisfiedLinkError / ExceptionInInitializerError (Error
                // subclasses) which would otherwise escape and crash the
                // NanoHTTPD worker thread, clearing the in-memory jarCache.
                Log.e(TAG, "Request failed (Throwable)", e)
                newJsonResponse(ApiResponse.error("Server error: ${e.javaClass.simpleName}: ${e.message}"))
            }
        }
    }

    private fun handleSpiderRequest(session: IHTTPSession): Response {
        val uri = session.uri
        val query = session.queryParameterString
        Log.d(TAG, "Request: ${session.method} $uri${if (query.isNullOrEmpty()) "" else "?$query"}")
        return when {
            uri == "/health" -> handleHealth()
            uri == "/spider/load" -> handleLoad(session)
            uri == "/spider/init" -> handleInit(session)
            uri == "/spider/homeContent" -> handleHomeContent(session)
            uri == "/spider/homeVideoContent" -> handleHomeVideoContent(session)
            uri == "/spider/categoryContent" -> handleCategoryContent(session)
            uri == "/spider/detailContent" -> handleDetailContent(session)
            uri == "/spider/scan" -> handleScan(session)
            uri == "/spider/scan-status" -> handleScanStatus(session)
            uri == "/spider/action" -> handleAction(session)
            uri == "/spider/playerContent" -> handlePlayerContent(session)
            uri == "/spider/searchContent" -> handleSearchContent(session)
            uri == "/spider/destroy" -> handleDestroy(session)
            uri == "/spider/config" -> handleConfigUpdate(session)
            uri == "/spider/setPref" -> handleSetPref(session)
            uri == "/spider/resolve" -> handleResolve(session)
            uri == "/spider/dump" -> handleDump(session)
            uri == "/proxy" -> handleProxy(session)
            uri == "/goproxy" -> handleGoProxy(session)
            uri == "/image" -> handleImageProxy(session)
            uri == "/platform" -> handlePlatform(session)
            uri == "/action" -> handleConfigAction(session)
            // ── Remote desktop (config-center mirroring) ──
            uri == "/remote/screen" -> handleRemoteScreen(session)
            uri == "/remote/tap" -> handleRemoteTap(session)
            uri == "/remote/swipe" -> handleRemoteSwipe(session)
            uri == "/remote/text" -> handleRemoteText(session)
            uri == "/remote/back" -> handleRemoteBack(session)
            uri == "/remote/home" -> handleRemoteHome(session)
            uri == "/remote/open-config" -> handleRemoteOpenConfig(session)
            uri == "/remote/test-dialog" -> handleTestDialog(session)
            else -> newJsonResponse(ApiResponse.error("Unknown endpoint: $uri"))
        }
    }

    private fun handleHealth(): Response {
        val info = mapOf(
            "status" to "ok",
            "server" to "SpiderHTTPServer",
            "version" to "1.0.0",
            "startedAt" to SpiderApplication.startedAt,
            "activeJarUrl" to (spiderManager.getActiveJarUrl() ?: "")
        )
        return newJsonResponse(ApiResponse.success(info))
    }

    private fun handleLoad(session: IHTTPSession): Response {
        val request = parseBody(session, LoadRequest::class.java)
        val result = spiderManager.loadJar(request.jarUrl, request.jarPath)
        return newJsonResponse(result)
    }

    private fun handleInit(session: IHTTPSession): Response {
        val request = parseBody(session, InitRequest::class.java)
        // Normalize ext to a String: JsonPrimitive → its string value,
        // JsonObject/JsonArray → compact JSON string. This lets sites whose
        // config ext is an Object (bilibili, education sites) pass Gson
        // parsing and reach spider.init() with a JSON string, matching how
        // FongMi/TV serializes Object ext to String when loading Site.
        val extStr: String = when (val el = request.ext) {
            null -> ""
            is com.google.gson.JsonPrimitive -> el.asString
            else -> el.toString()
        }
        val result = spiderManager.initSpider(request.key, request.className, extStr, request.jarUrl)
        return newJsonResponse(result)
    }

    private fun handleHomeContent(session: IHTTPSession): Response {
        val request = parseBody(session, HomeContentRequest::class.java)
        val result = spiderManager.homeContent(request.key, request.filter)
        return newJsonResponse(result)
    }

    private fun handleHomeVideoContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, HomeContentRequest::class.java) ?: HomeContentRequest()
        val result = spiderManager.homeVideoContent(request.key)
        return newJsonResponse(result)
    }

    private fun handleCategoryContent(session: IHTTPSession): Response {
        val request = parseBody(session, CategoryContentRequest::class.java)
        val result = spiderManager.categoryContent(request.key, request.tid, request.pg, request.filter, request.extend)
        return newJsonResponse(result)
    }

    private fun handleDetailContent(session: IHTTPSession): Response {
        val request = parseBody(session, DetailContentRequest::class.java)
        val result = spiderManager.detailContent(request.key, request.ids)
        return newJsonResponse(result)
    }

    /**
     * 触发 jar 配置中心扫码弹窗并截取二维码，返回给桌面前端。
     * 请求体: { key, ids: ["addQuark"] }
     */
    private fun handleScan(session: IHTTPSession): Response {
        val request = parseBody(session, DetailContentRequest::class.java)
        val result = spiderManager.scanQr(request.key, request.ids)
        return newJsonResponse(result)
    }

    /**
     * 调用 jar 的 action(String) 接口（FongMi 点击配置中心条目时的入口）。
     * 请求体: { key, action: "quarkcookie" }
     */
    private fun handleAction(session: IHTTPSession): Response {
        val request = parseBody(session, ActionRequest::class.java)
        val result = spiderManager.spiderAction(request.key, request.action)
        return newJsonResponse(result)
    }

    /**
     * 查询当前二维码登录状态（前端轮询）。无请求体。
     */
    private fun handleScanStatus(session: IHTTPSession): Response {
        val result = spiderManager.scanStatus()
        return newJsonResponse(result)
    }

    private fun handlePlayerContent(session: IHTTPSession): Response {
        val request = parseBody(session, PlayerContentRequest::class.java)
        val result = spiderManager.playerContent(request.key, request.flag, request.id, request.vipFlags)
        return newJsonResponse(result)
    }

    private fun handleSearchContent(session: IHTTPSession): Response {
        val request = parseBody(session, SearchContentRequest::class.java)
        val result = spiderManager.searchContent(request.key, request.keyword, request.quick, request.pg)
        return newJsonResponse(result)
    }

    private fun handleDestroy(session: IHTTPSession): Response {
        val request = parseBody(session, DestroyRequest::class.java)
        spiderManager.destroy(request.key)
        return newJsonResponse(ApiResponse.success("Spider destroyed: ${request.key}"))
    }

    /**
     * /spider/config — push the config JSON's global `hosts` (DNS override
     * "host=ip") and `cors` (per-host header injection) rules into the JAR
     * runtime. Mirrors FongMi/TV: OkHttp.dns().addAll(hosts) +
     * OkHttp.responseInterceptor().addAll(cors).
     */
    private fun handleConfigUpdate(session: IHTTPSession): Response {
        val request = parseBody(session, ConfigUpdateRequest::class.java)
        try {
            spiderManager.updateGlobalConfig(request.hosts, request.cors)
            return newJsonResponse(ApiResponse.success("Config applied: ${request.hosts.size} hosts, ${request.cors.size} cors"))
        } catch (e: Throwable) {
            Log.e(TAG, "updateGlobalConfig failed", e)
            return newJsonResponse(ApiResponse.error("updateGlobalConfig failed: ${e.message}"))
        }
    }

    // ── Remote desktop (config-center mirroring) ─────────────────────────
    //
    // These endpoints let the PC (incl. Linux/Mac — just fill in the
    // app's IP:port) operate the on-device config center directly, like a
    // remote desktop. They are completely adb-free:
    //   GET  /remote/screen          → JPEG base64 of the current screen
    //   POST /remote/tap   {x,y}     → inject a tap at screen coords
    //   POST /remote/swipe {x1,y1,x2,y2,duration}
    //   POST /remote/text  {text}    → inject text into the focused field
    //   POST /remote/back            → press BACK

    private fun handleRemoteScreen(session: IHTTPSession): Response {
        val scale = session.parameters.get("scale")?.firstOrNull()?.toFloatOrNull() ?: 0f
        val b64 = RemotePanel.get().captureScreenshot(scale)
        if (b64 == null) {
            return newJsonResponse(ApiResponse.error("screenshot failed"))
        }
        // 返回设备真实分辨率，供 PC 端将镜像点击坐标换算为设备绝对坐标
        val dm = android.content.res.Resources.getSystem().displayMetrics
        return newJsonResponse(
            ApiResponse.success(
                mapOf(
                    "image" to b64,
                    "deviceWidth" to dm.widthPixels,
                    "deviceHeight" to dm.heightPixels,
                )
            )
        )
    }

    private fun handleRemoteTap(session: IHTTPSession): Response {
        val request = parseBody(session, RemoteTapRequest::class.java)
        val ok = RemotePanel.get().injectTap(request.x, request.y)
        return newJsonResponse(if (ok) ApiResponse.success("tap ${request.x},${request.y}") else ApiResponse.error("tap failed"))
    }

    private fun handleRemoteSwipe(session: IHTTPSession): Response {
        val request = parseBody(session, RemoteSwipeRequest::class.java)
        val ok = RemotePanel.get().injectSwipe(request.x1, request.y1, request.x2, request.y2, request.duration)
        return newJsonResponse(if (ok) ApiResponse.success("swipe ok") else ApiResponse.error("swipe failed"))
    }

    private fun handleRemoteText(session: IHTTPSession): Response {
        val request = parseBody(session, RemoteTextRequest::class.java)
        val ok = RemotePanel.get().injectText(request.text)
        return newJsonResponse(if (ok) ApiResponse.success("text ok") else ApiResponse.error("text failed"))
    }

    private fun handleRemoteBack(session: IHTTPSession): Response {
        val ok = RemotePanel.get().injectBack()
        return newJsonResponse(if (ok) ApiResponse.success("back ok") else ApiResponse.error("back failed"))
    }

    private fun handleTestDialog(session: IHTTPSession): Response {
        val ok = RemotePanel.get().showTestDialog()
        return newJsonResponse(if (ok) ApiResponse.success("test dialog shown") else ApiResponse.error("failed"))
    }

    private fun handleRemoteHome(session: IHTTPSession): Response {
        val ok = RemotePanel.get().injectHome()
        return newJsonResponse(if (ok) ApiResponse.success("home ok") else ApiResponse.error("home failed"))
    }

    /**
     * /remote/open-config — 让安卓端打开配置中心界面（ConfigCenterActivity）。
     * PC 端切换/进入配置中心站点时调用，使 RemoteMirror 镜像显示的是
     * 配置中心界面（登录二维码、网盘授权、cookie 设置等），而不是安卓
     * 端 MainActivity 首页。
     */
    private fun handleRemoteOpenConfig(session: IHTTPSession): Response {
        return try {
            val ctx = SpiderApplication.get()
            if (ctx == null) {
                newJsonResponse(ApiResponse.error("application context unavailable"))
            } else {
                ConfigCenterActivity.start(ctx)
                newJsonResponse(ApiResponse.success("config center opened"))
            }
        } catch (e: Throwable) {
            Log.e(TAG, "open-config failed", e)
            newJsonResponse(ApiResponse.error("open config failed: ${e.message}"))
        }
    }

    /**
     * Persist a playback preference (playSpeed / scaleType / hardDecode /
     * skipIntro / skipOutro) into SharedPreferences so JAR spiders that
     * read these keys (e.g. Quark pan spider's playerContent) honor the
     * value set on the PC side.
     */
    private fun handleSetPref(session: IHTTPSession): Response {
        val request = parseBody(session, SetPrefRequest::class.java)
        if (request.key.isBlank()) {
            return newJsonResponse(ApiResponse.error("Missing key"))
        }
        val ok = spiderManager.setPref(request.key, request.value)
        return if (ok) newJsonResponse(ApiResponse.success("Pref saved: ${request.key}=${request.value}"))
        else newJsonResponse(ApiResponse.error("Failed to save pref: ${request.key}"))
    }

    /**
     * /spider/resolve — resolve a JAR proxy request into concrete playback
     * info: { url, headers, mime, type, body }. Desktop player uses this when
     * it needs to know the final URL / manifest without streaming through
     * /proxy (e.g. to drive hls.js with custom headers, or inspect the URL).
     */
    private fun handleResolve(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val params = try {
            gson.fromJson(body, Map::class.java) as? Map<*, *>
        } catch (e: Throwable) {
            null
        }
        if (params == null) {
            return newJsonResponse(ApiResponse.error("Invalid resolve body"))
        }
        val map = HashMap<String, String>()
        for ((k, v) in params) {
            if (k != null && v != null) map[k.toString()] = v.toString()
        }
        if (map.isEmpty()) {
            return newJsonResponse(ApiResponse.error("Empty resolve params"))
        }
        val result = spiderManager.resolve(map)
        return newJsonResponse(result)
    }

    private fun handleDump(session: IHTTPSession): Response {
        val request = parseBody(session, DumpRequest::class.java)
        val text = spiderManager.dumpSpider(request.key)
        return newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, text)
    }

    /**
     * /proxy — JAR proxy endpoint. Mirrors Android TVBox's RemoteServer /proxy
     * route.
     *
     *  - ?do=ck  → "ok" (the JAR's Proxy.a() probes ports 9978-9999 to locate
     *    the local proxy; the probe must return exactly "ok").
     *  - otherwise → calls the recent spider's proxy(Map) and streams the
     *    result (m3u8 manifests are rewritten so segments route back through
     *    this server).
     */
    private fun handleProxy(session: IHTTPSession): Response {
        val params = HashMap<String, String>()
        for ((k, v) in session.parameters) {
            params[k] = v.firstOrNull() ?: ""
        }

        val doAction = params["do"]
        if (doAction == "ck") {
            return newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, "ok")
        }
        if (doAction.isNullOrEmpty()) {
            return newFixedLengthResponse(
                Response.Status.BAD_REQUEST,
                MIME_PLAINTEXT,
                "Missing do parameter",
            )
        }

        Log.d(TAG, "/proxy: do=$doAction url=${(params["url"] ?: "").take(80)}")
        val result = spiderManager.handleProxy(params)
        if (result.error != null) {
            Log.w(TAG, "/proxy failed: ${result.error}")
            return newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR,
                MIME_PLAINTEXT,
                result.error,
            )
        }

        val body = result.bytes
        val isM3u8 = result.mime.contains("mpegurl") ||
            (body.size > 0 && String(body, 0, minOf(body.size, 10), Charsets.UTF_8).startsWith("#EXTM3U"))
        val responseMime = if (isM3u8) "application/vnd.apple.mpegurl; charset=utf-8" else result.mime

        // m3u8 manifest: rewrite segment URIs to route through this proxy.
        if (isM3u8) {
            val text = String(body, Charsets.UTF_8)
            val rewritten = spiderManager.m3u8Rewrite(text, params)
            val resp = newFixedLengthResponse(
                Response.Status.OK,
                responseMime,
                rewritten,
            )
            addCors(resp)
            return resp
        }

        // Video/other binary stream: support Range requests for direct
        // streaming and seeking (hls.js/xgplayer send Range for mp4).
        val range = session.headers["range"] ?: session.headers["Range"]
        val resp = buildRangeResponse(result.status, responseMime, body, range)
        result.headers.forEach { (k, v) -> resp.addHeader(k, v) }
        addCors(resp)
        return resp
    }

    /**
     * /goproxy — unified proxy for the netdisk Go proxy that runs INSIDE the
     * emulator (Quark's goproxy-android-amd64 binds 127.0.0.1:7989).
     *
     * Netdisk JARs return playback URLs like
     *   http://127.0.0.1:7989?url=<quark dl>&key=quark&type=quark&...
     * The browser can't reach that internal port, so the renderer rewrites it
     * to  /goproxy?url=<encodeURIComponent(original 7989 URL)>  on the normal
     * spider port (19978 -> 9978). This handler forwards the request to the
     * local goproxy and streams the response back, keeping a single forwarded
     * port for everything.
     */
    private fun handleGoProxy(session: IHTTPSession): Response {
        // NanoHTTPD already URL-decodes query params once, so `url` here is the
        // exact JAR-generated goproxy URL (inner `url=` param still %-encoded).
        // IMPORTANT: do NOT URLDecoder.decode again -- double-decoding turns the
        // inner quark dl (`https%3A%2F%2F...%26filename%3D...`) into a bare URL
        // whose `&` splits params, which makes the Go proxy reply 400/empty.
        val target = session.parameters["url"]?.firstOrNull() ?: ""
        if (target.isBlank()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Missing url parameter")
        }
        Log.d(TAG, "/goproxy: target=${target.take(120)}")

        // Netdisk account Cookie injected by the PC frontend.
        //
        // The JAR's playerContent returns a `header` object containing the
        // account Cookie (e.g. `{"Cookie":"__pus=...;__puus=...;"}`). Quark's
        // goproxy REQUIRES this cookie when requesting the CDN (without it the
        // CDN answers 412 / an empty body -> DEMUXER_ERROR_COULD_NOT_OPEN).
        // FongMi's player (ExoPlayer) sends that Cookie header directly to the
        // goproxy URL. A browser <video> cannot attach a custom Cookie header,
        // so the renderer appends it as `&cookie=<encoded>` and we inject it
        // here, exactly matching FongMi's behaviour.
        val cookieParam = session.parameters["cookie"]?.firstOrNull() ?: ""
        if (cookieParam.isNotBlank()) {
            Log.d(TAG, "/goproxy: attaching netdisk cookie (${cookieParam.length} chars)")
        }

        return try {
            val conn = URL(target).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            conn.instanceFollowRedirects = true
            // Forward Range / User-Agent / Referer so direct mp4 streaming,
            // seeking and anti-leech checks work.
            val range = session.headers["range"] ?: session.headers["Range"]
            if (!range.isNullOrBlank()) conn.setRequestProperty("Range", range)
            val ua = session.headers["user-agent"] ?: session.headers["User-Agent"]
            if (!ua.isNullOrBlank()) conn.setRequestProperty("User-Agent", ua)
            // NOTE: we intentionally do NOT forward the browser's Referer
            // header. Quark's goproxy replies with HTTP 200 + empty body when a
            // request carries a foreign Referer (it builds its own correct Quark
            // request headers internally, including anti-leech). Forwarding it
            // caused DEMUXER_ERROR_COULD_NOT_OPEN.
            // Inject the netdisk cookie from the URL param. On Android,
            // HttpURLConnection accepts an explicit "Cookie" header via
            // setRequestProperty (mirrors FongMi attaching it from the player).
            if (cookieParam.isNotBlank()) {
                conn.setRequestProperty("Cookie", cookieParam)
            }
            conn.doInput = true

            val status = conn.responseCode
            val mime = conn.contentType ?: "application/octet-stream"
            val contentLength = conn.contentLength
            val contentRange = conn.getHeaderField("Content-Range")
            val acceptRanges = conn.getHeaderField("Accept-Ranges")
            Log.d(TAG, "/goproxy: status=$status mime=$mime contentLength=$contentLength contentRange=$contentRange acceptRanges=$acceptRanges")

            // HEAD 请求：movi-player 的 HttpSource 用 HEAD + Content-Length 获取
            // 文件总大小。goproxy 对 HEAD 返回 206 + Content-Length:1（把 Range
            // 头当 GET 处理），导致浏览器判定非法响应(ERR_INVALID_HTTP_RESPONSE)
            // 且拿不到真实大小。这里用 GET + Range: bytes=0-0 探测，从
            // Content-Range 解析总大小，返回标准 200 + Content-Length:<total>。
            if (session.method == NanoHTTPD.Method.HEAD) {
                try {
                    val probe = URL(target).openConnection() as HttpURLConnection
                    probe.connectTimeout = 15000
                    probe.readTimeout = 60000
                    probe.requestMethod = "GET"
                    probe.setRequestProperty("Range", "bytes=0-0")
                    if (cookieParam.isNotBlank()) {
                        probe.setRequestProperty("Cookie", cookieParam)
                    }
                    val probeStatus = probe.responseCode
                    val probeContentRange = probe.getHeaderField("Content-Range")
                    val total = probeContentRange
                        ?.substringAfter('/')
                        ?.trim()
                        ?.toLongOrNull()
                    Log.d(TAG, "/goproxy HEAD probe: status=$probeStatus contentRange=$probeContentRange total=$total")
                    val size = total ?: probe.contentLength.toLong()
                    probe.inputStream?.close() ?: probe.errorStream?.close()
                    probe.disconnect()
                    val resp = newFixedLengthResponse(
                        Response.Status.OK,
                        mime,
                        java.io.ByteArrayInputStream(ByteArray(0)),
                        size,
                    )
                    resp.addHeader("Accept-Ranges", acceptRanges ?: "bytes")
                    addCors(resp)
                    return resp
                } catch (e: Throwable) {
                    Log.w(TAG, "/goproxy HEAD probe failed, falling through: ${e.message}")
                }
            }

            val input = if (status in 200..299) conn.inputStream else conn.errorStream
                ?: java.io.ByteArrayInputStream(ByteArray(0))
            // Stream the upstream response directly to the client -- the Go proxy
            // serves the video body (hundreds of MB), so buffering with
            // readBytes() would OOM / hit readTimeout. Wrap the stream so the
            // HttpURLConnection is disconnected when NanoHTTPD closes it.
            val stream = DisconnectingInputStream(input, conn)
            val len = conn.contentLength
            val resp = if (len >= 0) {
                newFixedLengthResponse(
                    Response.Status.lookup(status) ?: Response.Status.OK,
                    mime,
                    stream,
                    len.toLong(),
                )
            } else {
                newChunkedResponse(
                    Response.Status.lookup(status) ?: Response.Status.OK,
                    mime,
                    stream,
                )
            }
            // Forward 206 Content-Range for seeking.
            conn.getHeaderField("Content-Range")?.let { resp.addHeader("Content-Range", it) }
            conn.getHeaderField("Accept-Ranges")?.let { resp.addHeader("Accept-Ranges", it) }
            addCors(resp)
            resp
        } catch (e: Throwable) {
            Log.w(TAG, "/goproxy failed: ${e.message}")
            newFixedLengthResponse(
                Response.Status.lookup(502) ?: Response.Status.INTERNAL_ERROR,
                MIME_PLAINTEXT,
                "goproxy error: ${e.message ?: e.javaClass.simpleName}",
            )
        }
    }

    /** InputStream that disconnects its HttpURLConnection when closed. */
    private class DisconnectingInputStream(
        private val delegate: java.io.InputStream,
        private val conn: HttpURLConnection,
    ) : java.io.InputStream() {
        override fun read(): Int = delegate.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = delegate.read(b, off, len)
        override fun skip(n: Long): Long = delegate.skip(n)
        override fun available(): Int = delegate.available()
        override fun close() {
            try {
                delegate.close()
            } finally {
                try {
                    conn.disconnect()
                } catch (_: Throwable) {
                }
            }
        }
    }

    /**
     * Build a byte-stream response with optional HTTP Range (206 partial)
     * support so the browser player can seek in direct video streams.
     */
    private fun buildRangeResponse(
        status: Int,
        mime: String,
        body: ByteArray,
        range: String?,
    ): Response {
        if (body.isEmpty()) {
            return newFixedLengthResponse(Response.Status.OK, mime, java.io.ByteArrayInputStream(body), 0)
        }
        if (range == null) {
            return newFixedLengthResponse(
                Response.Status.lookup(status) ?: Response.Status.OK,
                mime,
                java.io.ByteArrayInputStream(body),
                body.size.toLong(),
            )
        }
        val m = Regex("bytes=(\\d*)-(\\d*)").find(range)
        if (m == null) {
            return newFixedLengthResponse(
                Response.Status.RANGE_NOT_SATISFIABLE,
                MIME_PLAINTEXT,
                "Invalid Range",
            )
        }
        val startStr = m.groupValues[1]
        val endStr = m.groupValues[2]
        val total = body.size
        val start = if (startStr.isEmpty()) 0 else startStr.toIntOrNull() ?: 0
        var end = if (endStr.isEmpty()) total - 1 else endStr.toIntOrNull() ?: (total - 1)
        if (start >= total) {
            return newFixedLengthResponse(
                Response.Status.RANGE_NOT_SATISFIABLE,
                MIME_PLAINTEXT,
                "Range not satisfiable",
            )
        }
        end = minOf(end, total - 1)
        val slice = body.copyOfRange(start, end + 1)
        val resp = newFixedLengthResponse(
            Response.Status.PARTIAL_CONTENT,
            mime,
            java.io.ByteArrayInputStream(slice),
            slice.size.toLong(),
        )
        resp.addHeader("Content-Range", "bytes $start-$end/$total")
        resp.addHeader("Accept-Ranges", "bytes")
        return resp
    }

    private fun addCors(resp: Response): Response {
        resp.addHeader("Access-Control-Allow-Origin", "*")
        resp.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        resp.addHeader("Access-Control-Allow-Headers", "*")
        return resp
    }

    /**
     * Image proxy: mirrors electron/ProxyServer.ts `/image?url=...`.
     * Spider vod_pic URLs embed headers as suffixes:
     *   https://img3.doubanio.com/.../poster.jpg@Referer=https://movie.douban.com/@User-Agent=Mozilla/5.0...
     * We strip the @Referer/@User-Agent/@Cookie suffixes, send them as real
     * HTTP headers, and stream the image bytes back. This bypasses CDN
     * anti-leech checks (e.g. doubanio.com requires a Referer).
     */
    private fun handleImageProxy(session: IHTTPSession): Response {
        val params = session.parameters
        val rawUrl = params["url"]?.firstOrNull()
        if (rawUrl.isNullOrBlank()) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Missing url parameter")
        }

        // Extract @Referer, @User-Agent, @Cookie headers from the URL suffix.
        val headers = mutableMapOf<String, String>()
        listOf("@Referer=", "@User-Agent=", "@Cookie=").forEach { tag ->
            val idx = rawUrl.indexOf(tag)
            if (idx >= 0) {
                val start = idx + tag.length
                val end = rawUrl.indexOf('@', start).let { if (it < 0) rawUrl.length else it }
                val value = URLDecoder.decode(rawUrl.substring(start, end), "UTF-8")
                val key = when (tag) {
                    "@Referer=" -> "Referer"
                    "@User-Agent=" -> "User-Agent"
                    else -> "Cookie"
                }
                headers[key] = value
            }
        }

        // Real image URL = everything before the first @header suffix.
        val firstHeaderIdx = listOf("@Referer=", "@User-Agent=", "@Cookie=")
            .map { rawUrl.indexOf(it) }
            .filter { it >= 0 }
            .minOrNull() ?: rawUrl.length
        val imageUrl = rawUrl.substring(0, firstHeaderIdx)

        Log.d(TAG, "/image: url=${imageUrl.take(80)} headers=${headers.keys.joinToString(",")}")

        return try {
            val conn = URL(imageUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 10000
            conn.readTimeout = 15000
            conn.instanceFollowRedirects = true
            // A generic UA if the URL didn't specify one — some CDNs reject empty UA.
            conn.setRequestProperty("User-Agent", headers["User-Agent"] ?: "Mozilla/5.0 (Linux; Android 13) okhttp/4.9.3")
            headers.forEach { (k, v) ->
                if (k != "User-Agent") conn.setRequestProperty(k, v)
            }
            conn.inputStream.use { input ->
                val bytes = input.readBytes()
                val contentType = conn.contentType ?: "image/jpeg"
                val resp = newFixedLengthResponse(Response.Status.OK, contentType, java.io.ByteArrayInputStream(bytes), bytes.size.toLong())
                // Allow the renderer to cache images.
                resp.addHeader("Cache-Control", "public, max-age=86400")
                resp
            }
        } catch (e: Throwable) {
            Log.w(TAG, "/image fetch failed: ${e.message}")
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Image fetch failed: ${e.message}")
        }
    }

    /**
     * /platform — 配置中心 jar 的平台探测端点（如 wex jar 请求
     * /platform?type=androidbro）。实现 jar 配置中心协议，返回 200 让
     * jar 继续其扫码/弹窗流程。探测阶段返回空，后续按 jar 需求填充。
     */
    private fun handlePlatform(session: IHTTPSession): Response {
        val type = session.parameters["type"]?.firstOrNull() ?: ""
        Log.d(TAG, "/platform: type=$type (query=${session.queryParameterString})")
        return newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, "ok")
    }

    /**
     * /action — 配置中心 jar 的操作端点（如 wex jar 请求
     * /action?do=refresh&type=fuckunet）。探测阶段返回空 JSON，
     * 后续按 jar 协议实现扫码/登录流程。
     */
    private fun handleConfigAction(session: IHTTPSession): Response {
        val params = HashMap<String, String>()
        for ((k, v) in session.parameters) {
            params[k] = v.firstOrNull() ?: ""
        }
        Log.d(TAG, "/action: $params")
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON, "{}")
    }

    private fun <T> parseBody(session: IHTTPSession, clazz: Class<T>): T {
        val body = parseRequestBody(session)
        return gson.fromJson(body, clazz) ?: clazz.getDeclaredConstructor().newInstance()
    }

    private fun parseRequestBody(session: IHTTPSession): String {
        val files = HashMap<String, String>()
        session.parseBody(files)
        return files["postData"] ?: ""
    }

    private fun newJsonResponse(apiResponse: ApiResponse): Response {
        val json = gson.toJson(apiResponse)
        return newFixedLengthResponse(Response.Status.OK, MIME_JSON, json)
    }

    companion object {
        private const val TAG = "SpiderHttpServer"
        private const val DEFAULT_PORT = 9978

        /** Port the NanoHTTPD server listens on. Also set on catvod's Proxy. */
        const val PORT = DEFAULT_PORT
        private const val MIME_JSON = "application/json"
        private const val MIME_PLAINTEXT = "text/plain"
    }
}
