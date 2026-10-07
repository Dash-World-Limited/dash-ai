@file:Suppress("unused", "UNUSED_PARAMETER")
package android.provider
/** STUB of android.provider.Settings.Global (animator scale lookup). */
object Settings {
    object Global {
        const val ANIMATOR_DURATION_SCALE = "animator_duration_scale"
        fun getFloat(resolver: android.content.ContentResolver, name: String, def: Float): Float = def
    }
}
