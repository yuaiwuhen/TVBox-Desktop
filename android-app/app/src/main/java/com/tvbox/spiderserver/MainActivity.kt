package com.tvbox.spiderserver

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
    }

    private lateinit var statusTextView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusTextView = findViewById(R.id.statusTextView)

        // 确保服务正在运行
        SpiderHttpService.startService(this)

        // 配置中心入口（安卓端保底扫码登录）
        findViewById<Button>(R.id.configCenterButton).setOnClickListener {
            ConfigCenterActivity.start(this)
        }

        // 更新状态
        updateServerStatus()
    }

    private fun updateServerStatus() {
        lifecycleScope.launch {
            try {
                val isRunning = SpiderHttpService.isRunning()
                val port = SpiderHttpService.getPort()

                withContext(Dispatchers.Main) {
                    val status = if (isRunning) {
                        getString(R.string.server_running, port)
                    } else {
                        getString(R.string.server_stopped)
                    }
                    statusTextView.text = status
                    Log.d(TAG, "Server status: $status")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get server status", e)
                withContext(Dispatchers.Main) {
                    statusTextView.text = getString(R.string.server_error, e.message)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        SpiderApplication.currentActivity = this
        updateServerStatus()
    }

    override fun onPause() {
        super.onPause()
        if (SpiderApplication.currentActivity === this) {
            SpiderApplication.currentActivity = null
        }
    }
}