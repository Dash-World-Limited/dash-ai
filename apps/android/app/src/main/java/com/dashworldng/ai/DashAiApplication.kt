package com.dashworldng.ai

import android.app.Application
import com.dashworldng.ai.di.AppContainer
import com.dashworldng.ai.di.AppServices

class DashAiApplication : Application() {
    val services: AppServices by lazy { AppContainer(this) }
}
