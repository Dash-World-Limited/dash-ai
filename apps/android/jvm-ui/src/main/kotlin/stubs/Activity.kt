@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.activity.compose
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
/** STUB: the system file picker does not exist on the JVM; launching records the request only. */
@Composable fun <I, O> rememberLauncherForActivityResult(contract: ActivityResultContract<I, O>, onResult: (O) -> Unit): ActivityResultLauncher<I> =
    remember { object : ActivityResultLauncher<I>() { override fun launch(input: I) { LauncherLog.launched += contract::class.simpleName.orEmpty() } } }
object LauncherLog { val launched = mutableListOf<String>() }
@Composable fun BackHandler(enabled: Boolean = true, onBack: () -> Unit) {}
