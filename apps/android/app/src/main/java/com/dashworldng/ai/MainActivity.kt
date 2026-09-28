package com.dashworldng.ai

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.dashworldng.ai.ui.DashAiApp
import com.dashworldng.ai.ui.theme.DashAiTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        val services = (application as DashAiApplication).services
        // Keep the system splash until saved settings are loaded, so the first screen is correct.
        splash.setKeepOnScreenCondition { !services.settings.settings.value.loaded }
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContent {
            DashAiTheme {
                DashAiApp(services)
            }
        }
    }
}
