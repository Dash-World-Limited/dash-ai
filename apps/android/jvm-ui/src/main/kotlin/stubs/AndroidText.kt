@file:Suppress("unused", "UNUSED_PARAMETER")
package android.text.format
object DateUtils {
    const val MINUTE_IN_MILLIS = 60_000L
    const val FORMAT_ABBREV_RELATIVE = 0x40000
    fun getRelativeTimeSpanString(time: Long, now: Long, minResolution: Long, flags: Int): CharSequence = ""
    fun getRelativeTimeSpanString(time: Long, now: Long, minResolution: Long): CharSequence = ""
    fun getRelativeTimeSpanString(startTime: Long): CharSequence = ""
}
