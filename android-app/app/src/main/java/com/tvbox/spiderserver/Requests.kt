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
