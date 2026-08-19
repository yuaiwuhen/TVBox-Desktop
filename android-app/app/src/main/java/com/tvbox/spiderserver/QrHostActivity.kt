package com.tvbox.spiderserver

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.FrameLayout

/**
 * 二维码宿主 Activity。
 *
 * 触发 jar 配置中心扫码前由 /spider/scan 启动，保持在前台，使 jar 的
 * Init.activity()（反射 ActivityThread.mActivities 找非暂停 Activity）
 * 能返回一个有效 Activity，从而正常弹出 AlertDialog 显示二维码。
 *
 * onResume（即已在前台、jar 的 Init.activity() 可用）时消费
 * [pendingScan]，通过 SpiderManager.triggerScan 调用 detailContent 触发
 * jar 弹窗，然后周期性调用 QrCapture.captureFromWindows() 截取弹窗中
 * 的二维码 Bitmap 转 base64。界面是透明布局，不影响 jar 弹窗显示。
 *
 * jar 首次触发时会在 X() 构造器里请求权限（WRITE_EXTERNAL_STORAGE +
 * ACCESS_WIFI_STATE），弹出系统权限窗打断宿主 Activity，导致 jar 弹
 * 二维码时 Init.activity() 为 null 而 NPE。权限窗对未声明权限自动拒绝
 * 并立即关闭（瞬时），权限结果回调后宿主 Activity 恢复前台，此时重触发
 * 一次 detailContent：jar 已处理过权限请求不再弹权限窗，直接弹出二维码。
 */
class QrHostActivity : Activity() {

    companion object {
        private const val TAG = "QrHostActivity"
        private const val SCAN_INTERVAL_MS = 300L
        private const val RETRIGGER_DELAY_MS = 300L

        /** 待触发的扫码数据（key to ids），由 SpiderManager.scanQr 设置 */
        @Volatile
        var pendingScan: Pair<String, List<String>>? = null

        /** 当前扫码的 key（权限结果回调后重触发用） */
        @Volatile
        var activeScanKey: String? = null

        /** 当前扫码的入口 id（权限结果回调后重触发用） */
        @Volatile
        var activeEntry: String? = null
    }

    private val handler = Handler(Looper.getMainLooper())
    private var scanning = false

    private val scanRunnable = object : Runnable {
        override fun run() {
            if (!scanning) return
            QrCapture.captureFromWindows()
            // 持续扫描：二维码截到后继续跟踪状态文本，直到弹窗消失
            handler.postDelayed(this, SCAN_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this))
        window.setBackgroundDrawableResource(android.R.color.transparent)
        Log.i(TAG, "QrHostActivity created")
    }

    override fun onResume() {
        super.onResume()
        QrCapture.scanning = true
        scanning = true
        handler.removeCallbacks(scanRunnable)
        handler.postDelayed(scanRunnable, 200)
        // 消费待触发数据：activity 已在前台，jar 的 Init.activity() 可用
        val pending = pendingScan
        if (pending != null) {
            pendingScan = null
            activeScanKey = pending.first
            activeEntry = pending.second.firstOrNull()
            Log.i(TAG, "QrHostActivity resumed, triggering scan for ${pending.second}")
            SpiderManager.instance?.triggerScan(pending.first, pending.second)
        } else {
            Log.i(TAG, "QrHostActivity resumed, scanning dialogs")
        }
    }

    override fun onPause() {
        super.onPause()
        scanning = false
        handler.removeCallbacks(scanRunnable)
        QrCapture.scanning = false
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val permStr = permissions.joinToString(",")
        val resStr = grantResults.joinToString(",")
        Log.i(TAG, "onRequestPermissionsResult code=$requestCode perms=[$permStr] results=[$resStr]")
        // 权限窗关闭、宿主 Activity 恢复前台后，重触发一次 detailContent
        // 让 jar 直接弹二维码（此时不再请求权限）。
        val key = activeScanKey ?: return
        val entry = activeEntry ?: return
        handler.postDelayed({
            if (scanning) {
                Log.i(TAG, "Re-triggering scan after permission result for key=$key entry=$entry")
                SpiderManager.instance?.triggerScan(key, listOf(entry))
            }
        }, RETRIGGER_DELAY_MS)
    }
}