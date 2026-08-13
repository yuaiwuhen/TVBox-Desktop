package com.github.catvod.crawler

import android.content.Context
import java.util.HashMap

/**
 * Abstract base class for all catvod spiders.
 *
 * This class must be present in the host APK because spider JARs
 * (e.g. com.github.catvod.spider.BaseSpiderGuard) extend it directly.
 * Without it, DexClassLoader fails with `ClassNotFoundException: com.github.catvod.crawler.Spider`
 * when trying to load any spider class from the JAR.
 *
 * Method signatures match the official FongMi/TV catvod Spider interface
 * so that subclasses compiled against the original catvod API can be loaded.
 */
abstract class Spider {

    /**
     * Called by the host before any content method. Default no-op.
     */
    open fun init(context: Context) {
        // no-op
    }

    /**
     * Called by the host with the configured `ext` string. Default no-op.
     */
    open fun init(context: Context, extend: String) {
        // no-op
    }

    /**
     * Home page categories + recommended videos.
     * Returns a JSON string understood by the host UI.
     */
    open fun homeContent(filter: Boolean): String {
        return ""
    }

    /**
     * Recommended videos for the home page (no categories).
     */
    open fun homeVideoContent(): String {
        return ""
    }

    /**
     * Paged category listing.
     *
     * @param tid     category id (from homeContent classes)
     * @param pg      page number as string ("1", "2", ...)
     * @param filter  whether to include filter definitions in the response
     * @param extend  user-selected filter values (may be empty)
     */
    open fun categoryContent(tid: String, pg: String, filter: Boolean, extend: HashMap<String, String>): String {
        return ""
    }

    /**
     * Detail page for a list of video ids (usually length 1).
     */
    open fun detailContent(ids: List<String>): String {
        return ""
    }

    /**
     * Search for a keyword.
     */
    open fun searchContent(key: String, quick: Boolean): String {
        return ""
    }

    /**
     * Paged search. Default delegates to the two-arg version.
     */
    open fun searchContent(key: String, quick: Boolean, pg: String): String {
        return searchContent(key, quick)
    }

    /**
     * Resolve a playable URL for the given video id + flag.
     *
     * @param flag     source flag (e.g. "默认", "线路1")
     * @param id       video id from detailContent
     * @param vipFlags list of flags that should be treated as VIP (parser required)
     */
    open fun playerContent(flag: String, id: String, vipFlags: List<String>): String {
        return ""
    }

    /**
     * Optional "action" hook used by some spiders for custom commands.
     * Default returns empty string.
     */
    open fun action(action: String): String {
        return ""
    }

    /**
     * Called when the spider instance is being retired. Default no-op.
     */
    open fun destroy() {
        // no-op
    }

    /**
     * Whether manual video selection is supported for the given key.
     */
    open fun isManualVideoCheck(key: String): Boolean {
        return false
    }

    /**
     * Return manual video candidates for the given key.
     */
    open fun manualVideoCheck(key: String): Array<Any> {
        return emptyArray()
    }

    /**
     * Audio-only content for the given id.
     */
    open fun audioContent(id: String): String {
        return ""
    }
}
