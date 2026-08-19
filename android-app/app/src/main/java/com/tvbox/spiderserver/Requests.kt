package com.tvbox.spiderserver

import com.google.gson.JsonElement

data class LoadRequest(
    val jarUrl: String = "",
    val jarPath: String? = null
)

data class InitRequest(
    val key: String = "",
    val className: String = "",
    // ext in config JSON can be either a plain String (most sites) or an
    // Object (e.g. bilibili / education sites). Using JsonElement lets Gson
    // accept either shape; handleInit converts it to a String before
    // passing to spider.init().
    val ext: JsonElement? = null,
    val jarUrl: String = ""
)

data class HomeContentRequest(
    val key: String = "",
    val filter: Boolean = false
)

/**
 * Global config pushed from the PC (config JSON's `hosts`/`cors` fields).
 * hosts: DNS override rules "host=ip" (OkDns.addAll).
 * cors:  per-host header injection {host, header} (ResponseInterceptor.addAll).
 */
data class ConfigUpdateRequest(
    val hosts: List<String> = emptyList(),
    val cors: List<HeaderRule> = emptyList()
)

data class HeaderRule(
    val host: String = "",
    // header can be a JSON object {"Referer": "..."} or a string
    val header: JsonElement? = null
)

// ── Remote desktop (config-center mirroring) ──

data class RemoteTapRequest(
    val x: Int = 0,
    val y: Int = 0
)

data class RemoteSwipeRequest(
    val x1: Int = 0,
    val y1: Int = 0,
    val x2: Int = 0,
    val y2: Int = 0,
    val duration: Long = 200
)

data class RemoteTextRequest(
    val text: String = ""
)

data class CategoryContentRequest(
    val key: String = "",
    val tid: String = "",
    val pg: String = "1",
    val filter: Boolean = false,
    val extend: Map<String, String> = emptyMap()
)

data class DetailContentRequest(
    val key: String = "",
    val ids: List<String> = emptyList()
)

data class PlayerContentRequest(
    val key: String = "",
    val flag: String = "",
    val id: String = "",
    val vipFlags: List<String> = emptyList()
)

data class SearchContentRequest(
    val key: String = "",
    val keyword: String = "",
    val quick: Boolean = false,
    val pg: String = "1"
)

data class DestroyRequest(
    val key: String = ""
)

data class SetPrefRequest(
    val key: String = "",
    val value: String = ""
)

data class DumpRequest(
    val key: String = ""
)

data class ActionRequest(
    val key: String = "",
    val action: String = ""
)
