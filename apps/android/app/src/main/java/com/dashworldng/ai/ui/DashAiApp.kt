package com.dashworldng.ai.ui

import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.dashworldng.ai.core.presentation.StartDestination
import com.dashworldng.ai.core.presentation.StartRoute
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.auth.AuthScreen
import com.dashworldng.ai.ui.chat.ChatScreen
import com.dashworldng.ai.ui.chat.ChatViewModel
import com.dashworldng.ai.ui.chat.DrawerCallbacks
import com.dashworldng.ai.ui.chat.DrawerDestination
import com.dashworldng.ai.ui.documents.DocumentDetailScreen
import com.dashworldng.ai.ui.documents.DocumentsScreen
import com.dashworldng.ai.ui.home.HomeScreen
import com.dashworldng.ai.ui.onboarding.OnboardingScreen
import com.dashworldng.ai.ui.onboarding.SplashScreen
import com.dashworldng.ai.ui.prompts.PromptLibraryScreen
import com.dashworldng.ai.ui.settings.AccountScreen
import com.dashworldng.ai.ui.settings.SettingsScreen
import com.dashworldng.ai.ui.system.rememberReducedMotion
import com.dashworldng.ai.ui.theme.DashAiTheme
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.tools.ToolsScreen
import com.dashworldng.ai.ui.automates.AutomatesScreen
import com.dashworldng.ai.ui.automates.AutomationDetailScreen
import com.dashworldng.ai.ui.automates.AutomationEditorScreen
import com.dashworldng.ai.ui.automates.AutomationRunScreen
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Navigation map (see docs/android-navigation.md). Home is the root once signed in or in Demo Mode. */
object Routes {
    const val SPLASH = "splash"
    const val ONBOARDING = "onboarding"
    const val AUTH = "auth"
    const val HOME = "home"
    const val CHAT = "chat"
    const val DOCUMENTS = "documents"
    const val DOCUMENT = "documents/{id}"
    const val AUTOMATES = "automates"
    const val AUTOMATION_NEW = "automates/new"
    const val AUTOMATION = "automates/{id}"
    const val AUTOMATION_EDIT = "automates/{id}/edit"
    const val AUTOMATION_RUN = "automates/{id}/runs/{runId}"
    const val TOOLS = "tools"
    const val PROMPTS = "prompts"
    const val SETTINGS = "settings"
    const val ACCOUNT = "account"

    /** Screens before the app is ready (onboarding, sign-in): a share waits until they are done. */
    val ENTRY = setOf(SPLASH, ONBOARDING, AUTH)

    fun document(id: String) = "documents/$id"

    fun automation(id: String) = "automates/$id"

    fun automationEdit(id: String) = "automates/$id/edit"

    fun automationRun(id: String, runId: String) = "automates/$id/runs/$runId"

    fun afterSplash(settings: AppSettings): String =
        when (StartRoute.resolve(settings.onboardingComplete, hasAccount = settings.account != null)) {
            StartDestination.ONBOARDING -> ONBOARDING
            StartDestination.AUTH -> AUTH
            StartDestination.HOME -> HOME
        }
}

private fun NavHostController.goFresh(route: String) {
    navigate(route) {
        popUpTo(graph.id) { inclusive = true }
        launchSingleTop = true
    }
}

/** Opens [route] above Home, never stacking the same screen twice. */
private fun NavHostController.open(route: String) {
    navigate(route) { launchSingleTop = true }
}

/**
 * The whole app. [onDarkTheme] lets the activity match the system bar icons to the active theme.
 */
@Composable
fun DashAiApp(services: AppServices, startDestination: String = Routes.SPLASH, onDarkTheme: (Boolean) -> Unit = {}) {
    val settings by services.settings.settings.collectAsStateWithLifecycle()
    DashAiTheme(settings.theme) {
        val dark = DashTheme.colors.isDark
        LaunchedEffect(dark) { onDarkTheme(dark) }
        AppNavigation(services, startDestination, settings)
    }
}

