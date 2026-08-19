package com.tvbox.spiderserver

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.ImageView
import java.net.HttpURLConnection
import java.net.URL

/** 轻量封面图加载器（无第三方依赖），带内存缓存。 */
object ThumbLoader {
    private val cache = LruCache<String, Bitmap>(80)

    fun load(iv: ImageView, url: String?) {
        if (url.isNullOrEmpty()) {
            iv.setImageResource(R.drawable.ic_thumb_placeholder)
            return
        }
        val cached = synchronized(cache) { cache.get(url) }
        if (cached != null) {
            iv.setImageBitmap(cached)
            return
        }
        iv.setImageResource(R.drawable.ic_thumb_placeholder)
        Thread {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.doInput = true
                val bmp = BitmapFactory.decodeStream(conn.inputStream)
                conn.disconnect()
                if (bmp != null) {
                    synchronized(cache) { cache.put(url, bmp) }
                    iv.post { iv.setImageBitmap(bmp) }
                }
            } catch (_: Throwable) {
                // 加载失败保持占位图
            }
        }.start()
    }
}
