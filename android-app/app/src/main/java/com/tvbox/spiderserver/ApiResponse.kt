package com.tvbox.spiderserver

/**
 * Unified API response wrapper.
 */
data class ApiResponse(
    val success: Boolean,
    val data: Any? = null,
    val error: String? = null
) {
    companion object {
        @JvmStatic
        fun success(data: Any?): ApiResponse = ApiResponse(true, data, null)

        @JvmStatic
        fun error(message: String): ApiResponse = ApiResponse(false, null, message)
    }
}
