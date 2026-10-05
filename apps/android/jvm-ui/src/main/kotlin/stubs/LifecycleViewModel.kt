@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.lifecycle.viewmodel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
abstract class CreationExtras { object Empty : CreationExtras() }
class InitializerViewModelFactoryBuilder { var create: (() -> ViewModel)? = null }
inline fun <reified VM : ViewModel> InitializerViewModelFactoryBuilder.initializer(noinline initializer: CreationExtras.() -> VM) {
    create = { CreationExtras.Empty.initializer() }
}
inline fun viewModelFactory(builder: InitializerViewModelFactoryBuilder.() -> Unit): ViewModelProvider.Factory {
    val b = InitializerViewModelFactoryBuilder().apply(builder)
    return object : ViewModelProvider.Factory { override fun create(): ViewModel = b.create!!() }
}
