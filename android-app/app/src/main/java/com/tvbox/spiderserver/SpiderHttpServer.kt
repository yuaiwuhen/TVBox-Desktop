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

    override fun serve(session: IHTTPSession): Response {
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
        Log.d(TAG, "Request: ${session.method} $uri")
        return when {
            uri == "/health" -> handleHealth()
            uri == "/spider/load" -> handleLoad(session)
            uri == "/spider/init" -> handleInit(session)
            uri == "/spider/homeContent" -> handleHomeContent(session)
            uri == "/spider/homeVideoContent" -> handleHomeVideoContent(session)
            uri == "/spider/categoryContent" -> handleCategoryContent(session)
            uri == "/spider/detailContent" -> handleDetailContent(session)
            uri == "/spider/playerContent" -> handlePlayerContent(session)
            uri == "/spider/searchContent" -> handleSearchContent(session)
            uri == "/spider/destroy" -> handleDestroy(session)
            uri == "/spider/setPref" -> handleSetPref(session)
            uri == "/spider/resolve" -> handleResolve(session)
            uri == "/proxy" -> handleProxy(session)
            uri == "/image" -> handleImageProxy(session)
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
