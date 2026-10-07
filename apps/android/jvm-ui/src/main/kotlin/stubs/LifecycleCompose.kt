@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.lifecycle.compose
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.StateFlow
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
@Composable fun <T> StateFlow<T>.collectAsStateWithLifecycle(
    lifecycleOwner: LifecycleOwner? = null,
    minActiveState: Lifecycle.State = Lifecycle.State.STARTED,
    context: CoroutineContext = EmptyCoroutineContext,
): State<T> = collectAsState(context)
