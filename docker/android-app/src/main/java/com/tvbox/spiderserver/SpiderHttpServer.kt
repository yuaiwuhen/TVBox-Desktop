package com.tvbox.spiderserver

import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import java.io.IOException

class SpiderHttpServer(port: Int) : NanoHTTPD(port) {

    companion object {
        private const val TAG = "SpiderHttpServer"
        private const val MIME_JSON = "application/json"
    }

    private val gson = Gson()
    private val spiderManager = SpiderManager()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        Log.d(TAG, "Request: $method $uri")

        return try {
            when {
                uri == "/health" -> handleHealth()
                uri.startsWith("/spider/") -> handleSpiderRequest(session)
                else -> newFixedLengthResponse(
                    Response.Status.NOT_FOUND,
                    MIME_JSON,
                    gson.toJson(ApiResponse.error("Not Found"))
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling request: $uri", e)
            newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR,
                MIME_JSON,
                gson.toJson(ApiResponse.error("Internal Server Error: ${e.message}"))
            )
        }
    }

    private fun handleHealth(): Response {
        val data = mapOf(
            "status" to "ok",
            "server" to "SpiderHTTPServer",
            "version" to "1.0.0"
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(ApiResponse.success(data))
        )
    }

    private fun handleSpiderRequest(session: IHTTPSession): Response {
        val uri = session.uri

        return runBlocking {
            when {
                uri == "/spider/load" -> handleLoad(session)
                uri == "/spider/init" -> handleInit(session)
                uri == "/spider/homeContent" -> handleHomeContent(session)
                uri == "/spider/categoryContent" -> handleCategoryContent(session)
                uri == "/spider/detailContent" -> handleDetailContent(session)
                uri == "/spider/playerContent" -> handlePlayerContent(session)
                uri == "/spider/searchContent" -> handleSearchContent(session)
                uri == "/spider/destroy" -> handleDestroy(session)
                else -> newFixedLengthResponse(
                    Response.Status.NOT_FOUND,
                    MIME_JSON,
                    gson.toJson(ApiResponse.error("API not found: $uri"))
                )
            }
        }
    }

    private fun handleLoad(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, LoadRequest::class.java)

        val result = spiderManager.loadJar(request.jarUrl, request.jarPath)
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleInit(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, InitRequest::class.java)

        val result = spiderManager.initSpider(
            request.key,
            request.className,
            request.ext,
            request.jarUrl
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleHomeContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, HomeContentRequest::class.java)

        val result = spiderManager.homeContent(request.key, request.filter)
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleCategoryContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, CategoryContentRequest::class.java)

        val result = spiderManager.categoryContent(
            request.key,
            request.tid,
            request.pg,
            request.filter,
            request.extend
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleDetailContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, DetailContentRequest::class.java)

        val result = spiderManager.detailContent(request.key, request.ids)
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handlePlayerContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, PlayerContentRequest::class.java)

        val result = spiderManager.playerContent(
            request.key,
            request.flag,
            request.id,
            request.vipFlags
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleSearchContent(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, SearchContentRequest::class.java)

        val result = spiderManager.searchContent(
            request.key,
            request.keyword,
            request.quick,
            request.pg
        )
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(result)
        )
    }

    private fun handleDestroy(session: IHTTPSession): Response {
        val body = parseRequestBody(session)
        val request = gson.fromJson(body, DestroyRequest::class.java)

        spiderManager.destroy(request.key)
        return newFixedLengthResponse(
            Response.Status.OK,
            MIME_JSON,
            gson.toJson(ApiResponse.success("Spider destroyed"))
        )
    }

    private fun parseRequestBody(session: IHTTPSession): String {
        val files = mutableMapOf<String, String>()
        try {
            session.parseBody(files)
            return files["postData"] ?: ""
        } catch (e: IOException) {
            Log.e(TAG, "Failed to parse request body", e)
            return ""
        } catch (e: ResponseException) {
            Log.e(TAG, "Response exception while parsing body", e)
            return ""
        }
    }
}

// 数据类定义
data class ApiResponse<T>(
    val success: Boolean,
    val data: T? = null,
    val error: String? = null
) {
    companion object {
        fun <T> success(data: T): ApiResponse<T> = ApiResponse(true, data)
        fun <T> error(message: String): ApiResponse<T> = ApiResponse(false, null, message)
    }
}

data class LoadRequest(
    val jarUrl: String,
    val jarPath: String? = null
)

data class InitRequest(
    val key: String,
    val className: String,
    val ext: String,
    val jarUrl: String
)

data class HomeContentRequest(
    val key: String,
    val filter: Boolean
)

data class CategoryContentRequest(
    val key: String,
    val tid: String,
    val pg: String,
    val filter: Boolean,
    val extend: Map<String, String>
)

data class DetailContentRequest(
    val key: String,
    val ids: List<String>
)

data class PlayerContentRequest(
    val key: String,
    val flag: String,
    val id: String,
    val vipFlags: List<String>
)

data class SearchContentRequest(
    val key: String,
    val keyword: String,
    val quick: Boolean,
    val pg: String? = null
)

data class DestroyRequest(
    val key: String
)