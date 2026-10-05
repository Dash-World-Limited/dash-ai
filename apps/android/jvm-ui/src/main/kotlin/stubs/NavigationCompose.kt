@file:Suppress("unused", "UNUSED_PARAMETER", "UNCHECKED_CAST")
package androidx.navigation.compose
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentScope
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.NamedNavArgument
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.entry
import androidx.navigation.setPatterns

private typealias Content = @Composable AnimatedContentScope.(NavBackStackEntry) -> Unit

@Composable fun rememberNavController(): NavHostController = remember { NavHostController() }
@Composable fun NavController.currentBackStackEntryAsState(): State<NavBackStackEntry?> = remember { derivedStateOf { backStack.lastOrNull() } }
@Composable fun NavHost(
    navController: NavHostController,
    startDestination: String,
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    route: String? = null,
    enterTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition) = { EnterTransition.None },
    exitTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition) = { ExitTransition.None },
    popEnterTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition) = enterTransition,
    popExitTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition) = exitTransition,
    builder: NavGraphBuilder.() -> Unit,
) {
    val graph = remember { NavGraphBuilder().apply(builder) }
    val destinations = graph.destinations.toMap()
    navController.run {
        if (backStack.isEmpty()) {
            setPatterns(this, destinations.keys.toList())
            backStack.add(entry(this, startDestination))
        }
    }
    val top = navController.backStack.last()
    Box(modifier) {
        AnimatedContent(top, transitionSpec = { EnterTransition.None togetherWith ExitTransition.None }, label = "nav") { entry ->
            destinations.getValue(entry.pattern).invoke(this, entry)
        }
    }
}
fun NavGraphBuilder.composable(
    route: String,
    arguments: List<NamedNavArgument> = emptyList(),
    content: @Composable AnimatedContentScope.(NavBackStackEntry) -> Unit,
) { destinations += route to content }
