package com.dashworldng.ai

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.dashworldng.ai.core.push.PushLink
import com.dashworldng.ai.data.share.ShareIntents
import com.dashworldng.ai.ui.DashAiApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        val services = (application as DashAiApplication).services
        // Keep the system splash until saved settings are loaded, so the first screen is correct.
        splash.setKeepOnScreenCondition { !services.settings.settings.value.loaded }
        applySystemBars(dark = true)
        // A share is handled once: not again when the activity is recreated (rotation, theme change).
        if (savedInstanceState == null) receive(intent)
        setContent {
            DashAiApp(services, onDarkTheme = ::applySystemBars)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receive(intent)
    }

    override fun onResume() {
        super.onResume()
        // The person may have changed notification permission in Android settings meanwhile.
        (application as DashAiApplication).services.notificationPermission.refresh()
    }

    /**
     * "Share → DASH AI", or a tapped Automates notification: the app opens it once the person is past
     * onboarding and sign-in. A notification carries ids only; the screen loads through the owner-checked API.
     */
    private fun receive(intent: Intent?) {
        val services = (application as DashAiApplication).services
        if (intent != null) PushLink.parse(intent::getStringExtra)?.let(services.pushOpens::post)
        ShareIntents.parse(this, intent)?.let(services.shares::post)
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
