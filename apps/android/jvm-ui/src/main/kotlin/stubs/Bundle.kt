@file:Suppress("unused", "UNUSED_PARAMETER")
package android.os
class Bundle(private val values: Map<String, String> = emptyMap()) { fun getString(key: String): String? = values[key] }
