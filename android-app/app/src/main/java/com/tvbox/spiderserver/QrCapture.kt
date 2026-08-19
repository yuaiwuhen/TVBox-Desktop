package com.tvbox.spiderserver

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import android.view.View
import android.widget.ImageView
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * 捕获 jar 配置中心弹窗中的二维码。
 *
 * jar 的配置中心（肥猫 csp_Config、wex csp_WexConfigGuard 等）在安卓端
 * 通过 AlertDialog 弹出二维码供扫码登录。这些 Dialog 与本进程同进程，
 * 我们通过反射读取 WindowManagerGlobal.mViews 拿到所有 Dialog 窗口的
 * 根视图，遍历找到带有二维码 Bitmap 的 ImageView，将其转成 base64 存
 * 入 latest，供 HTTP 接口 /spider/scan 返回给桌面前端。
 *
 * 依赖宿主 Activity（QrHostActivity）保持在前台，jar 的
 * Init.activity() 才能找到可用 Activity 弹出 Dialog。
 */
object QrCapture {
    private const val TAG = "QrCapture"

    /** 最近一次截取到的二维码 base64（data:image/png;base64,...），可能为 null */
    @Volatile
    var latestBase64: String? = null
        private set

    /** 最近一次截取到的二维码原始 Bitmap，用于判断是否更新过 */
    @Volatile
    var latestHash: Int = 0
        private set

    /** 截取到二维码的时间戳（millis），前端可据此判断是否是新二维码 */
    @Volatile
    var capturedAt: Long = 0L
        private set

    /** 当前是否正在扫码流程中 */
    @Volatile
    var scanning: Boolean = false

    /** 最近一次触发扫码的条目 id */
    @Volatile
    var lastEntryId: String? = null

    /** 最近一次捕获时的窗口数量（调试用） */
    @Volatile
    var lastWindowCount: Int = 0

    /** 弹窗内状态文本（jar 更新的"等待扫码/登录成功"等），可能为 null */
    @Volatile
    var statusText: String? = null
        private set

    /** 弹窗当前是否仍存在（登录成功后 jar 会 dismiss） */
    @Volatile
    var dialogPresent: Boolean = false

    /**
     * 需要排除的视图（宿主界面自身展示的二维码 ImageView 等）。
     * 配置中心界面（ConfigCenterActivity）会把自身展示二维码的 ImageView
     * 加入这里，避免扫描时把"自己画的二维码"当作 jar 弹窗里的新二维码捕获，
     * 覆盖 latestBase64 导致状态错乱。
     */
    private val excludedViews = ConcurrentHashMap.newKeySet<View>()

    /** 排除一个视图（其整个子树都不会被捕获），供宿主界面注册自身控件 */
    fun excludeView(view: View) {
        excludedViews.add(view)
    }

    /** 取消排除（宿主界面销毁时调用） */
    fun unexcludeView(view: View) {
        excludedViews.remove(view)
    }

    /**
     * 扫描当前进程中所有窗口根视图，提取二维码 ImageView 的 Bitmap 和
     * 状态 TextView 文本。返回 true 表示本次扫描捕获到了新二维码。
     */
    fun captureFromWindows(): Boolean {
        val roots = currentRootViews() ?: return false
        lastWindowCount = roots.size
        val found = findQrAndStatus(roots)
        // 二维码首次捕获时返回 true 触发停止扫描
        val isNew = found.qrBitmap != null && found.qrBitmap.hashCode() != latestHash
        if (isNew) {
            latestHash = found.qrBitmap!!.hashCode()
            latestBase64 = bitmapToBase64(found.qrBitmap!!)
            capturedAt = System.currentTimeMillis()
            Log.i(TAG, "Captured QR bitmap (${found.qrBitmap!!.width}x${found.qrBitmap!!.height}, base64=${latestBase64?.length ?: 0} chars, windows=$lastWindowCount)")
        }
        // 状态文本有更新就刷新
        if (found.statusText != null && found.statusText != statusText) {
            statusText = found.statusText
            Log.i(TAG, "Status updated: $statusText")
        }
        dialogPresent = found.qrBitmap != null || found.hasDialog
        return isNew
    }

