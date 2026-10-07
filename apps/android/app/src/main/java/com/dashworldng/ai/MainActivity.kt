package com.dashworldng.ai

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.dashworldng.ai.ui.DashAiApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        val services = (application as DashAiApplication).services
        // Keep the system splash until saved settings are loaded, so the first screen is correct.
        splash.setKeepOnScreenCondition { !services.settings.settings.value.loaded }
        applySystemBars(dark = true)
        setContent {
            DashAiApp(services, onDarkTheme = ::applySystemBars)
        }
    }

    /** Transparent bars drawn edge to edge; icons light on the dark theme, dark on the ivory theme. */
    private fun applySystemBars(dark: Boolean) {
        val style = if (dark) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        }
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }
}
