@file:Suppress("unused", "UNUSED_PARAMETER")
package com.dashworldng.ai.data.push

import com.dashworldng.ai.core.push.FixedNotificationPermission
import com.dashworldng.ai.core.push.FixedPushTokenSource
import com.dashworldng.ai.core.push.InMemoryPushStateStore
import com.dashworldng.ai.core.push.InMemorySeenPushStore
import com.dashworldng.ai.core.push.NotificationPermissionState
import com.dashworldng.ai.core.push.PushNotifier
import com.dashworldng.ai.core.push.PushStateStore
import com.dashworldng.ai.core.push.PushTokenSource
import com.dashworldng.ai.core.push.RecordingPushNotifier
import com.dashworldng.ai.core.push.SeenPushStore

/** STUB of the Android push wiring (Firebase and NotificationManager do not exist on the JVM). */
class AndroidPush(context: android.content.Context) {
    val tokens: PushTokenSource = FixedPushTokenSource()
    val permission: NotificationPermissionState = FixedNotificationPermission(granted = false)
    val notifier: PushNotifier = RecordingPushNotifier()
    val state: PushStateStore = InMemoryPushStateStore()
    val seen: SeenPushStore = InMemorySeenPushStore()
}
