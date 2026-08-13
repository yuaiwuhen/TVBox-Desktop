package com.tvbox.spiderserver

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.github.catvod.Init
import com.github.catvod.Proxy
import java.io.File

class SpiderApplication : Application() {

    companion object {
        private const val TAG = "SpiderApplication"
        const val CHANNEL_ID = "spider_server_channel"
        const val NOTIFICATION_ID = 1001

        @Volatile
        private var instance: SpiderApplication? = null

        /**
         * Process start timestamp (millis since epoch). Set once in onCreate.
         * Used by /health endpoint so clients can verify the process restarted
         * (timestamp changes between restarts).
         */
        @Volatile
        var startedAt: Long = 0L
            private set

        /**
         * Return the Application instance. Mirrors FongMi/TV's App.get().
         * The spider JAR's Init.init(Context) internally casts the Context to
         * Application, so callers must pass an Application, not a ContextImpl.
         */
        @JvmStatic
        fun get(): SpiderApplication = instance!!
    }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // Initialize catvod's Init.context() — required by merge.* classes in
        // spider JARs to obtain a Context (e.g., for getSharedPreferences).
        // Mirrors FongMi/TV's App.attachBaseContext calling Init.set(base).
        Init.set(base)
        Log.d(TAG, "catvod Init.context set: $base")
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        startedAt = System.currentTimeMillis()
        Log.d(TAG, "SpiderApplication initializing... (startedAt=$startedAt)")

        // Configure Android DNS servers. redroid container starts without DNS
        // properties set, which causes spider JAR's UrlChecker to fail with
        // "api.txt 所有配置服务器不可用" (all api.txt servers unavailable) and
        // homeContent returns null for ~40 sources. Set net.dns1/dns2 and
        // dhcp.wlan0.dns1/dns2 via setprop (requires root, which redroid
        // privileged mode provides).
        configureDnsServers()

        // Ensure cacheDir is writable. After a redroid container restart,
        // Android sometimes leaves cacheDir in a read-only state (dr-xr-s--x)
        // which prevents spider JAR downloads with "EACCES (Permission denied)".
        // Restore write permission so downloadJar() can write new JAR files.
        ensureCacheDirWritable()

        // 创建通知渠道（Android 8.0+）
        createNotificationChannel()

        // 固定 Proxy 端口为 SpiderHttpServer 监听端口。JAR spider 的
        // Proxy.a() 会探测 9978-9999 是否返回 "ok" 来定位本地代理；在
        // 桌面上代理逻辑全部在安卓端，由 /proxy 路由承担。设置后 spider
        // 生成的播放地址形如 http://127.0.0.1:9978/proxy?do=xxx&url=...，
        // 桌面端通过 adb forward 以 http://127.0.0.1:19978/proxy?... 访问。
        Proxy.set(SpiderHttpServer.PORT)

        // 启动HTTP服务
        SpiderHttpService.startService(this)
    }

    /**
     * Configure Android DNS servers via setprop. redroid container starts
     * without DNS properties, which causes spider JAR's UrlChecker to fail
     * resolving hosts like 9280.kstore.vip, leading to homeContent returning
     * null for many sources. Setting net.dns1/dns2 and dhcp.wlan0.dns1/dns2
     * fixes DNS resolution inside the Android system.
     */
    private fun configureDnsServers() {
        val dnsServers = listOf("8.8.8.8", "8.8.4.4")
        val props = listOf(
            "net.dns1" to dnsServers[0],
            "net.dns2" to dnsServers[1],
            "dhcp.wlan0.dns1" to dnsServers[0],
            "dhcp.wlan0.dns2" to dnsServers[1],
            "net.eth0.dns1" to dnsServers[0],
            "net.eth0.dns2" to dnsServers[1],
        )
        for ((key, value) in props) {
            try {
                val p = Runtime.getRuntime().exec(arrayOf("setprop", key, value))
                p.waitFor()
                Log.i(TAG, "DNS setprop $key=$value (exit=${p.exitValue()})")
            } catch (e: Throwable) {
                Log.w(TAG, "Failed to setprop $key=$value: ${e.message}")
            }
        }
    }

    /**
     * Ensure cacheDir has write permission. After redroid container restart,
     * cacheDir may be left read-only (dr-xr-s--x) which prevents spider JAR
     * downloads. We restore write permission for the app user.
     */
    private fun ensureCacheDirWritable() {
        try {
            val cacheDir = cacheDir
            if (!cacheDir.exists()) {
                cacheDir.mkdirs()
            }
            // Try Java File API first — works when app user owns the directory.
            if (!cacheDir.setWritable(true, true)) {
                Log.w(TAG, "setWritable(true, true) failed on cacheDir")
            }
            // Also ensure owner can write (setWritable(true) makes it owner+group+other)
            if (!cacheDir.canWrite()) {
                cacheDir.setWritable(true, false)
            }
            // Test by attempting to create a temp file
            val testFile = File(cacheDir, ".write_test_${System.currentTimeMillis()}")
            try {
                testFile.createNewFile()
                testFile.delete()
                Log.i(TAG, "cacheDir writable: ${cacheDir.absolutePath}")
                return
            } catch (e: Throwable) {
                Log.w(TAG, "cacheDir write test failed: ${e.message}, trying chmod")
            }
            // Fallback: use chmod via Runtime.exec (works if running as root
            // in redroid privileged mode, or as owner of the directory).
            val p = Runtime.getRuntime().exec(arrayOf("chmod", "775", cacheDir.absolutePath))
            p.waitFor()
            Log.i(TAG, "chmod 775 cacheDir exit=${p.exitValue()}: ${cacheDir.absolutePath}")
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to ensure cacheDir writable: ${e.message}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_description)
            }

            val notificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }
}