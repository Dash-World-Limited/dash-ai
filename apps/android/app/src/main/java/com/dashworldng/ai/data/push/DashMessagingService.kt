package com.dashworldng.ai.data.push

import com.dashworldng.ai.DashAiApplication
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Receives Automates pushes and token refreshes from FCM. Pushes are data-only, so this runs whether
 * the app is in the foreground, in the background or not running, and the app decides what to show
 * (see AppServices.receivePush).
 */
class DashMessagingService : FirebaseMessagingService() {
    private val services get() = (application as DashAiApplication).services

    override fun onNewToken(token: String) {
        services.onPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Called on a background thread with a short time budget: settings are read, nothing is fetched.
        runBlocking { withTimeoutOrNull(8_000) { services.receivePush(message.data) } }
    }
}
