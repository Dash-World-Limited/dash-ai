@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.lifecycle.viewmodel.compose
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
/** STUB: one ViewModel per call site (the real one scopes it to the navigation entry). */
@Composable inline fun <reified VM : ViewModel> viewModel(
    viewModelStoreOwner: ViewModelStoreOwner? = null,
    key: String? = null,
    factory: ViewModelProvider.Factory? = null,
): VM = remember(key) { factory!!.create() as VM }
