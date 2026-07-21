package com.tvbox.spiderserver

import android.util.Log
import com.google.gson.Gson
import dalvik.system.DexClassLoader
import java.io.File
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class SpiderManager {

    companion object {
        private const val TAG = "SpiderManager"
    }

    private val gson = Gson()
    private val spiders = ConcurrentHashMap<String, Any>()
    private val jarCache = ConcurrentHashMap<String, File>()

    /**
     * 加载JAR文件
     */
    fun loadJar(jarUrl: String, jarPath: String?): ApiResponse<String> {
        return try {
            Log.d(TAG, "Loading JAR: $jarUrl")

            // 如果提供了本地路径，直接使用
            val jarFile = if (jarPath != null && File(jarPath).exists()) {
                File(jarPath)
            } else {
                // 否则下载JAR文件
                downloadJar(jarUrl)
            }

            // 缓存JAR文件
            jarCache[jarUrl] = jarFile

            Log.i(TAG, "JAR loaded successfully: ${jarFile.absolutePath}")
            ApiResponse.success("JAR loaded successfully: ${jarFile.name}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load JAR: $jarUrl", e)
            ApiResponse.error("Failed to load JAR: ${e.message}")
        }
    }

    /**
     * 初始化Spider
     */
    fun initSpider(key: String, className: String, ext: String, jarUrl: String): ApiResponse<String> {
        return try {
            Log.d(TAG, "Initializing spider: $className")

            // 获取JAR文件
            val jarFile = jarCache[jarUrl] ?: throw Exception("JAR not loaded: $jarUrl")

            // 使用DexClassLoader加载类
            val optimizedDirectory = File("/data/data/com.tvbox.spiderserver/code_cache")
            if (!optimizedDirectory.exists()) {
                optimizedDirectory.mkdirs()
            }

            val classLoader = DexClassLoader(
                jarFile.absolutePath,
                optimizedDirectory.absolutePath,
                null,
                javaClass.classLoader
            )

            // 加载Spider类
            val spiderClass = classLoader.loadClass(className)
            val spiderInstance = spiderClass.getDeclaredConstructor().newInstance()

            // 调用init方法
            val initMethod = spiderClass.getMethod("init", String::class.java)
            initMethod.invoke(spiderInstance, ext)

            // 缓存Spider实例
            spiders[key] = spiderInstance

            Log.i(TAG, "Spider initialized successfully: $key")
            ApiResponse.success("Spider initialized: $className")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize spider: $className", e)
            ApiResponse.error("Failed to initialize spider: ${e.message}")
        }
    }

    /**
     * 获取首页内容
     */
    fun homeContent(key: String, filter: Boolean): ApiResponse<String> {
        return try {
            val spider = getSpider(key)
            val method = spider.javaClass.getMethod("homeContent", Boolean::class.java)
            val result = method.invoke(spider, filter) as String
            ApiResponse.success(result)
        } catch (e: Exception) {
            Log.e(TAG, "homeContent failed for $key", e)
            ApiResponse.error("homeContent failed: ${e.message}")
        }
    }

    /**
     * 获取分类内容
     */
    fun categoryContent(
        key: String,
        tid: String,
        pg: String,
        filter: Boolean,
        extend: Map<String, String>
    ): ApiResponse<String> {
        return try {
            val spider = getSpider(key)
            val method = spider.javaClass.getMethod(
                "categoryContent",
                String::class.java,
                String::class.java,
                Boolean::class.java,
                Map::class.java
            )
            val result = method.invoke(spider, tid, pg, filter, extend) as String
            ApiResponse.success(result)
        } catch (e: Exception) {
            Log.e(TAG, "categoryContent failed for $key", e)
            ApiResponse.error("categoryContent failed: ${e.message}")
        }
    }

    /**
     * 获取详情内容
     */
    fun detailContent(key: String, ids: List<String>): ApiResponse<String> {
        return try {
            val spider = getSpider(key)
            val method = spider.javaClass.getMethod("detailContent", List::class.java)
            val result = method.invoke(spider, ids) as String
            ApiResponse.success(result)
        } catch (e: Exception) {
            Log.e(TAG, "detailContent failed for $key", e)
            ApiResponse.error("detailContent failed: ${e.message}")
        }
    }

    /**
     * 获取播放链接
     */
    fun playerContent(key: String, flag: String, id: String, vipFlags: List<String>): ApiResponse<String> {
        return try {
            val spider = getSpider(key)
            val method = spider.javaClass.getMethod(
                "playerContent",
                String::class.java,
                String::class.java,
                List::class.java
            )
            val result = method.invoke(spider, flag, id, vipFlags) as String
            ApiResponse.success(result)
        } catch (e: Exception) {
            Log.e(TAG, "playerContent failed for $key", e)
            ApiResponse.error("playerContent failed: ${e.message}")
        }
    }

    /**
     * 搜索内容
     */
    fun searchContent(key: String, keyword: String, quick: Boolean, pg: String?): ApiResponse<String> {
        return try {
            val spider = getSpider(key)
            val result = if (pg != null) {
                val method = spider.javaClass.getMethod(
                    "searchContent",
                    String::class.java,
                    Boolean::class.java,
                    String::class.java
                )
                method.invoke(spider, keyword, quick, pg) as String
            } else {
                val method = spider.javaClass.getMethod(
                    "searchContent",
                    String::class.java,
                    Boolean::class.java
                )
                method.invoke(spider, keyword, quick) as String
            }
            ApiResponse.success(result)
        } catch (e: Exception) {
            Log.e(TAG, "searchContent failed for $key", e)
            ApiResponse.error("searchContent failed: ${e.message}")
        }
    }

    /**
     * 销毁Spider
     */
    fun destroy(key: String) {
        try {
            spiders.remove(key)
            Log.i(TAG, "Spider destroyed: $key")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to destroy spider: $key", e)
        }
    }

    /**
     * 获取Spider实例
     */
    private fun getSpider(key: String): Any {
        return spiders[key] ?: throw Exception("Spider not found: $key")
    }

    /**
     * 下载JAR文件
     */
    private fun downloadJar(url: String): File {
        val fileName = url.substringAfterLast('/')
        val targetFile = File("/data/data/com.tvbox.spiderserver/cache/$fileName")

        if (!targetFile.exists()) {
            Log.d(TAG, "Downloading JAR from: $url")
            val connection = URL(url).openConnection()
            connection.getInputStream().use { input ->
                targetFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            Log.i(TAG, "JAR downloaded: ${targetFile.absolutePath}")
        }

        return targetFile
    }
}