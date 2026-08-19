package com.tvbox.spiderserver

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import java.io.ByteArrayOutputStream

/**
 * 配置中心"远程桌面"支持。
 *
 * 让 PC 端（含 Linux/Mac，仅需填 IP:端口）像远程桌面一样直接操作
 * 安卓端的配置中心界面：
 *
 *   - 截图：通过反射读取 WindowManagerGlobal.mViews 拿到本进程所有
 *     窗口根视图（Activity + jar 弹窗），按 z-order 依次绘制合成一张
 *     全屏截图，JPEG 压缩后 base64 返回。无需 MediaProjection / root。
 *   - 点击：把屏幕坐标分发给命中的窗口根视图 dispatchTouchEvent
 *     （jar 弹窗和配置中心都是本进程 View，可直接注入事件）。
 *   - 文本：往当前焦点窗口注入文本按键。
 *   - 返回：触发当前 Activity 的 onBackPressed。
 *
 * 不依赖 adb，仅依赖本机 NanoHTTPD（默认绑定 0.0.0.0，局域网可达）。
 */
class RemotePanel {

    companion object {
        private const val TAG = "RemotePanel"
        private const val MAX_JPEG_QUALITY = 85
        private const val MAX_JPEG_WIDTH = 1080

        @Volatile
        private var instance: RemotePanel? = null

        fun get(): RemotePanel {
            if (instance == null) {
                synchronized(RemotePanel::class.java) {
                    if (instance == null) instance = RemotePanel()
                }
            }
            return instance!!
        }
    }

    private val uiHandler = android.os.Handler(android.os.Looper.getMainLooper())

