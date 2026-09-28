package com.dashworldng.ai.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.auth.AuthScreen
import com.dashworldng.ai.ui.chat.ChatScreen
import com.dashworldng.ai.ui.documents.DocumentsScreen
import com.dashworldng.ai.ui.onboarding.OnboardingScreen
import com.dashworldng.ai.ui.onboarding.SplashScreen
import com.dashworldng.ai.ui.prompts.PromptLibraryScreen
import com.dashworldng.ai.ui.settings.AccountScreen
import com.dashworldng.ai.ui.settings.SettingsScreen
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.launch

object Routes {
    const val SPLASH = "splash"
    const val ONBOARDING = "onboarding"
    const val AUTH = "auth"
    const val CHAT = "chat"
    const val DOCUMENTS = "documents"
    const val PROMPTS = "prompts"
    const val SETTINGS = "settings"
    const val ACCOUNT = "account"

    fun afterSplash(settings: AppSettings): String = when {
        !settings.onboardingComplete -> ONBOARDING
        settings.account == null -> AUTH
        else -> CHAT
    }
}

private fun NavHostController.goFresh(route: String) {
    navigate(route) {
        popUpTo(graph.id) { inclusive = true }
        launchSingleTop = true
    }
}

@Composable
fun DashAiApp(services: AppServices, startDestination: String = Routes.SPLASH) {
    val nav = rememberNavController()
    val settings by services.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    NavHost(
        navController = nav,
        startDestination = startDestination,
        modifier = Modifier.fillMaxSize().background(DashColors.Black),
    ) {
        composable(Routes.SPLASH) {
            SplashScreen(onFinished = { nav.goFresh(Routes.afterSplash(services.settings.settings.value)) })
        }
        composable(Routes.ONBOARDING) {
            OnboardingScreen(onFinish = {
                scope.launch { services.settings.update { it.copy(onboardingComplete = true) } }
                nav.goFresh(if (settings.account == null) Routes.AUTH else Routes.CHAT)
            })
        }
        composable(Routes.AUTH) {
            AuthScreen(services, onSignedIn = { nav.goFresh(Routes.CHAT) })
        }
        composable(Routes.CHAT) {
            ChatScreen(
                services = services,
                onOpenDocuments = { nav.navigate(Routes.DOCUMENTS) },
                onOpenPrompts = { nav.navigate(Routes.PROMPTS) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) },
                onOpenAccount = { nav.navigate(Routes.ACCOUNT) },
            )
        }
        composable(Routes.DOCUMENTS) {
            DocumentsScreen(services, onBack = { nav.popBackStack() }, onOpenChat = { nav.popBackStack(Routes.CHAT, inclusive = false) })
        }
        composable(Routes.PROMPTS) {
            PromptLibraryScreen(services, onBack = { nav.popBackStack() }, onUsePrompt = { nav.popBackStack(Routes.CHAT, inclusive = false) })
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(services, onBack = { nav.popBackStack() }, onSignIn = { nav.navigate(Routes.AUTH) })
        }
        composable(Routes.ACCOUNT) {
            AccountScreen(services, onBack = { nav.popBackStack() }, onSignedOut = { nav.goFresh(Routes.AUTH) })
        }
    }
}