@Composable
private fun AppNavigation(services: AppServices, startDestination: String, settings: AppSettings) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val reducedMotion = rememberReducedMotion()
    // One chat state for Home and the chat screen, so a question asked on Home continues in the chat.
    val chat = dashViewModel { ChatViewModel(services) }
    val drawer = remember(chat, nav) {
        DrawerCallbacks(
            onSearch = chat::setSearch,
            onOpen = { id ->
                chat.openConversation(id)
                nav.open(Routes.CHAT)
            },
            onNewChat = {
                chat.newChat()
                nav.open(Routes.CHAT)
            },
            onRename = chat::renameConversation,
            onDelete = chat::deleteConversation,
            onNavigate = { destination ->
                when (destination) {
                    DrawerDestination.HOME -> nav.popBackStack(Routes.HOME, inclusive = false)
                    DrawerDestination.DOCUMENTS -> nav.open(Routes.DOCUMENTS)
                    DrawerDestination.AUTOMATES -> nav.open(Routes.AUTOMATES)
                    DrawerDestination.TOOLS -> nav.open(Routes.TOOLS)
                    DrawerDestination.PROMPTS -> nav.open(Routes.PROMPTS)
                    DrawerDestination.SETTINGS -> nav.open(Routes.SETTINGS)
                }
            },
            now = services.clock::now,
            unread = services.notices.unread,
        )
    }
    val openChat = { nav.open(Routes.CHAT) }

    // "Share → DASH AI": once past onboarding and sign-in, the share opens a new chat above Home.
    val current by nav.currentBackStackEntryAsState()
    val share by services.shares.pending.collectAsStateWithLifecycle()
    val route = current?.destination?.route
    LaunchedEffect(share, route) {
        if (share == null || route == null || route in Routes.ENTRY) return@LaunchedEffect
        val incoming = services.shares.consume() ?: return@LaunchedEffect
        chat.receiveShare(incoming)
        nav.navigate(Routes.CHAT) { popUpTo(Routes.HOME) { inclusive = false } }
    }
    // Automates run on the server: the unread count is refreshed as people move around the app.
    LaunchedEffect(route, settings.account, settings.demoMode) {
        val signedIn = !settings.demoMode && settings.account?.isDemo == false
        if (!signedIn) return@LaunchedEffect services.notices.clear()
        if (route == null || route in Routes.ENTRY) return@LaunchedEffect
        val api = services.automations() ?: return@LaunchedEffect
        try {
            services.notices.refresh(api)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Offline or an older server: the count simply stays as it was.
        }
    }
    val duration = if (reducedMotion) 0 else 220

    NavHost(
        navController = nav,
        startDestination = startDestination,
        modifier = Modifier.fillMaxSize().background(DashTheme.colors.background),
        enterTransition = { fadeIn(tween(duration)) },
        exitTransition = { fadeOut(tween(duration)) },
    ) {
        composable(Routes.SPLASH) {
            SplashScreen(onFinished = { nav.goFresh(Routes.afterSplash(services.settings.settings.value)) })
        }
        composable(Routes.ONBOARDING) {
            OnboardingScreen(onFinish = {
                scope.launch { services.settings.update { it.copy(onboardingComplete = true) } }
                nav.goFresh(if (settings.account == null) Routes.AUTH else Routes.HOME)
            })
        }
        composable(Routes.AUTH) {
            AuthScreen(services, onSignedIn = { nav.goFresh(Routes.HOME) })
        }
        composable(Routes.HOME) {
            HomeScreen(
                vm = chat,
                drawer = drawer,
                onOpenChat = openChat,
                onOpenTools = { nav.open(Routes.TOOLS) },
                onOpenAccount = { nav.open(Routes.ACCOUNT) },
            )
        }
        composable(Routes.CHAT) {
            ChatScreen(
                vm = chat,
                drawer = drawer,
                onBack = { if (!nav.popBackStack()) nav.goFresh(Routes.HOME) },
                onOpenSettings = { nav.open(Routes.SETTINGS) },
                onOpenTools = { nav.open(Routes.TOOLS) },
            )
        }
        composable(Routes.DOCUMENTS) {
            DocumentsScreen(services, onBack = { nav.popBackStack() }, onOpenDocument = { nav.open(Routes.document(it)) })
        }
        composable(Routes.DOCUMENT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            DocumentDetailScreen(
                services,
                documentId = entry.arguments?.getString("id").orEmpty(),
                onBack = { nav.popBackStack() },
                onAsk = {
                    // The chat ViewModel picks the prefill up; Home stays underneath for Back.
                    nav.navigate(Routes.CHAT) { popUpTo(Routes.HOME) { inclusive = false } }
                },
            )
        }
        composable(Routes.AUTOMATES) {
            AutomatesScreen(
                services,
                onBack = { nav.popBackStack() },
                onSignIn = {
                    scope.launch { services.settings.update { it.copy(account = null, demoMode = true) } }
                    nav.goFresh(Routes.AUTH)
                },
                onNew = { nav.open(Routes.AUTOMATION_NEW) },
                onOpen = { nav.open(Routes.automation(it)) },
                onOpenRun = { id, runId -> nav.open(Routes.automationRun(id, runId)) },
            )
        }
        // Before AUTOMATION, so "new" is never read as an id.
        composable(Routes.AUTOMATION_NEW) {
            AutomationEditorScreen(services, automationId = null, onBack = { nav.popBackStack() }, onSaved = { id ->
                nav.popBackStack()
                nav.open(Routes.automation(id))
            })
        }
        composable(Routes.AUTOMATION, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            AutomationDetailScreen(
                services,
                automationId = id,
                onBack = { nav.popBackStack() },
                onEdit = { nav.open(Routes.automationEdit(id)) },
                onOpenRun = { runId -> nav.open(Routes.automationRun(id, runId)) },
            )
        }
        composable(Routes.AUTOMATION_EDIT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
            AutomationEditorScreen(services, automationId = entry.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() }, onSaved = {
                nav.popBackStack()
            })
        }
        composable(
            Routes.AUTOMATION_RUN,
            arguments = listOf(navArgument("id") { type = NavType.StringType }, navArgument("runId") { type = NavType.StringType }),
        ) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            AutomationRunScreen(
                services,
                automationId = id,
                runId = entry.arguments?.getString("runId").orEmpty(),
                onBack = { nav.popBackStack() },
                onRegenerated = {
                    // Back to the automation, where the new run shows as Running.
                    nav.popBackStack()
                    nav.open(Routes.automation(id))
                },
            )
        }
        composable(Routes.TOOLS) {
            ToolsScreen(services, onBack = { nav.popBackStack() }, onSignIn = {
                scope.launch { services.settings.update { it.copy(account = null, demoMode = true) } }
                nav.goFresh(Routes.AUTH)
            })
        }
        composable(Routes.PROMPTS) {
            PromptLibraryScreen(services, onBack = { nav.popBackStack() }, onUsePrompt = {
                nav.navigate(Routes.CHAT) { popUpTo(Routes.HOME) { inclusive = false } }
            })
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                services,
                onBack = { nav.popBackStack() },
                onSignIn = { nav.open(Routes.AUTH) },
                onOpenTools = { nav.open(Routes.TOOLS) },
                onOpenAccount = { nav.open(Routes.ACCOUNT) },
                onSyncNow = chat::syncNow,
            )
        }
        composable(Routes.ACCOUNT) {
            AccountScreen(services, onBack = { nav.popBackStack() }, onSignedOut = { nav.goFresh(Routes.AUTH) }, onSyncNow = chat::syncNow)
        }
    }
}
