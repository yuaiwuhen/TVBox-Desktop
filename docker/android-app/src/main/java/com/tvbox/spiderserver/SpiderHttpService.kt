package com.tvbox.spiderserver

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class SpiderHttpService : Service() {

    companion object {
        private const val TAG = "SpiderHttpService"
        private const val DEFAULT_PORT = 9978

        @Volatile
        private var httpServer: SpiderHttpServer? = null

        fun startService(context: Context) {
            val intent = Intent(context, SpiderHttpService::class.java)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, SpiderHttpService::class.java)
            context.stopService(intent)
        }

        fun isRunning(): Boolean {
            return httpServer?.isRunning ?: false
        }

        fun getPort(): Int {
            return httpServer?.listeningPort ?: 0
        }
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "SpiderHttpService onCreate")

        // 启动前台通知
        startForegroundNotification()

        // 启动HTTP服务器
        startHttpServer()
    }

    private fun startForegroundNotification() {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            notificationIntent,
            PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, SpiderApplication.CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.service_running))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()

        startForeground(SpiderApplication.NOTIFICATION_ID, notification)
    }

    private fun startHttpServer() {
        serviceScope.launch {
            try {
                if (httpServer == null) {
                    httpServer = SpiderHttpServer(DEFAULT_PORT)
                    httpServer!!.start()
                    Log.i(TAG, "HTTP Server started on port $DEFAULT_PORT")
                } else if (!httpServer!!.isRunning) {
                    httpServer!!.start()
                    Log.i(TAG, "HTTP Server restarted on port $DEFAULT_PORT")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start HTTP server", e)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "SpiderHttpService onStartCommand")
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onDestroy() {
        Log.d(TAG, "SpiderHttpService onDestroy")

        // 停止HTTP服务器
        httpServer?.stop()
        httpServer = null

        // 取消所有协程
        serviceScope.cancel()

        super.onDestroy()
    }
}