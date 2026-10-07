@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.compose.ui.platform
import androidx.compose.runtime.staticCompositionLocalOf
/** STUB of Android's LocalContext: a fake context whose system services do nothing. */
val LocalContext = staticCompositionLocalOf<android.content.Context> { android.content.FakeContext }