    /** 将触摸/按键事件切换到主线程执行（dispatchTouchEvent 需要 Looper）。 */
    private fun runOnUiThread(action: () -> Unit) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            action()
        } else {
            val latch = java.util.concurrent.CountDownLatch(1)
            uiHandler.post {
                try {
                    action()
                } finally {
                    latch.countDown()
                }
            }
            latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
        }
    }

    /** 最近一次捕获的全屏截图（供复用/降频），仅在请求时生成。 */
    private data class WindowSnapshot(
        val view: View,
        val x: Int,
        val y: Int,
        val zOrder: Int,
        val dimAmount: Float = 0f,
    )

    /**
     * 捕获当前所有窗口并合成一张全屏 JPEG（base64）。
     *
     * @param scale 缩放因子（0~1），降低带宽；null 表示按 MAX_JPEG_WIDTH 缩放。
     */
    fun captureScreenshot(scale: Float = 0f): String? {
        return try {
            val roots = currentWindowRoots() ?: return null
            if (roots.isEmpty()) {
                Log.w(TAG, "captureScreenshot: no windows")
                return null
            }
            Log.i(TAG, "captureScreenshot: ${roots.size} windows")

            // 取所有根视图的并集边界作为画布尺寸
            val screen = android.content.res.Resources.getSystem().displayMetrics
            val width = screen.widthPixels
            val height = screen.heightPixels

            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            // 背景
            canvas.drawColor(android.graphics.Color.BLACK)

            for (snap in roots) {
                try {
                    val v = snap.view
                    if (v.width <= 0 || v.height <= 0) continue
                    val vx = snap.x
                    val vy = snap.y
                    // FLAG_DIM_BEHIND 窗口：先画全屏半透明遮罩（dim 背景），
                    // 再画窗口本身，重现 Android 的"灰底 + 居中弹窗"效果。
                    if (snap.dimAmount > 0f) {
                        val dimPaint = android.graphics.Paint()
                        dimPaint.color = android.graphics.Color.argb(
                            (snap.dimAmount.coerceIn(0f, 1f) * 255).toInt(), 0, 0, 0
                        )
                        canvas.save()
                        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dimPaint)
                        canvas.restore()
                    }
                    canvas.save()
                    canvas.translate(vx.toFloat(), vy.toFloat())
                    v.draw(canvas)
                    canvas.restore()
                } catch (e: Throwable) {
                    Log.w(TAG, "draw window failed: ${e.message}")
                }
            }

            // 缩放（降带宽）
            val outW = if (scale > 0 && scale < 1) (width * scale).toInt() else width
            val outH = (outW.toFloat() / width * height).toInt()
            val scaled = if (outW != width) {
                Bitmap.createScaledBitmap(bitmap, outW, outH, true)
            } else {
                bitmap
            }

            val bos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, MAX_JPEG_QUALITY, bos)
            if (scaled !== bitmap) scaled.recycle()
            bitmap.recycle()

            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Throwable) {
            Log.e(TAG, "captureScreenshot failed", e)
            null
        }
    }

    /**
     * 注入一次点击（DOWN + UP）。
     *
     * @param x 屏幕绝对坐标
     * @param y 屏幕绝对坐标
     * @return true 表示事件已分发到某个窗口
     */
    fun injectTap(x: Int, y: Int): Boolean {
        return try {
            val roots = currentWindowRoots() ?: return false
            // 最上层带 dim 遮罩的窗口视为"jar 弹窗"。点击点无论落在弹窗
            // 内容内还是弹窗外（dim 区域），都应归属弹窗窗口处理：
            //   - 内容内 → 正常注入 DOWN/UP
            //   - 内容外 → 关闭弹窗（反射 dismiss + ACTION_OUTSIDE + BACK）
            val topDim = roots.asReversed().firstOrNull { it.dimAmount > 0f }
            val snap: WindowSnapshot = topDim ?: findWindowAt(x, y) ?: return false
            val v = snap.view
            val lx = x - snap.x
            val ly = y - snap.y

            val dialogRef = dialogFromView(v)
            val isDialogWindow = snap.dimAmount > 0f || dialogRef != null
            if (isDialogWindow) {
                // 判断点击点是否落在弹窗内容面板上。弹窗窗口本身可能很小
                // （wrap_content 居中），点击弹窗外时 lx/ly 可能为负或超出
                // 窗口尺寸，isInsideContentPanel 对这些点返回 false。
                val inside = if (v.width > 0 && v.height > 0) {
                    isInsideContentPanel(v, lx, ly)
                } else {
                    true
                }
                if (!inside) {
                    dismissDialogWindow(v, lx, ly)
                    Log.i(TAG, "injectTap x=$x y=$y -> outside dialog content, dismiss")
                    return true
                }
            }

            runOnUiThread {
                val now = android.os.SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(
                    now, now, MotionEvent.ACTION_DOWN, lx.toFloat(), ly.toFloat(), 0
                )
                val up = MotionEvent.obtain(
                    now, now + 60, MotionEvent.ACTION_UP, lx.toFloat(), ly.toFloat(), 0
                )
                v.dispatchTouchEvent(down)
                v.dispatchTouchEvent(up)
                down.recycle()
                up.recycle()
            }
            Log.i(TAG, "injectTap x=$x y=$y -> view=${v.javaClass.simpleName} (lx=$lx, ly=$ly)")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "injectTap failed", e)
            false
        }
    }

    /**
     * 点击在弹窗内容面板之外时，按多重方式关闭弹窗。
     * 不依赖反射结果作为进入条件——反射只是为了"尽力而为"地拿到
     * Dialog 实例，即使失败（Android 9+ hidden API 限制），
     * ACTION_OUTSIDE / BACK / 模拟触摸 仍会注入到该窗口。
     *
     * @param decor 弹窗根视图（DecorView）
     * @param lx    点击点在弹窗窗口内的坐标 x（可能为负/超出，表示在内容外）
     * @param ly    点击点在弹窗窗口内的坐标 y
     */
    private fun dismissDialogWindow(decor: View, lx: Int, ly: Int) {
        runOnUiThread {
            // 1) 反射 dismiss（尽力而为）
            try {
                val d = dialogFromView(decor)
                if (d != null && d.isShowing) {
                    Log.i(TAG, "dismissDialogWindow: dismiss via reflection ${d.javaClass.simpleName}")
                    d.dismiss()
                    if (!d.isShowing) return@runOnUiThread
                }
            } catch (ignored: Throwable) {
            }
            // 2) ACTION_OUTSIDE（系统向该窗口发送的"窗口外触摸"事件，坐标为 0,0）。
            //    标准 AlertDialog 的关闭路径是 Window.Callback.dispatchTouchEvent
            //    收到 ACTION_OUTSIDE 后调用 onTouchOutside()/dismiss()。
            //    直接往 DecorView dispatch 会被 View 的触摸分发拦截，因此优先
            //    通过 Window.Callback 注入，退化到 DecorView。
            try {
                val now = android.os.SystemClock.uptimeMillis()
                val outside = MotionEvent.obtain(
                    now, now, MotionEvent.ACTION_OUTSIDE, 0f, 0f, 0
                )
                val cb = windowCallbackFrom(decor)
                if (cb != null) {
                    cb.dispatchTouchEvent(outside)
                } else {
                    decor.dispatchTouchEvent(outside)
                }
                outside.recycle()
            } catch (ignored: Throwable) {
            }
            // 3) BACK 键（Dialog setCancelable(true) 默认在 onBackPressed 时 dismiss）
            try {
                val now = android.os.SystemClock.uptimeMillis()
                decor.dispatchKeyEvent(
                    android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK, 0)
                )
                decor.dispatchKeyEvent(
                    android.view.KeyEvent(now, now + 50, android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK, 0)
                )
            } catch (ignored: Throwable) {
            }
            // 4) 模拟真实 DOWN/UP 触摸：jar 自绘全屏弹窗（非 Dialog）只在
            //    onTouch 里检测"点击内容外"，必须注入触摸事件它才会自行关闭。
            try {
                val now = android.os.SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(
                    now, now, MotionEvent.ACTION_DOWN, lx.toFloat(), ly.toFloat(), 0
                )
                val up = MotionEvent.obtain(
                    now, now + 60, MotionEvent.ACTION_UP, lx.toFloat(), ly.toFloat(), 0
                )
                decor.dispatchTouchEvent(down)
                decor.dispatchTouchEvent(up)
                down.recycle()
                up.recycle()
            } catch (ignored: Throwable) {
            }
            // 5) BACK 可能触发 onCancel/onDismiss，再反射确认一次
            try {
                val d = dialogFromView(decor)
                if (d != null && d.isShowing) d.dismiss()
            } catch (ignored: Throwable) {
            }
        }
    }

    /**
     * 判断点击点 (lx, ly) 是否落在 Dialog 的"内容面板"上。
     *
     * AlertDialog 的 DecorView 结构大致为：
     *   DecorView (match_parent, 全屏)
     *     └─ mContentParent / FrameLayout (match_parent, 全屏) ← 必须跳过
     *          └─ AlertDialogLayout (wrap_content, 居中) ← 真正的"内容面板"
     *
     * 规则：递归查找可见子视图，凡是"尺寸与父视图相同（全屏）"的容器都跳过
     * 并继续深入；只有命中一个"非全屏"且包含点击点的子视图才算在内容面板上。
     * 这样点击 dim 遮罩/空白区域 → 不会命中任何非全屏内容 → 判定为"弹窗外"。
     */
    private fun isInsideContentPanel(view: View, lx: Int, ly: Int): Boolean {
        val rootW = view.width
        val rootH = view.height
        if (rootW <= 0 || rootH <= 0) return true
        return isInsideNonFullscreenChild(view, lx, ly, rootW, rootH)
    }

    private fun isInsideNonFullscreenChild(
        parent: View,
        lx: Int,
        ly: Int,
        rootW: Int,
        rootH: Int,
    ): Boolean {
        if (parent !is android.view.ViewGroup) return false
        for (i in parent.childCount - 1 downTo 0) {
            val child = parent.getChildAt(i)
            if (child.visibility != View.VISIBLE) continue
            if (child.width <= 0 || child.height <= 0) continue
            val clx = lx - child.left
            val cly = ly - child.top
            if (clx !in 0 until child.width || cly !in 0 until child.height) continue
            // 该子视图包含点击点。
            val isFullscreen =
                child.width >= rootW - 1 && child.height >= rootH - 1
            if (!isFullscreen) {
                return true // 非全屏 = 内容面板，命中即"在弹窗内"
            }
            // 全屏容器继续深入查找
            if (isInsideNonFullscreenChild(child, lx, ly, rootW, rootH)) {
                return true
            }
        }
        return false
    }

    /** 反射读取 View（DecorView）所属的 Window 实例；失败返回 null。 */
    private fun windowFromView(view: View): android.view.Window? {
        var cls: Class<*>? = view.javaClass
        return try {
            var field: java.lang.reflect.Field? = null
            while (cls != null && field == null) {
                try {
                    val f = cls.getDeclaredField("mWindow")
                    f.isAccessible = true
                    field = f
                } catch (ignored: NoSuchFieldException) {
                    cls = cls.superclass
                }
            }
            if (field == null) return null
            field.get(view) as? android.view.Window
        } catch (e: Throwable) {
            Log.w(TAG, "windowFromView failed: ${e.message}")
            null
        }
    }

    /** 反射读取 View（DecorView）所属 Window 的 Callback；失败返回 null。 */
    private fun windowCallbackFrom(view: View): android.view.Window.Callback? {
        return try {
            windowFromView(view)?.callback
        } catch (e: Throwable) {
            Log.w(TAG, "windowCallbackFrom failed: ${e.message}")
            null
        }
    }

    /**
     * 通过 DecorView 的 Window 找到其所属 Dialog 实例
     * （Dialog 的 Window.Callback 就是 Dialog 本身）。
     */
    private fun dialogFromView(view: View): android.app.Dialog? {
        return try {
            val cb = windowCallbackFrom(view) ?: return null
            if (cb is android.app.Dialog) cb else null
        } catch (e: Throwable) {
            Log.w(TAG, "dialogFromView failed: ${e.message}")
            null
        }
    }

    /**
     * 注入滑动（用于滚动列表/弹窗）。
     */
    fun injectSwipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 200): Boolean {
        val snap = findWindowAt(x1, y1) ?: return false
        return try {
            val v = snap.view
            val sx = x1 - snap.x
            val sy = y1 - snap.y
            val ex = x2 - snap.x
            val ey = y2 - snap.y
            val start = android.os.SystemClock.uptimeMillis()
            val steps = 10
            runOnUiThread {
                for (i in 0..steps) {
                    val t = start + durationMs * i / steps
                    val frac = i.toFloat() / steps
                    val mx = sx + (ex - sx) * frac
                    val my = sy + (ey - sy) * frac
                    val action = if (i == 0) MotionEvent.ACTION_DOWN
                    else if (i == steps) MotionEvent.ACTION_UP
                    else MotionEvent.ACTION_MOVE
                    val ev = MotionEvent.obtain(
                        t, t, action, mx, my, 0
                    )
                    v.dispatchTouchEvent(ev)
                    ev.recycle()
                }
            }
            Log.i(TAG, "injectSwipe ($x1,$y1)->($x2,$y2)")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "injectSwipe failed", e)
            false
        }
    }

    /**
     * 往当前焦点窗口注入一段文本（模拟键盘输入）。
     */
    fun injectText(text: String): Boolean {
        return try {
            val focused = currentFocusedView() ?: return false
            runOnUiThread {
                // 逐字符注入按键，模拟真实输入
                for (ch in text) {
                    val code = charToKeyCode(ch)
                    val now = android.os.SystemClock.uptimeMillis()
                    if (code != 0) {
                        // KeyEvent 通过 view.dispatchKeyEvent 注入
                        focused.dispatchKeyEvent(
                            android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, code, 0)
                        )
                        focused.dispatchKeyEvent(
                            android.view.KeyEvent(now, now + 30, android.view.KeyEvent.ACTION_UP, code, 0)
                        )
                    } else {
                        // 非 ASCII 字符：回退用 paste（通过 clipboard）——这里简化：
                        // 对无法映射的字符直接写入焦点控件的文本（若可编辑）。
                        injectUnicodeChar(focused, ch)
                    }
                }
            }
            Log.i(TAG, "injectText: $text")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "injectText failed", e)
            false
        }
    }

    /** 触发系统返回键（等效按 Back） */
    fun injectBack(): Boolean {
        return try {
            val roots = currentWindowRoots() ?: return false
            // 找最上层（zOrder 最大）窗口
            val top = roots.maxByOrNull { it.zOrder } ?: return false
            val now = android.os.SystemClock.uptimeMillis()
            val key = android.view.KeyEvent.KEYCODE_BACK
            runOnUiThread {
                top.view.dispatchKeyEvent(
                    android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, key, 0)
                )
                top.view.dispatchKeyEvent(
                    android.view.KeyEvent(now, now + 50, android.view.KeyEvent.ACTION_UP, key, 0)
                )
            }
            Log.i(TAG, "injectBack")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "injectBack failed", e)
            false
        }
    }

    /**
     * Debug-only：弹出一个真实 AlertDialog，用于验证"点击弹窗外关闭"
     * 的注入逻辑是否生效（等效 jar 弹窗）。正常功能不会调用它。
     */
    fun showTestDialog(): Boolean {
        return try {
            val activity = SpiderApplication.currentActivity
            if (activity == null || activity.isFinishing || activity.isDestroyed) {
                Log.w(TAG, "showTestDialog: no current activity")
                return false
            }
            runOnUiThread {
                try {
                    val dialog = android.app.AlertDialog.Builder(activity)
                        .setTitle("测试弹窗")
                        .setMessage("这是一个用于验证点击弹窗外关闭的测试弹窗。\n\n请尝试点击弹窗外的暗色区域。")
                        .setPositiveButton("确定", null)
                        .create()
                    dialog.setCanceledOnTouchOutside(true)
                    dialog.show()
                    Log.i(TAG, "showTestDialog: shown on ${activity.javaClass.simpleName}")
                } catch (e: Throwable) {
                    Log.e(TAG, "showTestDialog: build/show failed", e)
                }
            }
            true
        } catch (e: Throwable) {
            Log.e(TAG, "showTestDialog failed", e)
            false
        }
    }

    /** 触发系统 HOME 键（彻底关闭任何弹窗回到桌面） */
    fun injectHome(): Boolean {
        return try {
            val ctx = SpiderApplication.get()
            val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            intent.addCategory(android.content.Intent.CATEGORY_HOME)
            intent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            ctx.startActivity(intent)
            Log.i(TAG, "injectHome")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "injectHome failed", e)
            false
        }
    }

    // ── 内部实现 ──────────────────────────────────────────────

    private fun currentWindowRoots(): List<WindowSnapshot>? {
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
            val params = (mParams.get(instance) as? List<*>) ?: return null

            val list = mutableListOf<WindowSnapshot>()
            for (i in views.indices) {
                val v = views[i]
                if (v.width <= 0 && v.height <= 0) continue
                val p = params.getOrNull(i) as? WindowManager.LayoutParams
                // 跳过明显的系统级窗口（状态栏/导航栏/输入法），其余全部
                // 参与合成，与 QrCapture 的容错策略一致。
                if (p != null) {
                    val t = p.type
                    // 2000=STATUS_BAR 2002=INPUT_METHOD 2019=NAVIGATION_BAR 2004=KEYGUARD
                    if (t == 2000 || t == 2002 || t == 2019 || t == 2004) continue
                }
                // 用 View 的真实屏幕坐标，而不是 LayoutParams.x/y。
                // jar 的 AlertDialog 通常是 gr=CENTER 的窗口：系统通过 gravity
                // 自动居中，LayoutParams.x/y 保持 0，直接取会导致弹窗被画到
                // 左上角。getLocationOnScreen 对这类窗口返回正确位置。
                val loc = IntArray(2)
                v.getLocationOnScreen(loc)
                val x = loc[0]
                val y = loc[1]
                // FLAG_DIM_BEHIND 窗口带 dim 遮罩，取出 dimAmount 用于合成遮罩
                val hasDim = p?.flags?.and(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND) != 0
                val dimAmount = if (hasDim) (p?.dimAmount ?: 0f) else 0f
                list.add(WindowSnapshot(v, x, y, i, dimAmount))
            }
            list
        } catch (e: Throwable) {
            Log.w(TAG, "currentWindowRoots failed: ${e.message}")
            null
        }
    }

    private fun findWindowAt(x: Int, y: Int): WindowSnapshot? {
        val roots = currentWindowRoots() ?: return null
        // 1) 命中最上层"内容矩形"包含该点的窗口（弹窗内容区、Activity 等普通点击）
        for (snap in roots.asReversed()) {
            val v = snap.view
            val vx = snap.x
            val vy = snap.y
            if (v.width <= 0 || v.height <= 0) continue
            if (x >= vx && x <= vx + v.width && y >= vy && y <= vy + v.height) {
                return snap
            }
        }
        // 2) 命中空白区域（通常是带 dim 遮罩弹窗之外的区域）。原生 Android 里这类
        //    窗口拥有其 dim 区域的触摸权，点击遮罩会触发 setCanceledOnTouchOutside
        //    关闭弹窗。此处把事件分发给最上层的 dim 弹窗，local 坐标落在其内容矩形
        //    之外，从而令其 onTouchEvent 正常关闭自身。
        val topDim = roots.asReversed().firstOrNull { it.dimAmount > 0f }
        if (topDim != null) return topDim
        // 3) 回退：最顶层窗口（避免误点系统栏）
        return roots.maxByOrNull { it.zOrder }
    }

    private fun currentFocusedView(): View? {
        return try {
            val roots = currentWindowRoots() ?: return null
            // 1) 优先找 hasFocus 的视图（输入框聚焦时）
            for (snap in roots.asReversed()) {
                val focused = findFocusedIn(snap.view)
                if (focused != null) return focused
            }
            // 2) 回退：找可编辑的 EditText 作为输入目标
            for (snap in roots.asReversed()) {
                val editable = findEditableIn(snap.view)
                if (editable != null) return editable
            }
            // 3) 最后回退到最上层窗口的 decorView（KeyEvent 会沿树分发）
            return roots.maxByOrNull { it.zOrder }?.view
        } catch (e: Throwable) {
            Log.w(TAG, "currentFocusedView failed: ${e.message}")
            null
        }
    }

    private fun findFocusedIn(view: View): View? {
        if (view.isFocused && view.isFocusable) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                val f = findFocusedIn(view.getChildAt(i))
                if (f != null) return f
            }
        }
        return null
    }

    private fun findEditableIn(view: View): View? {
        if (view is android.widget.EditText) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                val e = findEditableIn(view.getChildAt(i))
                if (e != null) return e
            }
        }
        return null
    }

    private fun charToKeyCode(c: Char): Int {
        return when (c) {
            in '0'..'9' -> android.view.KeyEvent.KEYCODE_0 + (c - '0')
            in 'a'..'z' -> android.view.KeyEvent.KEYCODE_A + (c - 'a')
            in 'A'..'Z' -> android.view.KeyEvent.KEYCODE_A + (c - 'A')
            '.' -> android.view.KeyEvent.KEYCODE_PERIOD
            ',' -> android.view.KeyEvent.KEYCODE_COMMA
            '@' -> android.view.KeyEvent.KEYCODE_AT
            '-' -> android.view.KeyEvent.KEYCODE_MINUS
            '/' -> android.view.KeyEvent.KEYCODE_SLASH
            ' ' -> android.view.KeyEvent.KEYCODE_SPACE
            ':' -> android.view.KeyEvent.KEYCODE_SEMICOLON
            '#' -> android.view.KeyEvent.KEYCODE_POUND
            '_' -> android.view.KeyEvent.KEYCODE_MINUS
            else -> 0
        }
    }

    private fun injectUnicodeChar(view: View, c: Char) {
        try {
            // 尝试调用 EditText.append / TextView.setEditable 的便捷方式：
            // 通过 commitText 不现实（需 IME），这里直接尝试 findFocus + paste。
            // 对普通输入场景，非 ASCII 字符（中文/emoji）通过 clipboard 注入。
            val clip = android.content.ClipData.newPlainText("text", c.toString())
            val cm = SpiderApplication.get().getSystemService(
                android.content.Context.CLIPBOARD_SERVICE
            ) as? android.content.ClipboardManager
            cm?.setPrimaryClip(clip)
            // 触发粘贴
            view.dispatchKeyEvent(
                android.view.KeyEvent(
                    android.os.SystemClock.uptimeMillis(),
                    android.os.SystemClock.uptimeMillis(),
                    android.view.KeyEvent.ACTION_DOWN,
                    android.view.KeyEvent.KEYCODE_PASTE, 0
                )
            )
        } catch (e: Throwable) {
            Log.w(TAG, "injectUnicodeChar failed: ${e.message}")
        }
    }
}
