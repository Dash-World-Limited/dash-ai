@file:Suppress("unused", "UNUSED_PARAMETER")
package android.content
/** STUB: only the Android members the app sources use, so they compile on the JVM. Never runs. */
abstract class Context {
    abstract val applicationContext: Context
    abstract fun getSharedPreferences(name: String, mode: Int): SharedPreferences
    abstract fun startActivity(intent: Intent)
    abstract val contentResolver: ContentResolver
    companion object { const val MODE_PRIVATE: Int = 0 }
}
abstract class ContentResolver {
    abstract fun openOutputStream(uri: android.net.Uri): java.io.OutputStream?
}
interface SharedPreferences {
    fun getString(key: String, defValue: String?): String?
    fun edit(): Editor
    interface Editor { fun putString(key: String, value: String?): Editor; fun apply(); fun commit(): Boolean }
}
open class Intent(action: String? = null) {
    fun putExtra(name: String, value: String?): Intent = this
    fun setType(type: String?): Intent = this
    var type: String? = null
    fun addFlags(flags: Int): Intent = this
    var data: android.net.Uri? = null
    companion object {
        const val ACTION_SEND = "android.intent.action.SEND"
        const val ACTION_VIEW = "android.intent.action.VIEW"
        const val EXTRA_TEXT = "android.intent.extra.TEXT"
        const val FLAG_ACTIVITY_NEW_TASK = 0x10000000
        const val EXTRA_SUBJECT = "android.intent.extra.SUBJECT"
        fun createChooser(target: Intent, title: CharSequence?): Intent = target
    }
}

/** Used only by the JVM harness. */
object FakeContext : Context() {
    override val applicationContext: Context get() = this
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = error("not available in the JVM harness")
    override fun startActivity(intent: Intent) {}
    override val contentResolver: ContentResolver = object : ContentResolver() {
        override fun openOutputStream(uri: android.net.Uri): java.io.OutputStream? = null
    }
}
