@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.navigation
import androidx.compose.runtime.mutableStateListOf
/**
 * STUBS with the real navigation 2.8 signatures used by the app, backed by a minimal working back
 * stack so the UI can run on the JVM. Route patterns support "{arg}" path segments only.
 */
open class NavDestination(val route: String? = null)
open class NavGraph : NavDestination() { val id: Int = 0 }
class NavBackStackEntry(val route: String, val pattern: String, val arguments: android.os.Bundle?) { val destination: NavDestination = NavDestination(pattern) }
open class NavController {
    open val graph: NavGraph = NavGraph()
    val backStack = mutableStateListOf<NavBackStackEntry>()
    internal var patterns: List<String> = emptyList()
    val currentDestination: NavDestination? get() = backStack.lastOrNull()?.destination

    internal fun entryFor(route: String): NavBackStackEntry {
        for (p in patterns) {
            val ps = p.split('/'); val rs = route.split('/')
            if (ps.size != rs.size) continue
            val args = mutableMapOf<String, String>()
            if (ps.indices.all { i -> if (ps[i].startsWith("{")) { args[ps[i].trim('{', '}')] = rs[i]; true } else ps[i] == rs[i] }) {
                return NavBackStackEntry(route, p, android.os.Bundle(args))
            }
        }
        error("No destination for route $route")
    }

    fun navigate(route: String) = navigate(route) {}
    fun navigate(route: String, builder: NavOptionsBuilder.() -> Unit) {
        val options = NavOptionsBuilder().apply(builder)
        val entry = entryFor(route)
        options.popUpToId?.let { backStack.clear() }
        options.popUpToRoute?.let { (target, inclusive) ->
            val index = backStack.indexOfLast { it.pattern == target || it.route == target }
            if (index >= 0) while (backStack.size > index + (if (inclusive) 0 else 1)) backStack.removeAt(backStack.lastIndex)
        }
        if (options.launchSingleTop && backStack.lastOrNull()?.pattern == entry.pattern && backStack.lastOrNull()?.route == entry.route) return
        backStack.add(entry)
    }
    fun popBackStack(): Boolean = if (backStack.size > 1) { backStack.removeAt(backStack.lastIndex); true } else false
    fun popBackStack(route: String, inclusive: Boolean, saveState: Boolean = false): Boolean {
        val index = backStack.indexOfLast { it.pattern == route || it.route == route }
        if (index < 0) return false
        while (backStack.size > index + (if (inclusive) 0 else 1)) backStack.removeAt(backStack.lastIndex)
        return true
    }
}
open class NavHostController : NavController()
class NavOptionsBuilder {
    var launchSingleTop: Boolean = false
    var restoreState: Boolean = false
    internal var popUpToId: Int? = null
    internal var popUpToRoute: Pair<String, Boolean>? = null
    fun popUpTo(id: Int, popUpToBuilder: PopUpToBuilder.() -> Unit = {}) { popUpToId = id; PopUpToBuilder().apply(popUpToBuilder) }
    fun popUpTo(route: String, popUpToBuilder: PopUpToBuilder.() -> Unit = {}) { popUpToRoute = route to PopUpToBuilder().apply(popUpToBuilder).inclusive }
}
class PopUpToBuilder { var inclusive: Boolean = false; var saveState: Boolean = false }
open class NavGraphBuilder { val destinations = mutableListOf<Pair<String, @androidx.compose.runtime.Composable androidx.compose.animation.AnimatedContentScope.(NavBackStackEntry) -> Unit>>() }
class NamedNavArgument
class NavArgumentBuilder { var type: NavType<*> = NavType.StringType; var nullable: Boolean = false }
fun navArgument(name: String, builder: NavArgumentBuilder.() -> Unit): NamedNavArgument = NamedNavArgument()
abstract class NavType<T> { object StringType : NavType<String?>() }
fun setPatterns(nav: NavController, patterns: List<String>) { nav.patterns = patterns }
fun entry(nav: NavController, route: String): NavBackStackEntry = nav.entryFor(route)