    /** 重置捕获状态（每次开始新扫码前调用） */
    fun reset() {
        latestBase64 = null
        latestHash = 0
        capturedAt = 0L
        scanning = false
        lastEntryId = null
        statusText = null
        dialogPresent = false
    }

    /**
     * 通过反射读取本进程 WindowManagerGlobal.mViews —— 所有通过
     * WindowManager.addView 添加的根视图，包括 Activity 和 Dialog。
     * 同时读取 mParams 以区分 Dialog 与全屏 Activity。
     */
    private fun currentRootViews(): List<View>? {
        return try {
            val wmgClass = Class.forName("android.view.WindowManagerGlobal")
            val getInstance = wmgClass.getMethod("getInstance")
            val instance = getInstance.invoke(null)
            val mViews = wmgClass.getDeclaredField("mViews")
            mViews.isAccessible = true
            val mParams = wmgClass.getDeclaredField("mParams")
            mParams.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val views = (mViews.get(instance) as? List<View>) ?: return null
            @Suppress("UNCHECKED_CAST")
            val params = (mParams.get(instance) as? List<*>) ?: return views.toList()
            // 只保留 Dialog 窗口：LayoutParams 非 null 且既不是全屏也不是
            // 系统窗口。jar 的 AlertDialog 是 APPLICATION 类型的小窗口。
            val screenW = android.util.TypedValue.applyDimension(
                android.util.TypedValue.COMPLEX_UNIT_DIP,
                600f, // 粗筛：dialog 通常 < 600dp 宽
                android.content.res.Resources.getSystem().displayMetrics
            ).toInt()
            views.indices.mapNotNull { i ->
                val p = params.getOrNull(i)
                val v = views[i]
                val lp = p as? android.view.WindowManager.LayoutParams ?: return@mapNotNull null
                val w = if (lp.width > 0) lp.width else v.width
                if (w > 0 && w < screenW && w < 2000) v else null
            }
        } catch (e: Throwable) {
            Log.w(TAG, "currentRootViews failed: ${e.message}")
            null
        }
    }

    /** 捕获结果：二维码 Bitmap + 状态文本 + 是否有 dialog */
    private data class CaptureResult(
        val qrBitmap: Bitmap?,
        val statusText: String?,
        val hasDialog: Boolean
    )

    /** 在所有根视图里找二维码 ImageView 和状态 TextView */
    private fun findQrAndStatus(roots: List<View>): CaptureResult {
        var qr: Bitmap? = null
        var status: String? = null
        var hasDialog = false
        for (root in roots) {
            walkView(root) { view ->
                if (view is ImageView) {
                    val bmp = viewQrBitmap(view)
                    if (bmp != null && bmp.width >= 100 && bmp.height >= 100 && qr == null) {
                        qr = bmp
                    }
                    hasDialog = true
                } else if (view is android.widget.TextView) {
                    val t = view.text?.toString()?.trim()
                    if (!t.isNullOrEmpty() && t.length in 1..60 && status == null) {
                        status = t
                    }
                }
            }
        }
        return CaptureResult(qr, status, hasDialog)
    }

    private fun walkView(view: View, visit: (View) -> Unit) {
        if (view in excludedViews) return
        visit(view)
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                walkView(view.getChildAt(i), visit)
            }
        }
    }

    private fun viewQrBitmap(view: ImageView): Bitmap? {
        return try {
            val d = view.drawable
            if (d is android.graphics.drawable.BitmapDrawable) d.bitmap else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun bitmapToBase64(bmp: Bitmap): String {
        val stream = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, stream)
        val bytes = stream.toByteArray()
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        return "data:image/png;base64,$b64"
    }
}