@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.lifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.WeakHashMap
/** STUBS with the real androidx.lifecycle 2.8 signatures used by the app (Google Maven is blocked here). */
abstract class ViewModel { protected open fun onCleared() {} }
private val scopes = WeakHashMap<ViewModel, CoroutineScope>()
/** The JVM harness runs ViewModel work unconfined (immediately, on the caller's thread). */
val ViewModel.viewModelScope: CoroutineScope
    get() = synchronized(scopes) { scopes.getOrPut(this) { CoroutineScope(SupervisorJob() + Dispatchers.Unconfined) } }
interface LifecycleOwner
abstract class Lifecycle { enum class State { DESTROYED, INITIALIZED, CREATED, STARTED, RESUMED } }
interface ViewModelStoreOwner
class ViewModelProvider { interface Factory { fun create(): ViewModel = error("stub") } }
