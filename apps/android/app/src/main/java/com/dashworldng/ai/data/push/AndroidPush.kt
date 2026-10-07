package com.dashworldng.ai.data.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.dashworldng.ai.BuildConfig
import com.dashworldng.ai.MainActivity
import com.dashworldng.ai.R
import com.dashworldng.ai.core.push.NotificationPermissionState
import com.dashworldng.ai.core.push.PushLink
import com.dashworldng.ai.core.push.PushMessage
import com.dashworldng.ai.core.push.PushNotifier
import com.dashworldng.ai.core.push.PushRegistrationState
import com.dashworldng.ai.core.push.PushStateStore
import com.dashworldng.ai.core.push.PushText
import com.dashworldng.ai.core.push.PushTokenSource
import com.dashworldng.ai.core.push.SeenPushStore
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Everything Android-specific about Automates push, built once by the app container. */
class AndroidPush(context: Context) {
    private val app = context.applicationContext
    val tokens: PushTokenSource = FirebasePushTokenSource(app)
    val permission: NotificationPermissionState = AndroidNotificationPermission(app)
    val notifier: PushNotifier = AutomatesNotifier(app)
    val state: PushStateStore = PrefsPushStateStore(app)
    val seen: SeenPushStore = PrefsSeenPushStore(app)
}

/**
 * Firebase is set up from BuildConfig (supplied at build time, never committed), not from a
 * google-services.json, and only for messaging: no analytics. A build without the configuration has no
 * push; everything else works.
 */
internal object FirebaseSetup {
    @Volatile private var initialised = false

    fun configured(): Boolean = BuildConfig.FIREBASE_APP_ID.isNotEmpty() && BuildConfig.FIREBASE_API_KEY.isNotEmpty() &&
        BuildConfig.FIREBASE_PROJECT_ID.isNotEmpty() && BuildConfig.FIREBASE_SENDER_ID.isNotEmpty()

    @Synchronized
    fun ensure(context: Context): Boolean {
        if (!configured()) return false
        if (initialised || FirebaseApp.getApps(context).isNotEmpty()) return true.also { initialised = true }
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build()
        FirebaseApp.initializeApp(context, options)
        initialised = true
        return true
    }
}

private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { task ->
        val error = task.exception
        if (task.isSuccessful) cont.resume(task.result) else cont.resumeWithException(error ?: IllegalStateException("Task failed"))
    }
}

class FirebasePushTokenSource(private val context: Context) : PushTokenSource {
    override val available: Boolean get() = FirebaseSetup.configured()

    override suspend fun token(): String? {
        if (!FirebaseSetup.ensure(context)) return null
        return FirebaseMessaging.getInstance().token.awaitResult()
    }

    override suspend fun deleteToken() {
        if (!FirebaseSetup.ensure(context)) return
        FirebaseMessaging.getInstance().deleteToken().awaitResult()
    }
}

/** Android 13+ asks for POST_NOTIFICATIONS; on every version the person can turn notifications off in Settings. */
class AndroidNotificationPermission(private val context: Context) : NotificationPermissionState {
    private val state = MutableStateFlow(read())
    override val granted: StateFlow<Boolean> = state.asStateFlow()
    override val canPrompt: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    private fun read(): Boolean {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        // The person can also switch off just the Automates channel.
        val channel = manager.getNotificationChannel(PushText.CHANNEL_ID)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    override fun refresh() {
        state.value = read()
    }

    override fun openSystemSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
    }
}

/** Posts Automates notifications: fixed DASH AI text, tapping opens the right screen. */
class AutomatesNotifier(private val context: Context) : PushNotifier {
    private fun ensureChannel() {
        val channel = NotificationChannel(PushText.CHANNEL_ID, PushText.CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT)
            .apply { description = PushText.CHANNEL_DESCRIPTION }
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    // The permission is checked just above notify(); a SecurityException (revoked meanwhile) is caught.
    @SuppressLint("MissingPermission")
    override fun show(message: PushMessage): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        ensureChannel()
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        PushLink.extras(message).forEach { (key, value) -> open.putExtra(key, value) }
        val tap = PendingIntent.getActivity(
            context,
            message.notificationId.hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val body = PushText.body(message.type)
        val notification = NotificationCompat.Builder(context, PushText.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_dash)
            .setContentTitle(PushText.TITLE)
            .setContentText(body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            // The text is lock-screen safe by design (no prompt, result or names), so it is shown as is.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(tap)
            .build()
        return try {
            // Tagged by notification id: a repeated push replaces the notification instead of adding one.
            NotificationManagerCompat.from(context).notify(message.notificationId, NOTIFICATION_ID, notification)
            true
        } catch (e: SecurityException) {
            false
        }
    }

    override fun clearAll() {
        NotificationManagerCompat.from(context).cancelAll()
    }

    private companion object {
        const val NOTIFICATION_ID = 1
    }
}

/** The account and token hash this device last registered (never the token itself). */
class PrefsPushStateStore(context: Context) : PushStateStore {
    private val prefs = context.getSharedPreferences("dash_push", Context.MODE_PRIVATE)

    override fun load() = PushRegistrationState(prefs.getString("user_id", null), prefs.getString("token_hash", null))

    override fun save(state: PushRegistrationState) {
        prefs.edit().putString("user_id", state.userId).putString("token_hash", state.tokenHash).apply()
    }
}

/** Recently shown notification ids (bounded), kept across process restarts so a late repeat is not shown again. */
class PrefsSeenPushStore(context: Context, private val capacity: Int = 100) : SeenPushStore {
    private val prefs = context.getSharedPreferences("dash_push_seen", Context.MODE_PRIVATE)

    @Synchronized
    override fun markIfNew(notificationId: String): Boolean {
        val ids = prefs.getString("ids", "").orEmpty().split(',').filter { it.isNotEmpty() }
        if (notificationId in ids) return false
        prefs.edit().putString("ids", (ids + notificationId).takeLast(capacity).joinToString(",")).apply()
        return true
    }

    @Synchronized
    override fun clear() {
        prefs.edit().remove("ids").apply()
    }
}
