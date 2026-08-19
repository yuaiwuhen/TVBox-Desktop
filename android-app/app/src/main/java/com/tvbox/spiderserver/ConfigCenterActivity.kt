package com.tvbox.spiderserver

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.appbar.MaterialToolbar
import com.google.gson.JsonParser

/**
 * 配置中心（安卓端）。
 *
 * 与 FongMi 一致：直接以标准的影视条目卡片渲染 jar 配置中心返回的
 * vod 列表（homeContent / categoryContent），每个条目显示封面图
 * (vod_pic)、名称 (vod_name) 与备注 (vod_remarks)。
 *
 * 点击条目即触发 jar 的 detailContent，由 jar 自行弹出原生 Dialog（扫码
 * 登录 / 清除登录等）。所有原生弹窗由 jar 控制，本 Activity 不再额外叠
 * 加任何"等待 jar 弹窗"的保底层，避免遮挡 jar 的弹窗导致关不掉。
 *
 * 不提供任何网页版 / WebView 入口。
 */
class ConfigCenterActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "ConfigCenterActivity"

        fun start(context: android.content.Context) {
            // Android 10+ 对"后台应用启动 Activity"有 BAL 限制。SpiderHttpService
            // 是纯后台 Service（无可见 Activity），从它启动 ConfigCenterActivity
            // 会被 ActivityTaskManager 拦截（BAL_BLOCK, result code=102）。唯一可
            // 靠的豁免是持有 SYSTEM_ALERT_WINDOW（悬浮窗）权限。若未授权则尝试
            // 直接拉起授权页（需要用户点击授权），授权页本身在部分 ROM 上可能
            // 也被拦，但授权一次后即可长期使用。
            if (!android.provider.Settings.canDrawOverlays(context)) {
                try {
                    val intent = Intent(
                        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:" + context.packageName),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(intent)
                } catch (e: Throwable) {
                    android.util.Log.e(TAG, "open overlay settings failed", e)
                }
                return
            }
            val intent = Intent(context, ConfigCenterActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    private data class Entry(
        val id: String,
        val name: String,
        val remarks: String,
        val pic: String = ""
    )

    private lateinit var toolbar: MaterialToolbar
    private lateinit var progressBar: ProgressBar
    private lateinit var emptyText: TextView
    private lateinit var entryList: RecyclerView

    private var entries = listOf<Entry>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_config_center)

        toolbar = findViewById(R.id.topBar)
        setSupportActionBar(toolbar)
        supportActionBar?.title = getString(R.string.action_config_center)

        progressBar = findViewById(R.id.progressBar)
        emptyText = findViewById(R.id.emptyText)
        entryList = findViewById(R.id.entryList)

        entryList.layoutManager = GridLayoutManager(this, 6)

        loadEntries()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.config_center_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == R.id.action_refresh) {
            loadEntries()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    // =========================================================================
    // 数据加载
    // =========================================================================

    private fun loadEntries() {
        // 优先使用"配置中心源"(csp_Config)，而不是最近播放的视频源。
        // 若误用视频源，这里会渲染出一屏视频列表而非配置条目。
        val key = SpiderManager.instance?.getConfigCenterKey()
        if (key.isNullOrEmpty()) {
            showEmpty("尚未加载配置中心源\n请在电脑端选择配置中心源后重试")
            return
        }
        progressBar.visibility = View.VISIBLE
        emptyText.visibility = View.GONE

        Thread {
            val loaded = try {
                loadEntriesInternal(key)
            } catch (e: Throwable) {
                Log.e(TAG, "loadEntries failed for $key", e)
                listOf<Entry>()
            }
            runOnUiThread {
                progressBar.visibility = View.GONE
                if (loaded.isEmpty()) {
                    showEmpty("未找到配置中心条目")
                } else {
                    emptyText.visibility = View.GONE
                    entries = loaded
                    renderEntries(loaded)
                }
            }
        }.start()
    }

    /** 在后台线程解析配置中心条目 */
    private fun loadEntriesInternal(key: String): List<Entry> {
        val manager = SpiderManager.instance ?: return emptyList()

        // 1. homeContent → 找"配置中心"分类（typeName 含"配置"或"设置"）
        val homeResp = manager.homeContent(key, false)
        var homeJson: com.google.gson.JsonObject? = null
        if (homeResp.success && homeResp.data is String) {
            homeJson = runCatching {
                JsonParser.parseString(homeResp.data as String).asJsonObject
            }.getOrNull()
        }

        // 2. 若 homeContent 有 class 列表，尝试加载"配置中心"分类条目
        var listItems: List<Entry> = emptyList()
        val classes = homeJson?.getAsJsonArray("class")
        if (classes != null && classes.size() > 0) {
            for (i in 0 until classes.size()) {
                val clz = runCatching { classes.get(i).asJsonObject }.getOrNull() ?: continue
                val typeName = clz.get("typeName")?.asString ?: ""
                if (!typeName.contains("配置") && !typeName.contains("设置")) continue
                val typeId = clz.get("typeId")?.asString ?: ""
                if (typeId.isEmpty()) continue
                // categoryContent 拉取该分类的配置条目
                val catResp = manager.categoryContent(key, typeId, "1", false, emptyMap())
                if (catResp.success && catResp.data is String) {
                    val catJson = runCatching {
                        JsonParser.parseString(catResp.data as String).asJsonObject
                    }.getOrNull()
                    val list = catJson?.getAsJsonArray("list")
                    if (list != null && list.size() > 0) {
                        listItems = parseVodList(list)
                    }
                }
                break
            }
        }

        // 3. 若分类加载不到条目，退回 homeContent 自身的 list
        if (listItems.isEmpty()) {
            val homeList = homeJson?.getAsJsonArray("list")
            if (homeList != null && homeList.size() > 0) {
                listItems = parseVodList(homeList)
            }
        }

        Log.i(TAG, "Loaded ${listItems.size} entries")
        return listItems
    }

    private fun parseVodList(list: com.google.gson.JsonArray): List<Entry> {
        val result = mutableListOf<Entry>()
        for (i in 0 until list.size()) {
            val vod = runCatching { list.get(i).asJsonObject }.getOrNull() ?: continue
            val id = vod.get("vod_id")?.asString ?: ""
            if (id.isEmpty()) continue
            val name = vod.get("vod_name")?.asString ?: ""
            val remarks = vod.get("vod_remarks")?.asString ?: ""
            val pic = vod.get("vod_pic")?.asString ?: ""
            result.add(Entry(id, name, remarks, pic))
        }
        return result
    }

    // =========================================================================
    // 渲染（FongMi 风格：封面图 + 名称 + 备注）
    // =========================================================================

    private fun renderEntries(items: List<Entry>) {
        entryList.adapter = EntryAdapter(items) { onEntryClick(it) }
    }

    private fun showEmpty(message: String) {
        emptyText.text = message
        emptyText.visibility = View.VISIBLE
    }

    /** 点击条目：直接触发 jar 的 detailContent，由 jar 弹出原生 Dialog
     *  （扫码登录 / 清除登录等）。本 Activity 不再额外叠任何保底层。 */
    private fun onEntryClick(entry: Entry) {
        val key = SpiderManager.instance?.getRecentSpiderKey() ?: return
        Log.i(TAG, "Trigger scan for entry=${entry.id} (${entry.name})")
        SpiderManager.instance?.triggerScan(key, listOf(entry.id))
    }

    // =========================================================================
    // Adapter
    // =========================================================================

    private inner class EntryAdapter(
        private val items: List<Entry>,
        private val onClick: (Entry) -> Unit
    ) : RecyclerView.Adapter<EntryAdapter.VH>() {

        inner class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
            val pic: ImageView = itemView.findViewById(R.id.itemPic)
            val name: TextView = itemView.findViewById(R.id.itemName)
            val remarks: TextView = itemView.findViewById(R.id.itemRemarks)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_config_entry, parent, false)
            return VH(v)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val e = items[position]
            holder.name.text = e.name
            if (e.remarks.isBlank()) {
                holder.remarks.visibility = View.GONE
            } else {
                holder.remarks.visibility = View.VISIBLE
                holder.remarks.text = e.remarks
            }
            ThumbLoader.load(holder.pic, e.pic)
            holder.itemView.setOnClickListener { onClick(e) }
        }

        override fun getItemCount(): Int = items.size
    }
}